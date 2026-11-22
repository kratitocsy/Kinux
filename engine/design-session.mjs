// A design session: an agent changes the DESIGN, Kinux decides whether the
// change stands.
//
// The checks are fixed for the session; the design moves to meet them. Every
// edit happens in a private copy of the KiCad project and sidecar (the
// originals are never written), and is kept only if Kinux, re-running
// everything from the edited files, finds:
//
//   1. the edit reached the simulated circuit (the part's element changed), so
//      nothing passes for a reason that is not in the design;
//   2. ERC (kicad-cli) reports no more violations than before;
//   3. no check that passed before now fails, errors or goes unchecked;
//   4. at least one check that did not pass before now passes.
//
// Otherwise the copy is put back exactly as it was. Edit kinds are closed:
//
//   value {ref, value}           the symbol's Value field, as KiCad stores it
//                                (R, C and L values must parse as KiCad values)
//   model {ref, file, subckt|model, ports?}
//                                which simulation model the part uses: an
//                                entry in the session's sidecar, from a file
//                                in the model directory that defines that name
//
// Each edit states why (the requirement it serves). The session's result is a
// diff of the project against the original, for a person to review and apply.

import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDesign, parseKicadValue } from './kicad-adapter.mjs';
import { parseNetlist } from './netlist.mjs';
import { runChecks, normaliseSuite } from './runner.mjs';
import { checkErc } from '../workers/pcb/erc-drc-report.mjs';

export class DesignError extends Error {}
const sha = t => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const SAFE_VALUE = /^[A-Za-z0-9 .,_+\-µμΩ%/]{1,40}$/;
const SAFE_NAME = /^[A-Za-z0-9_.+-]{1,80}$/;

/** Index just past the s-expression that opens at `start` (strings respected). */
function sexpEnd(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/**
 * Set a placed symbol's Value field. Anchored: exactly one placed symbol with
 * this reference, exactly one Value field in it; anything else is refused.
 * @returns {{text: string, from: string}}
 */
export function setSymbolValue(schText, ref, value) {
  const re = new RegExp(`\\(property "Reference" "${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
  const hits = [...schText.matchAll(re)].map(m => m.index);
  // A placed symbol is a top-level "(symbol (lib_id ...": library definitions use "(symbol \"Name\"".
  const owners = hits.map(i => {
    let j = schText.lastIndexOf('(symbol', i);
    while (j >= 0 && /^\(symbol\s+"/.test(schText.slice(j, j + 10))) j = schText.lastIndexOf('(symbol', j - 1);
    return j;
  }).filter(j => j >= 0 && /^\(symbol\s*\(lib_id|^\(symbol\s*\n\s*\(lib_id/.test(schText.slice(j, j + 40)));
  const unique = [...new Set(owners)];
  if (unique.length !== 1) throw new DesignError(`expected exactly one placed symbol ${ref}, found ${unique.length}`);
  const start = unique[0], end = sexpEnd(schText, start);
  const block = schText.slice(start, end);
  const vals = [...block.matchAll(/\(property "Value" "((?:[^"\\]|\\.)*)"/g)];
  if (vals.length !== 1) throw new DesignError(`${ref} has ${vals.length} Value fields`);
  const from = vals[0][1];
  const at = start + vals[0].index;
  const old = vals[0][0];
  const next = `(property "Value" "${value}"`;
  return { text: schText.slice(0, at) + next + schText.slice(at + old.length), from };
}

/** A line diff for review: the changed region of each file, with context. */
export function diffText(a, b, name, context = 3) {
  if (a === b) return '';
  const A = a.split('\n'), B = b.split('\n');
  const hunks = [];
  if (A.length === B.length) {
    const changed = A.map((l, i) => l !== B[i]).map((c, i) => (c ? i : -1)).filter(i => i >= 0);
    for (const i of changed) {
      const lo = Math.max(0, i - context), hi = Math.min(A.length, i + context + 1);
      hunks.push([`@@ line ${i + 1} @@`, ...A.slice(lo, i).map(l => ` ${l}`), `-${A[i]}`, `+${B[i]}`, ...A.slice(i + 1, hi).map(l => ` ${l}`)].join('\n'));
    }
  } else {
    let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
    hunks.push([`@@ line ${p + 1} @@`, ...A.slice(Math.max(0, p - context), p).map(l => ` ${l}`),
      ...A.slice(p, A.length - s).map(l => `-${l}`), ...B.slice(p, B.length - s).map(l => `+${l}`),
      ...A.slice(A.length - s, A.length - s + context).map(l => ` ${l}`)].join('\n'));
  }
  return [`--- original/${name}`, `+++ edited/${name}`, ...hunks].join('\n');
}

const kindOf = ref => (/^RV/.test(ref) ? null : /^R\d/.test(ref) ? 'R' : /^C\d/.test(ref) ? 'C' : /^L\d/.test(ref) ? 'L' : null);

/**
 * @param {object} o
 * @param {string} o.schematic   the original .kicad_sch (never written)
 * @param {string} o.sidecar     the original sidecar (never written)
 * @param {string} [o.modelDir]  model files the session may point a part at
 * @param {string} [o.intent]
 * @param {object} o.suite       the check suite (fixed for the session)
 */
export function createDesignSession({ schematic, sidecar, modelDir, intent, suite: rawSuite, compat = null, timeoutMs = 600_000 }) {
  const suite = normaliseSuite(rawSuite);
  const srcDir = dirname(resolve(schematic));
  const work = mkdtempSync(join(tmpdir(), 'kinux-design-'));
  cpSync(srcDir, join(work, 'project'), { recursive: true, filter: p => !/\.kicad_prl$|-backups|\.lck$/.test(p) });
  const sch = join(work, 'project', basename(schematic));
  const side = join(work, 'sidecar.json');
  writeFileSync(side, readFileSync(sidecar, 'utf8'));
  const original = { sch: readFileSync(schematic, 'utf8'), side: readFileSync(sidecar, 'utf8') };
  const log = [];
  let state = null;
  let queue = Promise.resolve();

  async function evaluate() {
    const built = await buildDesign({ schematic: sch, sidecar: side, modelDir, intent });
    const checks = await runChecks(built.netlist, suite, { compat, timeoutMs });
    const erc = await checkErc({ input: sch });
    return { netlist: built.netlist, manifest: built.manifest, results: checks.results, erc: { verdict: erc.verdict, count: erc.violation_count ?? null, summary: String(erc.summary ?? '').split('\n')[0] } };
  }
  const init = async () => (state ??= await evaluate());
  const elementOf = (netlist, ref) => parseNetlist(netlist).components.find(c => c.refdes === ref || c.refdes === `X${ref}`) ?? null;
  const verdicts = results => Object.fromEntries(results.map(r => [r.test_id, r]));

  async function judge(edit) {
    const before = await init();
    const why = String(edit.why ?? '').trim();
    const refuse = (code, reason) => { const r = { status: 'rejected', code, reason, edit }; log.push(r); return r; };
    if (!why) return refuse('no_reason', 'say which requirement this edit serves (why)');
    const ref = String(edit.ref ?? '');
    if (!SAFE_NAME.test(ref)) return refuse('bad_ref', 'a part reference');
    const snapshot = { sch: readFileSync(sch, 'utf8'), side: readFileSync(side, 'utf8') };
    let desc;
    try {
      if (edit.kind === 'value') {
        const value = String(edit.value ?? '').trim();
        if (!SAFE_VALUE.test(value)) throw new DesignError('a value is up to 40 plain characters');
        const k = kindOf(ref);
        // Read the value the way the adapter does: the first token is the value, and notes after it
        // (a dielectric, a tolerance: "180pF C0G", "10k 1%") are kept in the field for the BOM.
        if (k) { const head = value.split(/\s+/)[0]; const p = parseKicadValue(head, k); if (!p.ok) throw new DesignError(`"${head}" is not a ${k} value: ${p.why}`); }
        const { text, from } = setSymbolValue(snapshot.sch, ref, value);
        if (from === value) throw new DesignError(`${ref} is already ${value}`);
        writeFileSync(sch, text);
        desc = `${ref} value ${from} -> ${value}`;
      } else if (edit.kind === 'model') {
        const file = String(edit.file ?? ''), name = String(edit.subckt ?? edit.model ?? '');
        if (!modelDir) throw new DesignError('this session has no model directory');
        if (!SAFE_NAME.test(file) || !SAFE_NAME.test(name)) throw new DesignError('file and model name are plain names');
        const path = join(modelDir, file);
        if (!existsSync(path)) throw new DesignError(`no model file ${file} (files: ${readdirSync(modelDir).join(', ')})`);
        const body = readFileSync(path, 'utf8');
        const kind = edit.subckt ? 'subckt' : 'model';
        if (!new RegExp(`^\\s*\\.${kind}\\s+${name.replace(/[.+]/g, '\\$&')}\\b`, 'mi').test(body)) throw new DesignError(`${file} defines no .${kind} ${name}`);
        const sc = JSON.parse(snapshot.side);
        sc.models ??= [];
        const old = sc.models.find(m => m.ref === ref);
        const ports = Array.isArray(edit.ports) ? edit.ports.map(String) : old?.ports;
        if (!ports) throw new DesignError(`${ref} has no model yet: give its ports (symbol pin numbers in subckt order)`);
        const entry = { ref, file, [kind]: name, ports };
        sc.models = [...sc.models.filter(m => m.ref !== ref), entry];
        writeFileSync(side, `${JSON.stringify(sc, null, 2)}\n`);
        desc = `${ref} model ${old ? `${old.file}:${old.subckt ?? old.model}` : 'none'} -> ${file}:${name}`;
      } else throw new DesignError(`unknown edit kind "${edit.kind}" (value, model)`);
    } catch (e) {
      writeFileSync(sch, snapshot.sch); writeFileSync(side, snapshot.side);
      if (e instanceof DesignError) return refuse('refused', e.message);
      throw e;
    }
    let after;
    try { after = await evaluate(); } catch (e) {
      writeFileSync(sch, snapshot.sch); writeFileSync(side, snapshot.side);
      return refuse('does_not_build', `the edited design does not build: ${e.message}`);
    }
    const revert = (code, reason, extra = {}) => { writeFileSync(sch, snapshot.sch); writeFileSync(side, snapshot.side); return refuse(code, reason) && Object.assign(log.at(-1), extra); };
    // 1. It reached the circuit.
    const e0 = elementOf(before.netlist, ref), e1 = elementOf(after.netlist, ref);
    if (e0 && e1 && e0.raw === e1.raw && edit.kind === 'value') return revert('no_effect', `${ref}'s simulated element did not change (${e1.raw.trim()}): the simulation does not use this field`);
    // 2. ERC no worse.
    if (before.erc.count !== null && after.erc.count !== null && after.erc.count > before.erc.count) return revert('erc', `ERC went from ${before.erc.count} to ${after.erc.count} violations: ${after.erc.summary}`);
    // 3 and 4. No regression, at least one fix.
    const B = verdicts(before.results), A = verdicts(after.results);
    const regressed = Object.values(B).filter(r => r.verdict === 'PASS' && A[r.test_id]?.verdict !== 'PASS')
      .map(r => ({ check: r.assertion, was: r.measured, now: A[r.test_id]?.measured ?? null, verdict: A[r.test_id]?.verdict ?? 'missing' }));
    const fixed = Object.values(A).filter(r => r.verdict === 'PASS' && B[r.test_id]?.verdict !== 'PASS')
      .map(r => ({ check: r.assertion, was: B[r.test_id]?.measured ?? null, now: r.measured }));
    const moved = Object.values(A).filter(r => B[r.test_id] && r.measured !== B[r.test_id].measured && typeof r.measured === 'number')
      .map(r => ({ check: r.assertion, was: B[r.test_id].measured, now: r.measured, verdict: r.verdict }));
    if (regressed.length) return revert('regression', `it breaks ${regressed.length} check(s) that passed`, { regressed, moved });
    if (!fixed.length) return revert('fixes_nothing', 'no check that failed now passes', { moved });
    state = after;
    const rec = { status: 'kept', id: `E${log.filter(x => x.status === 'kept').length + 1}`, edit, description: desc, why,
      fixed, moved, erc: after.erc, passing: after.results.filter(r => r.verdict === 'PASS').length, checks: after.results.length };
    log.push(rec);
    return rec;
  }

  return {
    workspace: work,
    log,
    async brief() {
      const s = await init();
      return {
        checks: s.results.map(r => ({ id: r.test_id, check: r.assertion, verdict: r.verdict, measured: r.measured ?? null, limit: r.limit ?? null, ...(r.reason ? { reason: String(r.reason).slice(0, 200) } : {}) })),
        failing: s.results.filter(r => r.verdict !== 'PASS').map(r => r.assertion),
        parts: s.manifest.parts.map(p => ({ ref: p.ref, part: `${p.lib}:${p.part}`, value: p.value_raw, status: p.status, simulated_as: p.detail })),
        circuit: s.netlist.split('\n').filter(l => /^[A-Z]/i.test(l) && !/^\*/.test(l)).slice(0, 80),
        models: modelDir ? readdirSync(modelDir).map(f => ({ file: f, defines: [...readFileSync(join(modelDir, f), 'utf8').matchAll(/^\s*\.(subckt|model)\s+(\S+)/gmi)].map(m => `${m[1].toLowerCase()} ${m[2]}`).slice(0, 20) })) : [],
        erc: s.erc,
        edits: log.map(r => ({ status: r.status, id: r.id ?? null, edit: r.edit, ...(r.code ? { code: r.code } : {}) })),
        rule: 'The checks are fixed. Change the design so failing checks pass, break none, and add no ERC violations. Kinux keeps an edit only then, in a copy; the person applies the diff.',
      };
    },
    propose(edit) {
      const job = queue.then(() => judge(edit));
      queue = job.catch(() => {});
      return job;
    },
    diff() {
      return {
        workspace: work,
        schematic: join(work, 'project', basename(schematic)), sidecar: side,
        diff: [diffText(original.sch, readFileSync(sch, 'utf8'), basename(schematic)), diffText(original.side, readFileSync(side, 'utf8'), basename(sidecar))].filter(Boolean).join('\n\n'),
        kept: log.filter(r => r.status === 'kept').map(r => ({ id: r.id, description: r.description, why: r.why, fixed: r.fixed.map(f => f.check) })),
        design_sha: sha(readFileSync(sch, 'utf8') + readFileSync(side, 'utf8')),
      };
    },
  };
}

// Profile the survivors of an EXISTING `kinux verify` run (R6, for real boards).
//
// profile.mjs re-runs a whole verification and dumps every vector as ASCII. On
// a real board with a vendor model that is hours of solving and gigabytes per
// dump (TI's TLC555 has hundreds of internal nodes, at 10 ns over 4 ms). This
// variant starts from a finished run instead:
//
//  * the mutants are regenerated from the run's own design.cir (generation is
//    deterministic) and matched to the run's survivors by mutant id;
//  * for every Simulation block of the suite, the original and each survivor
//    are solved under that block's analysis AND its `source:` lines, so the
//    comparison happens under the same conditions as the checks;
//  * only top-level design nets and top-level source currents are saved, the
//    things a check can observe; a vendor model's internal nodes are not;
//  * output is ngspice's binary raw format.
//
// BEHAVIOUR, not just the suite's own analyses (--behaviour). A suite that only
// runs operating points cannot see a capacitor at all, so every capacitor
// mutant comes out "identical" under its analyses. That is a coverage gap, not
// an equivalent fault: the board still behaves differently when it powers up.
// Measured on quiet-orbit's DC-only suite: 15 of 36 survivors were capacitor
// mutants identical under DC. So equivalence is also judged under one or more
// behaviour analyses (e.g. a power-up transient from zero with `uic`), driven
// by the first block's sources, and a survivor is identical only if it is
// identical there too.
//
// The comparison itself is compareRuns from profile.mjs, unchanged: a survivor
// whose every saved vector stays within 1e-6 relative of the original, in every
// block, is solver-identical (demonstrably equivalent). Everything else is a
// measured difference, for a person to weigh. Nothing here decides a label.
//
// usage: node spikes/survivors/profile-run.mjs <run-dir> --checks <checks.md>
//          [--behaviour "<analysis>" ...] [--ngspice-compat psa] [--jobs n] [--timeout-ms n] [--out <profile.json>]

import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseNetlist, isGround } from '../../engine/netlist.mjs';
import { generateMutants } from '../../engine/operators.mjs';
import { loadSuite } from '../../engine/cli.mjs';
import { compatArgs } from '../../workers/ngspice/run.mjs';
import { compareRuns } from './profile.mjs';

const execFileAsync = promisify(execFile);
export const IDENTICAL = 1e-6;
const NGSPICE = process.env.KINUX_NGSPICE_BIN || 'ngspice';

/** Parse an ngspice binary raw file (real or complex) into the shape compareRuns expects. */
export function parseBinaryRaw(buf) {
  const marker = buf.indexOf('Binary:\n');
  if (marker < 0) throw new Error('not a binary raw file');
  const header = buf.subarray(0, marker).toString('latin1').split('\n');
  const meta = { plot: '', complex: false, nvars: 0, npts: 0 };
  const vars = [];
  for (let i = 0; i < header.length; i++) {
    const l = header[i];
    if (l.startsWith('Plotname:')) meta.plot = l.slice(9).trim();
    else if (l.startsWith('Flags:')) meta.complex = /complex/i.test(l);
    else if (l.startsWith('No. Variables:')) meta.nvars = Number(l.split(':')[1]);
    else if (l.startsWith('No. Points:')) meta.npts = Number(l.split(':')[1]);
    else if (l.startsWith('Variables:')) {
      for (let k = 0; k < meta.nvars; k++) vars.push(header[++i].trim().split(/\s+/)[1].toLowerCase());
    }
  }
  let off = marker + 'Binary:\n'.length;
  const width = meta.complex ? 16 : 8;
  const need = meta.npts * meta.nvars * width;
  if (buf.length - off < need) throw new Error(`raw file truncated: ${buf.length - off} of ${need} bytes`);
  const cols = vars.map(() => new Array(meta.npts));
  for (let p = 0; p < meta.npts; p++) {
    for (let v = 0; v < meta.nvars; v++) {
      if (meta.complex) { cols[v][p] = [buf.readDoubleLE(off), buf.readDoubleLE(off + 8)]; off += 16; }
      else { cols[v][p] = buf.readDoubleLE(off); off += 8; }
    }
  }
  if (meta.complex) for (let p = 0; p < meta.npts; p++) cols[0][p] = cols[0][p][0];
  const hasScale = /transient|ac analysis|dc transfer/i.test(meta.plot);
  const vectors = new Map();
  vars.forEach((name, idx) => { if (!(hasScale && idx === 0)) vectors.set(name, cols[idx]); });
  return { plot: meta.plot, scale: hasScale ? cols[0] : null, complex: meta.complex, vectors };
}

/** The vectors a check could observe: every top-level net, and the current of every top-level V source. */
export function observableVectors(netlist, block) {
  const nets = netlist.nodes().filter(n => !isGround(n)).map(n => `v(${n.toLowerCase()})`);
  const vsrc = netlist.components.filter(c => c.type === 'V').map(c => `i(${c.refdes.toLowerCase()})`);
  const extra = (block.sources ?? []).map((_, i) => `i(vksrc${i + 1})`);
  return [...new Set([...nets, ...vsrc, ...extra])];
}

/** Build the deck for one block: circuit + the block's own sources + its analysis, saving only `vectors`. */
export function profileDeck(circuitText, block, vectors, rawName) {
  const body = circuitText.split('\n').filter(l => !/^\s*\.end\s*$/i.test(l)).join('\n');
  const sources = (block.sources ?? []).map((s, i) => `Vksrc${i + 1} ${s.port} 0 DC ${Number(s.value.value).toExponential(12)}`);
  return [body, ...sources, '.control', 'set filetype=binary', `save ${vectors.join(' ')}`,
    block.analysis.raw, `write ${rawName} ${vectors.join(' ')}`, '.endc', '.end', ''].join('\n');
}

async function solve(text, block, vectors, dir, tag, { compat, timeoutMs }) {
  const raw = `${tag}.raw`;
  writeFileSync(join(dir, `${tag}.cir`), profileDeck(text, block, vectors, raw));
  try {
    await execFileAsync(NGSPICE, [...compatArgs(compat), '-b', `${tag}.cir`], { cwd: dir, timeout: timeoutMs, maxBuffer: 64 << 20 });
  } catch (e) {
    return { error: `ngspice failed: ${String(e.stderr || e.message).split('\n').find(l => /error|fail|singular|converge/i.test(l)) ?? (e.killed ? 'timeout' : 'see run')}` };
  }
  const p = join(dir, raw);
  if (!existsSync(p)) return { error: 'ngspice produced no data' };
  try { return { run: parseBinaryRaw(readFileSync(p)) }; } finally { rmSync(p, { force: true }); }
}

export async function profileRun(runDir, checksPath, { compat = null, jobs = 1, timeoutMs = 3_600_000, behaviour = [], log = () => {} } = {}) {
  const designText = readFileSync(join(runDir, 'design.cir'), 'utf8');
  const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  const suite = loadSuite(checksPath);
  const suiteBlocks = suite.blocks.filter(b => b.analysis && b.kind !== 'thermal');
  const blocks = [...suiteBlocks, ...behaviour.map(raw => ({ analysis: { raw }, sources: suiteBlocks[0]?.sources ?? [], behaviour: true }))];
  const nl = parseNetlist(designText);
  const mutants = new Map(generateMutants(nl).map(m => [m.mutant_id, m]));
  const survivors = report.mutants.filter(m => m.status === 'survived');
  const missing = survivors.filter(s => !mutants.has(s.mutant_id)).map(s => s.mutant_id);
  if (missing.length) throw new Error(`cannot regenerate ${missing.length} survivor(s) from design.cir: ${missing.slice(0, 3).join(', ')}`);

  const work = mkdtempSync(join(tmpdir(), 'kinux-profrun-'));
  try {
    const base = [];
    for (const [i, b] of blocks.entries()) {
      log(`original, block ${i + 1} (${b.analysis.raw})`);
      base.push(await solve(designText, b, observableVectors(nl, b), work, `base${i}`, { compat, timeoutMs }));
    }
    const out = new Array(survivors.length);
    let next = 0;
    const worker = async () => {
      while (next < survivors.length) {
        const k = next++;
        const s = survivors[k];
        const m = mutants.get(s.mutant_id);
        const profile = [];
        for (const [i, b] of blocks.entries()) {
          const mut = await solve(m.text, b, observableVectors(nl, b), work, `m${k}b${i}`, { compat, timeoutMs });
          const tag = { analysis: b.analysis.raw, ...(b.behaviour ? { behaviour: true } : {}) };
          if (base[i].error || mut.error) profile.push({ ...tag, error: base[i].error ?? mut.error });
          else profile.push({ ...tag, ...compareRuns(base[i].run, mut.run) });
        }
        const usable = profile.filter(p => !p.error);
        const suiteOnly = profile.filter(p => !p.behaviour);
        out[k] = { mutant_id: s.mutant_id, operator: s.operator, target: s.target, description: s.description,
          identical_under_suite_analyses: suiteOnly.length > 0 && suiteOnly.every(p => !p.error && p.max_rel < IDENTICAL),
          identical_in_every_analysis: usable.length === profile.length && usable.length > 0 && usable.every(p => p.max_rel < IDENTICAL),
          max_rel: usable.length ? Math.max(...usable.map(p => p.max_rel)) : null, profile };
        log(`${s.mutant_id}: max_rel ${out[k].max_rel}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, survivors.length)) }, worker));
    return { run_id: report.run_id, design_hash: report.design_hash, identical_threshold_relative: IDENTICAL,
      ngspice_compat: compat, blocks: blocks.map(b => b.analysis.raw), behaviour_analyses: behaviour, base_errors: base.filter(b => b.error).map(b => b.error),
      survivors: out };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const behaviour = args.flatMap((a, i) => (a === '--behaviour' ? [args[i + 1]] : []));
  const runDir = args[0];
  const checks = flag('--checks');
  if (!runDir || !checks) { console.error('usage: profile-run.mjs <run-dir> --checks <md> [--ngspice-compat psa] [--jobs n] [--out file]'); process.exit(2); }
  const result = await profileRun(runDir, checks, { compat: flag('--ngspice-compat', null), jobs: Number(flag('--jobs', 1)),
    timeoutMs: Number(flag('--timeout-ms', 3_600_000)), behaviour, log: m => process.stderr.write(`${m}\n`) });
  const out = flag('--out', join(runDir, 'survivor-profile.json'));
  writeFileSync(out, JSON.stringify(result, null, 1));
  const ident = result.survivors.filter(s => s.identical_in_every_analysis).length;
  const suiteIdent = result.survivors.filter(s => s.identical_under_suite_analyses).length;
  console.log(`${result.survivors.length} survivors: ${suiteIdent} identical under the suite's own analyses, ${ident} identical in every analysis${behaviour.length ? ` including behaviour (${behaviour.join('; ')})` : ''}; written to ${out}`);
}

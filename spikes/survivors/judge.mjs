// A plain-file judging queue for survivors (R6, the plain-file version of R37).
//
//   node spikes/survivors/judge.mjs sheet --profile <survivor-profile.json> [--labels labels.jsonl] --out <sheet.md>
//   node spikes/survivors/judge.mjs sheet --labels spikes/survivors/labels.jsonl --out <sheet.md>
//   node spikes/survivors/judge.mjs tally <sheet.md>
//
// `sheet` writes one entry per survivor: the solver's evidence, any label an
// agent PROPOSED (marked as a proposal), and two blank lines for a person:
//
//   decision:      one of EQUIVALENT, BENIGN, GAP, MODEL, or leave blank
//   reason:        a sentence, required for any decision
//
// `tally` reads the sheet back and reports, for Gate A:
//
//   strict equivalent = solver-identical + person-confirmed EQUIVALENT
//
// "Benign" (the requirements still hold) is reported beside it, never inside
// it (founder's rule, 2026-11-21). A decision without a reason does not count.
// Survivors nobody has judged are counted as undecided, never as equivalent.
// A solver-identical survivor is EQUIVALENT whatever the sheet says: that is
// measured, and a person cannot overrule a measurement into a gap.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from '../../contracts/check-run.mjs';

export const DECISIONS = new Set(['EQUIVALENT', 'BENIGN', 'GAP', 'MODEL']);

function fromProfile(profile, labels) {
  return profile.survivors.map(s => {
    const lab = labels.get(s.mutant_id) ?? labels.get(`${profile.design ?? ''}/${s.mutant_id}`);
    return {
      id: s.mutant_id, description: s.description, target: s.target,
      solver_identical: s.identical_in_every_analysis,
      evidence: s.identical_in_every_analysis
        ? `solver-identical: every observable vector within ${profile.identical_threshold_relative} relative of the original, in every block`
        : `largest relative difference ${s.max_rel === null ? 'not measured (a run failed)' : s.max_rel.toExponential(3)}`
          + (s.profile ?? []).filter(p => p.worst?.length).map(p => `; ${p.analysis}: ${p.worst.slice(0, 2).map(w => `${w.name} ${w.rel === null ? 'missing' : w.rel.toExponential(2)}`).join(', ')}`).join(''),
      proposal: lab && lab.basis !== 'solver' ? lab : null,
    };
  });
}

function fromLabels(rows) {
  return rows.map(r => ({
    id: r.id, description: r.description, target: r.target,
    solver_identical: r.basis === 'solver',
    evidence: r.basis === 'solver' ? String(r.evidence) : (Array.isArray(r.evidence) ? r.evidence[0] : String(r.evidence ?? '')),
    proposal: r.basis === 'solver' ? null : r,
  }));
}

export function renderSheet(items, title) {
  const out = [`# Survivor judging sheet: ${title}`, '',
    'Fill in `decision:` (EQUIVALENT, BENIGN, GAP or MODEL) and `reason:` for each survivor you judge.',
    'EQUIVALENT: no check could ever tell it from the original. BENIGN: it changes behaviour, but every',
    'requirement still holds. GAP: a real fault the checks miss. MODEL: the fault is inside a model or a',
    'bench stand-in, not the design. Leave a survivor blank if you are not sure: blank is counted as undecided.',
    'Agent proposals are shown for reference only and count for nothing until you decide.', ''];
  for (const it of items) {
    out.push(`## ${it.id}`, '', `- what: ${it.description ?? ''}`, `- solver: ${it.evidence}`);
    if (it.solver_identical) out.push('- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**');
    if (it.proposal) out.push(`- proposed (not confirmed): ${it.proposal.label} (${it.proposal.unanimous ? 'unanimous' : 'not unanimous'} among agent reviewers)`);
    out.push('', 'decision: ', 'reason: ', '');
  }
  return out.join('\n');
}

/** Parse a filled sheet. */
export function parseSheet(text) {
  const items = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) { cur = { id: h[1].trim(), solver_identical: false, decision: null, reason: '' }; items.push(cur); continue; }
    if (!cur) continue;
    if (/^- \*\*solver-identical/.test(line)) cur.solver_identical = true;
    const d = /^decision:\s*(\S*)\s*$/i.exec(line);
    if (d) cur.decision = d[1] ? d[1].toUpperCase() : null;
    const r = /^reason:\s*(.*)$/i.exec(line);
    if (r) cur.reason = r[1].trim();
  }
  return items;
}

export function tally(items) {
  const n = items.length;
  const c = { solver_identical: 0, EQUIVALENT: 0, BENIGN: 0, GAP: 0, MODEL: 0, undecided: 0, invalid: [] };
  for (const it of items) {
    if (it.solver_identical) { c.solver_identical += 1; continue; }
    if (!it.decision) { c.undecided += 1; continue; }
    if (!DECISIONS.has(it.decision) || !it.reason) { c.invalid.push(it.id); c.undecided += 1; continue; }
    c[it.decision] += 1;
  }
  const strict = c.solver_identical + c.EQUIVALENT;
  const ci = n ? wilson(strict, n) : null;
  return {
    survivors: n, ...c,
    strict_equivalent: strict,
    strict_fraction: n ? strict / n : null,
    strict_ci: ci,
    with_benign_fraction: n ? (strict + c.BENIGN) / n : null,
    note: c.undecided ? `${c.undecided} survivor(s) undecided: the strict fraction is a floor until they are judged` : 'every survivor judged',
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (cmd === 'sheet') {
    const labelRows = flag('--labels') ? readFileSync(flag('--labels'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const labels = new Map(labelRows.map(r => [r.id, r]));
    let items, title;
    if (flag('--profile')) {
      const profile = JSON.parse(readFileSync(flag('--profile'), 'utf8'));
      items = fromProfile(profile, labels);
      title = profile.run_id ?? flag('--profile');
    } else if (labelRows.length) {
      items = fromLabels(labelRows);
      title = flag('--labels');
    } else { console.error('sheet needs --profile or --labels'); process.exit(2); }
    if (!flag('--out')) { console.error('sheet needs --out'); process.exit(2); }
    writeFileSync(flag('--out'), renderSheet(items, title));
    console.log(`${items.length} survivors, ${items.filter(i => i.solver_identical).length} solver-identical; sheet written to ${flag('--out')}`);
  } else if (cmd === 'tally' && args[0]) {
    console.log(JSON.stringify(tally(parseSheet(readFileSync(args[0], 'utf8'))), null, 1));
  } else {
    console.error('usage: judge.mjs sheet --profile <p.json> [--labels l.jsonl] --out <sheet.md> | judge.mjs sheet --labels <l.jsonl> --out <sheet.md> | judge.mjs tally <sheet.md>');
    process.exit(2);
  }
}

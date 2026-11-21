// Combine solver profiles and reviewers' proposed labels into labels.jsonl and the equivalent fraction.
//
// usage: node spikes/survivors/fraction.mjs <profile.json> <labels-A.json> [<labels-B.json> ...] --out <labels.jsonl>
//
// Rules (so no label is stronger than its evidence):
//  - A survivor identical to the original within the threshold in every analysis is EQUIVALENT,
//    basis "solver". That is measured, not an opinion.
//  - Every other label is a reviewer's PROPOSAL, status "proposed". Consensus = a strict majority of
//    reviewers; otherwise "disputed". Nothing here is confirmed until a person sets status "confirmed".
//  - A fraction is reported three ways: solver-demonstrated only (a floor), plus proposed equivalent/
//    benign/not-a-design-fault by consensus, and the number of disputed survivors left unresolved.
import { readFileSync, writeFileSync } from 'node:fs';
import { wilson } from '../../contracts/check-run.mjs';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
const [profilePath, ...labelPaths] = args;
if (!profilePath || labelPaths.length === 0 || !out) {
  console.error('usage: fraction.mjs <profile.json> <labels...json> --out <labels.jsonl>');
  process.exit(2);
}

const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const reviewers = labelPaths.map(p => new Map(JSON.parse(readFileSync(p, 'utf8')).map(l => [l.id, l])));

const rows = [];
for (const d of profile.designs) for (const s of d.survivors) {
  const key = `${s.design}/${s.id}`;
  const row = { id: key, design: s.design, target: s.target, description: s.description };
  if (s.identical_in_every_analysis) {
    Object.assign(row, { label: 'EQUIVALENT', basis: 'solver', status: 'demonstrated',
      evidence: `identical to the original within ${profile.identical_threshold_relative} relative in every analysis` });
  } else {
    const votes = reviewers.map(r => r.get(key)).filter(Boolean);
    const counts = {};
    for (const v of votes) counts[v.label] = (counts[v.label] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const majority = top && top[1] * 2 > reviewers.length ? top[0] : null;
    Object.assign(row, {
      label: majority ?? 'DISPUTED', basis: 'reviewers', status: 'proposed',
      votes: votes.map(v => ({ label: v.label, confidence: v.confidence })),
      unanimous: votes.length === reviewers.length && votes.every(v => v.label === votes[0].label),
      evidence: votes.map(v => v.evidence),
      missing_checks: votes.map(v => v.missing_check).filter(Boolean),
    });
  }
  rows.push(row);
}
writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const n = rows.length;
const by = l => rows.filter(r => r.label === l).length;
const demonstrated = rows.filter(r => r.status === 'demonstrated').length;
const pct = x => `${(100 * x).toFixed(0)}%`;
const ci = k => { const [lo, hi] = wilson(k, n); return `${pct(lo)}-${pct(hi)}`; };
console.log(`survivors: ${n}`);
for (const l of ['EQUIVALENT', 'BENIGN', 'REAL_GAP', 'NOT_A_DESIGN_FAULT', 'DISPUTED']) console.log(`  ${l.padEnd(20)} ${by(l)}`);
console.log(`solver-demonstrated equivalent (floor): ${demonstrated}/${n} = ${pct(demonstrated / n)} (95% CI ${ci(demonstrated)})`);
const eq = by('EQUIVALENT') + by('BENIGN') + by('NOT_A_DESIGN_FAULT');
console.log(`proposed not-a-gap by consensus (equivalent+benign+not-a-fault): ${eq}/${n} = ${pct(eq / n)}; disputed ${by('DISPUTED')} unresolved`);
const per = {};
for (const r of rows) (per[r.design] ??= []).push(r);
for (const [d, rs] of Object.entries(per)) console.log(`  ${d.padEnd(16)} ${rs.length} survivors, ${rs.filter(r => r.label === 'REAL_GAP').length} real gaps proposed`);

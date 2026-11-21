// Validate the coverage-gap report against the real mutation engine.
//
// For every design+suite pair: compute the structural report (engine/coverage.mjs), then run the
// real mutation engine (ngspice) and compare. Ground truth per part (or net) is what the solver
// did to ALL of that target's mutants:
//   ALL-SURVIVE  at least one mutant survived and none was killed.
//   KILLED-ANY   at least one mutant was killed.
//   Mutants that are NOT_CHECKED, ERROR or EQUIVALENT are neither kills nor survivals; a target
//   with only those is not evaluable and is left out of both numbers.
// precision = of the targets the report calls UNCOVERED (and that are evaluable), the fraction
//             with ALL-SURVIVE.
// recall    = of the ALL-SURVIVE targets, the fraction the report called UNCOVERED.
// Nothing is tuned here; the definition in engine/coverage.mjs is not adjusted to these numbers.
//
// usage: node spikes/coverage/validate.mjs [--fang-dir <dir with rc_filter/ and buck_regulator/>] [--json out.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNetlist } from '../../engine/netlist.mjs';
import { loadSuite } from '../../engine/cli.mjs';
import { runVerification } from '../../engine/runner.mjs';
import { buildReport } from '../../engine/report.mjs';
import { analyseCoverage } from '../../engine/coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = p => (p.startsWith('/') ? p : join(ROOT, p));
const lc = s => String(s).toLowerCase();

export function designs(fangDir) {
  const list = [
    ['divider-rc / weak', 'engine/fixtures/divider-rc.cir', 'engine/fixtures/checks-weak.md'],
    ['divider-rc / thorough', 'engine/fixtures/divider-rc.cir', 'engine/fixtures/checks-thorough.md'],
    ['phase-leg / weak', 'examples/phase-leg-support/phase-leg-support.cir', 'examples/phase-leg-support/checks-weak.md'],
    ['phase-leg / thorough', 'examples/phase-leg-support/phase-leg-support.cir', 'examples/phase-leg-support/checks-thorough.md'],
  ];
  if (fangDir && existsSync(join(fangDir, 'rc_filter/design.cir'))) {
    list.push(['fang rc_filter', join(fangDir, 'rc_filter/design.cir'), 'spikes/fang/rc_filter.checks.md']);
    list.push(['fang buck_regulator', join(fangDir, 'buck_regulator/design.cir'), 'spikes/fang/buck_regulator.checks.md']);
  }
  return list;
}

/** Run coverage + mutation for one pair and compare. */
export async function validatePair(name, netlistPath, checksPath) {
  const text = readFileSync(abs(netlistPath), 'utf8');
  const suite = loadSuite(abs(checksPath));
  const cov = analyseCoverage(parseNetlist(text), suite);
  const outcome = await runVerification({ netlist: text, suite, runId: `cov-${name.replace(/\W+/g, '-')}`, useQueue: false });
  const report = buildReport(outcome, { threshold: 0 });
  // open_connection on a capacitor leaves a node with only a capacitor on it. At op, ngspice 42 then
  // returns a wrong DC solution for the WHOLE circuit (measured: V(vcc) 5 -> 0 with C1 opened; V(gate)
  // 11.99 -> 0 with the unrelated CF opened), so those kills are solver artefacts, not detections of
  // anything the capacitor does. `truth` counts them as kills (strict, as the engine scores them);
  // `truth_adjusted` does not. Both are reported; neither is tuned to look good.
  const opOnly = m => (m.killed_by ?? []).length > 0 && m.killed_by.every(id => {
    const b = suite.blocks[Number(/^[^:]+:b(\d+):/.exec(id)?.[1])];
    return b && ['op', 'dc'].includes(b.analysis?.kind);
  });
  const artefact = (m, type) => m.status === 'killed' && m.operator === 'open_connection' && type === 'C' && opOnly(m);
  const hasSubckt = /^\s*\.subckt\b/im.test(text);
  const truth = (target, type, kind) => {
    const ms = report.mutants.filter(m => lc(m.target) === lc(target));
    const killed = ms.filter(m => m.status === 'killed').length;
    const survived = ms.filter(m => m.status === 'survived').length;
    const killedAdj = ms.filter(m => m.status === 'killed' && !artefact(m, type)).length;
    const survivedAdj = survived + ms.filter(m => artefact(m, type)).length;
    const classify = (k, sv) => (k > 0 ? 'KILLED-ANY' : sv > 0 ? 'ALL-SURVIVE' : ms.length ? 'NOT-EVALUABLE' : 'NO-MUTANTS');
    const row = { mutants: ms.length, killed, survived, other: ms.length - killed - survived,
      truth: classify(killed, survived), truth_adjusted: classify(killedAdj, survivedAdj) };
    // output_short inserts its resistor after the LAST element line of the file; when that line is inside a
    // .subckt body the short lands on a local node of the body and does nothing (measured: node 5 shorted
    // "through 1 mohm" survives a check on V(5)). Net ground truth is unsound for such files.
    if (kind === 'net' && hasSubckt) { row.truth = row.truth_adjusted = ms.length ? 'NOT-EVALUABLE' : 'NO-MUTANTS'; row.note = 'output_short lands inside the .subckt body'; }
    return row;
  };
  const rows = [];
  for (const p of cov.parts) rows.push({ kind: 'part', target: p.refdes, flagged: p.status === 'uncovered', status: p.status, reason_code: p.reason_code ?? null, ...truth(p.refdes, p.type, 'part') });
  for (const n of cov.nets) rows.push({ kind: 'net', target: n.net, flagged: n.status === 'uncovered', status: n.status, reason_code: n.reason_code ?? null, ...truth(n.net, null, 'net') });
  return { name, summary: cov.summary, mutants: report.mutants.length, rows };
}

export function score(rows, key = 'truth') {
  const ev = rows.filter(r => r[key] === 'ALL-SURVIVE' || r[key] === 'KILLED-ANY');
  const flagged = ev.filter(r => r.flagged);
  const allSurvive = ev.filter(r => r[key] === 'ALL-SURVIVE');
  const tp = flagged.filter(r => r[key] === 'ALL-SURVIVE').length;
  return { evaluable: ev.length, flagged: flagged.length, all_survive: allSurvive.length, true_positive: tp,
    precision: flagged.length ? tp / flagged.length : null, recall: allSurvive.length ? tp / allSurvive.length : null,
    wrong_flagged: flagged.filter(r => r[key] === 'KILLED-ANY').map(r => r.target),
    missed: allSurvive.filter(r => !r.flagged).map(r => r.target) };
}

const frac = (a, b) => (b ? `${a}/${b} = ${(100 * a / b).toFixed(0)}%` : `${a}/0 n/a`);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fi = process.argv.indexOf('--fang-dir');
  const ji = process.argv.indexOf('--json');
  const results = [];
  for (const [name, n, c] of designs(fi > 0 ? process.argv[fi + 1] : null)) results.push(await validatePair(name, n, c));
  const pool = { part: [], net: [] };
  for (const r of results) {
    console.log(`\n== ${r.name}  (${r.mutants} mutants)`);
    for (const kind of ['part', 'net']) {
      const rows = r.rows.filter(x => x.kind === kind);
      pool[kind].push(...rows);
      for (const key of ['truth', 'truth_adjusted']) {
        const s = score(rows, key);
        console.log(`  ${kind}s [${key === 'truth' ? 'strict' : 'adjusted'}]: evaluable ${s.evaluable}; flagged ${s.flagged}; all-survive ${s.all_survive}; precision ${frac(s.true_positive, s.flagged)}; recall ${frac(s.true_positive, s.all_survive)}`);
        if (s.wrong_flagged.length) console.log(`      flagged but a mutant was KILLED: ${s.wrong_flagged.join(', ')}`);
        if (s.missed.length) console.log(`      all survive but NOT flagged:     ${s.missed.join(', ')}`);
      }
    }
  }
  console.log('\n== pooled over all pairs (the same design appears under several suites)');
  for (const kind of ['part', 'net']) for (const key of ['truth', 'truth_adjusted']) {
    const s = score(pool[kind], key);
    console.log(`  ${kind}s [${key === 'truth' ? 'strict' : 'adjusted'}]: evaluable ${s.evaluable}; flagged ${s.flagged}; all-survive ${s.all_survive}; precision ${frac(s.true_positive, s.flagged)}; recall ${frac(s.true_positive, s.all_survive)}`);
  }
  if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify(results, null, 1));
}

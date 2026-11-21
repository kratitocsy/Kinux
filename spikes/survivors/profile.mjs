// Profile every survivor of a mutation run: how does the mutated circuit differ from the original?
//
// A survivor is a fault the checks did not catch. Whether that is a gap in the checks, or not
// a fault at all, depends on whether the fault changes anything. So for each survivor this
// re-runs ngspice on the original and the mutated circuit, in every analysis the design's
// checks use, dumps EVERY node voltage and branch current, and measures the largest difference.
//
// This is evidence from the solver, not an opinion. A survivor whose profile is identical to
// the original, in every analysis, within a tight tolerance, is demonstrably equivalent: no
// check could ever tell it apart. Everything else is a measured difference, which a person (or an
// agent proposing a label for a person to confirm) can weigh against what the design must do.
//
// usage: node spikes/survivors/profile.mjs <out.json> [--fang-dir <dir containing rc_filter/ and buck_regulator/>]
//
// Needs ngspice. The fang designs come from spikes/fang/run.sh; they are skipped if absent.

import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNetlist } from '../../engine/netlist.mjs';
import { generateMutants } from '../../engine/operators.mjs';
import { runVerification } from '../../engine/runner.mjs';
import { buildReport } from '../../engine/report.mjs';
import { loadSuite } from '../../engine/cli.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IDENTICAL = 1e-6;   // relative difference below this, everywhere, counts as identical

// ---- ASCII raw file --------------------------------------------------------------------------

/** Parse an ngspice ASCII raw file into { plot, scale, vectors: Map(name -> number[] | [re,im][]) }. */
export function parseRaw(text) {
  const lines = text.split('\n');
  const meta = { complex: false, plot: '' };
  const vars = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('Values:')) {
    const l = lines[i];
    if (l.startsWith('Plotname:')) meta.plot = l.slice(9).trim();
    else if (l.startsWith('Flags:')) meta.complex = /complex/i.test(l);
    else if (l.startsWith('No. Variables:')) meta.nvars = Number(l.split(':')[1]);
    else if (l.startsWith('No. Points:')) meta.npts = Number(l.split(':')[1]);
    else if (l.startsWith('Variables:')) {
      for (let k = 0; k < meta.nvars; k++) { i++; const p = lines[i].trim().split(/\s+/); vars.push(p[1].toLowerCase()); }
    }
    i++;
  }
  i++; // past "Values:"
  const cols = vars.map(() => []);
  const num = tok => (tok.includes(',') ? tok.split(',').map(Number) : Number(tok));
  for (let pt = 0; pt < meta.npts; pt++) {
    for (let v = 0; v < vars.length; v++) {
      while (i < lines.length && lines[i].trim() === '') i++;   // blank line between points
      const toks = (lines[i++] ?? '').trim().split(/\s+/).filter(Boolean);
      cols[v].push(num(toks[toks.length - 1]));   // the first variable of each point has an index in front
    }
  }
  const hasScale = /transient|ac analysis|dc transfer/i.test(meta.plot);
  const vectors = new Map();
  vars.forEach((name, idx) => { if (!(hasScale && idx === 0)) vectors.set(name, cols[idx]); });
  return { plot: meta.plot, scale: hasScale ? cols[0] : null, complex: meta.complex, vectors };
}

const mag = x => (Array.isArray(x) ? Math.hypot(x[0], x[1]) : Math.abs(x));
const sub = (a, b) => (Array.isArray(a) ? [a[0] - b[0], a[1] - b[1]] : a - b);

/** Linear interpolation of y(x) at xq, for real vectors. */
function interp(xs, ys, xq) {
  let lo = 0, hi = xs.length - 1;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[hi]) return ys[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= xq) lo = mid; else hi = mid; }
  const t = (xq - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Largest difference per vector, relative to that vector's own peak in the original (floor 1e-9). */
export function compareRuns(base, mut) {
  const rows = [];
  const onlyInMutant = [];
  for (const [name, mv] of mut.vectors) if (!base.vectors.has(name)) onlyInMutant.push(name);
  for (const [name, bv] of base.vectors) {
    const mv = mut.vectors.get(name);
    if (!mv) { rows.push({ name, rel: null, missing: true }); continue; }
    let aligned = mv;
    const sameGrid = base.scale && mut.scale && base.scale.length === mut.scale.length;
    if (base.scale && !sameGrid && !base.complex && !mv.some(Array.isArray)) {
      aligned = base.scale.map(x => interp(mut.scale, mv, x));   // transient steps differ
    } else if (aligned.length !== bv.length) {
      rows.push({ name, rel: null, mismatched: true }); continue;
    }
    let peak = 0, worst = 0, at = 0;
    for (let k = 0; k < bv.length; k++) {
      peak = Math.max(peak, mag(bv[k]));
      const d = mag(sub(aligned[k], bv[k]));
      if (d > worst) { worst = d; at = k; }
    }
    rows.push({ name, rel: worst / Math.max(peak, 1e-9), abs: worst, baseline_peak: peak,
      at: base.scale ? base.scale[at] : null });
  }
  rows.sort((a, b) => (b.rel ?? 0) - (a.rel ?? 0));
  return { max_rel: rows.find(r => r.rel !== null)?.rel ?? 0, worst: rows.slice(0, 3), compared: rows.length, only_in_mutant: onlyInMutant };
}

// ---- running ngspice ---------------------------------------------------------------------------

function dump(circuitText, analysis, dir, tag) {
  const body = circuitText.split('\n').filter(l => !/^\s*\.end\s*$/i.test(l)).join('\n');
  const out = join(dir, `${tag}.raw`);
  const deck = `${body}\n.control\nset filetype=ascii\n${analysis}\nwrite ${out} all\n.endc\n.end\n`;
  const file = join(dir, `${tag}.cir`);
  writeFileSync(file, deck);
  try {
    execFileSync('ngspice', ['-b', file], { cwd: dir, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { error: `ngspice failed: ${String(e.stderr || e.message).split('\n').find(l => /error|fail|singular|converge/i.test(l)) ?? 'see run'}` };
  }
  if (!existsSync(out)) return { error: 'ngspice produced no data (likely did not converge)' };
  return { run: parseRaw(readFileSync(out, 'utf8')) };
}

const analysesOf = suite => [...new Set(suite.blocks
  .filter(b => b.analysis && b.analysis.kind !== 'thermal' && b.kind !== 'thermal')
  .map(b => b.analysis.raw))];

// ---- designs -------------------------------------------------------------------------------------

function designs(fangDir) {
  const list = [
    { id: 'divider-rc', netlist: 'engine/fixtures/divider-rc.cir', checks: 'engine/fixtures/checks-thorough.md',
      read: ['engine/fixtures/divider-rc.cir', 'engine/fixtures/checks-thorough.md', 'engine/README.md'] },
    { id: 'phase-leg', netlist: 'examples/phase-leg-support/phase-leg-support.cir', checks: 'examples/phase-leg-support/checks-thorough.md',
      read: ['examples/phase-leg-support/README.md', 'examples/phase-leg-support/phase-leg-support.cir', 'examples/phase-leg-support/checks-thorough.md'] },
  ];
  if (fangDir && existsSync(join(fangDir, 'rc_filter/design.cir'))) {
    list.push({ id: 'fang-rc-filter', netlist: join(fangDir, 'rc_filter/design.cir'), checks: 'spikes/fang/rc_filter.checks.md',
      read: [join(fangDir, 'rc_filter/design.cir'), 'spikes/fang/rc_filter.checks.md', 'spikes/fang/README.md'] });
    list.push({ id: 'fang-buck', netlist: join(fangDir, 'buck_regulator/design.cir'), checks: 'spikes/fang/buck_regulator.checks.md',
      inlinedModelElements: ['Vhigh', 'Vlow', 'Shigh', 'Slow', 'Rboot', 'Rfb', 'Ren'],
      read: [join(fangDir, 'buck_regulator/design.cir'), 'spikes/fang/buck_regulator.checks.md', 'spikes/fang/README.md'] });
  }
  return list;
}

const abs = p => (p.startsWith('/') ? p : join(ROOT, p));

async function profileDesign(d, workdir) {
  const netlistText = readFileSync(abs(d.netlist), 'utf8');
  const suite = loadSuite(abs(d.checks));
  const outcome = await runVerification({ netlist: netlistText, suite, runId: `surv-${d.id}`, useQueue: false });
  const report = buildReport(outcome, { threshold: 0 });
  const events = outcome.stream.events;
  const titles = new Map(events.filter(e => e.type === 'test.queued').map(e => [e.data.test_id, e.data.title]));
  const resultsFor = subject => events
    .filter(e => e.type === 'test.result' && e.data.subject === subject)
    .map(e => ({ check: titles.get(e.data.test_id), verdict: e.data.verdict, measured: e.data.measured ?? null, limit: e.data.limit ?? null, units: e.data.units ?? null }));

  const texts = new Map(generateMutants(parseNetlist(netlistText)).map(m => [m.mutant_id, m]));
  const analyses = analysesOf(suite);
  const baseRuns = new Map(analyses.map(a => [a, dump(netlistText, a, workdir, `base-${d.id}-${analyses.indexOf(a)}`)]));
  const survivors = report.mutants.filter(m => m.status === 'survived');

  const out = [];
  for (const s of survivors) {
    const m = texts.get(s.mutant_id);
    const profile = [];
    for (const a of analyses) {
      const base = baseRuns.get(a);
      const mut = dump(m.text, a, workdir, `m-${d.id}-${out.length}-${analyses.indexOf(a)}`);
      if (base.error || mut.error) { profile.push({ analysis: a, error: base.error ?? mut.error }); continue; }
      profile.push({ analysis: a, ...compareRuns(base.run, mut.run) });
    }
    const usable = profile.filter(p => !p.error);
    const model = d.inlinedModelElements?.includes(s.target) ?? false;
    out.push({
      id: s.mutant_id, design: d.id, operator: m.operator, target: s.target, description: s.description,
      inside_inlined_model: model,
      identical_in_every_analysis: usable.length > 0 && usable.every(p => p.max_rel < IDENTICAL),
      profile,
      check_results_on_mutant: resultsFor(s.mutant_id),
      check_results_on_baseline: resultsFor('baseline'),
    });
  }
  return {
    id: d.id, read_first: d.read, analyses,
    mutants: report.mutants.length, killed: report.mutants.filter(m => m.status === 'killed').length,
    survivors: out,
  };
}

// Only when run directly: profile-run.mjs imports compareRuns from this file.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
const outPath = process.argv[2];
if (!outPath) { console.error('usage: profile.mjs <out.json> [--fang-dir <dir>]'); process.exit(2); }
const fi = process.argv.indexOf('--fang-dir');
const fangDir = fi > 0 ? process.argv[fi + 1] : null;

const workdir = mkdtempSync(join(tmpdir(), 'kinux-surv-'));
try {
  const result = { identical_threshold_relative: IDENTICAL, designs: [] };
  for (const d of designs(fangDir)) {
    process.stderr.write(`profiling ${d.id} ...\n`);
    result.designs.push(await profileDesign(d, workdir));
  }
  writeFileSync(outPath, JSON.stringify(result, null, 1));
  for (const d of result.designs) {
    const ident = d.survivors.filter(s => s.identical_in_every_analysis).length;
    console.log(`${d.id.padEnd(16)} ${String(d.mutants).padStart(3)} mutants, ${String(d.killed).padStart(3)} killed, ${String(d.survivors.length).padStart(3)} survivors, ${ident} solver-identical`);
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
}

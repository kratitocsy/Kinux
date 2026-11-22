// The power each part of a design dissipates, measured by ngspice.
//
// Every non-ground terminal of every top-level element is given a 0 V sense
// source in series (`Vkp<j>_<k> net kp<j>_<k> 0`, the element now connects to
// kp<j>_<k>). A 0 V source changes nothing electrically; its current is the
// current INTO that terminal. The power a part absorbs is then
//
//     P = Σ_k V(terminal k) · I(into terminal k)
//
// which holds for any element, a vendor subcircuit included, with no model of
// what is inside. Sources come out negative (they deliver power). For a
// transient block the instantaneous power is averaged over the window by
// trapezoidal integration of ngspice's own samples; for `op` it is the single
// operating point. The block's analysis and `source:` lines are the suite's, so
// the power is the power under the conditions the checks were written for.
//
// Nothing here estimates anything: a part with no element (a connector, a
// mounting hole) has no power, and a part a stand-in element represents (an
// MCU modelled as a current sink) is attributed only when the caller names
// the stand-in, and is reported as such.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist, isGround } from './netlist.mjs';
import { runNetlist } from '../workers/ngspice/run.mjs';
import { parseWrdata } from './waveforms.mjs';

/** The reference a top-level element stands for: XD1 -> D1 (the adapter's X prefix), R4 -> R4. */
export function refOf(refdes) {
  return /^X[A-Z]/i.test(refdes) && refdes.length > 2 ? refdes.slice(1) : refdes;
}

/** The sense-source deck: every non-ground terminal of every element gets a 0 V source. */
export function senseDeck(netlistText, block) {
  const nl = parseNetlist(netlistText);
  const elements = [];
  const extra = [];
  let j = 0;
  for (const line of nl.lines) {
    if (line.kind !== 'element' || line.type === 'K') continue;
    j += 1;
    const terms = [];
    line.nodes = line.nodes.map((n, k) => {
      if (isGround(n)) return n;
      const node = `kp${j}_${k}`;
      extra.push(`Vkp${j}_${k} ${n} ${node} 0`);
      terms.push(node);
      return node;
    });
    line.dirty = true;
    elements.push({ refdes: line.refdes, terms });
  }
  const body = nl.toString().split('\n').filter(l => !/^\s*\.end\s*$/i.test(l));
  const sources = (block.sources ?? []).map((s, i) => `Vksrc${i + 1} ${s.port} 0 DC ${Number(s.value.value).toExponential(12)}`);
  const lets = [], names = [];
  elements.forEach((e, i) => {
    if (!e.terms.length) return;
    const name = `pw${i + 1}`;
    lets.push(`let ${name} = ${e.terms.map(t => `v(${t})*i(v${t})`).join(' + ')}`);
    names.push({ name, refdes: e.refdes });
  });
  // Power the block's own sources deliver: -value · I(source), I flowing into its + node.
  if (block.sources?.length) {
    lets.push(`let pwsrc = ${block.sources.map((s, i) => `-(${Number(s.value.value).toExponential(12)})*i(vksrc${i + 1})`).join(' + ')}`);
    names.push({ name: 'pwsrc', refdes: null });
  }
  const analysis = [block.analysis.kind, ...(block.analysis.params ?? [])].join(' ');
  const deck = [...body, ...extra, ...sources, '.control', 'set wr_singlescale', 'set wr_vecnames', analysis,
    ...lets, `wrdata pw.dat ${names.map(n => n.name).join(' ')}`, '.endc', '.end', ''].join('\n');
  return { deck, names };
}

/** Time average of y(t) over [from, to] by the trapezoidal rule on the solver's own samples. */
export function trapezoidAverage(t, y, from = t[0], to = t[t.length - 1]) {
  let area = 0, span = 0;
  for (let i = 1; i < t.length; i++) {
    const a = Math.max(t[i - 1], from), b = Math.min(t[i], to);
    if (b <= a) continue;
    const lerp = x => y[i - 1] + (y[i] - y[i - 1]) * (x - t[i - 1]) / (t[i] - t[i - 1]);
    area += (b - a) * (lerp(a) + lerp(b)) / 2;
    span += b - a;
  }
  return span > 0 ? area / span : NaN;
}

/**
 * Measure every element's dissipated power under one suite block.
 * @param {string} netlistText  the design netlist (no analysis of its own)
 * @param {object} block        a parsed suite block (analysis op or tran, sources)
 * @param {{compat?, timeoutMs?, averageFrom?: number, standIns?: Record<string,{ref:string, note:string}>}} opts
 * @returns {Promise<{ok:boolean, reason_code?, reason?, analysis?, parts?: Record<string,{watts:number, elements:string[], note?:string}>, sources_w?: number}>}
 */
export async function measurePartPower(netlistText, block, { compat = null, timeoutMs = 120_000, averageFrom, standIns = {} } = {}) {
  const kind = block.analysis?.kind;
  if (kind !== 'op' && kind !== 'tran') {
    return { ok: false, reason_code: 'out_of_scope', reason: `power is measured from an op or tran block; this block is ${kind ?? 'without an analysis'}` };
  }
  const { deck, names } = senseDeck(netlistText, block);
  const run = await runNetlist(deck, { compat, timeoutMs, allowWriteFiles: ['pw.dat'], keepDir: true });
  try {
    if (!run.ok || !run.run_dir) return { ok: false, reason_code: run.reason_code ?? 'tool_error', reason: run.reason ?? 'ngspice failed' };
    let text;
    try { text = readFileSync(join(run.run_dir, 'pw.dat'), 'utf8'); } catch { return { ok: false, reason_code: 'tool_error', reason: 'ngspice wrote no power data' }; }
    const { cols } = parseWrdata(text);
    if (cols.length !== names.length + 1 || !cols[0].length) return { ok: false, reason_code: 'tool_error', reason: 'power data has the wrong shape' };
    const parts = {};
    let sources = 0, delivered = 0;
    names.forEach(({ refdes }, i) => {
      const y = cols[i + 1];
      const watts = kind === 'op' ? y[0] : trapezoidAverage(cols[0], y, averageFrom ?? cols[0][0]);
      if (refdes === null) { delivered = watts; return; }
      if (/^[VI]/i.test(refdes) && !standIns[refdes]) { sources += watts; return; }
      const stand = standIns[refdes];
      const ref = stand ? stand.ref : refOf(refdes);
      const p = parts[ref] ?? (parts[ref] = { watts: 0, elements: [] });
      p.watts += watts;
      p.elements.push(refdes);
      if (stand) p.note = stand.note;
    });
    return {
      ok: true, analysis: block.analysis.raw ?? kind, parts,
      // Energy balance, from the solver's own numbers: what the block's sources
      // deliver equals what every element absorbs (design sources count negative).
      balance: { delivered_w: delivered, absorbed_w: Object.values(parts).reduce((a, p) => a + p.watts, 0) + sources, design_sources_w: sources },
      averaged: kind === 'tran' ? { from: averageFrom ?? cols[0][0], to: cols[0][cols[0].length - 1], samples: cols[0].length } : null,
      netlist_sha256: run.netlist_sha256, tool_versions: run.tool_versions,
    };
  } finally {
    if (run.run_dir) rmSync(run.run_dir, { recursive: true, force: true });
  }
}

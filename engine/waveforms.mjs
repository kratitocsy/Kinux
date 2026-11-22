// Waveforms of the original design, for people to look at.
//
// For each transient block of a suite, the baseline is solved once more with
// the block's own analysis and `source:` lines, recording the voltage of every
// net the block names (its scope and its V()/f() targets). The samples are
// ngspice's own (`wrdata`), decimated for the viewer by keeping each bucket's
// minimum and maximum in time order, so no peak or edge is lost. Nothing here
// judges anything: verdicts come from the checks, this only draws what the
// solver computed.
//
// The deck goes through the same sanitizer as every other; the only file it may
// write is `wave.dat` in its own run directory.

import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runNetlist } from '../workers/ngspice/run.mjs';
import { isGround } from './netlist.mjs';

const SAFE_NET = /^[A-Za-z0-9_./:+-]+$/;
export const MAX_NETS = 8;
const sha256 = buf => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/** Nets a block looks at, in order: scope first, then V() and f() targets. */
export function blockNets(block) {
  const out = [];
  const add = n => { if (n && SAFE_NET.test(n) && !isGround(n) && !out.includes(n)) out.push(n); };
  if (block.scope?.kind === 'nets') block.scope.nets.forEach(add);
  for (const a of block.assertions ?? []) {
    const m = a.measurable;
    if (m && (m.kind === 'voltage' || m.kind === 'frequency')) add(m.target);
  }
  return out.slice(0, MAX_NETS);
}

/** Parse `wrdata` output written with wr_singlescale and wr_vecnames. */
export function parseWrdata(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const names = lines[0].trim().split(/\s+/);
  const cols = names.map(() => []);
  for (const l of lines.slice(1)) {
    const v = l.trim().split(/\s+/).map(Number);
    if (v.length !== names.length || v.some(x => !Number.isFinite(x))) continue;
    v.forEach((x, i) => cols[i].push(x));
  }
  return { names, cols };
}

/** Keep each bucket's min and max (in time order) so edges and peaks survive. */
export function decimate(time, series, maxPoints) {
  const n = time.length;
  if (n <= maxPoints) return { time, series, decimated: false };
  const buckets = Math.floor(maxPoints / 2);
  const idx = [];
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * n) / buckets), hi = Math.max(lo + 1, Math.floor(((b + 1) * n) / buckets));
    // Pick the extremes of the first series; keep the same instants for every series.
    let iMin = lo, iMax = lo;
    for (let i = lo; i < hi; i++) {
      if (series[0][i] < series[0][iMin]) iMin = i;
      if (series[0][i] > series[0][iMax]) iMax = i;
    }
    idx.push(...(iMin <= iMax ? [iMin, iMax] : [iMax, iMin]));
  }
  const keep = [...new Set(idx)];
  return { time: keep.map(i => time[i]), series: series.map(s => keep.map(i => s[i])), decimated: true };
}

/**
 * Capture the baseline's waveforms for every transient block.
 * @returns {Promise<Array<{artifact_id, test_id, kind, file, mime, sha256, bytes}>>}
 */
export async function captureWaveforms(netlist, suite, { compat = null, timeoutMs, outDir, maxPoints = 4000 } = {}) {
  const out = [];
  mkdirSync(outDir, { recursive: true });
  const body = netlist.split('\n').filter(l => !/^\s*\.end\s*$/i.test(l)).join('\n');
  for (const block of suite.blocks) {
    if (block.kind === 'thermal' || block.analysis?.kind !== 'tran') continue;
    const nets = blockNets(block);
    if (!nets.length) continue;
    const sources = (block.sources ?? []).map((s, i) => `Vksrc${i + 1} ${s.port} 0 DC ${Number(s.value.value).toExponential(12)}`);
    const vectors = nets.map(n => `v(${n})`).join(' ');
    const deck = [body, ...sources, '.control', 'set wr_singlescale', 'set wr_vecnames',
      [block.analysis.kind, ...(block.analysis.params ?? [])].join(' '), `wrdata wave.dat ${vectors}`, '.endc', '.end', ''].join('\n');
    const run = await runNetlist(deck, { compat, timeoutMs, allowWriteFiles: ['wave.dat'], keepDir: true });
    try {
      if (!run.ok || !run.run_dir) continue;
      let text;
      try { text = readFileSync(join(run.run_dir, 'wave.dat'), 'utf8'); } catch { continue; }
      const { cols } = parseWrdata(text);
      if (cols.length !== nets.length + 1 || cols[0].length < 2) continue;
      const d = decimate(cols[0], cols.slice(1), maxPoints);
      const payload = {
        solver: 'ngspice', ngspice_compat: compat, analysis: block.analysis.raw, block: block.prefix,
        points: cols[0].length, decimated: d.decimated, x: { name: 'time', unit: 's', values: d.time },
        series: nets.map((n, i) => ({ name: `V(${n})`, unit: 'V', values: d.series[i] })),
      };
      const file = `wave-${block.prefix}.json`;
      const buf = Buffer.from(`${JSON.stringify(payload)}\n`);
      writeFileSync(join(outDir, file), buf);
      const first = block.assertions?.[0];
      out.push({ artifact_id: `wave-${block.prefix}`, test_id: first ? `${suite.id}:${block.prefix}:${first.line}:k1` : `${suite.id}:${block.prefix}`,
        kind: 'waveform', file, mime: 'application/json', sha256: sha256(buf), bytes: buf.length });
    } finally {
      if (run.run_dir) rmSync(run.run_dir, { recursive: true, force: true });
    }
  }
  return out;
}

// Waveforms of the original design (engine/waveforms.mjs), from real ngspice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decimate, parseWrdata, blockNets } from '../engine/waveforms.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('decimation keeps every bucket\'s extremes, so a narrow spike survives', () => {
  const n = 10_000;
  const time = Array.from({ length: n }, (_, i) => i);
  const v = time.map(i => (i === 7_777 ? 9 : 0));
  const d = decimate(time, [v], 200);
  assert.ok(d.decimated && d.time.length <= 200);
  assert.ok(d.series[0].includes(9), 'the one-sample spike is kept');
  assert.ok(d.time.every((t, i) => i === 0 || t > d.time[i - 1]), 'time stays increasing');
});

test('wrdata columns parse, and a block\'s nets come from its scope and its V()/f() targets, ground excluded', () => {
  const { names, cols } = parseWrdata(' time  v(n)  v(m)\n 0 0 0\n 1e-9 5 2.5\n');
  assert.deepEqual(names, ['time', 'v(n)', 'v(m)']);
  assert.deepEqual(cols[1], [0, 5]);
  const block = { scope: { kind: 'nets', nets: ['out', '0'] }, assertions: [
    { measurable: { kind: 'voltage', target: 'mid' } }, { measurable: { kind: 'current', target: 'R1' } }] };
  assert.deepEqual(blockNets(block), ['out', 'mid']);
});

test('kinux verify --waveforms records the baseline\'s transient, announced as a waveform artifact (real ngspice)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-wave-'));
  writeFileSync(join(dir, 'd.cir'), '* rc\nV1 in 0 PULSE(0 5 0 1n 1n 50u 100u)\nR1 in out 1k\nC1 out 0 10n\n.end\n');
  writeFileSync(join(dir, 'c.md'), '## Simulation\n\nscope: nets [in, out]\nanalysis: tran 100n 300u\nassert: V(out) at 45u between 4.9 and 5.1\n');
  execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(dir, 'd.cir'), '--checks', join(dir, 'c.md'),
    '--out', join(dir, 'o'), '--threshold', '0', '--quiet', '--waveforms', '--operators', 'value_drift_10'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const events = readFileSync(join(dir, 'o', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const art = events.filter(e => e.type === 'test.artifact' && e.data.kind === 'waveform');
  assert.equal(art.length, 1);
  assert.ok(events.some(e => e.type === 'test.queued' && e.data.test_id === art[0].data.test_id), 'attached to the block\'s real check');
  const p = JSON.parse(readFileSync(join(dir, 'o', art[0].data.uri), 'utf8'));
  assert.deepEqual(p.series.map(s => s.name), ['V(in)', 'V(out)']);
  assert.equal(p.solver, 'ngspice');
  // RC = 10 us: by 45 us (4.5 tau) V(out) is within 1.2% of 5 V, by hand: 5 * (1 - e^-4.5) = 4.944.
  const i = p.x.values.findIndex(t => t >= 45e-6);
  assert.ok(Math.abs(p.series[1].values[i] - 4.944) < 0.05, `V(out) at 45 us = ${p.series[1].values[i]}`);
});

// Running mutants in parallel (--jobs) must not change any result (K29).
//
// The engine collects every mutant's outcome and only then emits events, in
// the mutants' original order, so concurrency can only change wall time. This
// test holds it to that: the same design and suite with --jobs 1 and --jobs 4,
// through the queue and directly, give identical reports and event streams
// once wall-clock fields (timestamps, durations) are removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, 'engine', 'fixtures', 'divider-rc.cir');
const CHECKS = join(ROOT, 'engine', 'fixtures', 'checks-thorough.md');

const CLOCK = new Set(['ts', 'duration_ms', 'ms', 'elapsed_ms', 'started_at', 'finished_at', 'dispatch', 'queue_path']);
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !CLOCK.has(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

function run(extra) {
  const out = mkdtempSync(join(tmpdir(), 'kinux-jobs-'));
  execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', DESIGN, '--checks', CHECKS, '--out', out,
    '--threshold', '0', '--quiet', '--run-id', 'run-jobs', ...extra], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const events = readFileSync(join(out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { report: scrub(report), events: scrub(events) };
}

test('--jobs 4 gives the same report and event stream as --jobs 1, through the queue and directly', () => {
  const one = run(['--jobs', '1']);
  assert.ok(one.report.mutants.length > 20, 'enough mutants to interleave');
  for (const extra of [['--jobs', '4'], ['--jobs', '4', '--no-queue']]) {
    const four = run(extra);
    assert.deepEqual(four.report.score, one.report.score, extra.join(' '));
    assert.deepEqual(four.report.mutants, one.report.mutants, extra.join(' '));
    assert.deepEqual(four.events, one.events, `${extra.join(' ')}: event stream differs`);
  }
});

test('--jobs must be a whole number from 1 to 64', () => {
  for (const bad of ['0', '65', '2.5', 'many']) {
    let code = 0;
    try { run(['--jobs', bad]); } catch (e) { code = e.status; }
    assert.equal(code, 2, bad);
  }
});

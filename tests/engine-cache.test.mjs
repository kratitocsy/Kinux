// Making runs cheaper without changing what they say (K29).
//
//  --cache        reuses ngspice results keyed by the exact deck, the ngspice
//                 version and the compat mode. ngspice is byte-reproducible,
//                 so a reused result is the result. Check bounds are judged
//                 after the run, so changing a bound re-scores from the cache.
//  --stop-on-kill runs a mutant's blocks cheapest first and stops once it is
//                 killed. Every mutant's status must be what it is without it.
//
// All runs use the real ngspice on engine/fixtures/divider-rc.cir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCacheable } from '../engine/runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, 'engine', 'fixtures', 'divider-rc.cir');
const THOROUGH = join(ROOT, 'engine', 'fixtures', 'checks-thorough.md');

const CLOCK = new Set(['ts', 'duration_ms', 'ms', 'elapsed_ms', 'dispatch', 'cached']);
const scrub = v => Array.isArray(v) ? v.map(scrub)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !CLOCK.has(k)).map(([k, x]) => [k, scrub(x)])) : v;

function run(checks, extra) {
  const out = mkdtempSync(join(tmpdir(), 'kinux-cache-'));
  const stdout = execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', DESIGN, '--checks', checks, '--out', out,
    '--threshold', '0', '--run-id', 'run-cache', ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
  const m = /cache: (\d+) simulation\(s\) reused, (\d+) run/.exec(stdout);
  return { report: JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')),
    events: readFileSync(join(out, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    hits: m ? Number(m[1]) : null, misses: m ? Number(m[2]) : null };
}

test('a cached run says exactly what an uncached run says, and a second run reuses every simulation', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'kinux-cachedb-')), 'cache.sqlite');
  const plain = run(THOROUGH, []);
  const first = run(THOROUGH, ['--cache', db]);
  const second = run(THOROUGH, ['--cache', db]);
  assert.equal(first.hits, 0);
  assert.ok(first.misses > 30, `first run simulated ${first.misses} decks`);
  assert.equal(second.misses, 0, 'nothing is simulated twice');
  assert.equal(second.hits, first.misses);
  for (const r of [first, second]) {
    assert.deepEqual(scrub(r.report.mutants), scrub(plain.report.mutants));
    assert.deepEqual(scrub(r.report.score), scrub(plain.report.score));
    assert.deepEqual(scrub(r.events), scrub(plain.events));
  }
});

test('changing a bound re-scores from the cache, and gives what a fresh run gives', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'kinux-cachedb-')), 'cache.sqlite');
  run(THOROUGH, ['--cache', db]);
  const text = readFileSync(THOROUGH, 'utf8');
  const tight = text.replace(/assert: V\(out\) between (\S+) and (\S+)/, 'assert: V(out) between 2.358 and 2.359');
  assert.notEqual(tight, text, 'the fixture has a V(out) band to tighten');
  const file = join(mkdtempSync(join(tmpdir(), 'kinux-tight-')), 'tight.md');
  writeFileSync(file, tight);
  const cached = run(file, ['--cache', db]);
  const fresh = run(file, []);
  assert.equal(cached.misses, 0, 'only the bound changed: every simulation is reused');
  assert.deepEqual(scrub(cached.report.mutants), scrub(fresh.report.mutants));
  assert.deepEqual(scrub(cached.report.score), scrub(fresh.report.score));
});

test('only reproducible results are cached: never a timeout, a missing binary or a config error', () => {
  assert.equal(isCacheable({ ok: true }), true);
  assert.equal(isCacheable({ ok: false, reason_code: 'sim_nonconverge' }), true);
  assert.equal(isCacheable({ ok: false, timed_out: true, reason_code: 'timeout' }), false);
  assert.equal(isCacheable({ ok: false, spawn_error: 'ENOENT', reason_code: 'tool_missing' }), false);
  assert.equal(isCacheable({ ok: false, stage: 'config', reason_code: 'tool_error' }), false);
  assert.equal(isCacheable({ ok: false, reason_code: 'tool_error' }), false);
});

test('--stop-on-kill leaves every mutant status unchanged and runs fewer simulations', () => {
  const dbA = join(mkdtempSync(join(tmpdir(), 'kinux-cachedb-')), 'a.sqlite');
  const dbB = join(mkdtempSync(join(tmpdir(), 'kinux-cachedb-')), 'b.sqlite');
  const full = run(THOROUGH, ['--cache', dbA]);
  const fast = run(THOROUGH, ['--cache', dbB, '--stop-on-kill']);
  const status = r => Object.fromEntries(r.report.mutants.map(m => [m.mutant_id, m.status]));
  assert.deepEqual(status(fast), status(full));
  assert.deepEqual(fast.report.score, full.report.score);
  assert.ok(fast.misses < full.misses, `simulations: ${fast.misses} with stop-on-kill, ${full.misses} without`);
  const skipped = fast.report.mutants.filter(m => m.skipped_blocks?.length);
  assert.ok(skipped.length > 0);
  for (const m of skipped) assert.equal(m.status, 'killed', `${m.mutant_id} skipped blocks but is ${m.status}`);
  for (const m of fast.report.mutants.filter(m => m.status === 'survived')) assert.equal(m.skipped_blocks, undefined);
});

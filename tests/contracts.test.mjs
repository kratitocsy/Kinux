import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRun, validateEvent, validateManifest, validateReceipt, computeScore, wilson } from '../contracts/check-run.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../contracts/fixtures');
const events = () => readFileSync(join(FIX, 'valid-run.events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const manifest = () => JSON.parse(readFileSync(join(FIX, 'valid-run.manifest.json'), 'utf8'));
const hash = c => 'sha256:' + c.repeat(64);
const find = (evs, type, pred = () => true) => evs.find(e => e.type === type && pred(e.data));

test('the sample run is consistent and entirely synthetic', () => {
  const evs = events();
  assert.deepEqual(checkRun(evs), []);
  assert.ok(evs.every(e => e.provenance === 'synthetic'), 'every event of the sample must say synthetic');
});

test('the sample manifest is valid and labels its artifacts', () => {
  const m = manifest();
  const r = validateManifest(m);
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(m.artifacts.every(a => a.provenance));
  assert.equal(validateManifest({ ...m, artifacts: [{ ...m.artifacts[0], provenance: undefined }] }).ok, false);
});

test('score: killed / (killed + survived), the rest reported separately', () => {
  const s = computeScore(['killed', 'killed', 'survived', 'not_checked', 'equivalent']);
  assert.equal(s.score, 2 / 3);
  assert.equal(s.checkable_fraction, 3 / 5);
  assert.equal(s.not_checked, 1);
  assert.equal(s.equivalent, 1);
  assert.equal(computeScore(['not_checked']).score, null);
  assert.deepEqual(wilson(0, 0), [null, null]);
  const [lo, hi] = wilson(2, 3);
  assert.ok(lo > 0.2 && lo < 0.3 && hi > 0.85 && hi < 0.95, `${lo} ${hi}`);
});

test('schema rejects a malformed envelope', () => {
  const base = events()[0];
  for (const [name, bad] of [
    ['missing actor', { ...base, actor: undefined }],
    ['unknown actor kind', { ...base, actor: { kind: 'wizard', id: 'x' } }],
    ['unknown type', { ...base, type: 'run.exploded' }],
    ['missing provenance', { ...base, provenance: undefined }],
    ['bad provenance', { ...base, provenance: 'imagined' }],
    ['bad design hash', { ...base, design_hash: 'abc' }],
    ['extra property', { ...base, surprise: 1 }],
    ['wrong version', { ...base, v: 2 }],
  ]) {
    assert.equal(validateEvent(JSON.parse(JSON.stringify(bad))).ok, false, name);
  }
});

test('schema: NOT_CHECKED and ERROR need a reason code, and verdicts are a closed set', () => {
  const evs = events();
  const nc = find(evs, 'test.result', d => d.verdict === 'NOT_CHECKED');
  assert.ok(validateEvent(nc).ok);
  assert.equal(validateEvent({ ...nc, data: { ...nc.data, reason_code: undefined } }).ok, false);
  assert.equal(validateEvent({ ...nc, data: { ...nc.data, verdict: 'MAYBE' } }).ok, false);
  assert.equal(validateEvent({ ...nc, data: { ...nc.data, verdict: 'ERROR', reason_code: undefined } }).ok, false);
});

test('schema: killed_by must be non-empty exactly when a mutant is killed', () => {
  const evs = events();
  const killed = find(evs, 'mutation.result', d => d.status === 'killed');
  const survived = find(evs, 'mutation.result', d => d.status === 'survived');
  assert.equal(validateEvent({ ...killed, data: { ...killed.data, killed_by: [] } }).ok, false);
  assert.equal(validateEvent({ ...survived, data: { ...survived.data, killed_by: ['T1'] } }).ok, false);
});

test('rule: seq must start at 0 and have no gaps', () => {
  const evs = events();
  evs.splice(3, 1);
  assert.ok(checkRun(evs).some(p => p.includes('seq')));
});

test('rule: a result for a test that was never queued is rejected', () => {
  const evs = events();
  const r = find(evs, 'test.result');
  r.data.test_id = 'T99';
  assert.ok(checkRun(evs).some(p => p.includes('never queued')));
});

test('rule: NOT_CHECKED can never kill a mutant', () => {
  const evs = events();
  const m4 = find(evs, 'mutation.result', d => d.mutant_id === 'M4');
  m4.data.status = 'killed';
  m4.data.killed_by = ['T1']; // T1 on M4 is NOT_CHECKED
  assert.ok(checkRun(evs).some(p => p.includes('M4') && p.includes('not FAIL')));
});

test('rule: a mutant is not killed if the baseline did not pass', () => {
  const evs = events();
  find(evs, 'test.result', d => d.subject === 'baseline' && d.test_id === 'T1').data.verdict = 'FAIL';
  assert.ok(checkRun(evs).some(p => p.includes('baseline verdict is FAIL')));
});

test('rule: a survivor must not have a failing check', () => {
  const evs = events();
  find(evs, 'test.result', d => d.subject === 'M2' && d.test_id === 'T1').data.verdict = 'FAIL';
  assert.ok(checkRun(evs).some(p => p.includes('M2') && p.includes('survived')));
});

test('rule: run.score must match the mutation results', () => {
  const evs = events();
  find(evs, 'run.score').data.score = 1;
  assert.ok(checkRun(evs).some(p => p.includes('run.score.score')));
});

test('rule: a completed run with mutants needs a run.score', () => {
  const evs = events().filter(e => e.type !== 'run.score').map((e, i) => ({ ...e, seq: i }));
  assert.ok(checkRun(evs).some(p => p.includes('run.score')));
});

test('rule: run.finished must be last, and one run.started first', () => {
  const evs = events();
  const fin = evs.pop();
  evs.splice(5, 0, fin);
  const reseq = evs.map((e, i) => ({ ...e, seq: i }));
  assert.ok(checkRun(reseq).some(p => p.includes('run.finished must be the last')));
});

test('a receipt needs the disclaimer and valid hashes', () => {
  const score = find(events(), 'run.score').data;
  const receipt = {
    v: 1, receipt_id: hash('a'), created: '2026-11-19T10:00:00Z', engine_version: '0.0.1',
    inputs: [{ path: 'divider.cir', sha256: hash('b') }], tool_versions: { ngspice: '44' }, seeds: { monte_carlo: 1 },
    check_set_sha: hash('c'), operator_set_sha: hash('d'), result_hashes: [hash('e')], score,
    disclaimer: 'Pre-check linter. Not a certification and not a substitute for engineering sign-off.',
  };
  const ok = validateReceipt(receipt);
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(validateReceipt({ ...receipt, disclaimer: 'Certified safe.' }).ok, false);
  assert.equal(validateReceipt({ ...receipt, receipt_id: 'nope' }).ok, false);
});

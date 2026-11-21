// K19: one reason code, one verdict, in every worker.
//
// `mesh_failed`, `mesh_not_converged` and `unsupported_contact` mean "we could
// not check", and the plan says such a check is NOT_CHECKED. ngspice's verdict
// module used to turn them into ERROR while the FEA and motion workers made
// them NOT_CHECKED, so the same failure changed the mutant's status
// (error vs not_checked) depending on which worker saw it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCheck } from '../workers/ngspice/verdict.mjs';
import { notRun as feaNotRun } from '../workers/fea/study.mjs';
import { notRun as motionNotRun } from '../workers/motion/verify.mjs';
import { NOT_CHECKED_CODES, ERROR_CODES, verdictForReason } from '../workers/reason-codes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, '..', 'contracts', 'event.schema.json'), 'utf8'));
const CODES = SCHEMA.$defs.reasonCode.enum;

const ngspiceNotRun = code => evaluateCheck({ ok: false, reason_code: code, reason: 'x' }, { test_id: 't', min: 0, max: 1 });
const WORKERS = {
  ngspice: ngspiceNotRun,
  fea: code => feaNotRun('t', 'baseline', code, 'x'),
  motion: code => motionNotRun('t', 'baseline', code, 'x'),
};

const MESH_AND_CONTACT = ['mesh_failed', 'mesh_not_converged', 'unsupported_contact'];

test('every reason code in the contract is classified, exactly once', () => {
  const unclassified = CODES.filter(c => !NOT_CHECKED_CODES.has(c) && !ERROR_CODES.has(c) && c !== 'tool_missing');
  assert.deepEqual(unclassified, [], 'a code in event.schema.json that reason-codes.mjs does not classify');
  for (const c of NOT_CHECKED_CODES) assert.ok(!ERROR_CODES.has(c), `${c} is in both sets`);
  for (const c of [...NOT_CHECKED_CODES, ...ERROR_CODES]) assert.ok(CODES.includes(c), `${c} is not a contract reason code`);
});

for (const code of MESH_AND_CONTACT) {
  test(`${code} is NOT_CHECKED in every worker, never ERROR (K19)`, () => {
    const got = Object.fromEntries(Object.entries(WORKERS).map(([w, f]) => [w, f(code).verdict]));
    assert.deepEqual(got, { ngspice: 'NOT_CHECKED', fea: 'NOT_CHECKED', motion: 'NOT_CHECKED' });
  });
}

test('timeout and tool_error are ERROR in every worker', () => {
  for (const code of ['timeout', 'tool_error']) {
    for (const [w, f] of Object.entries(WORKERS)) assert.equal(f(code).verdict, 'ERROR', `${w} ${code}`);
  }
});

test('no reason code can ever produce a PASS or a FAIL, and every result carries its code', () => {
  for (const code of CODES) {
    for (const [w, f] of Object.entries(WORKERS)) {
      const r = f(code);
      assert.ok(r.verdict === 'NOT_CHECKED' || r.verdict === 'ERROR', `${w} ${code} -> ${r.verdict}`);
      assert.equal(r.reason_code, code);
    }
  }
});

test('an unknown reason code fails closed to ERROR, and the result is still not a pass', () => {
  assert.equal(verdictForReason('some_future_code'), 'ERROR');
  const r = ngspiceNotRun('some_future_code');
  assert.equal(r.verdict, 'ERROR');
});

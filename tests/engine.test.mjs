// The mutation engine, against the real ngspice binary.
//
// Nothing here is stubbed: every verdict in these tests came out of
// /usr/bin/ngspice. The fixture is engine/fixtures/divider-rc.cir -- a 5V rail,
// a 10k/10k divider, a 10u bypass capacitor, a 1k/1u output filter and a 100k
// load -- with the two check suites in the same directory.
//
// The headline test is `a weak check suite scores lower than a thorough one`.
// It is the premise of the product: if a thin suite and a careful suite scored
// the same, the number would be measuring nothing.

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkRun, computeScore, wilson, validateEvent } from '../contracts/check-run.mjs';
import { parseNetlist } from '../engine/netlist.mjs';
import { generateMutants, OPERATORS } from '../engine/operators.mjs';
import { runVerification, BaselineGate, classifyMutant, EventStream, sha256 } from '../engine/runner.mjs';
import { buildReport, finishRun, renderMarkdown, scoreLine, computeCap, gatingConditions, GATING_CAP, effectiveScore } from '../engine/report.mjs';
import { classifyEquivalence, normaliseNetlist, belowResolution, sameNetlist, findDuplicates } from '../engine/equivalence.mjs';
import { loadSuite, parseArgs, main } from '../engine/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'engine', 'fixtures');
const DESIGN = readFileSync(join(FIX, 'divider-rc.cir'), 'utf8');

const WEAK = loadSuite(join(FIX, 'checks-weak.md'));
const THOROUGH = loadSuite(join(FIX, 'checks-thorough.md'));

/** One run per suite, shared by every test that needs it. */
const runs = {};
async function verify(name, suite, extra = {}) {
  const key = name + JSON.stringify(extra);
  if (!runs[key]) {
    runs[key] = (async () => {
      const outcome = await runVerification({ netlist: DESIGN, suite, runId: `test-${name}`, project: 'divider-rc', ...extra });
      const report = buildReport(outcome, { threshold: 0.7 });
      const events = finishRun(outcome, report);
      return { outcome, report, events };
    })();
  }
  return runs[key];
}

before(async () => {
  // Fail loudly and early if the binary is missing: a skipped simulator would
  // make every assertion below meaningless.
  const { ngspiceVersion } = await import('../workers/ngspice/run.mjs');
  const v = await ngspiceVersion();
  assert.equal(v.available, true, 'these tests require the real ngspice binary');
});

/* ========================================================================== */
/* The headline                                                               */
/* ========================================================================== */

describe('the premise', () => {
  test('a deliberately weak check suite scores LOWER than a thorough one on the same design', async () => {
    const weak = await verify('weak', WEAK);
    const thorough = await verify('thorough', THOROUGH);

    // Same design, same mutants: only the checks differ.
    assert.equal(weak.outcome.design_hash, thorough.outcome.design_hash);
    assert.deepEqual(
      weak.outcome.mutants.map(m => m.mutant_id),
      thorough.outcome.mutants.map(m => m.mutant_id),
    );
    assert.ok(weak.outcome.mutants.length >= 25, `expected a real mutant population, got ${weak.outcome.mutants.length}`);

    // Both suites pass on the unmutated design, so neither is handicapped by a
    // baseline failure: the difference is coverage and nothing else.
    assert.deepEqual(weak.outcome.baseline.blocked, []);
    assert.deepEqual(thorough.outcome.baseline.blocked, []);
    assert.equal(weak.report.cap, null);
    assert.equal(thorough.report.cap, null);

    // The weak suite is one loose check on the rail; the thorough one pins six.
    assert.equal(weak.outcome.baseline.killable.length, 1);
    assert.equal(thorough.outcome.baseline.killable.length, 6);

    const w = weak.report.score, t = thorough.report.score;
    assert.ok(t.score > w.score, `thorough ${t.score} should beat weak ${w.score}`);
    // Not a hair's breadth: the gap is large, and the two Wilson intervals do
    // not overlap, so the ranking is not an artefact of a small sample.
    assert.ok(t.score - w.score > 0.4, `the gap should be decisive, was ${(t.score - w.score).toFixed(3)}`);
    assert.ok(t.ci_low > w.ci_high, `intervals overlap: weak up to ${w.ci_high}, thorough from ${t.ci_low}`);

    // And the reason is visible, not just the number: every mutant the weak
    // suite missed and the thorough one caught is a check the weak suite lacks.
    const weakStatus = new Map(weak.outcome.mutants.map(m => [m.mutant_id, m.status]));
    const gained = thorough.outcome.mutants.filter(m => m.status === 'killed' && weakStatus.get(m.mutant_id) === 'survived');
    assert.ok(gained.length > 10, `expected the thorough suite to catch many more, got ${gained.length}`);
    for (const m of gained) assert.ok(m.killed_by.length > 0);
  });

  test('the weak suite only catches faults that move the one node it looks at', async () => {
    const weak = await verify('weak', WEAK);
    const killed = weak.outcome.mutants.filter(m => m.status === 'killed');
    assert.ok(killed.length > 0, 'a suite that catches nothing at all would be a different bug');
    // Its only check is V(vcc); a divider ratio error cannot be caught by it.
    const divider = weak.outcome.mutants.find(m => m.operator === 'divider_ratio_off');
    assert.equal(divider.status, 'survived');
    const thorough = await verify('thorough', THOROUGH);
    assert.equal(thorough.outcome.mutants.find(m => m.operator === 'divider_ratio_off').status, 'killed');
  });
});

/* ========================================================================== */
/* Baseline gating                                                            */
/* ========================================================================== */

describe('baseline gating (contract rule 2)', () => {
  // `V(vcc) between 9 and 10` is false on this design: the rail is 5V. The
  // baseline FAILS it, so it is a broken check, and a broken check must not be
  // allowed to kill anything.
  const BROKEN = {
    id: 'checks',
    blocks: [{
      analysis: 'op',
      assertions: [
        'V(vcc) between 9 and 10',       // baseline FAIL -- can never kill
        'V(mid) between 2.36 and 2.405', // baseline PASS -- can kill
      ],
    }],
  };

  test('a check the baseline fails kills nothing, and is named as a gating defect', async () => {
    const { outcome, report } = await verify('broken', BROKEN);
    const failing = outcome.baseline.results.find(r => r.assertion.includes('9 and 10'));
    assert.equal(failing.verdict, 'FAIL');
    assert.ok(!outcome.baseline.killable.includes(failing.test_id));
    assert.deepEqual(report.baseline.not_passed.map(r => r.test_id), [failing.test_id]);

    // Structurally impossible, not merely absent: the gate does not hold it.
    assert.equal(outcome.gate.canKill(failing.test_id), false);
    for (const m of outcome.mutants) {
      assert.ok(!m.killed_by.includes(failing.test_id), `${m.mutant_id} was credited to a check the baseline failed`);
    }

    // Mutants DID fail that check -- it is the gate, not a lack of failures,
    // that stops it counting.
    const sawFailures = outcome.mutants.some(m => m.results.some(r => r.test_id === failing.test_id && r.verdict === 'FAIL'));
    assert.equal(sawFailures, true, 'the broken check should still have failed on some mutants');

    assert.ok(report.cap, 'a baseline that does not pass a check is a gating defect');
    assert.deepEqual(report.cap.gates.map(g => g.code), ['baseline_check_not_passing']);
  });

  test('a check the baseline could not run (NOT_CHECKED) also kills nothing', async () => {
    const suite = {
      id: 'checks',
      blocks: [{ analysis: 'op', assertions: ['V(nosuchnet) between 1 and 2', 'V(mid) between 2.36 and 2.405'] }],
    };
    const { outcome, report } = await verify('unresolvable', suite);
    const nc = outcome.baseline.results.find(r => r.assertion.includes('nosuchnet'));
    assert.equal(nc.verdict, 'NOT_CHECKED');
    assert.ok(nc.reason_code, 'NOT_CHECKED needs a reason_code');
    assert.equal(outcome.gate.canKill(nc.test_id), false);
    for (const m of outcome.mutants) assert.ok(!m.killed_by.includes(nc.test_id));
    assert.ok(report.cap.gates.some(g => g.code === 'baseline_check_not_passing'));
  });

  test('classifyMutant refuses to classify without a baseline gate', () => {
    assert.throws(() => classifyMutant(null, [{ test_id: 't', verdict: 'FAIL' }]), /BaselineGate/);
    assert.throws(() => classifyMutant({ killedBy: () => ['t'] }, []), /BaselineGate/);
  });
});

/* ========================================================================== */
/* NOT_CHECKED and ERROR never kill                                           */
/* ========================================================================== */

describe('NOT_CHECKED and ERROR (contract rules 1-4)', () => {
  const gate = new BaselineGate([
    { test_id: 'a', verdict: 'PASS' },
    { test_id: 'b', verdict: 'PASS' },
    { test_id: 'c', verdict: 'FAIL' },
  ]);

  test('a NOT_CHECKED verdict is not a kill', () => {
    const v = classifyMutant(gate, [
      { test_id: 'a', verdict: 'NOT_CHECKED', reason_code: 'sim_nonconverge' },
      { test_id: 'b', verdict: 'PASS' },
    ]);
    assert.equal(v.status, 'survived');
    assert.deepEqual(v.killed_by, []);
    assert.deepEqual(v.inconclusive, ['a']);
  });

  test('an ERROR verdict is not a kill', () => {
    const v = classifyMutant(gate, [
      { test_id: 'a', verdict: 'ERROR', reason_code: 'timeout' },
      { test_id: 'b', verdict: 'PASS' },
    ]);
    assert.equal(v.status, 'survived');
    assert.deepEqual(v.killed_by, []);
  });

  test('every eligible check inconclusive means not_checked or error, never survived', () => {
    const nc = classifyMutant(gate, [
      { test_id: 'a', verdict: 'NOT_CHECKED', reason_code: 'sim_nonconverge' },
      { test_id: 'b', verdict: 'NOT_CHECKED', reason_code: 'no_model' },
    ]);
    assert.equal(nc.status, 'not_checked');
    const er = classifyMutant(gate, [
      { test_id: 'a', verdict: 'ERROR', reason_code: 'timeout' },
      { test_id: 'b', verdict: 'NOT_CHECKED', reason_code: 'no_model' },
    ]);
    assert.equal(er.status, 'error');
    for (const v of [nc, er]) assert.deepEqual(v.killed_by, []);
  });

  test('a FAIL on a check the baseline did not pass is not a kill', () => {
    const v = classifyMutant(gate, [{ test_id: 'c', verdict: 'FAIL' }, { test_id: 'b', verdict: 'PASS' }]);
    assert.equal(v.status, 'survived');
    assert.deepEqual(v.killed_by, []);
  });

  test('no results at all is not_checked, never survived', () => {
    const v = classifyMutant(gate, []);
    assert.equal(v.status, 'not_checked');
  });

  test('killed_by is non-empty exactly when the status is killed (rule 3)', async () => {
    for (const name of ['weak', 'thorough']) {
      const { outcome } = await verify(name, name === 'weak' ? WEAK : THOROUGH);
      for (const m of outcome.mutants) {
        assert.equal(m.killed_by.length > 0, m.status === 'killed', `${m.mutant_id} (${m.status}) killed_by=${m.killed_by.length}`);
      }
    }
  });

  test('a survivor has no check that failed on it (rule 4)', async () => {
    const { outcome } = await verify('thorough', THOROUGH);
    for (const m of outcome.mutants.filter(m => m.status === 'survived')) {
      for (const r of m.results) {
        if (r.verdict !== 'FAIL') continue;
        assert.equal(outcome.gate.canKill(r.test_id), false, `${m.mutant_id} survived although ${r.test_id} failed on it`);
      }
    }
  });
});

/* ========================================================================== */
/* Score arithmetic and the interval                                          */
/* ========================================================================== */

describe('score', () => {
  test('matches computeScore over the mutant statuses, exactly', async () => {
    const { outcome, report } = await verify('thorough', THOROUGH);
    const want = computeScore(outcome.mutants.map(m => m.status));
    assert.deepEqual(report.score, want);
    assert.equal(report.score.score, want.killed / (want.killed + want.survived));
    assert.equal(report.score.total, outcome.mutants.length);
    // NOT_CHECKED, ERROR and equivalent are outside the fraction (rule 6).
    assert.equal(report.score.killed + report.score.survived + report.score.not_checked + report.score.errors + report.score.equivalent, report.score.total);
  });

  test('the Wilson interval travels with the score everywhere it appears', async () => {
    const { report, events } = await verify('thorough', THOROUGH);
    const [lo, hi] = wilson(report.score.killed, report.score.killed + report.score.survived);
    assert.equal(report.score.ci_low, lo);
    assert.equal(report.score.ci_high, hi);

    // The printed form carries all four facts of contract rule 7.
    const line = scoreLine(report.score);
    assert.match(line, /95% CI/);
    assert.match(line, /killed \//);
    assert.match(line, /mutants/);
    assert.match(line, /checkable fraction/);

    // Markdown shows the score only through that line.
    const md = renderMarkdown(report);
    assert.ok(md.includes(`**Mutation score: ${line}**`));

    // And the event carries them too.
    const score = events.find(e => e.type === 'run.score');
    for (const k of ['killed', 'survived', 'total', 'checkable_fraction', 'score', 'ci_low', 'ci_high']) {
      assert.ok(k in score.data, `run.score is missing ${k}`);
    }
  });

  test('a score cannot be printed without its interval, fraction and count', () => {
    const full = computeScore(['killed', 'survived']);
    for (const key of ['score', 'ci_low', 'ci_high', 'total', 'checkable_fraction']) {
      const broken = { ...full };
      delete broken[key];
      assert.throws(() => scoreLine(broken), new RegExp(key));
    }
  });

  test('nothing checkable gives a null score, not a zero', () => {
    const s = computeScore(['not_checked', 'equivalent', 'error']);
    assert.equal(s.score, null);
    assert.equal(s.ci_low, null);
    assert.match(scoreLine(s), /not checkable/);
  });
});

/* ========================================================================== */
/* The cap                                                                    */
/* ========================================================================== */

describe('the cap', () => {
  test('is null when there is no gating defect, and the raw score stands', async () => {
    const { report } = await verify('thorough', THOROUGH);
    assert.equal(report.cap, null);
    assert.equal(report.effective_score, report.score.score);
    assert.match(renderMarkdown(report), /No gating condition/);
  });

  test('applies, is named, and never rewrites the raw score', async () => {
    const { report, events } = await verify('broken', {
      id: 'checks',
      blocks: [{ analysis: 'op', assertions: ['V(vcc) between 9 and 10', 'V(mid) between 2.36 and 2.405'] }],
    });
    assert.ok(report.cap, 'the baseline failed a check: that is a gating defect');
    assert.equal(report.cap.applied_at, GATING_CAP);
    assert.match(report.cap.reason, /baseline did not pass/);
    assert.match(report.cap.reason, /cap this run at/);
    assert.deepEqual(report.cap.gates.map(g => g.code), ['baseline_check_not_passing']);

    // The raw score is untouched; the cap lives in its own field.
    const raw = computeScore(report.mutants.map(m => m.status));
    assert.deepEqual(report.score, raw);
    assert.equal(report.effective_score, Math.min(raw.score, GATING_CAP));
    assert.equal(report.cap.bites, raw.score > GATING_CAP);

    // Visible in the Markdown and in the stream, named, with both numbers.
    const md = renderMarkdown(report);
    assert.match(md, /CAP APPLIED/);
    assert.match(md, /baseline_check_not_passing/);
    assert.match(md, /The raw score is never silently rewritten/);
    const score = events.find(e => e.type === 'run.score');
    assert.equal(score.data.cap.applied_at, GATING_CAP);
    assert.match(events.at(-1).data.summary, /CAPPED/);
  });

  test('an ERROR during the run is a gating condition', () => {
    const gates = gatingConditions({ baselineBlocked: [], statuses: ['killed', 'survived', 'error'], score: 0.5 });
    assert.deepEqual(gates.map(g => g.code), ['run_error']);
    const cap = computeCap(0.95, gates);
    assert.equal(cap.applied_at, GATING_CAP);
    assert.equal(cap.bites, true);
    assert.equal(effectiveScore(0.95, cap), GATING_CAP);
    assert.match(cap.reason, /ERROR/);
  });

  test('a null score with a gating condition stays null, and the cap still names it', () => {
    const gates = gatingConditions({ baselineBlocked: [], statuses: ['not_checked'], score: null });
    assert.ok(gates.some(g => g.code === 'nothing_checkable'));
    const cap = computeCap(null, gates);
    assert.equal(effectiveScore(null, cap), null);
    assert.equal(cap.bites, true);
  });

  test('a high score can never coexist with a gating defect', () => {
    for (const score of [0.9, 0.99, 1]) {
      const cap = computeCap(score, gatingConditions({ baselineBlocked: [{ test_id: 'x', verdict: 'FAIL' }], statuses: [], score }));
      assert.ok(effectiveScore(score, cap) <= GATING_CAP);
    }
  });
});

/* ========================================================================== */
/* Equivalence                                                                */
/* ========================================================================== */

describe('equivalence detection is conservative', () => {
  test('no genuinely different mutant of the real design is marked equivalent', () => {
    const mutants = generateMutants(parseNetlist(DESIGN), { operators: OPERATORS });
    assert.ok(mutants.length >= 25);
    for (const m of mutants) {
      const e = classifyEquivalence(DESIGN, m);
      assert.equal(e.equivalent, false, `${m.mutant_id} was wrongly called equivalent: ${e.detail}`);
      assert.ok(!sameNetlist(DESIGN, m.text), `${m.mutant_id} should differ from the design`);
    }
  });

  test('a 5% value drift is NOT equivalent -- it is a real fault', () => {
    const mutants = generateMutants(parseNetlist(DESIGN), { operators: OPERATORS.filter(o => o.id === 'value_drift_5') });
    assert.ok(mutants.length > 0);
    for (const m of mutants) assert.equal(classifyEquivalence(DESIGN, m).equivalent, false);
  });

  test('a mutant that removes a capacitor no DC check can see is a SURVIVOR, not an equivalent', async () => {
    const { outcome } = await verify('thorough', THOROUGH);
    const bypass = outcome.mutants.find(m => m.operator === 'bypass_cap_removed');
    assert.equal(bypass.status, 'survived', 'an uncatchable-by-these-checks fault must count against the score');
    assert.equal(bypass.equivalence.equivalent, false);
  });

  test('a textually identical mutant is equivalent', () => {
    const same = { mutant_id: 'M-noop', text: `* Title\n\n  r1 VCC MID 10K  ; a comment\nR2 mid 0 10k\n*comment\n.end\n`, patch: { meta: {} } };
    const base = `* Title\nR2 mid 0 10k\nR1 vcc mid 10k\n.end\n`;
    const e = classifyEquivalence(base, same);
    assert.equal(e.equivalent, true);
    assert.equal(e.reason, 'textually_identical');
  });

  test('a value change below the simulator resolution is equivalent; one above it is not', () => {
    const mk = (from, to) => ({ mutant_id: 'M', text: `* t\nR1 a b ${to}\n.end\n`, patch: { meta: { kind: 'value_change', from, to } } });
    const base = '* t\nR1 a b 10000\n.end\n';
    assert.equal(classifyEquivalence(base, mk(10000, 10000.000001)).equivalent, true);
    assert.equal(classifyEquivalence(base, mk(10000, 10000.1)).equivalent, false);
    assert.equal(belowResolution(1e-6, 1e-6 * (1 + 1e-9)), true);
    assert.equal(belowResolution(1e-6, 1.05e-6), false);
    // A topology change is never equivalent, whatever its metadata says.
    assert.equal(classifyEquivalence(base, { text: '* t\nR1 a c 10000\n.end\n', patch: { meta: { kind: 'topology' } } }).equivalent, false);
  });

  test('normalisation ignores comments, case, indentation and line order only', () => {
    assert.equal(normaliseNetlist('* T\nR1 a b 1k\nR2 b 0 2k\n'), normaliseNetlist('* t\n\n  R2 B 0 2K\n*note\nr1 A B 1k ; x\n'));
    assert.notEqual(normaliseNetlist('* T\nR1 a b 1k\n'), normaliseNetlist('* T\nR1 a b 1.0001k\n'));
    assert.notEqual(normaliseNetlist('* T\nR1 a b 1k\n'), normaliseNetlist('* T\nR1 a 0 1k\n'));
  });

  test('equivalent mutants are reported and never counted in the score', () => {
    const gate = new BaselineGate([{ test_id: 'a', verdict: 'PASS' }]);
    const v = classifyMutant(gate, [], { equivalence: { equivalent: true, reason: 'textually_identical', detail: 'same netlist' } });
    assert.equal(v.status, 'equivalent');
    assert.deepEqual(v.killed_by, []);
    const s = computeScore(['killed', 'survived', 'equivalent']);
    assert.equal(s.score, 0.5);
    assert.equal(s.equivalent, 1);
  });

  test('duplicate mutants are reported but still scored', () => {
    const dups = findDuplicates([
      { mutant_id: 'A', text: '* t\nR1 a b 1k\n' },
      { mutant_id: 'B', text: '* t\n  r1 A B 1K\n' },
      { mutant_id: 'C', text: '* t\nR1 a b 2k\n' },
    ]);
    assert.deepEqual(dups, [{ mutant_id: 'B', same_as: 'A' }]);
  });
});

/* ========================================================================== */
/* The event stream                                                           */
/* ========================================================================== */

describe('events.jsonl', () => {
  test('passes checkRun with zero problems', async () => {
    for (const [name, suite] of [['weak', WEAK], ['thorough', THOROUGH]]) {
      const { events } = await verify(name, suite);
      assert.deepEqual(checkRun(events), [], `${name} run has contract problems`);
    }
  });

  test('a run whose baseline failed a check is still a contract-clean stream', async () => {
    const { events } = await verify('broken', {
      id: 'checks',
      blocks: [{ analysis: 'op', assertions: ['V(vcc) between 9 and 10', 'V(mid) between 2.36 and 2.405'] }],
    });
    assert.deepEqual(checkRun(events), []);
  });

  test('ordering, seq and envelope (rules 5 and 8)', async () => {
    const { events, outcome } = await verify('thorough', THOROUGH);
    assert.equal(events[0].type, 'run.started');
    assert.equal(events.at(-1).type, 'run.finished');
    events.forEach((e, i) => {
      assert.equal(e.seq, i, `gap at ${i}`);
      assert.equal(e.design_hash, outcome.design_hash);
      assert.equal(e.provenance, 'real');
      assert.equal(e.run_id, 'test-thorough');
      assert.equal(validateEvent(e).ok, true, JSON.stringify(validateEvent(e).errors));
    });
    const scores = events.filter(e => e.type === 'run.score');
    assert.equal(scores.length, 1);
    const lastMutation = Math.max(...events.filter(e => e.type === 'mutation.result').map(e => e.seq));
    assert.ok(scores[0].seq > lastMutation, 'run.score must come after the last mutation.result');

    // Every result's test was queued first, and the baseline's results come
    // before any mutant's.
    const queued = new Set();
    let seenMutantResult = false;
    for (const e of events) {
      if (e.type === 'test.queued') queued.add(e.data.test_id);
      if (e.type === 'test.result') {
        assert.ok(queued.has(e.data.test_id), `${e.data.test_id} was never queued`);
        if (e.data.subject !== 'baseline') seenMutantResult = true;
        else assert.equal(seenMutantResult, false, 'a baseline result came after a mutant result');
      }
    }
    assert.equal(events.filter(e => e.type === 'mutation.result').length, outcome.mutants.length);
    // The design hash is the hash of the design, not of anything else.
    assert.equal(outcome.design_hash, sha256(DESIGN));
  });

  test('the stream refuses to emit an event the contract rejects', () => {
    const s = new EventStream({ runId: 'r', designHash: sha256('x') });
    assert.throws(() => s.emit('run.started', { project: 'p' }), /invalid run.started/);
    assert.throws(() => new EventStream({ runId: 'r', designHash: 'nope' }), /design_hash/);
    assert.throws(() => new EventStream({ designHash: sha256('x') }), /run_id/);
  });

  test('equivalent mutants produce no test.result at all', () => {
    // Nothing is simulated for them, so they cannot acquire a verdict (rule 6).
    const s = new EventStream({ runId: 'r', designHash: sha256('x') });
    s.emit('mutation.result', { mutant_id: 'M', target: 'R1', description: 'd', layer: 'netlist', origin: 'fixed', status: 'equivalent', killed_by: [] });
    assert.equal(s.events.filter(e => e.type === 'test.result').length, 0);
  });
});

/* ========================================================================== */
/* Dispatch and CLI                                                           */
/* ========================================================================== */

describe('dispatch', () => {
  test('the job queue and the direct loop agree exactly', async () => {
    const viaQueue = await verify('weak', WEAK);
    const direct = await verify('weak-direct', WEAK, { useQueue: false });
    assert.deepEqual(
      direct.outcome.mutants.map(m => [m.mutant_id, m.status, m.killed_by.join(',')]),
      viaQueue.outcome.mutants.map(m => [m.mutant_id, m.status, m.killed_by.join(',')]),
    );
    assert.deepEqual(direct.report.score, viaQueue.report.score);
    assert.ok(viaQueue.outcome.mutants.every(m => m.dispatch === 'queue'));
    assert.ok(direct.outcome.mutants.every(m => m.dispatch === 'direct'));
  });
});

describe('the CLI', () => {
  test('parses its arguments and loads a Markdown suite', () => {
    const a = parseArgs(['verify', 'd.cir', '--checks', 'c.md', '--threshold', '0.5', '--no-queue', '--json']);
    assert.equal(a.command, 'verify');
    assert.equal(a.design, 'd.cir');
    assert.equal(a.threshold, 0.5);
    assert.equal(a.useQueue, false);
    assert.equal(a.json, true);
    assert.throws(() => parseArgs(['verify', 'd', '--threshold', '7']), /between 0 and 1/);
    assert.throws(() => parseArgs(['--nope']), /unknown option/);
    assert.equal(THOROUGH.blocks.length, 2);
    assert.equal(THOROUGH.blocks[0].analysis.kind, 'op');
    assert.equal(WEAK.blocks[0].assertions.length, 1);
  });

  test('verify writes the three files and exits non-zero below the threshold', async () => {
    const dir = join(process.env.TMPDIR ?? '/tmp', `kinux-cli-${process.pid}`);
    const lines = [];
    const code = await main(
      ['verify', join(FIX, 'divider-rc.cir'), '--checks', join(FIX, 'checks-weak.md'), '--out', dir, '--threshold', '0.7', '--run-id', 'cli-test'],
      { log: s => lines.push(s), error: s => lines.push(s) },
    );
    assert.equal(code, 1, 'the weak suite is below 70%, so the exit code must be non-zero');
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.run_id, 'cli-test');
    assert.equal(report.passed_threshold, false);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    assert.match(md, /Mutation score: /);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(checkRun(events), []);
    assert.ok(lines.some(l => l.includes('contract-clean')));

    const code2 = await main(
      ['verify', join(FIX, 'divider-rc.cir'), '--checks', join(FIX, 'checks-thorough.md'), '--out', dir, '--threshold', '0.7', '--run-id', 'cli-test-2', '--quiet'],
      { log: () => {}, error: () => {} },
    );
    assert.equal(code2, 0, 'the thorough suite is above 70%, so it must exit 0');
  });

  test('a usage error exits 2 and says so', async () => {
    const out = [];
    assert.equal(await main(['verify'], { log: s => out.push(s), error: s => out.push(s) }), 2);
    assert.equal(await main(['frobnicate'], { log: () => {}, error: () => {} }), 2);
    assert.equal(await main(['--help'], { log: () => {}, error: () => {} }), 0);
  });
});

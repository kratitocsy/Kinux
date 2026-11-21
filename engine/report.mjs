// The report: JSON, Markdown, and the cap.
//
// THE SCORE NEVER TRAVELS ALONE. `computeScore` (frozen, in contracts/) returns
// the score together with its checkable fraction, its mutant count and its
// Wilson 95% interval, and this module never splits them up: every renderer
// goes through `scoreLine()`, which refuses to print a score without all four.
// A bare "62%" is the number this whole tool exists to not produce.
//
// THE CAP. Modelled on Copperhead's `src/kicad/score.ts`, where any
// error-severity finding caps the composite below the known-good floor "so a
// high score can never coexist with a gating defect", and the cap is reported as
// a structured object naming the value and the reason. Kinux needs the same
// shape for the rule in docs/PLAN.md section 6: "its verdict can't be better
// than its weakest NOT_CHECKED".
//
// Two deliberate differences from Copperhead:
//
//  * The capped number is a SEPARATE field. `score` stays exactly what
//    `computeScore` produced, because contracts/check-run.mjs recomputes it from
//    the events and a run whose `run.score` disagreed with its results would be
//    an inconsistent run. The cap lands on `effective_score`, and `cap` names
//    the ceiling and why it applied.
//  * `cap` is non-null whenever a gating condition exists, even if the raw score
//    is already below the ceiling. Copperhead only records the cap when it bites.
//    Here the gating defect itself is the thing a reader must see, so it is
//    always named; `cap.bites` says whether it changed the number.

import { computeScore, wilson } from '../contracts/check-run.mjs';

/** The ceiling a gating defect imposes, on the 0..1 scale of the score. */
export const GATING_CAP = 0.4;
/** The score a suite is expected to reach before anyone calls it good. */
export const KNOWN_GOOD_FLOOR = 0.85;

const pct = x => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fixed = x => (x === null || x === undefined ? 'null' : x.toFixed(4));

/**
 * The one place a score is turned into text. Every field of the contract's
 * rule 7 is present or the function throws: score, checkable fraction, mutant
 * count and the Wilson 95% interval.
 * @param {ReturnType<typeof computeScore>} s
 */
export function scoreLine(s) {
  for (const key of ['killed', 'survived', 'total', 'checkable_fraction', 'score', 'ci_low', 'ci_high']) {
    if (!(key in (s ?? {}))) throw new Error(`a score cannot be printed without ${key}: the score always travels with its checkable fraction, mutant count and confidence interval`);
  }
  const checkable = s.killed + s.survived;
  const score = s.score === null ? 'not checkable' : pct(s.score);
  const ci = s.ci_low === null ? 'no interval (nothing checkable)' : `95% CI ${pct(s.ci_low)}-${pct(s.ci_high)}`;
  return `${score} (${s.killed} killed / ${checkable} checkable of ${s.total} mutants, checkable fraction ${pct(s.checkable_fraction)}, ${ci})`;
}

/* -------------------------------------------------------------------------- */
/* The cap                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Gating conditions: facts that make a high score meaningless.
 *
 *  * `baseline_check_not_passing` -- the baseline did not PASS a check, so that
 *    check sat out the whole run and could not kill anything (contract rule 2).
 *    This is the hardware equivalent of a test suite that does not compile.
 *  * `run_error` -- the tool itself broke on a mutant. An ERROR is not evidence
 *    about the design.
 *  * `nothing_checkable` -- no mutant was both killed and survivable, so the
 *    score is null and there is nothing to be confident about.
 *
 * Mutants that came back NOT_CHECKED are NOT gating: they are already visible in
 * the checkable fraction, which by rule 7 is printed with the score every time.
 *
 * @returns {Array<{code: string, count: number, detail: string}>}
 */
export function gatingConditions({ baselineBlocked = [], statuses = [], generationErrors = [], score }) {
  const gates = [];
  if (baselineBlocked.length) {
    gates.push({
      code: 'baseline_check_not_passing',
      count: baselineBlocked.length,
      detail: `the baseline did not pass ${baselineBlocked.length} check(s) (${baselineBlocked.map(r => `${r.test_id}=${r.verdict}${r.reason_code ? `/${r.reason_code}` : ''}`).join(', ')}); a check the baseline did not pass can never kill a mutant`,
    });
  }
  const errors = statuses.filter(s => s === 'error').length;
  if (errors) {
    gates.push({ code: 'run_error', count: errors, detail: `${errors} mutant(s) ended in an ERROR: the tool failed, so those mutants are not evidence either way` });
  }
  if (generationErrors.length) {
    gates.push({ code: 'mutant_generation_error', count: generationErrors.length, detail: `${generationErrors.length} operator(s) could not produce a mutant: ${generationErrors.map(e => e.message).join('; ')}` });
  }
  if (score === null) {
    gates.push({ code: 'nothing_checkable', count: 1, detail: 'no mutant was killed or survived, so there is no score to report' });
  }
  return gates;
}

/**
 * The cap itself: `{ applied_at, reason } | null`, plus the gates it came from.
 * Never folded into `score`.
 */
export function computeCap(score, gates) {
  if (!gates.length) return null;
  const applied_at = Math.min(GATING_CAP, KNOWN_GOOD_FLOOR - 0.01);
  const bites = score === null || score > applied_at;
  return {
    applied_at,
    reason: `${gates.length} gating condition(s) cap this run at ${pct(applied_at)}, below the known-good floor of ${pct(KNOWN_GOOD_FLOOR)}: ${gates.map(g => g.detail).join(' | ')}`,
    bites,
    gates,
  };
}

/** The number a gate may act on. `score` itself is left exactly as computed. */
export const effectiveScore = (score, cap) =>
  (score === null ? null : cap ? Math.min(score, cap.applied_at) : score);

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn a `runVerification` outcome into the report object. Pure.
 * @param {object} outcome
 * @param {{threshold?: number}} [opts]
 */
export function buildReport(outcome, opts = {}) {
  const statuses = outcome.mutants.map(m => m.status);
  const score = computeScore(statuses);
  const gates = gatingConditions({
    baselineBlocked: outcome.baseline.blocked,
    statuses,
    generationErrors: outcome.generation_errors ?? [],
    score: score.score,
  });
  const cap = computeCap(score.score, gates);
  const effective = effectiveScore(score.score, cap);
  const threshold = opts.threshold ?? null;

  const byOperator = {};
  for (const m of outcome.mutants) {
    const o = (byOperator[m.operator] ??= { operator: m.operator, title: m.operator_title ?? m.operator, killed: 0, survived: 0, not_checked: 0, equivalent: 0, error: 0, total: 0 });
    o[m.status] += 1;
    o.total += 1;
  }
  for (const o of Object.values(byOperator)) {
    const checkable = o.killed + o.survived;
    const [lo, hi] = wilson(o.killed, checkable);
    o.score = checkable === 0 ? null : o.killed / checkable;
    o.ci_low = lo;
    o.ci_high = hi;
    o.checkable_fraction = o.total === 0 ? 0 : checkable / o.total;
  }

  return {
    schema: 'kinux.engine.report/1',
    run_id: outcome.run_id,
    design_hash: outcome.design_hash,
    project: outcome.project,
    domain: outcome.domain,
    provenance: outcome.provenance,
    tool_versions: outcome.tool_versions,
    disclaimer: 'Pre-check linter. Not a certification and not a substitute for engineering sign-off.',
    suite: outcome.suite,
    baseline: {
      checks: outcome.baseline.results.length,
      passed: outcome.baseline.killable.length,
      not_passed: outcome.baseline.blocked.map(r => ({ test_id: r.test_id, verdict: r.verdict, reason_code: r.reason_code ?? null, reason: r.reason ?? null })),
      killable_checks: outcome.baseline.killable,
      results: outcome.baseline.results,
    },
    score,                      // exactly computeScore(); never capped
    score_text: scoreLine(score),
    cap,                        // { applied_at, reason, bites, gates } | null
    effective_score: effective, // what a gate may lower
    threshold,
    passed_threshold: threshold === null ? null : effective !== null && effective >= threshold,
    by_operator: Object.values(byOperator).sort((a, b) => (a.operator < b.operator ? -1 : 1)),
    mutants: outcome.mutants.map(m => ({
      mutant_id: m.mutant_id,
      operator: m.operator,
      target: m.target,
      description: m.description,
      status: m.status,
      killed_by: m.killed_by,
      inconclusive: m.inconclusive,
      why: m.why,
      equivalence: m.equivalence?.equivalent ? m.equivalence : null,
      dispatch: m.dispatch,
      duration_ms: m.duration_ms,
      ...(m.skipped_blocks ? { skipped_blocks: m.skipped_blocks } : {}),
    })),
    duplicates: outcome.duplicates ?? [],
    generation_errors: outcome.generation_errors ?? [],
  };
}

/**
 * Emit `run.score` (exactly one, after the last `mutation.result`) and
 * `run.finished` (last). The score event carries `computeScore`'s fields
 * verbatim -- checkRun recomputes them -- plus the cap, so the viewer sees the
 * gating defect next to the number.
 */
export function finishRun(outcome, report) {
  const stream = outcome.stream;
  const data = { ...report.score };
  if (report.cap) data.cap = { applied_at: report.cap.applied_at, reason: report.cap.reason, bites: report.cap.bites };
  data.effective_score = report.effective_score;
  stream.emit('run.score', data);
  stream.emit('run.finished', {
    status: 'completed',
    summary: `${report.score_text}${report.cap ? ` -- CAPPED at ${pct(report.cap.applied_at)}: ${report.cap.gates.map(g => g.code).join(', ')}` : ''}`,
  });
  return stream.events;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

const STATUS_ORDER = ['killed', 'survived', 'not_checked', 'error', 'equivalent'];

/** @param {ReturnType<typeof buildReport>} report */
export function renderMarkdown(report) {
  const s = report.score;
  const L = [];
  L.push(`# Mutation report: ${report.project}`);
  L.push('');
  L.push(`**Mutation score: ${scoreLine(s)}**`);
  L.push('');
  if (report.cap) {
    L.push(`> **CAP APPLIED${report.cap.bites ? '' : ' (does not bite: the raw score is already below the ceiling)'} at ${pct(report.cap.applied_at)}.**`);
    L.push('>');
    L.push(`> ${report.cap.reason}`);
    L.push('>');
    for (const g of report.cap.gates) L.push(`> - \`${g.code}\` (${g.count}): ${g.detail}`);
    L.push('>');
    L.push(`> Reported score: ${pct(s.score)}. After the cap: ${pct(report.effective_score)}. The raw score is never silently rewritten; both numbers are shown.`);
    L.push('');
  } else {
    L.push('No gating condition: the baseline passed every check and no mutant ended in an ERROR, so no cap applies.');
    L.push('');
  }
  if (report.threshold !== null) {
    L.push(`Threshold ${pct(report.threshold)}: **${report.passed_threshold ? 'met' : 'NOT met'}** (compared against the capped score, ${pct(report.effective_score)}).`);
    L.push('');
  }
  L.push(`- Run: \`${report.run_id}\``);
  L.push(`- Design hash: \`${report.design_hash}\``);
  L.push(`- Provenance: **${report.provenance}**; tools: ${Object.entries(report.tool_versions).map(([k, v]) => `${k} ${v}`).join(', ') || 'none recorded'}`);
  L.push(`- ${report.disclaimer}`);
  L.push('');

  L.push('## Baseline');
  L.push('');
  L.push(`${report.baseline.passed} of ${report.baseline.checks} checks passed on the unmutated design. Only those ${report.baseline.passed} can ever kill a mutant.`);
  L.push('');
  if (report.baseline.not_passed.length) {
    L.push('| check | baseline verdict | reason |');
    L.push('|---|---|---|');
    for (const r of report.baseline.not_passed) L.push(`| \`${r.test_id}\` | ${r.verdict} | ${r.reason_code ?? ''} ${r.reason ? `-- ${String(r.reason).split('\n')[0]}` : ''} |`);
    L.push('');
  }

  L.push('## Mutants');
  L.push('');
  L.push(`| status | count | counted in the score |`);
  L.push('|---|---|---|');
  L.push(`| killed | ${s.killed} | yes (numerator) |`);
  L.push(`| survived | ${s.survived} | yes (denominator) |`);
  L.push(`| not_checked | ${s.not_checked} | no |`);
  L.push(`| error | ${s.errors} | no |`);
  L.push(`| equivalent | ${s.equivalent} | no (rule 6) |`);
  L.push('');

  L.push('### By operator');
  L.push('');
  L.push('| operator | killed | survived | not checked | error | equivalent | score |');
  L.push('|---|---|---|---|---|---|---|');
  for (const o of report.by_operator) {
    L.push(`| ${o.operator} | ${o.killed} | ${o.survived} | ${o.not_checked} | ${o.error} | ${o.equivalent} | ${o.score === null ? 'not checkable' : `${pct(o.score)} (${o.killed}/${o.killed + o.survived}, 95% CI ${pct(o.ci_low)}-${pct(o.ci_high)})`} |`);
  }
  L.push('');

  for (const status of STATUS_ORDER) {
    const list = report.mutants.filter(m => m.status === status);
    if (!list.length) continue;
    L.push(`### ${status} (${list.length})`);
    L.push('');
    for (const m of list) {
      L.push(`- \`${m.mutant_id}\` -- ${m.description}`);
      L.push(`  - ${m.why}`);
      if (m.killed_by.length) L.push(`  - killed by: ${m.killed_by.map(t => `\`${t}\``).join(', ')}`);
    }
    L.push('');
  }

  if (report.duplicates.length) {
    L.push('### Duplicate mutants (still scored)');
    L.push('');
    for (const d of report.duplicates) L.push(`- \`${d.mutant_id}\` is the same netlist as \`${d.same_as}\``);
    L.push('');
  }

  L.push('## What this does not tell you');
  L.push('');
  L.push('- A survivor is a gap in the checks, not proof of a defect.');
  L.push('- `not_checked` and `error` are never a pass and never a catch; they are outside the score and visible in the checkable fraction above.');
  L.push('- Equivalent mutants are only those proved identical to the design or changed below the simulator\'s resolution. Anything doubtful is counted as a survivor, which lowers the score.');
  L.push('');
  return L.join('\n');
}

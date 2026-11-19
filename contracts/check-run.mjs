// Validates events against the schemas and checks the rules a schema cannot express.
// Used by the tests now, and by the run server and the viewer later.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(join(HERE, name), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const eventSchema = load('event.schema.json');
ajv.addSchema(eventSchema);
const validateEventFn = ajv.getSchema(eventSchema.$id);
const validateManifestFn = ajv.compile(load('manifest.schema.json'));
const validateReceiptFn = ajv.compile(load('receipt.schema.json'));

const fmt = errors => (errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);

export function validateEvent(event) {
  const ok = validateEventFn(event);
  return { ok, errors: ok ? [] : fmt(validateEventFn.errors) };
}
export function validateManifest(m) {
  const ok = validateManifestFn(m);
  return { ok, errors: ok ? [] : fmt(validateManifestFn.errors) };
}
export function validateReceipt(r) {
  const ok = validateReceiptFn(r);
  return { ok, errors: ok ? [] : fmt(validateReceiptFn.errors) };
}

/** Wilson score interval for k successes out of n. Returns [null, null] when n is 0. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** The score as defined in contracts/README.md. */
export function computeScore(statuses) {
  const count = s => statuses.filter(x => x === s).length;
  const killed = count('killed'), survived = count('survived');
  const total = statuses.length;
  const checkable = killed + survived;
  const [lo, hi] = wilson(killed, checkable);
  return {
    killed, survived,
    not_checked: count('not_checked'), equivalent: count('equivalent'), errors: count('error'),
    total,
    checkable_fraction: total === 0 ? 0 : checkable / total,
    score: checkable === 0 ? null : killed / checkable,
    ci_low: lo, ci_high: hi,
  };
}

const near = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

/** Returns a list of problems; an empty list means the run is consistent. */
export function checkRun(events) {
  const problems = [];
  if (!events.length) return ['run has no events'];

  events.forEach((ev, i) => {
    const { ok, errors } = validateEvent(ev);
    if (!ok) problems.push(`event ${i}: ${errors.join('; ')}`);
  });
  if (problems.length) return problems; // later rules assume valid shapes

  const runId = events[0].run_id;
  events.forEach((ev, i) => {
    if (ev.seq !== i) problems.push(`event ${i}: seq is ${ev.seq}, expected ${i} (gap or reorder)`);
    if (ev.run_id !== runId) problems.push(`event ${i}: run_id ${ev.run_id} differs from ${runId}`);
  });

  if (events[0].type !== 'run.started') problems.push('first event must be run.started');
  const started = events.filter(e => e.type === 'run.started').length;
  if (started !== 1) problems.push(`expected exactly one run.started, found ${started}`);
  const finishedAt = events.findIndex(e => e.type === 'run.finished');
  if (finishedAt !== -1 && finishedAt !== events.length - 1) problems.push('run.finished must be the last event');

  const queued = new Set();
  const results = new Map(); // `${test_id}|${subject}` -> verdict
  for (const ev of events) {
    if (ev.type === 'test.queued') queued.add(ev.data.test_id);
    if (ev.type === 'test.result') {
      if (!queued.has(ev.data.test_id)) problems.push(`seq ${ev.seq}: result for test ${ev.data.test_id} that was never queued`);
      results.set(`${ev.data.test_id}|${ev.data.subject}`, ev.data.verdict);
    }
  }

  const mutants = new Map();
  for (const ev of events) {
    if (ev.type !== 'mutation.result') continue;
    const m = ev.data;
    if (mutants.has(m.mutant_id)) problems.push(`seq ${ev.seq}: duplicate mutant ${m.mutant_id}`);
    mutants.set(m.mutant_id, m.status);

    // A mutant is killed only if the baseline passed the check and the mutant failed it.
    for (const t of m.killed_by) {
      const base = results.get(`${t}|baseline`);
      const mut = results.get(`${t}|${m.mutant_id}`);
      if (base !== 'PASS') problems.push(`seq ${ev.seq}: mutant ${m.mutant_id} killed by ${t} but its baseline verdict is ${base ?? 'missing'}, not PASS`);
      if (mut !== 'FAIL') problems.push(`seq ${ev.seq}: mutant ${m.mutant_id} killed by ${t} but the mutant verdict is ${mut ?? 'missing'}, not FAIL`);
    }
    // A survivor must not have a check that actually failed on it.
    if (m.status === 'survived') {
      for (const [key, verdict] of results) {
        const [t, subject] = key.split('|');
        if (subject === m.mutant_id && verdict === 'FAIL' && results.get(`${t}|baseline`) === 'PASS') {
          problems.push(`seq ${ev.seq}: mutant ${m.mutant_id} is marked survived but ${t} failed on it`);
        }
      }
    }
  }

  const scores = events.filter(e => e.type === 'run.score');
  const finished = finishedAt !== -1 ? events[finishedAt] : null;
  if (finished && finished.data.status === 'completed' && mutants.size > 0 && scores.length !== 1) {
    problems.push(`a completed run with mutants needs exactly one run.score, found ${scores.length}`);
  }
  for (const ev of scores) {
    const lastMutant = Math.max(...events.filter(e => e.type === 'mutation.result').map(e => e.seq), -1);
    if (ev.seq < lastMutant) problems.push(`seq ${ev.seq}: run.score comes before the last mutation.result`);
    const want = computeScore([...mutants.values()]);
    for (const key of Object.keys(want)) {
      const got = ev.data[key];
      const same = typeof want[key] === 'number' || want[key] === null ? near(got, want[key]) : got === want[key];
      if (!same) problems.push(`seq ${ev.seq}: run.score.${key} is ${got}, recomputed ${want[key]}`);
    }
  }
  return problems;
}

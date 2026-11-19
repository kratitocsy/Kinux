// Builds the sample run: valid-run.events.jsonl and valid-run.manifest.json.
// EVERY value in it is synthetic. It exists to define the format and to test the rules; no solver produced it.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScore } from '../check-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');

const RUN_ID = 'demo-divider-001';
const DESIGN_HASH = sha('synthetic voltage divider design v1');
const solver = { kind: 'solver', id: 'ngspice' };
const villain = { kind: 'villain', id: 'fixed-rules' };
const system = { kind: 'system', id: 'kinux' };

const events = [];
const add = (type, actor, data, provenance = 'synthetic') => {
  const seq = events.length;
  events.push({
    v: 1, run_id: RUN_ID, seq,
    ts: new Date(Date.UTC(2026, 10, 19, 10, 0, seq)).toISOString(),
    type, actor, design_hash: DESIGN_HASH, provenance, data,
  });
};

add('run.started', system, {
  project: 'voltage-divider-demo', domain: 'electronics',
  design_artifact_ref: 'examples/divider', source: 'synthetic',
  tool_versions: { kinux: '0.0.1', note: 'synthetic, no tool ran' },
});

const tests = [
  ['T1', 'Output voltage within 3.2 to 3.4 V', ['REQ-1']],
  ['T2', 'Divider current below 1 mA', ['REQ-2']],
  ['T3', 'Output settles within 10 ms', ['REQ-3']],
];
for (const [id, title, reqs] of tests) {
  add('test.queued', system, { test_id: id, title, layer: 'netlist', solver: 'ngspice', requirement_ids: reqs });
}

const waveform = 'synthetic waveform bytes';
add('test.artifact', solver, {
  test_id: 'T1', artifact_id: 'wf-baseline', kind: 'waveform', uri: 'artifacts/wf-baseline.f32',
  sha256: sha(waveform), bytes: waveform.length, mime: 'application/octet-stream',
});

const baseline = { T1: [3.3, 'V'], T2: [0.66, 'mA'], T3: [4.2, 'ms'] };
for (const [id, [measured, units]] of Object.entries(baseline)) {
  add('test.result', solver, { test_id: id, subject: 'baseline', verdict: 'PASS', measured, units });
}

add('agent.action', villain, { action: 'inject_faults', summary: 'Applying 5 fixed-rule faults to the baseline design' });

const result = (mutant, test, verdict, extra = {}) =>
  add('test.result', solver, { test_id: test, subject: mutant, verdict, ...extra });
const mutation = (mutant_id, target, description, status, killed_by) =>
  add('mutation.result', villain, { mutant_id, target, description, layer: 'netlist', origin: 'fixed', status, killed_by });

// M1: R1 doubled -> output voltage drops, T1 fails.
result('M1', 'T1', 'FAIL', { measured: 2.2, units: 'V' }); result('M1', 'T2', 'PASS', { measured: 0.33, units: 'mA' }); result('M1', 'T3', 'PASS', { measured: 4.4, units: 'ms' });
mutation('M1', 'R1', 'R1 value x2', 'killed', ['T1']);

// M2: bypass capacitor removed. Every check still passes, so the checks are blind to it.
result('M2', 'T1', 'PASS', { measured: 3.3, units: 'V' }); result('M2', 'T2', 'PASS', { measured: 0.66, units: 'mA' }); result('M2', 'T3', 'PASS', { measured: 0.4, units: 'ms' });
mutation('M2', 'C1', 'C1 removed', 'survived', []);

// M3: R2 opened -> output rises to the supply, T1 fails.
result('M3', 'T1', 'FAIL', { measured: 5.0, units: 'V' }); result('M3', 'T2', 'PASS', { measured: 0.0, units: 'mA' }); result('M3', 'T3', 'PASS', { measured: 4.1, units: 'ms' });
mutation('M3', 'R2', 'R2 opened', 'killed', ['T1']);

// M4: a chip with no SPICE model. Cannot be simulated, so it is NOT_CHECKED, never a pass.
result('M4', 'T1', 'NOT_CHECKED', { reason_code: 'no_model', reason: 'U1 has no SPICE model' });
mutation('M4', 'U1', 'U1 replaced with an out-of-spec part', 'not_checked', []);

// M5: R3 tolerance nudged by 0.1 percent. No effect on the circuit's behaviour.
result('M5', 'T1', 'PASS', { measured: 3.3, units: 'V' }); result('M5', 'T2', 'PASS', { measured: 0.66, units: 'mA' }); result('M5', 'T3', 'PASS', { measured: 4.2, units: 'ms' });
mutation('M5', 'R3', 'R3 value +0.1 percent', 'equivalent', []);

const statuses = events.filter(e => e.type === 'mutation.result').map(e => e.data.status);
add('run.score', system, computeScore(statuses));
add('run.finished', system, { status: 'completed', summary: '2 of 3 checkable faults caught; 1 survived (C1 removed).' });

writeFileSync(join(HERE, 'valid-run.events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');

const manifest = {
  v: 1, run_id: RUN_ID,
  design: { adapter: 'synthetic', files: [{ path: 'divider.cir', sha256: sha('synthetic netlist') }] },
  artifacts: [
    { id: 'wf-baseline', kind: 'waveform', uri: 'artifacts/wf-baseline.f32', sha256: sha(waveform), label: 'Baseline output (synthetic)', provenance: 'synthetic' },
  ],
};
writeFileSync(join(HERE, 'valid-run.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${events.length} events`);

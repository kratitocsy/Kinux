// Review by proposals (engine/review.mjs): agents propose, verifiers decide.
//
// The design is our own hand-written KiCad fixture (engine/fixtures/divider.kicad_sch,
// a 5 V source into a 10k/10k divider), read through the real kicad-cli and
// solved by the real ngspice. Each verifier must be able to say no.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDesign } from '../engine/kicad-adapter.mjs';
import { buildBundle, createReview, replay, renderReport, describeBundle } from '../engine/review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'engine', 'fixtures');

async function bundle() {
  const d = await buildDesign({ schematic: join(FIX, 'divider.kicad_sch'), sidecar: join(FIX, 'divider.sidecar.json') });
  const dir = mkdtempSync(join(tmpdir(), 'kinux-review-'));
  const spec = join(dir, 'SPEC.md');
  writeFileSync(spec, '# Spec\n\nThe divider output SHALL sit between 2.4 V and\n2.6 V with a 5 V input.\nThe output SHALL never exceed 5 V.\n');
  return { b: buildBundle({ design: d, deck: d.netlist, documents: [{ path: spec }] }), d };
}

test('the bundle shows the parts, the nets and the documents, with a hash', async () => {
  const { b } = await bundle();
  const view = describeBundle(b);
  assert.match(view.bundle_hash, /^[0-9a-f]{64}$/);
  assert.ok(view.parts.length >= 2);
  assert.ok(Object.keys(view.nets).length >= 2);
  assert.equal(view.documents[0].name, 'SPEC.md');
});

test('citations: a verbatim quote is verified with its line, even across a line break; anything else is rejected', async () => {
  const { b } = await bundle();
  const r = createReview(b);
  const ok = await r.propose({ kind: 'citation', doc: 'SPEC.md', quote: 'between 2.4 V and 2.6 V with a 5 V input' });
  assert.equal(ok.status, 'verified', ok.reason);
  assert.equal(ok.evidence.line, 3);
  for (const [quote, why] of [['between 2.4 V and 2.7 V with a 5 V input', /does not occur/], ['2.4 V', /at least 12/]]) {
    const no = await r.propose({ kind: 'citation', doc: 'SPEC.md', quote });
    assert.equal(no.status, 'rejected');
    assert.match(no.reason, why);
  }
  assert.equal((await r.propose({ kind: 'citation', doc: 'DATASHEET.pdf', quote: 'anything at all here' })).status, 'rejected');
});

test('facts are checked against the netlist, and a claim of absence needs the whole net', async () => {
  const { b, d } = await bundle();
  const r = createReview(b);
  const part = d.comps.find(c => /^R/.test(c.ref));
  assert.equal((await r.propose({ kind: 'fact', claim: 'part_value', ref: part.ref, value: part.value })).status, 'verified');
  assert.equal((await r.propose({ kind: 'fact', claim: 'part_value', ref: part.ref, value: '47k' })).status, 'rejected');
  const net = d.nets.find(n => n.nodes.length >= 2);
  const pins = net.nodes.map(x => `${x.ref}.${x.pin}`);
  assert.equal((await r.propose({ kind: 'fact', claim: 'connected', net: net.name, pins: [pins[0]] })).status, 'verified');
  const partial = await r.propose({ kind: 'fact', claim: 'net_members', net: net.name, pins: [pins[0]] });
  assert.equal(partial.status, 'rejected');
  assert.match(partial.reason, /complete list/);
  assert.equal((await r.propose({ kind: 'fact', claim: 'net_members', net: net.name, pins })).status, 'verified');
});

test('a measurement is the solver\'s number, never the proposer\'s', async () => {
  const { b } = await bundle();
  const r = createReview(b);
  const m = await r.propose({ kind: 'measurement', probe: 'V(OUT)', analysis: 'op' });
  assert.equal(m.status, 'verified', m.reason);
  // divider.kicad_sch: V(out) = 2.48511 V, checked against a hand calculation in tests/kicad-adapter.test.mjs.
  assert.ok(Math.abs(m.evidence.measured - 2.48511) < 1e-3, `measured ${m.evidence.measured}`);
  const smuggled = await r.propose({ kind: 'measurement', probe: 'V(OUT)', analysis: 'op', value: 9 });
  assert.equal(smuggled.status, 'rejected');
  const nowhere = await r.propose({ kind: 'measurement', probe: 'V(NOSUCHNET)', analysis: 'op' });
  assert.equal(nowhere.status, 'rejected');
  const shell = await r.propose({ kind: 'measurement', probe: 'V(OUT); shell touch /tmp/x', analysis: 'op' });
  assert.equal(shell.status, 'rejected');
});

test('a finding needs verified premises: a requirement and evidence from the design', async () => {
  const { b, d } = await bundle();
  const r = createReview(b);
  const cite = await r.propose({ kind: 'citation', doc: 'SPEC.md', quote: 'between 2.4 V and 2.6 V with a 5 V input' });
  const meas = await r.propose({ kind: 'measurement', probe: 'V(OUT)', analysis: 'op' });
  const bad = await r.propose({ kind: 'citation', doc: 'SPEC.md', quote: 'this sentence is not in the spec' });
  const f1 = await r.propose({ kind: 'finding', severity: 'info', title: 'Divider output inside its band', premises: [cite.id, meas.id] });
  assert.equal(f1.status, 'verified', f1.reason);
  const f2 = await r.propose({ kind: 'finding', severity: 'major', title: 'Output exceeds the band', premises: [bad.id, meas.id] });
  assert.equal(f2.status, 'rejected');
  assert.match(f2.reason, /not verified/);
  const f3 = await r.propose({ kind: 'finding', severity: 'major', title: 'Only a requirement, no evidence', premises: [cite.id] });
  assert.match(f3.reason, /fact or measurement/);
  const f4 = await r.propose({ kind: 'finding', severity: 'major', title: 'No premises at all here' });
  assert.equal(f4.status, 'rejected');
  const q = await r.propose({ kind: 'question', text: 'Is the 5 V input regulated?' });
  assert.equal(q.status, 'open');

  const report = renderReport(r);
  assert.match(report, /Divider output inside its band/);
  assert.doesNotMatch(report, /Output exceeds the band/, 'a rejected finding never reaches the report');
  assert.match(report, /ngspice measured V\(OUT\)/);
  assert.match(report, /Is the 5 V input regulated/);
});

test('replay with no model re-verifies the log and reproduces the report byte for byte', async () => {
  const { b } = await bundle();
  const r = createReview(b);
  const c = await r.propose({ kind: 'citation', doc: 'SPEC.md', quote: 'The output SHALL never exceed 5 V' });
  const m = await r.propose({ kind: 'measurement', probe: 'V(OUT)', analysis: 'op' });
  await r.propose({ kind: 'finding', severity: 'info', title: 'Output never exceeds 5 V', premises: [c.id, m.id] });
  await r.propose({ kind: 'citation', doc: 'SPEC.md', quote: 'not in the spec at all, invented' });
  const again = await replay(b, r.log);
  assert.deepEqual(again.mismatches, []);
  assert.equal(renderReport(again.review), renderReport(r));
});

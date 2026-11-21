// The coverage-gap report (engine/coverage.mjs), checked against the REAL mutation engine.
//
// Every claim "this part is uncovered" is compared with what ngspice did to every mutant of that
// part. Nothing is mocked. A part the report calls uncovered must have no killed mutant; the
// open-feedback-loop fixture (engine/fixtures/openloop-buck.cir) has the same structure as the fang
// buck deck and must stay flagged, or the first test fails.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNetlist } from '../engine/netlist.mjs';
import { loadSuite, main as verifyMain } from '../engine/cli.mjs';
import { runVerification } from '../engine/runner.mjs';
import { buildReport } from '../engine/report.mjs';
import { OPERATORS } from '../engine/operators.mjs';
import { analyseCoverage, renderCoverage, COVERAGE_SCHEMA } from '../engine/coverage.mjs';
import { main as coverageMain } from '../engine/coverage-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'engine', 'fixtures');
const PHASE = join(HERE, '..', 'examples', 'phase-leg-support');
const text = p => readFileSync(p, 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'kinux-cov-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const write = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return p; };

const cover = (net, checks, reqs) => analyseCoverage(parseNetlist(net), loadSuite(checks), reqs);
const part = (rep, ref) => rep.parts.find(p => p.refdes === ref);
const net = (rep, n) => rep.nets.find(x => x.net === n);

/** Real mutation run; returns Map(target lowercased -> {killed, survived, mutants}). */
async function truth(netlist, checksPath, operators) {
  const outcome = await runVerification({ netlist, suite: loadSuite(checksPath), runId: 'cov-test', useQueue: false, operators });
  const rep = buildReport(outcome, { threshold: 0 });
  const by = new Map();
  for (const m of rep.mutants) {
    const t = by.get(m.target.toLowerCase()) ?? { killed: 0, survived: 0, mutants: 0 };
    t.mutants += 1;
    if (m.status === 'killed') t.killed += 1;
    if (m.status === 'survived') t.survived += 1;
    by.set(m.target.toLowerCase(), t);
  }
  return by;
}
const noOpenOnCaps = OPERATORS;   // all operators; see the capacitor note in the divider test

describe('open feedback loop (the fang buck structure)', () => {
  const NET = text(join(FIX, 'openloop-buck.cir'));
  const CHECKS = join(FIX, 'checks-openloop-buck.md');

  test('the feedback divider and its pin are flagged, and ngspice agrees: no mutant of them is killed', async () => {
    const rep = cover(NET, CHECKS);
    assert.equal(rep.schema, COVERAGE_SCHEMA);
    for (const ref of ['R1', 'R2', 'Rfb']) {
      assert.equal(part(rep, ref).status, 'uncovered', `${ref} must be flagged`);
      assert.equal(part(rep, ref).reason_code, 'dangling_control');
    }
    assert.equal(net(rep, 'fb').status, 'uncovered');
    assert.equal(net(rep, 'fb').reason_code, 'dangling_control');
    // the output loop IS covered
    for (const ref of ['L1', 'C1', 'RL', 'Sh', 'Sl']) assert.equal(part(rep, ref).status, 'covered', ref);
    assert.equal(net(rep, 'out').via, 'measured');

    const t = await truth(NET, CHECKS, noOpenOnCaps);
    for (const ref of ['R1', 'R2']) {
      const x = t.get(ref.toLowerCase());
      assert.ok(x.survived >= 3, `${ref}: expected several mutants, got ${x.mutants}`);
      assert.equal(x.killed, 0, `${ref}: the report says no check can see it; a killed mutant would prove it wrong`);
    }
    // Rfb sits inside the converter's .subckt: a model's internals are never mutated (K27), so
    // the engine has nothing to say about it, while coverage (above) still sees it is unreachable.
    assert.equal(t.get('rfb'), undefined, 'no mutant may be generated inside a subcircuit');
  });

  test('control: once a check reads the tap, the loop is no longer dangling, and the solver kills its mutants', async () => {
    // baseline V(fb) = 3.3 * 64k/264k = 0.8; a tight band on it makes the divider visible.
    const checks = write('tap.md', `# tap\n\n## Simulation\n\nscope: nets out, fb\nanalysis: tran 20n 1m\nassert: V(out) at 900u between 3.201 and 3.399\nassert: V(fb) at 900u between 0.79 and 0.81\n`);
    const rep = cover(NET, checks);
    for (const ref of ['R1', 'R2']) assert.equal(part(rep, ref).status, 'covered', ref);
    assert.equal(net(rep, 'fb').via, 'measured');
    const t = await truth(NET, checks, OPERATORS);
    assert.ok(t.get('r1').killed > 0 && t.get('r2').killed > 0, 'with V(fb) asserted the solver must kill drifts of R1 and R2');
  });

  test('a net that feeds a through path is not mistaken for a dangling stub', () => {
    // R2 and R3 are in series between out and gnd2 through fb, which has a pin AND two non-stiff neighbours.
    const net2 = NET.replace('R1 fb 0 64k', 'R1 fb mid 64k\nR9 mid out2 1k\nRL2 out2 0 100');
    const rep = cover(net2, CHECKS);
    // fb now has two non-stiff neighbours (out and mid): a through path, so no stub is declared
    assert.equal(part(rep, 'R2').status, 'covered');
    assert.equal(part(rep, 'R1').status, 'covered');
  });
});

describe('what "named" does not mean', () => {
  const DIV = text(join(FIX, 'divider-rc.cir'));

  test('a part or net named only in a comment, prose, a scope line or an HTML comment is never covered', async () => {
    const noisyNet = DIV.replace('R1 vcc mid 10k', '* R1 R2 R3 C2 RL mid out are all checked by V(mid) and V(out) and I(R3)\nR1 vcc mid 10k');
    const checks = write('noisy.md', [
      '# Weak suite with a lot of talk',
      '',
      'This suite checks V(mid), V(out), I(R3) and every part R1 R2 R3 C2 RL, honestly.',
      '',
      '<!-- assert: V(out) between 2 and 3 -->',
      '',
      '```',
      'assert: V(mid) between 2 and 3',
      '```',
      '',
      '## Simulation',
      '',
      'scope: nets [vcc, mid, out]',
      'analysis: op',
      'assert: V(vcc) between 4 and 6',
      '',
    ].join('\n'));
    const rep = cover(noisyNet, checks);
    assert.equal(loadSuite(checks).blocks[0].assertions.length, 1, 'only the live assertion is parsed');
    for (const ref of ['R1', 'R2', 'R3', 'C2', 'RL']) assert.equal(part(rep, ref).status, 'uncovered', `${ref} is only talked about`);
    for (const n of ['mid', 'out']) {
      assert.equal(net(rep, n).status, 'uncovered', n);
      assert.equal(net(rep, n).named_in_scope_only, true, `${n} is named in scope but never asserted`);
    }
    assert.ok(rep.scope_named_not_asserted.nets.includes('mid'));
    // and the solver agrees for every resistor (value drifts and opens do not move V(vcc))
    const t = await truth(noisyNet, checks, OPERATORS.filter(o => o.id.startsWith('value_drift')));
    for (const ref of ['r1', 'r2', 'r3', 'rl']) assert.equal(t.get(ref).killed, 0, ref);
  });

  test('a requirement is not covered because a comment names it; an unmapped requirement is never reported covered', () => {
    const weak = join(FIX, 'checks-weak.md');
    const rep = cover(DIV, weak, [
      'RL must not be overloaded',                    // names a part no check probes
      'the output net out stays within 5%',           // names a net no check measures
      'the vcc rail is 5 V +/- 1 V',                  // names the measured net
      'the board is safe',                            // names nothing in the design
      { id: 'R-explicit', text: 'filter corner', nets: ['out'] },
      'ripple below 3 %',                             // a bare number is not a net name
    ]);
    const by = Object.fromEntries(rep.requirements.map(r => [r.id, r]));
    assert.equal(by['REQ-1'].status, 'uncovered');
    assert.equal(by['REQ-2'].status, 'uncovered');
    assert.equal(by['REQ-3'].status, 'covered');
    assert.equal(by['REQ-3'].via, 'measured');
    assert.equal(by['REQ-4'].status, 'unmapped');
    assert.equal(by['R-explicit'].status, 'uncovered');
    assert.equal(by['REQ-6'].status, 'unmapped');
  });
});

describe('weak and thorough suites on divider-rc, against the solver', () => {
  const DIV = text(join(FIX, 'divider-rc.cir'));

  test('every part flagged under the weak suite is a part whose resistor/drift mutants all survive', async () => {
    const weak = join(FIX, 'checks-weak.md');
    const rep = cover(DIV, weak);
    assert.deepEqual(rep.parts.filter(p => p.status === 'uncovered').map(p => p.refdes).sort(), ['C1', 'C2', 'R1', 'R2', 'R3', 'RL']);
    assert.equal(rep.checks[0].status, 'blind', 'V(vcc) is held by an ideal source: it cannot see any passive fault');
    // Opening a capacitor makes ngspice 42 return a wrong DC solution (V(vcc) 5 -> 0), which "kills" for
    // a reason that has nothing to do with the capacitor. So compare on every operator EXCEPT open_connection.
    const ops = OPERATORS.filter(o => o.id !== 'open_connection');
    const t = await truth(DIV, weak, ops);
    for (const p of rep.parts.filter(q => q.status === 'uncovered')) {
      const x = t.get(p.refdes.toLowerCase());
      assert.ok(x && x.survived > 0, p.refdes);
      assert.equal(x.killed, 0, `${p.refdes} flagged uncovered but a mutant was killed`);
    }
  });

  test('the thorough suite leaves only C1 (a capacitor across the ideal supply) uncovered, and says why', () => {
    // C1 sits across V1; only I(V1), an op check, could see it, and at op a capacitor is open.
    const rep = cover(DIV, join(FIX, 'checks-thorough.md'));
    assert.deepEqual(rep.parts.filter(p => p.status === 'uncovered').map(p => p.refdes), ['C1']);
    assert.equal(part(rep, 'C1').reason_code, 'capacitor_open_at_dc');
  });

  test('a capacitor reached only by a DC check is flagged as open at DC; a transient check covers it', () => {
    const op = write('op.md', '# op\n\n## Simulation\n\nscope: nets out\nanalysis: op\nassert: V(out) between 2.3 and 2.4\n');
    const tran = write('tran.md', '# tran\n\n## Simulation\n\nscope: nets out\nanalysis: tran 10u 2m\nassert: V(out) at 500u between 197m and 201m\n');
    assert.equal(part(cover(DIV, op), 'C2').reason_code, 'capacitor_open_at_dc');
    assert.equal(part(cover(DIV, tran), 'C2').status, 'covered');
    assert.equal(part(cover(DIV, tran), 'R1').status, 'covered');
  });
});

describe('controlled sources, probes and thermal checks', () => {
  test('a controlled source whose output no check reads makes its control network uncovered, and the solver agrees', async () => {
    const NET = '* E source feeding nothing that is measured\nV1 in 0 DC 1\nR1 in a 1k\nR2 a 0 1k\nE1 x 0 a 0 2\nR3 x 0 1k\nR4 in out 1k\nR5 out 0 1k\n.end\n';
    const checks = write('e.md', '# e\n\n## Simulation\n\nscope: nets out\nanalysis: op\nassert: V(out) between 0.49 and 0.51\n');
    const rep = cover(NET, checks);
    for (const ref of ['R1', 'R2', 'E1', 'R3']) assert.equal(part(rep, ref).status, 'uncovered', ref);
    for (const ref of ['R4', 'R5', 'V1']) assert.equal(part(rep, ref).status, 'covered', ref);
    const t = await truth(NET, checks, OPERATORS.filter(o => o.id.startsWith('value_drift')));
    for (const ref of ['r1', 'r2', 'r3']) assert.equal(t.get(ref).killed, 0, ref);
    // ... and when the amplifier output IS measured, the control divider becomes covered through the E source
    const measured = write('e2.md', '# e\n\n## Simulation\n\nscope: nets x\nanalysis: op\nassert: V(x) between 0.99 and 1.01\n');
    const rep2 = cover(NET, measured);
    for (const ref of ['R1', 'R2', 'E1']) assert.equal(part(rep2, ref).status, 'covered', ref);
    // R3 loads an ideal VCVS output, which no load can move; R4/R5 are not in the path to x.
    for (const ref of ['R3', 'R4', 'R5']) assert.equal(part(rep2, ref).status, 'uncovered', ref);
    const t2 = await truth(NET, measured, OPERATORS.filter(o => o.id.startsWith('value_drift')));
    assert.ok(t2.get('r1').killed > 0 && t2.get('r2').killed > 0, 'a drift in the control divider must be killed once x is measured');
    for (const ref of ['r3', 'r4', 'r5']) assert.equal(t2.get(ref).killed, 0, ref);
  });

  test('I(), P() and T() probes make a part directly covered; the phase-leg shunt is probed by the thermal suite', () => {
    const NET = text(join(PHASE, 'phase-leg-support.cir'));
    const rep = cover(NET, join(PHASE, 'checks-thermal.md'));
    assert.equal(part(rep, 'RSH').via, 'probed');
    assert.equal(part(rep, 'RG').via, 'probed');
    const rep2 = cover(NET, join(PHASE, 'checks-thorough.md'));
    assert.equal(part(rep2, 'RFB1').status, 'covered');
  });

  test('a check that names a net or part the design does not have is reported unresolved, never covered', () => {
    const checks = write('ghost.md', '# g\n\n## Simulation\n\nscope: nets ghost\nanalysis: op\nassert: V(ghost) between 1 and 2\nassert: I(RZZ) < 1\n');
    const rep = cover(text(join(FIX, 'divider-rc.cir')), checks);
    assert.equal(rep.summary.checks.unresolved, 2);
    assert.equal(rep.summary.parts.covered, 0);
  });
});

describe('hostile design files', () => {
  test('a recursive or undefined subcircuit is an opaque part with a note, not a hang, a throw or a false "uncovered"', () => {
    const NET = '* hostile\nV1 a 0 DC 1\nX1 a b loop\nX2 b c missing\nR1 c 0 1k\n.subckt loop p q\nX9 p q loop\n.ends\n.end\n';
    const checks = write('h.md', '# h\n\n## Simulation\n\nscope: nets c\nanalysis: op\nassert: V(c) between 0 and 2\n');
    const rep = cover(NET, checks);
    assert.ok(rep.notes.some(n => /recursive/.test(n)));
    assert.ok(rep.notes.some(n => /not defined/.test(n)));
    assert.equal(part(rep, 'X2').status, 'unknown');
    assert.notEqual(part(rep, 'R1').status, 'unknown');
  });

  test('names like __proto__ and constructor are ordinary names', () => {
    const NET = '* names\nV1 __proto__ 0 DC 1\nR1 __proto__ constructor 1k\nR2 constructor 0 1k\n.end\n';
    const checks = write('p.md', '# p\n\n## Simulation\n\nscope: nets constructor\nanalysis: op\nassert: V(constructor) between 0 and 2\n');
    const rep = cover(NET, checks);
    assert.equal(part(rep, 'R1').status, 'covered');
    assert.equal(net(rep, 'constructor').via, 'measured');
  });
});

describe('output and command line', () => {
  test('text and JSON agree and the CLI works without a solver', () => {
    const NET = join(FIX, 'openloop-buck.cir');
    const CHECKS = join(FIX, 'checks-openloop-buck.md');
    const out = [];
    const code = coverageMain([NET, '--checks', CHECKS, '--json', '--requirement', 'V(out) holds 3.3 V', '--requirement', 'R1 divider'], { log: s => out.push(s) });
    assert.equal(code, 0);
    const rep = JSON.parse(out[0]);
    assert.equal(rep.schema, COVERAGE_SCHEMA);
    assert.equal(rep.requirements[1].status, 'uncovered', 'R1 is named by the requirement but no check can see it');
    const textOut = renderCoverage(rep);
    assert.match(textOut, /R1\s+\[dangling_control\]/);
    assert.equal(coverageMain([NET, '--checks', CHECKS, '--fail-on-gaps'], { log() {} }), 1);
    assert.equal(coverageMain([NET], { log() {}, error() {} }), 2);
    assert.equal(coverageMain(['--bogus'], { log() {}, error() {} }), 2);
  });
});

test('engine/cli.mjs is untouched by this feature: verify still runs on the same inputs', async () => {
  // a smoke test that the shared loader the coverage report depends on still feeds the engine
  const lines = [];
  const code = await verifyMain(['verify', join(FIX, 'divider-rc.cir'), '--checks', join(FIX, 'checks-weak.md'), '--out', join(tmp, 'run'), '--threshold', '0', '--limit', '3', '--quiet', '--no-queue'], { log: s => lines.push(s), error: () => {} });
  assert.equal(code, 0);
});

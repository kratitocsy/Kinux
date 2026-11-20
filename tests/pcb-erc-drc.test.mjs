// Tests for workers/pcb/erc-drc-report.mjs (step S2.6: ERC and DRC reports
// parsed).
//
// The parser is driven by report JSON, so most of this runs on FIXTURE files in
// workers/pcb/fixtures/reports/. That is not a convenience: this container has
// kicad-cli 7.0.11, which has no `sch erc` and no `pcb drc` at all, so no real
// report can be produced here. Which fixtures are real KiCad output and which
// are hand-authored is recorded in that directory's README.md, and it bounds
// what these passing tests prove.
//
// The last group does call the REAL binary, to prove the version gate: on this
// machine ERC and DRC must come back NOT_CHECKED with a reason, never PASS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeReport, formatViolations, footprintOwner, joinsNets,
  duplicateFootprintRefs, parseReportJson, reportVerdict,
  evaluateReportText, evaluateReportFile, checkErc, checkDrc,
} from '../workers/pcb/erc-drc-report.mjs';
import { detectKicadCli, capabilities } from '../workers/pcb/kicad-cli.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, '..', 'workers', 'pcb', 'fixtures', 'reports');
const BOARD = join(HERE, '..', 'workers', 'pcb', 'fixtures', 'two-trace.kicad_pcb');
const text = name => readFileSync(join(REPORTS, name), 'utf8');
const load = name => JSON.parse(text(name));

/** A result is only trustworthy if it is legal as a test.result event. */
const HASH = `sha256:${'0'.repeat(64)}`;
function assertContractLegal(result) {
  const { ok, errors } = validateEvent({
    v: 1,
    run_id: 'r-erc-drc',
    seq: 0,
    ts: '2026-11-20T00:00:00Z',
    type: 'test.result',
    actor: { kind: 'solver', id: 'pcb' },
    design_hash: HASH,
    provenance: 'synthetic',
    data: result,
  });
  assert.ok(ok, `result is not a legal test.result: ${errors.join('; ')}`);
  if (result.verdict === 'NOT_CHECKED' || result.verdict === 'ERROR') {
    assert.ok(result.reason_code, 'NOT_CHECKED and ERROR must carry a reason_code');
  }
  assert.ok(['PASS', 'FAIL', 'NOT_CHECKED', 'ERROR'].includes(result.verdict));
}

// ------------------------------------------------------------------ clean

test('a clean ERC report parses to PASS (real KiCad fixture)', () => {
  const r = evaluateReportText({ text: text('erc-clean.json'), source: 'erc', test_id: 'erc' });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.subject, 'baseline');
  assert.deepEqual(r.violations, []);
  assert.equal(r.violation_count, 0);
  assert.equal(r.summary, 'ERC: clean');
  assert.equal(r.reason_code, undefined);
  assertContractLegal(r);
});

test('a clean DRC report parses to PASS (real KiCad fixture)', () => {
  const r = evaluateReportText({ text: text('drc-clean.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.unrouted, 0);
  assert.deepEqual(r.intrinsic, []);
  assert.equal(r.summary, 'DRC: clean');
  assertContractLegal(r);
});

// ------------------------------------------------------------------- fail

test('error-severity violations parse to FAIL, surfaced individually', () => {
  const r = evaluateReportText({ text: text('erc-unconnected-pin.json'), source: 'erc', test_id: 'erc' });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.violation_count, 2);

  // Each finding is its own object, with its type, severity, sheet and position.
  assert.deepEqual(r.violations.map(v => v.type), ['pin_not_connected', 'no_connect_dangling']);
  const pin = r.violations.find(v => v.type === 'pin_not_connected');
  assert.equal(pin.severity, 'error');
  assert.equal(pin.sheet, '/');
  assert.equal(pin.description, 'Pin not connected');
  assert.equal(pin.items.length, 1);
  assert.equal(pin.items[0].description, 'Symbol U1 Pin 3 [GPIO0, Passive, Line]');
  assert.equal(typeof pin.items[0].x, 'number');
  assert.equal(typeof pin.items[0].y, 'number');

  // The warning travels too; the parser reports what KiCad included.
  assert.equal(r.violations.find(v => v.type === 'no_connect_dangling').severity, 'warning');

  // The rendering names each one.
  assert.match(r.summary, /ERC: 2 violation\(s\)/);
  assert.match(r.summary, /error pin_not_connected \[sheet \/\]: Pin not connected/);
  assert.match(r.summary, /- Symbol U1 Pin 3 \[GPIO0, Passive, Line\] @ \(1\.27, 0\.9652\)/);
  assertContractLegal(r);
});

test('a real DRC violation fails, and the short inside one footprint fails with it', () => {
  const r = evaluateReportText({ text: text('drc-violations.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'FAIL');
  // clearance against a track (not inside one footprint), the short, and the
  // schematic_parity finding, which is folded in as a violation.
  assert.deepEqual(r.violations.map(v => v.type), ['clearance', 'shorting_items', 'pad_net_mismatch']);
  assert.deepEqual(r.intrinsic, []);
  // ...and the unrouted connection in the same report is still only counted.
  assert.equal(r.unrouted, 1);
  assertContractLegal(r);
});

// ----------------------------------------------- unrouted ratsnest (never FAIL)

test('unrouted ratsnest items are counted and reported but do NOT cause a FAIL', () => {
  const r = evaluateReportText({ text: text('drc-unrouted.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'PASS', 'a draft board left as ratsnest is not a DRC failure');
  assert.notEqual(r.verdict, 'FAIL');
  assert.equal(r.unrouted, 3, 'the count must be reported, not silently dropped');
  assert.deepEqual(r.violations, []);
  assert.equal(r.summary, 'DRC: clean (3 connection(s) unrouted, left as ratsnest)');
  assertContractLegal(r);
});

test('unconnected_items never leak into violations even when they say severity error', () => {
  // KiCad marks them `"severity": "error"`; that is the trap this guards.
  const raw = load('drc-unrouted.json');
  assert.ok(raw.unconnected_items.every(u => u.severity === 'error'));
  const n = normalizeReport(raw, 'drc');
  assert.equal(n.ok, true);
  assert.equal(n.violations.length, 0);
  assert.equal(n.unrouted, 3);
});

// ------------------------------------------ single-footprint findings (never FAIL)

test('findings confined to a single footprint are reported beside the result, not as failures', () => {
  const r = evaluateReportText({ text: text('drc-intrinsic.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'PASS', 'layout cannot edit a library footprint, so this is not a placement failure');
  assert.notEqual(r.verdict, 'FAIL');
  assert.deepEqual(r.violations, []);
  // Reported, with the owning footprint named.
  assert.deepEqual(r.intrinsic.map(v => v.type), ['hole_clearance', 'clearance']);
  assert.equal(r.intrinsic_count, 2);
  assert.deepEqual(r.intrinsic.map(footprintOwner), ['J1', 'J1']);
  assert.match(r.summary, /2 finding\(s\) inside a single library footprint, not a placement problem: J1 hole_clearance, J1 clearance/);
  assertContractLegal(r);
});

test('the exceptions hold: spanning two parts, touching a track, or shorting two nets all still FAIL', () => {
  const v = (type, ...items) => ({ type, severity: 'error', description: type, items: items.map(description => ({ description })) });

  const between = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Pad 2 [GND] of R1 on F.Cu')] }, 'drc');
  assert.equal(between.ok, false);
  assert.deepEqual(between.intrinsic, []);

  const track = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Track [GND] on F.Cu, length 2.1 mm')] }, 'drc');
  assert.equal(track.ok, false);
  assert.deepEqual(track.intrinsic, []);

  // A short is an electrical fault whichever footprint it sits in.
  const short = normalizeReport({ violations: [v('shorting_items', 'Pad A4 [VCC] of J1 on F.Cu', 'Pad B9 [GND] of J1 on F.Cu')] }, 'drc');
  assert.equal(short.ok, false);
  assert.deepEqual(short.violations.map(x => x.type), ['shorting_items']);
  assert.ok(joinsNets(short.violations[0]));

  // An unannotated reference is the library default, not a name.
  const holes = normalizeReport({ violations: [v('hole_to_hole', 'NPTH pad of REF**', 'NPTH pad of REF**')] }, 'drc');
  assert.equal(holes.ok, false);
  assert.equal(footprintOwner(holes.violations[0]), null);

  // A reference carried by two footprints names neither.
  const twice = normalizeReport(
    { violations: [v('hole_clearance', 'Pad 1 [GND] of H1 on F.Cu', 'NPTH pad of H1')] },
    'drc',
    { duplicateRefs: new Set(['H1']) },
  );
  assert.equal(twice.ok, false);

  // ERC never excuses anything: a schematic has no footprints.
  const erc = normalizeReport({ violations: [v('hole_clearance', 'Pad A1 [GND] of J1 on F.Cu', 'NPTH pad of J1')] }, 'erc');
  assert.equal(erc.ok, false);
  assert.equal(erc.intrinsic, undefined);
});

test('a footprint KiCad cannot vouch for is never excused', () => {
  const r = evaluateReportText({ text: text('drc-lib-footprint-issues.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.violations.map(v => v.type), ['lib_footprint_issues', 'hole_clearance']);
  assert.deepEqual(r.intrinsic, []);
});

test('when the board could not be read for its references, nothing is excused', () => {
  const r = evaluateReportText({ text: text('drc-intrinsic.json'), source: 'drc', test_id: 'drc', boardText: null });
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.intrinsic, []);
  assert.equal(r.violation_count, 2);
});

test('a duplicate reference is read off a real board file, in either KiCad syntax', () => {
  assert.deepEqual([...duplicateFootprintRefs(readFileSync(BOARD, 'utf8'))], [], 'the fixture board has no duplicates');
  const board = [
    '(footprint "MountingHole:MountingHole_3.2mm_M3" (property "Reference" "H1" (at 0 0))',
    '(footprint "MountingHole:MountingHole_3.2mm_M3" (property "Reference" "H1" (at 5 0))',
    '(footprint "Resistor_SMD:R_0603_1608Metric" (property "Reference" "R1" (at 9 0))',
    '(module Old (fp_text reference U2 (at 0 0)) (fp_text reference "U2" (at 1 0)))',
  ].join('\n');
  assert.deepEqual([...duplicateFootprintRefs(board)].sort(), ['H1', 'U2']);

  // And it is honoured through the text path: the finding stops being excused.
  const dup = ['(footprint "x" (property "Reference" "J1" (at 0 0))', '(footprint "x" (property "Reference" "J1" (at 5 0))'].join('\n');
  const r = evaluateReportText({ text: text('drc-intrinsic.json'), source: 'drc', boardText: dup });
  assert.equal(r.verdict, 'FAIL');
});

// --------------------------------------------- malformed reports are ERROR

test('truncated report JSON yields ERROR with a reason_code, never a PASS', () => {
  const r = evaluateReportText({ text: text('drc-truncated.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'ERROR');
  assert.notEqual(r.verdict, 'PASS');
  assert.equal(r.reason_code, 'tool_error');
  assert.equal(r.detail_code, 'report_unparsable');
  assert.match(r.reason, /not valid JSON/);
  assertContractLegal(r);
});

test('every flavour of malformed report is ERROR with a reason_code, never PASS', () => {
  const cases = [
    ['', 'report_empty'],
    ['   \n', 'report_empty'],
    ['{"violations": [', 'report_unparsable'],
    ['not json at all', 'report_unparsable'],
    ['null', 'report_not_an_object'],
    ['[]', 'report_not_an_object'],
    ['42', 'report_not_an_object'],
  ];
  for (const [body, detail] of cases) {
    for (const source of ['erc', 'drc']) {
      const r = evaluateReportText({ text: body, source, test_id: source });
      assert.equal(r.verdict, 'ERROR', `${JSON.stringify(body)} must be ERROR`);
      assert.notEqual(r.verdict, 'PASS');
      assert.equal(r.reason_code, 'tool_error');
      assert.equal(r.detail_code, detail, JSON.stringify(body));
      assertContractLegal(r);
    }
  }
  // And a non-string body, e.g. a readFile that returned a Buffer or undefined.
  for (const bad of [undefined, null, 17, {}]) {
    const r = evaluateReportText({ text: bad, source: 'drc' });
    assert.equal(r.verdict, 'ERROR');
  }
});

test('an empty object is a clean report, but a missing report file is ERROR', async () => {
  // Tolerance of missing fields across KiCad versions is deliberate...
  assert.equal(parseReportJson('{}').ok, true);
  assert.equal(normalizeReport({}, 'erc').ok, true);
  // ...but an absent file is not an empty report: kicad-cli bailed before checking.
  const r = await evaluateReportFile({ reportPath: join(REPORTS, 'does-not-exist.json'), source: 'drc', test_id: 'drc' });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.reason_code, 'tool_error');
  assert.equal(r.detail_code, 'report_missing');
  assertContractLegal(r);
});

test('an unknown report source is ERROR, not a guess', () => {
  const r = evaluateReportText({ text: '{}', source: 'lvs' });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.reason_code, 'tool_error');
  assert.equal(r.detail_code, 'unknown_report_source');
  assertContractLegal(r);
});

// -------------------------------------------- the version gate on THIS machine

test('this container really does have a kicad-cli that cannot do ERC or DRC', async () => {
  const caps = await capabilities();
  assert.equal(caps.available, true, 'kicad-cli must be installed for this test to mean anything');
  assert.equal(caps.major, 7, `expected KiCad 7 here, found ${caps.version}`);
  assert.equal(caps.drc, false);
  assert.equal(caps.erc, false);
});

for (const [name, run] of [['ERC', checkErc], ['DRC', checkDrc]]) {
  test(`asking for ${name} on this machine's KiCad 7.0.11 yields NOT_CHECKED naming the version gap`, async () => {
    const v = await detectKicadCli();
    const r = await run({ input: BOARD, test_id: `${name.toLowerCase()}_gate` });

    assert.notEqual(r.verdict, 'PASS', 'a check that did not run must never look like it passed');
    assert.notEqual(r.verdict, 'FAIL');
    assert.equal(r.verdict, 'NOT_CHECKED');
    assert.ok(r.reason_code, 'NOT_CHECKED requires a reason_code');
    assert.equal(r.reason_code, 'tool_missing');
    assert.equal(r.detail_code, 'kicad_cli_too_old');

    // The version found and the version required are both named.
    assert.equal(r.version_found, v.version);
    assert.equal(r.version_required, '8.0');
    assert.match(r.reason, /7\.0\.11/);
    assert.match(r.reason, /KiCad 8\.0/);
    assert.match(r.reason, /did not run/);
    assert.equal(r.test_id, `${name.toLowerCase()}_gate`);
    assert.equal(r.subject, 'baseline');

    // No violations, no counts: there is nothing to report, and reporting
    // "0 violations" here would read as a pass.
    assert.equal(r.violations, undefined);
    assert.equal(r.unrouted, undefined);
    assertContractLegal(r);
  });
}

test('the gate is reused, not reimplemented: its result passes straight through', async () => {
  // Stand in for runDrc with a report-producing KiCad 8, to show the parse path
  // beyond the gate. This is the only way to reach it on this container.
  const dir = mkdtempSync(join(tmpdir(), 'kinux-drc-'));
  const path = join(dir, 'drc.json');
  writeFileSync(path, text('drc-unrouted.json'));
  const r = await checkDrc({ input: BOARD, reportPath: path, test_id: 'drc', _run: async () => ({ ok: true }) });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.unrouted, 3);

  // And a run that produced no report at all is ERROR, not PASS.
  const none = await checkDrc({ input: BOARD, test_id: 'drc', _run: async () => ({ ok: true }) });
  assert.equal(none.verdict, 'ERROR');
  assert.equal(none.detail_code, 'report_missing');

  // A gate result keeps its own reason_code whatever it is.
  const gated = await checkErc({
    input: BOARD, test_id: 'erc',
    _run: async () => ({ verdict: 'NOT_CHECKED', reason_code: 'tool_missing', detail_code: 'kicad_cli_missing', reason: 'gone' }),
  });
  assert.equal(gated.verdict, 'NOT_CHECKED');
  assert.equal(gated.detail_code, 'kicad_cli_missing');
  assertContractLegal(gated);

  // A thrown error is ERROR with a reason, never a pass.
  const threw = await checkDrc({ input: BOARD, test_id: 'drc', _run: async () => { throw new Error('boom'); } });
  assert.equal(threw.verdict, 'ERROR');
  assert.equal(threw.detail_code, 'kicad_cli_failed');
  assert.match(threw.reason, /boom/);
  assertContractLegal(threw);
});

test('reportVerdict is a pure mapping from a normalized report', () => {
  assert.equal(reportVerdict(normalizeReport(load('erc-clean.json'), 'erc'), { test_id: 't' }).verdict, 'PASS');
  assert.equal(reportVerdict(normalizeReport(load('drc-violations.json'), 'drc'), { test_id: 't' }).verdict, 'FAIL');
  assert.equal(reportVerdict(normalizeReport(load('drc-unrouted.json'), 'drc'), { test_id: 't', subject: 'm-1' }).subject, 'm-1');
  assert.equal(formatViolations(normalizeReport({}, 'drc')), 'DRC: clean');
});

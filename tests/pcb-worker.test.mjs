// Tests for the PCB geometry/rule worker in workers/pcb/.
//
// These call the REAL kicad-cli binary. There is no stub and no recorded
// output: if kicad-cli is missing or broken the relevant tests fail loudly,
// which is the point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePcb, parsePcbFile, readSexp } from '../workers/pcb/parse.mjs';
import {
  checkTraceCurrent, ipc2221Ampacity, ipc2221MinWidthMm, layerClass,
  K_EXTERNAL, K_INTERNAL, OZ_COPPER_MILS,
} from '../workers/pcb/trace-current.mjs';
import { capabilities, detectKicadCli, exportPcb, exportGlb, runDrc, runErc } from '../workers/pcb/kicad-cli.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'workers', 'pcb', 'fixtures');
const BOARD = join(FIXTURES, 'two-trace.kicad_pcb');
const ODD = join(FIXTURES, 'odd-tokens.kicad_pcb');

// ---------------------------------------------------------------- parsing

test('parses the fixture board: outline, layers, nets and segments', () => {
  const b = parsePcbFile(BOARD);

  assert.equal(b.version, 20221018);
  assert.equal(b.generator, 'kinux_spike');

  assert.deepEqual(b.layers.map(l => l.name), ['F.Cu', 'B.Cu', 'Edge.Cuts']);
  assert.deepEqual(b.layers.map(l => l.ordinal), [0, 31, 44]);

  assert.deepEqual(b.nets, [{ number: 0, name: '' }, { number: 1, name: 'VIN' }]);

  // Four Edge.Cuts lines forming a 40 x 30 mm rectangle.
  assert.equal(b.outline.length, 4);
  const xs = b.outline.flatMap(o => [o.start.x, o.end.x]);
  const ys = b.outline.flatMap(o => [o.start.y, o.end.y]);
  assert.equal(Math.min(...xs), 100); assert.equal(Math.max(...xs), 140);
  assert.equal(Math.min(...ys), 80);  assert.equal(Math.max(...ys), 110);

  assert.equal(b.segments.length, 2);
  assert.deepEqual(b.segments.map(s => s.width_mm), [0.25, 0.15]);
  assert.deepEqual(b.segments.map(s => s.layer), ['F.Cu', 'F.Cu']);
  assert.deepEqual(b.segments.map(s => s.net), [1, 1]);
  assert.deepEqual(b.segments.map(s => s.net_name), ['VIN', 'VIN']);
  assert.deepEqual(b.segments.map(s => s.length_mm), [20, 20]);
  assert.deepEqual(b.segments[0].start, { x: 110, y: 90 });
  assert.deepEqual(b.segments[0].end, { x: 130, y: 90 });
});

test('unknown node types are skipped, not fatal', () => {
  const b = parsePcbFile(ODD);
  // some_future_node and zone are nothing we model; they must not throw.
  const skipped = Object.fromEntries(b.skipped.map(s => [s.token, s.count]));
  assert.equal(skipped.some_future_node, 1);
  assert.equal(skipped.zone, 1);
  // The things we do model still came through.
  assert.equal(b.segments.length, 4);
  assert.equal(b.layers.find(l => l.name === 'In1.Cu').userName, 'Inner One');
  // Escaped quotes inside a net name survive.
  assert.equal(b.nets.find(n => n.number === 2).name, '/some "quoted" net');
  // Only Edge.Cuts counts as outline; the F.SilkS gr_line does not.
  assert.equal(b.outline.length, 1);
});

test('the reader survives nonsense that is still balanced, and rejects what is not', () => {
  const t = readSexp('(a (b "c d") 1 -2.5 3e2)');
  assert.equal(t[0], 'a');
  assert.equal(t[1][0], 'b');
  assert.equal(String(t[1][1]), 'c d');   // quoted string, kept whole
  assert.deepEqual(t.slice(2), [1, -2.5, 300]); // bare numeric atoms become numbers
  assert.throws(() => readSexp('(a (b)'), /unbalanced/);
  assert.throws(() => readSexp('(a))'), /unbalanced/);
  assert.throws(() => readSexp('(a "unterminated'), /unterminated/);
  assert.throws(() => parsePcb('(not_a_board (version 1))'), /not a kicad_pcb/);
  // A segment with no geometry is dropped rather than guessed at.
  const b = parsePcb('(kicad_pcb (net 1 "N") (segment (width 0.2) (layer "F.Cu") (net 1)))');
  assert.equal(b.segments.length, 0);
});

// ------------------------------------------------------- IPC-2221 formula
//
// I = k * dT^0.44 * A^0.725,  A in mil^2,  k = 0.048 external / 0.024 internal
// 1 oz copper = 1.37 mil.  1 mm = 1/0.0254 = 39.37008 mil.
//
// HAND-WORKED VALUES (shown so the expected numbers are not just "whatever the
// code printed"):
//
// (1) 0.25 mm, external, dT = 10 C, 1 oz
//     w = 0.25/0.0254          = 9.84252 mil
//     A = 9.84252 * 1.37       = 13.48425 mil^2
//     dT^0.44 = 10^0.44        = 2.754229
//     A^0.725 = e^(0.725*ln 13.48425) = e^(0.725*2.601520) = e^1.886102 = 6.593715
//     I = 0.048 * 2.754229 * 6.593715 = 0.871697 A
//
// (2) 0.15 mm, external, dT = 10 C, 1 oz
//     w = 5.90551 mil ; A = 5.90551*1.37 = 8.09055 mil^2
//     A^0.725 = e^(0.725*ln 8.09055) = e^(0.725*2.090752) = e^1.515795 = 4.553048
//     I = 0.048 * 2.754229 * 4.553048 = 0.601901 A
//
// (3) 0.25 mm, INTERNAL, dT = 10 C, 1 oz  -> k halves, so I halves exactly
//     I = 0.024 * 2.754229 * 6.593715 = 0.435849 A
//
// (4) 0.5 mm, external, dT = 20 C, 1 oz
//     w = 19.68504 mil ; A = 26.96850 mil^2
//     20^0.44 = 3.738011 ; A^0.725 = e^(0.725*3.294667) = e^2.388634 = 10.89880
//     I = 0.048 * 3.738011 * 10.89880 = 1.954635 A
//
// (5) 1.0 mm, external, dT = 10 C, 2 oz   -> thickness 2.74 mil
//     A = 39.37008 * 2.74 = 107.874016 mil^2
//     ln(A) = 4.6809640 ; 0.725*ln(A) = 3.3936989
//     A^0.725 = e^3.3936989 = 29.775887
//     I = 0.048 * 2.7542287 * 29.775887 = 3.936460980 A
//
// NOTE: an earlier revision of this block wrote ln(A) = 4.681005 and so
// expected 3.936376 A. That was an arithmetic slip in the hand working, not
// an error in the implementation. Recomputed independently at full precision
// (outside this codebase, so the check stays non-circular) the value is
// 3.936460980 A, which is what ipc2221Ampacity returns.

const close = (got, want, eps = 5e-6) =>
  assert.ok(Math.abs(got - want) < eps, `expected ${want}, got ${got} (diff ${Math.abs(got - want)})`);

test('IPC-2221 ampacity matches the hand-worked values', () => {
  close(ipc2221Ampacity({ width_mm: 0.25, deltaT_c: 10, external: true }).ampacity_a, 0.871697);
  close(ipc2221Ampacity({ width_mm: 0.15, deltaT_c: 10, external: true }).ampacity_a, 0.601901);
  close(ipc2221Ampacity({ width_mm: 0.25, deltaT_c: 10, external: false }).ampacity_a, 0.435849);
  close(ipc2221Ampacity({ width_mm: 0.5, deltaT_c: 20, external: true }).ampacity_a, 1.954635);
  close(ipc2221Ampacity({ width_mm: 1.0, deltaT_c: 10, external: true, copper_oz: 2 }).ampacity_a, 3.936460980);

  // Cross-section and constants are what the comment says they are.
  const m = ipc2221Ampacity({ width_mm: 0.25, external: true });
  close(m.area_mil2, 13.484252, 1e-5);
  assert.equal(m.k, K_EXTERNAL);
  assert.equal(m.thickness_mil, OZ_COPPER_MILS);
  assert.equal(ipc2221Ampacity({ width_mm: 0.25, external: false }).k, K_INTERNAL);
  // Internal is exactly half of external at the same geometry.
  close(ipc2221Ampacity({ width_mm: 0.25, external: false }).ampacity_a,
        ipc2221Ampacity({ width_mm: 0.25, external: true }).ampacity_a / 2);
  // Default dT is 10 C.
  close(ipc2221Ampacity({ width_mm: 0.25, external: true }).ampacity_a,
        ipc2221Ampacity({ width_mm: 0.25, deltaT_c: 10, external: true }).ampacity_a);

  // The inverse round-trips.
  const w = ipc2221MinWidthMm({ current_a: 0.871697, deltaT_c: 10, external: true });
  close(w, 0.25, 1e-5);

  assert.throws(() => ipc2221Ampacity({ width_mm: 0, external: true }), RangeError);
  assert.throws(() => ipc2221Ampacity({ width_mm: 0.2, deltaT_c: -1, external: true }), RangeError);
});

test('layer classification', () => {
  assert.equal(layerClass('F.Cu'), 'external');
  assert.equal(layerClass('B.Cu'), 'external');
  assert.equal(layerClass('In1.Cu'), 'internal');
  assert.equal(layerClass('In4.Cu'), 'internal');
  assert.equal(layerClass('F.SilkS'), 'non_copper');
  assert.equal(layerClass('Edge.Cuts'), 'non_copper');
  assert.equal(layerClass(undefined), 'non_copper');
});

test('0.25 mm passes and 0.15 mm fails at the same required current', () => {
  const b = parsePcbFile(BOARD);
  // 0.75 A sits between the two ampacities (0.8717 A and 0.6019 A).
  const r = checkTraceCurrent(b, { net_currents_a: { VIN: 0.75 } });

  assert.equal(r.segments.length, 2);
  const [thick, thin] = r.segments;

  assert.equal(thick.width_mm, 0.25);
  assert.equal(thick.verdict, 'PASS');
  close(thick.measured, 0.871697);
  assert.equal(thick.limit, 0.75);

  assert.equal(thin.width_mm, 0.15);
  assert.equal(thin.verdict, 'FAIL');
  close(thin.measured, 0.601901);

  assert.notEqual(thick.verdict, thin.verdict);
  assert.deepEqual(r.summary, { total: 2, pass: 1, fail: 1, not_checked: 0, error: 0 });

  // Raise the temperature budget enough and the thin trace passes too: the
  // verdict follows the inputs, it is not baked in.
  const hot = checkTraceCurrent(b, { net_currents_a: { VIN: 0.75 }, deltaT_c: 30 });
  assert.equal(hot.segments[1].verdict, 'PASS');
});

test('an internal-layer segment is held to the halved IPC-2221 constant', () => {
  const b = parsePcbFile(ODD);
  const r = checkTraceCurrent(b, { net_currents_a: { VIN: 0.5 } });
  const inner = r.segments.find(s => s.layer === 'In1.Cu');
  assert.equal(inner.layer_class, 'internal');
  assert.equal(inner.k, K_INTERNAL);
  close(inner.measured, 0.435849);
  // The same 0.25 mm width passed on F.Cu at 0.75 A, and fails here at 0.5 A.
  assert.equal(inner.verdict, 'FAIL');
});

// ------------------------------------------------------------- honesty rules

test('a net with no declared current requirement is NOT_CHECKED, never PASS', () => {
  const b = parsePcbFile(BOARD);
  const r = checkTraceCurrent(b, { net_currents_a: {} }); // nothing declared

  assert.equal(r.summary.pass, 0);
  assert.equal(r.summary.not_checked, 2);
  for (const s of r.segments) {
    assert.equal(s.verdict, 'NOT_CHECKED');
    assert.notEqual(s.verdict, 'PASS');
    assert.equal(s.detail_code, 'no_current_requirement');
    assert.ok(s.reason_code, 'NOT_CHECKED must carry a reason_code');
    assert.equal(s.measured, undefined, 'an unchecked segment must not report a measurement');
  }

  // Declaring a current for one net only leaves the other unchecked.
  const odd = checkTraceCurrent(parsePcbFile(ODD), { net_currents_a: { VIN: 0.4 } });
  const unnamed = odd.segments.find(s => s.net === 0);
  assert.equal(unnamed.verdict, 'NOT_CHECKED');
  assert.equal(unnamed.detail_code, 'no_current_requirement');
  assert.ok(/unnamed/.test(unnamed.reason));

  // A nonsensical requirement does not become a pass either.
  const bad = checkTraceCurrent(b, { net_currents_a: { VIN: 0 } });
  assert.equal(bad.segments[0].verdict, 'NOT_CHECKED');
  assert.equal(bad.segments[0].detail_code, 'bad_current_requirement');
});

test('a non-copper segment is NOT_CHECKED, not silently passed', () => {
  const r = checkTraceCurrent(parsePcbFile(ODD), { net_currents_a: { VIN: 0.1 } });
  const silk = r.segments.find(s => s.layer === 'F.SilkS');
  assert.equal(silk.verdict, 'NOT_CHECKED');
  assert.equal(silk.detail_code, 'not_a_copper_layer');
  assert.equal(silk.reason_code, 'out_of_scope');
});

test('every verdict this worker emits is legal in a contracts test.result event', () => {
  // The contracts own the verdict/reason_code rules; import them, do not restate them.
  const b = parsePcbFile(ODD);
  const r = checkTraceCurrent(b, { net_currents_a: { VIN: 0.5 } });
  const asEvent = (seq, data) => ({
    v: 1, run_id: 'r1', seq, ts: '2026-11-19T00:00:00Z', type: 'test.result',
    actor: { kind: 'solver', id: 'pcb-worker' },
    design_hash: 'sha256:' + '0'.repeat(64), provenance: 'real', data,
  });
  r.segments.forEach((s, i) => {
    const { ok, errors } = validateEvent(asEvent(i, {
      test_id: 'trace_current', subject: 'baseline', verdict: s.verdict,
      ...(s.measured === undefined ? {} : { measured: s.measured, limit: s.limit, units: 'A' }),
      ...(s.reason_code ? { reason_code: s.reason_code, reason: s.reason } : {}),
    }));
    assert.ok(ok, `segment ${i} (${s.verdict}): ${errors.join('; ')}`);
  });
});

// -------------------------------------------------------- real kicad-cli

test('the real kicad-cli is present and its capabilities are reported honestly', async () => {
  const v = await detectKicadCli();
  assert.equal(v.available, true, `kicad-cli not runnable: ${v.error}`);
  assert.match(v.version, /^\d+\.\d+/);

  const caps = await capabilities();
  assert.ok(caps.pcb_export.includes('svg'));
  assert.equal(caps.drc, caps.major >= 8);
  assert.equal(caps.erc, caps.major >= 8);
  assert.equal(caps.glb, caps.pcb_export.includes('glb'));
});

test('asking for DRC returns NOT_CHECKED with a reason code, and is not a PASS', async () => {
  const caps = await capabilities();
  const r = await runDrc({ input: BOARD });

  if (caps.drc) {
    // Only reachable on KiCad 8.0+, which this container does not have.
    assert.notEqual(r.verdict, 'NOT_CHECKED');
    return;
  }

  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.notEqual(r.verdict, 'PASS');
  assert.ok(r.reason_code, 'NOT_CHECKED must carry a reason_code');
  assert.equal(r.detail_code, 'kicad_cli_too_old');
  assert.equal(r.version_found, caps.version);
  assert.equal(r.version_required, '8.0');
  assert.match(r.reason, new RegExp(caps.version.replace(/\./g, '\\.')));
  assert.match(r.reason, /8\.0/);
  // No artifact and no measurement were invented.
  assert.equal(r.ok, undefined);
  assert.equal(r.measured, undefined);
});

test('ERC and GLB are NOT_CHECKED the same way', async () => {
  const caps = await capabilities();
  for (const [name, r] of [['erc', await runErc({ input: BOARD })],
                           ['glb', await exportGlb({ input: BOARD, output: '/dev/null' })]]) {
    if ((name === 'erc' && caps.erc) || (name === 'glb' && caps.glb)) continue;
    assert.equal(r.verdict, 'NOT_CHECKED', name);
    assert.notEqual(r.verdict, 'PASS', name);
    assert.equal(r.detail_code, 'kicad_cli_too_old', name);
    assert.equal(r.version_required, '8.0', name);
  }
});

test('an export format the binary does not have is NOT_CHECKED, not an error we hide', async () => {
  const r = await exportPcb({ input: BOARD, format: 'definitely-not-a-format', output: '/dev/null' });
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.equal(r.detail_code, 'unsupported_export_format');
});

test('a real headless kicad-cli pcb export svg produces a non-empty SVG', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kinux-pcb-')), 'board.svg');
  const r = await exportPcb({ input: BOARD, format: 'svg', output: out });

  assert.equal(r.verdict, undefined, `export failed: ${r.reason ?? ''} ${r.stderr ?? ''}`);
  assert.equal(r.ok, true);
  assert.ok(r.bytes > 0, 'SVG is empty');
  assert.equal(statSync(out).size, r.bytes);

  const svg = readFileSync(out, 'utf8');
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>/);

  // execFile with an argument array: the command line is a list, never a string.
  assert.ok(Array.isArray(r.argv));
  assert.deepEqual(r.argv.slice(0, 3), ['kicad-cli', 'pcb', 'export']);
});

test('a missing input board is an ERROR with a reason, not a silent pass', async () => {
  const r = await exportPcb({ input: join(tmpdir(), 'no-such-board-xyz.kicad_pcb'), format: 'svg', output: '/dev/null' });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.detail_code, 'input_missing');
  assert.ok(r.reason_code);
});

test('a board that kicad-cli refuses to load is an ERROR, and we say so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-pcb-bad-'));
  const bad = join(dir, 'broken.kicad_pcb');
  writeFileSync(bad, '(kicad_pcb (version 20221018) (this is not a board)\n');
  const r = await exportPcb({ input: bad, format: 'svg', output: join(dir, 'out.svg') });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.reason_code, 'tool_error');
  assert.ok(r.reason.length > 0);
});

// KiCad -> SPICE adapter (ROADMAP R3), against the REAL kicad-cli and the REAL ngspice.
//
// The fixtures are hand-written KiCad schematics in engine/fixtures/ (a divider,
// a hostile variant, an ICs-only board). No Copperhead file is used or copied.
//
// Hand calculation for the divider (R1 10k, R2 10k, R4 1k, R3 1M, C1 open at DC,
// R5 DNP and removed, source 5 V):
//   Rload = R4 + R3 = 1.001e6;  Rp = R2 || Rload = 10e3*1.001e6/1.011e6 = 9901.089
//   V(mid) = 5 * Rp / (R1 + Rp) = 2.48759;  V(out) = V(mid) * R3 / Rload = 2.48511
// If `1M` were read as SPICE reads it (1 milliohm) V(out) would be ~0.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDesign, exportWithKicadCli, parseKicadValue, parseKicadNetlist, parseKicadSpice, compareIntent,
  loadModelFile, validateSidecar, mapNets, formatSummary, AdapterError,
} from '../engine/kicad-adapter.mjs';
import { runNetlist } from '../workers/ngspice/run.mjs';
import { sanitize } from '../workers/ngspice/sanitize.mjs';
import { main } from '../engine/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'engine', 'fixtures');
const DIVIDER = join(FIX, 'divider.kicad_sch');
const SIDECAR = join(FIX, 'divider.sidecar.json');
const tmp = () => mkdtempSync(join(tmpdir(), 'kinux-adapter-test-'));
const quiet = { log: () => {}, error: () => {} };

/** Run a deck in real ngspice and read one `print` value. */
async function opValue(deck, vec) {
  const r = await runNetlist(`${deck.replace(/\.end\s*$/i, '')}.control\nop\nprint ${vec}\n.endc\n.end\n`);
  assert.ok(r.ok, r.reason ?? 'ngspice failed');
  const m = new RegExp(`${vec.replace(/[()]/g, '\\$&')}\\s*=\\s*([-+0-9.eE]+)`, 'i').exec(r.stdout);
  assert.ok(m, `no ${vec} in ngspice output:\n${r.stdout}`);
  return Number(m[1]);
}

/** The invariant under test: nothing unmodelled is in the deck, and the counts add up. */
function assertNoUnmodelledInDeck(manifest, deck) {
  let depth = 0;                                   // lines inside an inlined .subckt are the model's, not parts
  const deckRefs = [];
  for (const l of deck.split('\n')) {
    if (/^\.subckt/i.test(l)) depth++;
    else if (/^\.ends/i.test(l)) depth--;
    else if (depth === 0 && /^[A-Za-z]/.test(l) && !l.startsWith('.')) deckRefs.push(l.split(/\s+/)[0].replace(/^X/, ''));
  }
  for (const p of manifest.parts) {
    if (p.status === 'not_checked') assert.ok(!deckRefs.includes(p.ref), `${p.ref} is not_checked (${p.reason_code}) but is in the deck`);
    else assert.ok(deckRefs.includes(p.ref), `${p.ref} is modelled but missing from the deck`);
  }
  const sourceLines = deckRefs.filter(r => /^[VI]/.test(r) && !manifest.parts.some(p => p.ref === r)).length;
  assert.equal(deckRefs.length - sourceLines, manifest.counts.modelled);
}

describe('values: the SI-prefix boundary', () => {
  const cases = [
    ['1M', 'R', '1e6'], ['1Meg', 'R', '1e6'], ['1MEG', 'R', '1e6'], ['1meg', 'R', '1e6'], ['1m', 'R', '1e-3'],
    ['4k7', 'R', '4.7e3'], ['4K7', 'R', '4.7e3'], ['4R7', 'R', '4.7'], ['2M2', 'R', '2.2e6'], ['10kΩ', 'R', '10e3'], ['5.1k', 'R', '5.1e3'],
    ['100n', 'C', '100e-9'], ['100nF', 'C', '100e-9'], ['4.7uF', 'C', '4.7e-6'], ['4u7', 'C', '4.7e-6'], ['1F', 'C', '1'], ['10pF', 'C', '10e-12'],
    ['15u', 'L', '15e-6'], ['15uH', 'L', '15e-6'], ['1mH', 'L', '1e-3'], ['2H', 'L', '2'],
  ];
  for (const [tok, kind, want] of cases) {
    test(`${kind} "${tok}" -> ${want}`, () => {
      const v = parseKicadValue(tok, kind);
      assert.ok(v.ok, v.why);
      assert.equal(v.text, want);
    });
  }
  test('values that are not a value of that kind are refused, not guessed', () => {
    for (const [tok, kind] of [['DNP', 'R'], ['10uF', 'R'], ['5V', 'C'], ['abc', 'L'], ['1k;shell', 'R'], ['', 'R'], ['1mil', 'R']]) {
      assert.equal(parseKicadValue(tok, kind).ok, false, `${kind} "${tok}" must be refused`);
    }
  });

  // The headline: against REAL ngspice, 1 V across each spelling.
  test('real ngspice: raw `1M` is a milliohm (1000 A), `1meg` and the adapter output are a megaohm (1 uA)', async () => {
    const across = async value => opValue(`across\nV1 a 0 DC 1\nR1 a 0 ${value}\n.end\n`, 'i(v1)');
    const raw = await across('1M');
    const meg = await across('1meg');
    const adapted = await across(parseKicadValue('1M', 'R').text);
    assert.ok(Math.abs(raw - -1000) < 1e-6, `raw 1M drew ${raw} A, expected 1000 A (a milliohm)`);
    assert.ok(Math.abs(meg - -1e-6) < 1e-12, `1meg drew ${meg} A`);
    assert.ok(Math.abs(adapted - meg) < 1e-15, 'the adapter must produce exactly what 1meg produces');
    assert.ok(Math.abs(raw / adapted - 1e9) / 1e9 < 1e-9, 'the unadapted value is a billion times too small');
  });
});

describe('the divider fixture through real kicad-cli', () => {
  let built;
  test('exports and classifies every part', async () => {
    built = await buildDesign({ schematic: DIVIDER, sidecar: SIDECAR });
    const { manifest } = built;
    assert.equal(manifest.counts.total, 9);
    assert.equal(manifest.counts.modelled, 5);
    assert.deepEqual(manifest.counts.by_reason, { blackbox: 1, no_model: 1, out_of_scope: 2 });
    assert.equal(manifest.counts.electrical, 7);
    assert.ok(Math.abs(manifest.counts.checkable_fraction - 5 / 7) < 1e-12);
    const byRef = Object.fromEntries(manifest.parts.map(p => [p.ref, p]));
    assert.equal(byRef.U1.reason_code, 'no_model');
    assert.equal(byRef.D1.reason_code, 'blackbox');
    assert.equal(byRef.TP1.reason_code, 'out_of_scope');
    assert.equal(byRef.R5.reason_code, 'out_of_scope');
    assert.deepEqual(manifest.dnp, ['R5']);
    assert.deepEqual(byRef.R2.dropped_tokens, ['1%']);
    assert.ok(manifest.normalisations.some(n => n.startsWith('R2:') && n.includes('1%')));
    assert.match(formatSummary(manifest), /checkable fraction: 71\.4%/);
  });

  test('the deck: ground is 0, the DNP part is gone, values are plain numbers, the source is there', () => {
    const lines = built.netlist.trim().split('\n');
    assert.deepEqual(lines.slice(1), [
      'C1 OUT 0 100e-9', 'R1 VIN MID 10e3', 'R2 MID 0 10e3', 'R3 OUT 0 1e6', 'R4 MID OUT 1e3', 'V1 VIN 0 DC 5', '.end',
    ]);
    assert.ok(sanitize(built.netlist).ok);
  });

  test('real ngspice gives the hand-calculated answer, so 1M reached it as a megaohm', async () => {
    const vout = await opValue(built.netlist, 'v(out)');
    const vmid = await opValue(built.netlist, 'v(mid)');
    assert.ok(Math.abs(vmid - 2.48759) < 1e-4, `V(mid)=${vmid}`);
    assert.ok(Math.abs(vout - 2.48511) < 1e-4, `V(out)=${vout}`);
  });

  test('a raw `1M` from an older KiCad export is translated too (not just `1Meg`)', async () => {
    const exp = await exportWithKicadCli(DIVIDER);
    assert.match(exp.spice, /R3 \/OUT GND 1Meg/, 'this KiCad already writes 1Meg; the test rewrites it to the raw spelling');
    const raw = { ...exp, spice: exp.spice.replace('1Meg', '1M') };
    const r = await buildDesign({ schematic: DIVIDER, sidecar: SIDECAR, exported: raw });
    assert.ok(r.netlist.includes('R3 OUT 0 1e6\n'));
    assert.ok(!/\b1M\b/.test(r.netlist));
  });

  test('every not_checked part is absent from the deck; a tampered deck is caught (the check can fail)', () => {
    assertNoUnmodelledInDeck(built.manifest, built.netlist);
    const tampered = built.netlist.replace('.end', 'U1 MID 0 1k\n.end');
    assert.throws(() => assertNoUnmodelledInDeck(built.manifest, tampered), /U1 is not_checked/);
    const pretend = JSON.parse(JSON.stringify(built.manifest));
    pretend.parts.find(p => p.ref === 'U1').status = 'modelled';
    assert.throws(() => assertNoUnmodelledInDeck(pretend, built.netlist), /U1 is modelled but missing/);
  });

  test('the fraction is recomputed from the parts, not trusted', () => {
    const m = built.manifest;
    const electrical = m.parts.filter(p => p.reason_code !== 'out_of_scope');
    assert.equal(m.counts.checkable_fraction, electrical.filter(p => p.status === 'modelled').length / electrical.length);
    for (const p of m.parts) assert.ok(p.status === 'modelled' ? p.reason_code === null : ['no_model', 'blackbox', 'out_of_scope', 'netlist_unsupported'].includes(p.reason_code));
  });
});

describe('connectivity cross-check against an intent file', () => {
  const intent = {
    parts: ['C1', 'D1', 'R1', 'R2', 'R3', 'R4', 'R5', 'TP1', 'U1'].map(ref => ({ ref })),
    nets: [
      { name: 'VIN', pins: ['R1.1'] }, { name: 'MID', pins: ['R1.2', 'R2.1', 'R4.1', 'R5.1', 'U1.1'] },
      { name: 'GND', pins: ['R2.2', 'R3.2', 'C1.2', 'R5.2', 'U1.2', 'D1.1'] },
      { name: 'OUT', pins: ['R4.2', 'R3.1', 'C1.1', 'D1.2', 'TP1.1'] }, { name: 'IC_OUT', pins: ['U1.3'] },
    ],
  };
  test('agrees with a correct intent file, and reports every difference in a wrong one', async () => {
    const { nets, comps } = await buildDesign({ schematic: DIVIDER, sidecar: SIDECAR });
    assert.equal(compareIntent(nets, comps, intent).agrees, true);
    const wrong = JSON.parse(JSON.stringify(intent));
    wrong.nets[1].pins = wrong.nets[1].pins.filter(p => p !== 'U1.1');        // MID loses a pin
    wrong.nets[2].name = 'AGND';                                              // renamed and now differs
    wrong.parts.push({ ref: 'Q9' });
    const r = compareIntent(nets, comps, wrong);
    assert.equal(r.agrees, false);
    const kinds = r.mismatches.map(m => m.kind);
    assert.ok(kinds.includes('pins_differ'), JSON.stringify(r.mismatches));
    assert.ok(r.renamed_only.some(x => x.intent === 'AGND' && x.kicad === 'GND'));
    assert.ok(kinds.includes('part_missing_in_kicad'));
  });
});

describe('sidecar models: only from the allowlisted directory, only sanitized', () => {
  const GOOD = '* a simple buffer\n.subckt AMP in gnd out\nRin in gnd 100k\nEo out gnd in gnd 0.5\n.ends AMP\n';
  function world(files = {}) {
    const root = tmp();
    const models = join(root, 'models');
    mkdirSync(models);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(models, name), text);
    return { root, models };
  }
  const sidecarFor = (extra = {}) => ({
    version: 1,
    sources: [{ ref: 'V1', kind: 'vdc', plus: 'VIN', minus: 'GND', volts: 5 }],
    models: [{ ref: 'U1', file: 'amp.cir', subckt: 'AMP', ports: ['1', '2', '3'], ...extra }],
  });
  async function buildWith(sc, models) {
    const p = join(tmp(), 'sidecar.json');
    writeFileSync(p, JSON.stringify(sc));
    return buildDesign({ schematic: DIVIDER, sidecar: p, modelDir: models });
  }

  test('a good model is inlined, becomes modelled, and real ngspice simulates it', async () => {
    const { models } = world({ 'amp.cir': GOOD });
    const r = await buildWith(sidecarFor(), models);
    const u1 = r.manifest.parts.find(p => p.ref === 'U1');
    assert.equal(u1.status, 'modelled');
    assert.equal(u1.model.name, 'AMP');
    assert.ok(!/\.include|\.lib/i.test(r.netlist), 'the deck never includes a file');
    assert.ok(r.netlist.includes('XU1 MID 0 IC_OUT AMP'));
    assertNoUnmodelledInDeck(r.manifest, r.netlist);
    const vmid = await opValue(r.netlist, 'v(mid)');
    const vic = await opValue(r.netlist, 'v(ic_out)');
    assert.ok(Math.abs(vic / vmid - 0.5) < 1e-6, `gain ${vic / vmid}`);
    assert.equal(r.manifest.counts.modelled, 6);
  });

  test('hostile model files and paths are each refused, the part stays not_checked, and nothing leaks into the deck', async () => {
    const outside = tmp();
    writeFileSync(join(outside, 'secret.cir'), GOOD);
    const { models } = world({
      'inc.cir': '.include /etc/passwd\n.subckt AMP in gnd out\nR1 in out 1\n.ends\n',
      'lib.cir': '.lib /etc/passwd x\n.subckt AMP in gnd out\nR1 in out 1\n.ends\n',
      'ctl.cir': '.subckt AMP in gnd out\nR1 in out 1\n.ends\n.control\nshell touch pwned\n.endc\n',
      'tran.cir': '.subckt AMP in gnd out\nR1 in out 1\n.ends\n.tran 1u 1m\n',
      'bt.cir': '.subckt AMP in gnd out\nR1 in out `id`\n.ends\n',
      'amp.txt.exe': GOOD, 'wrongname.cir': GOOD,
    });
    symlinkSync(join(outside, 'secret.cir'), join(models, 'link.cir'));
    const cases = [
      ['../secret.cir', 'netlist_unsupported'], ['/etc/passwd', 'netlist_unsupported'], [`${outside}/secret.cir`, 'netlist_unsupported'],
      ['link.cir', 'netlist_unsupported'], ['inc.cir', 'netlist_unsupported'], ['lib.cir', 'netlist_unsupported'],
      ['ctl.cir', 'netlist_unsupported'], ['tran.cir', 'netlist_unsupported'], ['bt.cir', 'netlist_unsupported'],
      ['amp.txt.exe', 'netlist_unsupported'], ['missing.cir', 'no_model'], ['a/../amp.cir', 'netlist_unsupported'], ['~/x.cir', 'netlist_unsupported'],
    ];
    for (const [file, code] of cases) {
      const r = await buildWith(sidecarFor({ file }), models);
      const u1 = r.manifest.parts.find(p => p.ref === 'U1');
      assert.equal(u1.status, 'not_checked', `${file} must not be modelled`);
      assert.equal(u1.reason_code, code, `${file}: ${u1.detail}`);
      assert.ok(!/passwd|shell|\.control|\.include|XU1/.test(r.netlist), `${file} leaked into the deck`);
      assertNoUnmodelledInDeck(r.manifest, r.netlist);
    }
    // Positive control for the allowlist: the same bytes inside the directory are accepted.
    const ok = await buildWith(sidecarFor(), world({ 'amp.cir': GOOD }).models);
    assert.equal(ok.manifest.parts.find(p => p.ref === 'U1').status, 'modelled');
  });

  test('a wrong port count, a wrong pin and a missing subckt are not_checked, never modelled', async () => {
    const { models } = world({ 'amp.cir': GOOD });
    for (const [extra, re] of [[{ ports: ['1', '2'] }, /3 ports/], [{ ports: ['1', '2', '9'] }, /no pin "9"/], [{ subckt: 'NOPE' }, /not defined/]]) {
      const r = await buildWith(sidecarFor(extra), models);
      const u1 = r.manifest.parts.find(p => p.ref === 'U1');
      assert.equal(u1.status, 'not_checked');
      assert.match(u1.detail, re);
    }
  });

  test('without an allowlisted directory no model is read', () => {
    assert.equal(loadModelFile(null, 'amp.cir').ok, false);
  });

  test('the sidecar is a closed schema', () => {
    const bad = [
      { version: 2 }, { version: 1, extra: 1 }, { version: 1, sources: [{ ref: 'V1', kind: 'vdc', plus: 'A', minus: 'B', volts: 5, raw: '.control' }] },
      { version: 1, sources: [{ ref: 'V1 0 0\n.control', kind: 'vdc', plus: 'A', minus: 'B', volts: 5 }] },
      { version: 1, sources: [{ ref: 'R1', kind: 'vdc', plus: 'A', minus: 'B', volts: 5 }] },
      { version: 1, sources: [{ ref: 'V1', kind: 'vdc', plus: 'A', minus: 'B', volts: '5; shell' }] },
      { version: 1, models: [{ ref: 'U1', file: 'a.cir', subckt: 'X', model: 'Y', ports: ['1'] }] },
      { version: 1, models: [{ ref: 'U1', file: 'a.cir', subckt: 'X y', ports: ['1'] }] },
      { version: 1, blackbox: [{ ref: 'U1' }] },
    ];
    for (const sc of bad) assert.throws(() => validateSidecar(sc), AdapterError, JSON.stringify(sc));
    assert.ok(validateSidecar(JSON.parse(readFileSync(SIDECAR, 'utf8'))));
  });

  test('a source on a net that does not exist is an error, not a floating source', async () => {
    const p = join(tmp(), 's.json');
    writeFileSync(p, JSON.stringify({ version: 1, sources: [{ ref: 'V1', kind: 'vdc', plus: 'NOPE', minus: 'GND', volts: 5 }] }));
    await assert.rejects(buildDesign({ schematic: DIVIDER, sidecar: p }), /net "NOPE" is not in the design/);
  });
});

describe('hostile designs', () => {
  const HOSTILE = join(FIX, 'hostile.kicad_sch');
  const PWNED = '/tmp/kinux-pwned';

  test('POSITIVE CONTROL: the payload really fires when nothing sanitizes it', async () => {
    const marker = join(tmp(), 'fired');
    const r = await runNetlist(`ctl\nV1 a 0 DC 1\nR1 a 0 1k\n.control\nshell touch ${marker}\n.endc\n.end\n`, { alreadySanitized: true });
    assert.ok(existsSync(marker), `an unsanitized .control shell must create the marker (ngspice ok=${r.ok}); otherwise the tests below prove nothing`);
    // ...and the sanitizer refuses the very same deck.
    assert.equal(sanitize(`ctl\nV1 a 0 DC 1\n.control\nshell touch ${marker}\n.endc\n.end\n`).ok, false);
  });

  test('a value carrying a .control/shell payload is not_checked and never reaches the deck', async () => {
    rmSync(PWNED, { force: true });
    const r = await buildDesign({ schematic: HOSTILE });
    const r6 = r.manifest.parts.find(p => p.ref === 'R6');
    assert.equal(r6.status, 'not_checked');
    assert.ok(!/control|shell|pwned/i.test(r.netlist));
    assert.ok(sanitize(r.netlist).ok);
    assert.ok(Number.isFinite(await opValue(r.netlist, 'v(out)')));
    assert.ok(!existsSync(PWNED), 'the payload must not have run');
    assertNoUnmodelledInDeck(r.manifest, r.netlist);
  });

  test('hostile text in KiCad\'s SPICE export (injected lines, trailing commands) never reaches the deck', async () => {
    const exp = await exportWithKicadCli(DIVIDER);
    const spice = exp.spice.replace('R1 /VIN /MID 10k', 'R1 /VIN /MID 1k;shell').replace('.end', '.control\nshell touch /tmp/kinux-pwned\n.endc\n.include /etc/passwd\nR9 a b 1k\nR4 /MID /OUT 1\n`id`\n.end');
    const r = await buildDesign({ schematic: DIVIDER, sidecar: SIDECAR, exported: { ...exp, spice } });
    assert.ok(!/control|shell|passwd|R9|`/.test(r.netlist), r.netlist);
    assert.equal(r.manifest.parts.find(p => p.ref === 'R1').status, 'not_checked', 'R1 carried `1k;shell` and must be refused');
    const r4 = r.manifest.parts.find(p => p.ref === 'R4');
    assert.equal(r4.status, 'not_checked', 'R4 appears twice in the export, so neither line is trusted');
    assert.equal(r4.reason_code, 'netlist_unsupported');
  });

  test('a Sim.Library path pointing outside is never read by the adapter; KiCad itself refuses and the failure is loud', async () => {
    await assert.rejects(buildDesign({ schematic: join(FIX, 'hostile-simlib.kicad_sch') }), e => e instanceof AdapterError && e.code === 'kicad_failed' && /passwd/.test(e.message));
  });

  test('Sim.* properties are recorded but not acted on', async () => {
    const r = await buildDesign({ schematic: HOSTILE });
    const r7 = r.manifest.parts.find(p => p.ref === 'R7');
    assert.equal(r7.status, 'not_checked');
  });

  test('a non-.kicad_sch input, a missing file and a missing kicad-cli are refused with a code', async () => {
    await assert.rejects(exportWithKicadCli(join(FIX, 'divider-rc.cir')), e => e.code === 'bad_input');
    await assert.rejects(exportWithKicadCli(join(FIX, 'nope.kicad_sch')), e => e.code === 'bad_input');
    await assert.rejects(exportWithKicadCli(DIVIDER, { bin: '/nonexistent/kicad-cli' }), e => e.code === 'kicad_failed');
  });
});

describe('net names', () => {
  test('ground spellings merge into 0, odd characters are made safe, collisions stay distinct', () => {
    const { map, merged } = mapNets(['/GND', 'GND', 'AGND', '/OUT', 'OUT', '+5V', 'Net-(U1-Pad1)', '/A B', 'a_b']);
    assert.equal(map.get('/GND'), '0');
    assert.equal(map.get('GND'), '0');
    assert.equal(map.get('AGND'), '0');
    assert.deepEqual(merged, ['AGND']);
    assert.equal(map.get('+5V'), '+5V');
    assert.equal(map.get('Net-(U1-Pad1)'), 'Net-_U1-Pad1_');
    assert.notEqual(map.get('/OUT'), map.get('OUT'));
    assert.equal(new Set([...map.values()].filter(v => v !== '0').map(v => v.toLowerCase())).size, [...map.values()].filter(v => v !== '0').length);
  });
  test('parsers read the real export shapes', async () => {
    const exp = await exportWithKicadCli(DIVIDER);
    const n = parseKicadNetlist(exp.sexpr);
    assert.equal(n.comps.length, 9);
    assert.ok(n.nets.some(x => x.name === '/MID' && x.nodes.length === 5));
    const s = parseKicadSpice(exp.spice);
    assert.equal(s.passives.get('R3').valueTokens[0], '1Meg');
  });
});

describe('kinux verify on a KiCad design', () => {
  test('runs end to end, writes the manifest and prints the fraction with the score', async () => {
    const out = join(tmp(), 'run');
    const lines = [];
    const code = await main(['verify', DIVIDER, '--sidecar', SIDECAR, '--checks', join(FIX, 'divider.checks.md'), '--out', out, '--limit', '4', '--run-id', 'kicad-test'], { log: s => lines.push(s), error: s => lines.push(s) });
    const text = lines.join('\n');
    assert.ok([0, 1].includes(code), `exit ${code}\n${text}`);
    assert.match(text, /checkable fraction: 71\.4%/);
    assert.match(text, /score covers the modelled subset only: 5 of 7/);
    assert.match(text, /contract-clean/);
    const model = JSON.parse(readFileSync(join(out, 'design-model.json'), 'utf8'));
    assert.equal(model.counts.modelled, 5);
    assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /## Design model \(KiCad\)/);
    assert.ok(existsSync(join(out, 'design.cir')));
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.design_model.electrical, 7);
  });

  test('a design where nothing is checkable says so, claims no score and exits 4', async () => {
    const out = join(tmp(), 'run');
    const lines = [];
    const code = await main(['verify', join(FIX, 'ics-only.kicad_sch'), '--checks', join(FIX, 'divider.checks.md'), '--out', out], { log: s => lines.push(s), error: s => lines.push(s) });
    const text = lines.join('\n');
    assert.equal(code, 4);
    assert.match(text, /NOTHING IS CHECKABLE/);
    assert.match(text, /no mutation score is claimed/);
    assert.ok(!/mutation score:/.test(text));
    assert.ok(!existsSync(join(out, 'report.md')), 'no report may be written for an empty design');
    assert.equal(JSON.parse(readFileSync(join(out, 'design-model.json'), 'utf8')).counts.checkable_fraction, 0);
  });

  test('--sidecar on a .cir is a usage error, and the .cir path is unchanged', async () => {
    assert.equal(await main(['verify', join(FIX, 'divider-rc.cir'), '--sidecar', SIDECAR, '--checks', join(FIX, 'checks-weak.md')], quiet), 2);
    const code = await main(['verify', join(FIX, 'divider-rc.cir'), '--checks', join(FIX, 'checks-weak.md'), '--out', join(tmp(), 'r'), '--limit', '2', '--quiet'], quiet);
    assert.ok([0, 1].includes(code));
  });

  test('a bad sidecar is a usage error with a message', async () => {
    const p = join(tmp(), 'bad.json');
    writeFileSync(p, '{"version":1,"oops":true}');
    const lines = [];
    const code = await main(['verify', DIVIDER, '--sidecar', p, '--checks', join(FIX, 'divider.checks.md')], { log: s => lines.push(s), error: s => lines.push(s) });
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /unknown key "oops"/);
  });
});

describe('check net names and aliases', () => {
  const run = async (sidecarObj, checks) => {
    const d = tmp();
    const sc = join(d, 's.json'); writeFileSync(sc, JSON.stringify(sidecarObj));
    const ck = join(d, 'c.md'); writeFileSync(ck, checks);
    const lines = [];
    const code = await main(['verify', DIVIDER, '--sidecar', sc, '--checks', ck, '--out', join(d, 'out'), '--limit', '1'], { log: s => lines.push(s), error: s => lines.push(s) });
    return { code, text: lines.join('\n') };
  };
  const SRC = [{ ref: 'V1', kind: 'vdc', plus: 'VIN', minus: 'GND', volts: 5 }];

  test('a check on a net name the deck does not have is refused, with a hint, never run', async () => {
    const r = await run({ version: 1, sources: SRC }, '## Simulation\n\nscope: nets [/MID]\nanalysis: op\nassert: V(/MID) between 2 and 3\n');
    assert.equal(r.code, 2);
    assert.match(r.text, /check net "\/MID" \(scope\) .*calls this net "MID"/);
    const s = await run({ version: 1, sources: SRC }, '## Simulation\n\nscope: nets [MID]\nanalysis: op\nsource: CC9=1\nassert: V(MID) between 2 and 3\n');
    assert.equal(s.code, 2);
    assert.match(s.text, /"CC9" \(source\)/);
    assert.ok(!/mutation score/.test(s.text));
  });

  test('an alias gives `source:` a legal name for a net it could not name, and real ngspice honours it', async () => {
    // Names like +5V cannot be source ports; here VIN stands in, reached through the alias VINA.
    const r = await run({ version: 1, aliases: [{ name: 'VINA', net: 'VIN' }] }, '## Simulation\n\nscope: nets [MID, VINA]\nanalysis: op\nsource: VINA=5\nassert: V(MID) between 2.480 and 2.495\n');
    assert.ok([0, 1].includes(r.code), r.text);
    assert.match(r.text, /contract-clean/);
    const p = join(tmp(), 'a.json');
    writeFileSync(p, JSON.stringify({ version: 1, aliases: [{ name: 'VINA', net: 'VIN' }] }));
    const built = await buildDesign({ schematic: DIVIDER, sidecar: p });
    assert.ok(built.netlist.includes('Ralias_VINA VINA VIN 1e-3'));
    assert.deepEqual(built.manifest.aliases, [{ name: 'VINA', net: 'VIN', element: 'Ralias_VINA' }]);
    assert.throws(() => validateSidecar({ version: 1, aliases: [{ name: '+5V', net: 'VIN' }] }), AdapterError);
  });
});

test('a model file may set initial conditions inside its own subcircuits, never on the design', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-ic-'));
  writeFileSync(join(dir, 'ok.lib'), '.subckt BLK a b\nR1 a q 1k\nC1 q b 1n\n.ic v(q) 0\n.nodeset v(q)=0\n.ends BLK\n');
  writeFileSync(join(dir, 'top.lib'), '.subckt BLK a b\nR1 a b 1k\n.ends BLK\n.ic v(out) 5\n');
  const ok = loadModelFile(dir, 'ok.lib');
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.text, /\.ic v\(q\) 0/);
  const top = loadModelFile(dir, 'top.lib');
  assert.equal(top.ok, false);
  assert.match(top.detail, /\.ic is not allowed/);
});

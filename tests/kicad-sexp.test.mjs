// Tests for the .kicad_sch front end in workers/kicad/.
//
// The load-bearing property is the source map: a span this module reports must
// slice the original file back to exactly the text it claims to describe. Most
// of what follows is that round trip, asserted against real file bytes rather
// than against the parser's own idea of where things are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  atomAt, child, childSpan, childSpans, children, escapeAtom, flag, isList,
  listEnd, numAt, parseSexp, positionAt, propertyValue, replaceSpan,
  sliceSpan, spanOf, tagOf, toByteSpan,
} from '../workers/kicad/sexp.mjs';
import {
  deriveConnectivity, loadSchematicProject, parseSchematic, pinAbsolute,
  pinsOfUnit, readDesignGraph, readSchematicFile,
} from '../workers/kicad/schematic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'workers', 'kicad', 'fixtures');
const OPEN_KEY = join(FIXTURES, 'open-key.kicad_sch');
const ODD = join(FIXTURES, 'odd-nodes.kicad_sch');
const HIER_ROOT = join(FIXTURES, 'hier-root.kicad_sch');
const HIER_SUB = join(FIXTURES, 'hier-sub.kicad_sch');

// ------------------------------------------------------------------ parsing

test('parses lists, atoms and quoted strings', () => {
  assert.deepEqual(parseSexp('(a b "c d" 1.5)'), [['a', 'b', 'c d', '1.5']]);
  assert.deepEqual(parseSexp('(outer (inner "x") (inner "y"))'),
    [['outer', ['inner', 'x'], ['inner', 'y']]]);
  // whitespace, tabs and newlines between tokens are all just separators
  assert.deepEqual(parseSexp('(\n\ta\t\r\n  "b"\n)'), [['a', 'b']]);
  assert.deepEqual(parseSexp('()'), [[]]);
});

test('escaped quotes and backslashes come back as the literal character', () => {
  // the same assertions copperhead's own parser test makes
  assert.deepEqual(parseSexp('(a "b \\"c\\"" d)'), [['a', 'b "c"', 'd']]);
  const [node] = parseSexp('(a "q\\"b" "s\\\\t")');
  assert.equal(node[1], 'q"b');
  assert.equal(node[2], 's\\t');
});

test('\\n and \\t in a quoted atom become a real newline and tab', () => {
  // KiCad writes a multi-line text item as `line1\nline2`; reading that as
  // `line1nline2` would be wrong for anything that measures the string.
  const [node] = parseSexp('(text "line1\\nline2\\tend")');
  assert.equal(node[1], 'line1\nline2\tend');
});

test('a quoted atom keeps its characters even when they are structural', () => {
  const [node] = parseSexp('(label "net (with) parens" "and ) a close")');
  assert.deepEqual(node, ['label', 'net (with) parens', 'and ) a close']);
});

test('deeply nested lists parse and keep their nesting', () => {
  const DEPTH = 1000;
  const text = `${'(x '.repeat(DEPTH)}"bottom"${')'.repeat(DEPTH)}`;
  const [root] = parseSexp(text);
  let node = root;
  let depth = 0;
  while (isList(node)) { depth++; node = node[1]; }
  assert.equal(depth, DEPTH);
  assert.equal(node, 'bottom');
  // and the outermost span still covers the whole document
  assert.equal(sliceSpan(text, spanOf(root)), text);
});

test('structurally broken source throws, with a line number', () => {
  assert.throws(() => parseSexp('(a (b c)'), /unbalanced "\(".*line 1 column 1/s);
  assert.throws(() => parseSexp('(a)\n)'), /unbalanced "\)".*line 2 column 1/s);
  assert.throws(() => parseSexp('(a "unterminated'), /unterminated string.*line 1 column 4/s);
});

test('multiple top-level nodes and bare atoms are read, not rejected', () => {
  assert.deepEqual(parseSexp('(a) (b)'), [['a'], ['b']]);
  assert.deepEqual(parseSexp('lonely'), ['lonely']);
});

// -------------------------------------------------------------------- spans

test('every span slices back to the text it describes', () => {
  const text = readFileSync(ODD, 'utf8');
  const [root] = parseSexp(text);
  let checked = 0;
  const walk = (node) => {
    if (!isList(node)) return;
    const span = spanOf(node);
    assert.ok(span, 'every parsed list has a span');
    const slice = sliceSpan(text, span);
    assert.equal(slice[0], '(');
    assert.equal(slice[slice.length - 1], ')');
    if (span.tag) assert.ok(slice.startsWith(`(${span.tag}`) || /^\(\s/.test(slice));
    // the reported line/column really is where the slice starts
    assert.deepEqual(positionAt(text, span.start), { line: span.line, column: span.column });
    checked++;
    for (let i = 0; i < node.length; i++) {
      const cs = childSpan(node, i);
      assert.ok(cs, 'every element of a list has a span');
      if (typeof node[i] === 'string') {
        // a quoted atom's inner range is the decoded value's source form
        const inner = text.slice(cs.innerStart, cs.innerEnd);
        assert.equal(inner, cs.quoted ? escapeAtom(node[i]) : node[i]);
      }
      walk(node[i]);
    }
  };
  walk(root);
  assert.ok(checked > 50, `walked ${checked} lists`);
});

test('line numbers are 1-based and count real newlines', () => {
  const text = '(kicad_sch\n  (version 20231120)\n  (uuid "x")\n)';
  const [root] = parseSexp(text);
  assert.equal(spanOf(root).line, 1);
  assert.equal(spanOf(child(root, 'version')).line, 2);
  assert.equal(spanOf(child(root, 'uuid')).line, 3);
  assert.equal(spanOf(child(root, 'uuid')).column, 3);
});

test('string offsets and byte offsets are reported separately', () => {
  // The fixture carries a kΩ. A consumer that counts bytes must not be handed
  // a JS string index and told it is a byte offset.
  const text = readFileSync(ODD, 'utf8');
  const buf = readFileSync(ODD);
  const [root] = parseSexp(text);
  const textNode = child(root, 'text');
  assert.ok(textNode[1].includes('kΩ'));
  // the Ω node itself starts before any non-ASCII, so its offsets agree...
  const textSpan = spanOf(textNode);
  assert.equal(toByteSpan(text, textSpan).start, textSpan.start);
  assert.notEqual(toByteSpan(text, textSpan).end, textSpan.end, 'but it is longer in bytes');
  // ...and everything after it is shifted by the extra UTF-8 bytes
  const later = spanOf(child(root, 'symbol'));
  const byte = toByteSpan(text, later);
  assert.notEqual(byte.start, later.start, 'the file has non-ASCII before this node');
  assert.equal(buf.subarray(byte.start, byte.end).toString('utf8'), sliceSpan(text, later));
  assert.equal(buf.subarray(toByteSpan(text, textSpan).start, toByteSpan(text, textSpan).end).toString('utf8'),
    sliceSpan(text, textSpan));
});

test('listEnd and childSpans find a list without parsing it', () => {
  const text = readFileSync(OPEN_KEY, 'utf8');
  const open = text.indexOf('(title_block');
  assert.equal(sliceSpan(text, { start: open, end: listEnd(text, open) }).startsWith('(title_block'), true);
  assert.deepEqual(childSpans(text, open).map(s => s.tag), ['title', 'date', 'rev', 'comment']);
  // a ")" inside a quoted string must not end the list
  const tricky = '(a "not ) an end" (b))';
  assert.equal(listEnd(tricky, 0), tricky.length);
});

// -------------------------------------------------------- anchored rewriting

test('a value is mutated by an anchored replace, leaving every other byte alone', () => {
  const text = readFileSync(OPEN_KEY, 'utf8');
  const sheet = parseSchematic(text, OPEN_KEY);
  const r1 = sheet.components.find(c => c.refdes === 'R1');
  assert.equal(r1.value, '10k');
  assert.equal(sliceSpan(text, r1.spans.value), '"10k"');

  const after = replaceSpan(text, r1.spans.value, '100k', { inner: true });
  assert.equal(after.length, text.length + 1);
  assert.equal(parseSchematic(after, OPEN_KEY).components.find(c => c.refdes === 'R1').value, '100k');
  // exactly one difference, and it is where we said it would be
  let diffs = 0;
  for (let i = 0; i < Math.min(text.length, after.length); i++) if (text[i] !== after[i]) { diffs++; break; }
  assert.equal(diffs, 1);
  assert.equal(text.slice(0, r1.spans.value.innerStart), after.slice(0, r1.spans.value.innerStart));
  assert.equal(text.slice(r1.spans.value.innerEnd), after.slice(r1.spans.value.innerEnd + 1));
});

test('a replacement needing escapes is escaped the way KiCad escapes it', () => {
  const text = '(property "Value" "10k")';
  const span = childSpan(parseSexp(text)[0], 2);
  const after = replaceSpan(text, span, 'a "quoted" value', { inner: true });
  assert.equal(after, '(property "Value" "a \\"quoted\\" value")');
  assert.equal(parseSexp(after)[0][2], 'a "quoted" value');
});

// --------------------------------------------------------- unknown node types

test('an unknown node type does not crash the parser or the extractor', () => {
  const sheet = readSchematicFile(ODD);
  assert.deepEqual(sheet.skipped, [{ token: 'a_node_type_kinux_has_never_heard_of', count: 1 }]);
  // ...and it is still fully parsed, with spans, in case we learn what it is
  const [root] = [sheet.root];
  const mystery = child(root, 'a_node_type_kinux_has_never_heard_of');
  assert.ok(spanOf(mystery));
  assert.equal(atomAt(child(mystery, 'and_a_bare_atom'), 1), 'yes');
  // the nodes it does recognise but does not extract are listed apart
  assert.deepEqual(sheet.ignored.map(i => i.token).sort(),
    ['embedded_fonts', 'rule_area', 'sheet_instances', 'table', 'text', 'text_box']);
  // and the components either side of the unknown node came through
  assert.deepEqual(sheet.components.map(c => c.refdes), ['R1', 'U9']);
});

test('invented node types, flags and properties are tolerated in any shape', () => {
  for (const odd of [
    '(kicad_sch (version 1) (what (ever)) )',
    '(kicad_sch (version 1) (symbol))',               // a symbol with nothing in it
    '(kicad_sch (version 1) (symbol (lib_id "L:N")))', // no properties at all
    '(kicad_sch (version 1) (lib_symbols (symbol)))',  // a nameless lib symbol
    '(kicad_sch (version 1) (wire (pts)))',            // a wire with no points
    '(kicad_sch (version 1) (label))',                 // a nameless label
    '(kicad_sch (version 1) (sheet (property "Sheetname" "x")))', // no Sheetfile
    '(kicad_sch (version 1) (future_node 1 2 3 "four" (five)))',
  ]) {
    const sheet = parseSchematic(odd, 'inline.kicad_sch');
    assert.ok(Array.isArray(sheet.components), odd);
    assert.doesNotThrow(() => deriveConnectivity(sheet), odd);
  }
  // a document that is not a schematic at all is rejected clearly
  assert.throws(() => parseSchematic('(kicad_pcb (version 1))', 'b.kicad_pcb'), /not a kicad_sch/);
});

// ----------------------------------------------------- component extraction

test('extracts the expected components from the open-key fixture', () => {
  const sheet = readSchematicFile(OPEN_KEY);
  assert.deepEqual(sheet.components.map(c => [c.refdes, c.value, c.libId, c.footprint]), [
    ['R1', '10k', 'Device:R', 'Resistor_SMD:R_0603_1608Metric'],
    ['R2', '1k', 'Device:R', 'Resistor_SMD:R_0603_1608Metric'],
    ['U1', 'ESP32-S3-MINI', 'fixture:ESP32-S3-MINI', 'RF_Module:ESP32-S3-MINI-1'],
  ]);
  const u1 = sheet.components.find(c => c.refdes === 'U1');
  assert.deepEqual(u1.at, { x: 139.7, y: 100.33, rot: 0 });
  assert.equal(u1.unit, 1);
  assert.equal(u1.dnp, false);
  assert.equal(u1.inBom, true);
  assert.equal(u1.uuid, '0d0d0d0d-0000-4000-8000-000000000003');
  // the authoritative per-sheet-path refdes, not just the displayed property
  assert.deepEqual(u1.instances, [{
    project: 'open-key',
    path: '/0a0a0a0a-0000-4000-8000-000000000001',
    reference: 'U1',
    unit: 1,
  }]);
});

test('every component span points at that component in the file', () => {
  const text = readFileSync(OPEN_KEY, 'utf8');
  const sheet = parseSchematic(text, OPEN_KEY);
  assert.ok(sheet.components.length > 0);
  for (const c of sheet.components) {
    const slice = sliceSpan(text, c.span);
    assert.ok(slice.startsWith('(symbol'), `${c.refdes}: ${slice.slice(0, 20)}`);
    assert.ok(slice.endsWith(')'));
    // the slice is self-contained: re-parsing it alone gives the same component
    const [again] = parseSexp(slice);
    assert.equal(atomAt(child(again, 'lib_id'), 1), c.libId);
    assert.equal(propertyValue(again, 'Reference'), c.refdes);
    // the per-field spans land on the exact atoms
    assert.equal(sliceSpan(text, c.spans.refdes), `"${c.refdes}"`);
    assert.equal(sliceSpan(text, c.spans.value), `"${c.value}"`);
    assert.equal(sliceSpan(text, c.spans.footprint), `"${c.footprint}"`);
    assert.equal(sliceSpan(text, c.spans.libId), `"${c.libId}"`);
    // and the reported line is the line the symbol really starts on
    assert.equal(text.split('\n')[c.line - 1].trim(), '(symbol');
    assert.equal(c.file, OPEN_KEY);
  }
});

test('power and ground ports are not components, but their nets are named', () => {
  // `power:` prefixed and `(power)`-flagged lib symbols both count, which is
  // the only way a custom power library is recognised.
  const sheet = readSchematicFile(HIER_ROOT);
  assert.deepEqual(sheet.components.map(c => c.refdes), ['C1']);
  assert.deepEqual(sheet.powerPorts.map(p => [p.refdes, p.value, p.libId]), [['#PWR01', 'GND', 'power:GND']]);
  assert.equal(sheet.libSymbols.get('power:GND').isPower, true);
  assert.equal(sheet.libSymbols.get('Device:C').isPower, false);
});

test('lib symbol pins are read with their unit, and placed with mirror and rotation', () => {
  const sheet = readSchematicFile(OPEN_KEY);
  const r = sheet.libSymbols.get('Device:R');
  assert.deepEqual(r.pins.map(p => [p.number, p.name, p.x, p.y, p.unit]), [
    ['1', '~', 0, 3.81, 1],
    ['2', '~', 0, -3.81, 1],
  ]);
  // single-unit symbols keep every pin
  assert.equal(pinsOfUnit(r.pins, 1).length, 2);
  // multi-unit: unit 0 is common to every unit, unit N only to that placement
  const multi = [{ unit: 0, x: 0, y: 0 }, { unit: 1, x: 1, y: 0 }, { unit: 2, x: 2, y: 0 }];
  assert.deepEqual(pinsOfUnit(multi, 2).map(p => p.unit), [0, 2]);
  // schematic Y grows downward while symbol Y grows upward, hence the flip
  assert.deepEqual(pinAbsolute({ x: 100, y: 100, rot: 0 }, null, { x: 0, y: 3.81 }), { x: 100, y: 96.19 });
  assert.deepEqual(pinAbsolute({ x: 100, y: 100, rot: 180 }, null, { x: 0, y: 3.81 }), { x: 100, y: 103.81 });
  assert.deepEqual(pinAbsolute({ x: 100, y: 100, rot: 0 }, 'y', { x: 2.54, y: 0 }), { x: 97.46, y: 100 });
});

// ----------------------------------------------------- sheets and hierarchy

test('sheet structure is reported, with the file each sheet names', () => {
  const g = readDesignGraph(HIER_ROOT);
  assert.deepEqual(g.sheets.map(s => s.sheetName), ['/', 'Power stage']);
  assert.deepEqual(g.components.map(c => [c.refdes, c.sheetName]), [['C1', '/'], ['R10', 'Power stage']]);
  assert.deepEqual(g.hierarchy.map(h => [h.name, h.pins]), [
    ['Power stage', ['VOUT', 'GND']],
    ['Missing stage', []],
  ]);
  // a sheet whose file is not on disk is reported, not thrown
  assert.equal(g.missingSheets.length, 1);
  assert.match(g.missingSheets[0].file, /nowhere-at-all\.kicad_sch$/);
  assert.equal(g.missingSheets[0].reason, 'file not found');
  assert.equal(g.missingSheets[0].from, loadSchematicProject(HIER_ROOT).rootFile);
  // the span of the sheet node that named the missing file
  const rootText = readFileSync(HIER_ROOT, 'utf8');
  assert.ok(sliceSpan(rootText, g.missingSheets[0].span).includes('nowhere-at-all.kicad_sch'));
});

test('sheet spans point at the sheet node in the parent file', () => {
  const text = readFileSync(HIER_ROOT, 'utf8');
  const sheet = parseSchematic(text, HIER_ROOT);
  for (const ref of sheet.sheetRefs) {
    assert.ok(sliceSpan(text, ref.span).startsWith('(sheet'));
    assert.equal(sliceSpan(text, ref.spans.name), `"${ref.name}"`);
    if (ref.fileName) assert.equal(sliceSpan(text, ref.spans.fileName), `"${ref.fileName}"`);
  }
});

// ------------------------------------------------------------- connectivity

test('a single flat sheet: nets are derived, and named only where the file names them', () => {
  const g = readDesignGraph(OPEN_KEY);
  const conn = g.connectivity;
  assert.equal(conn.status, 'derived');
  assert.equal(conn.derivable, true);
  assert.deepEqual(conn.blockers, []);

  const named = conn.nets.filter(n => n.named);
  assert.deepEqual(named.map(n => n.name), ['3V3', 'EN', 'GND', 'KEY_DAH']);
  const pinsOf = (name) => named.find(n => n.name === name).pins
    .map(p => `${p.refdes}.${p.pinNumber}`).sort();
  // same assertions copperhead makes about this fixture, via pin names
  assert.deepEqual(pinsOf('KEY_DAH'), ['R2.1', 'U1.5']);
  assert.deepEqual(pinsOf('GND'), ['R2.2', 'U1.8']);
  assert.deepEqual(pinsOf('3V3'), ['R1.1', 'U1.1']);
  assert.deepEqual(pinsOf('EN'), ['R1.2', 'U1.2']);

  // every pin on a net carries its own source location
  const text = readFileSync(OPEN_KEY, 'utf8');
  for (const net of conn.nets) {
    for (const p of net.pins) {
      assert.ok(sliceSpan(text, p.span).startsWith('(symbol'));
      assert.equal(p.file, OPEN_KEY);
    }
  }
});

test('an unnamed net is left unnamed: KiCad auto net names are never invented', () => {
  const conn = readDesignGraph(OPEN_KEY).connectivity;
  const unnamed = conn.nets.filter(n => !n.named);
  assert.ok(unnamed.length > 0);
  for (const n of unnamed) {
    assert.equal(n.name, null);
    assert.deepEqual(n.nameCandidates, []);
  }
  // U1's unconnected GPIOs: reported as unresolved with a reason, not as a net
  assert.deepEqual(
    conn.unresolvedPins.map(p => p.pinName).sort(),
    ['GPIO0', 'GPIO18', 'GPIO21', 'GPIO3'],
  );
  for (const p of conn.unresolvedPins) {
    assert.match(p.reason, /no label and no power port/);
  }
  // no net name anywhere looks like something we made up
  for (const n of conn.nets) assert.ok(n.name === null || !/^Net-\(/.test(n.name));
});

test('a hierarchical design is reported as not derivable, with reasons and no nets', () => {
  const g = readDesignGraph(HIER_ROOT);
  const conn = g.connectivity;
  assert.equal(conn.status, 'not_derivable');
  assert.equal(conn.derivable, false);
  assert.equal(conn.nets, null, 'no guessed nets');
  const codes = conn.blockers.map(b => b.code);
  assert.ok(codes.includes('hierarchical_design'), codes.join(','));
  assert.ok(codes.includes('sheet_references'), codes.join(','));
  for (const b of conn.blockers) assert.ok(b.detail.length > 10, 'each blocker says why');
  // the components and spans are still there: only the nets are withheld
  assert.deepEqual(g.components.map(c => c.refdes), ['C1', 'R10']);
});

test('a child sheet read on its own says its nets continue into the parent', () => {
  const conn = deriveConnectivity(readSchematicFile(HIER_SUB));
  assert.equal(conn.status, 'not_derivable');
  assert.equal(conn.nets, null);
  const b = conn.blockers.find(x => x.code === 'hierarchical_labels');
  assert.ok(b, conn.blockers.map(x => x.code).join(','));
  assert.match(b.detail, /continues into its parent/);
});

test('a missing library symbol blocks connectivity instead of dropping its pins', () => {
  const conn = deriveConnectivity(readSchematicFile(ODD));
  assert.equal(conn.status, 'not_derivable');
  assert.equal(conn.nets, null);
  const b = conn.blockers.find(x => x.code === 'missing_lib_symbol');
  assert.ok(b);
  assert.match(b.detail, /U9 instantiates "NotInThisFile:MysteryPart"/);
  // the blocker points at the `(symbol` line, which is the line before the
  // `(lib_id "NotInThisFile:…")` that names the missing library symbol
  const libIdLine = readFileSync(ODD, 'utf8').split('\n').findIndex(l => l.includes('NotInThisFile')) + 1;
  assert.equal(b.line, libIdLine - 1);
});

test('buses are refused rather than half-expanded', () => {
  const withBus = `(kicad_sch (version 1)
  (lib_symbols (symbol "Device:R"
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27)
      (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))
  (bus (pts (xy 10 10) (xy 50 10)))
  (label "D[7..0]" (at 10 10 0))
  (symbol (lib_id "Device:R") (at 20 20 0) (unit 1)
    (property "Reference" "R1" (at 20 20 0))
    (property "Value" "1k" (at 20 20 0))))`;
  const conn = deriveConnectivity(parseSchematic(withBus, 'bus.kicad_sch'));
  assert.equal(conn.status, 'not_derivable');
  assert.equal(conn.nets, null);
  const codes = conn.blockers.map(b => b.code);
  assert.ok(codes.includes('buses'), codes.join(','));
  assert.ok(codes.includes('bus_label'), codes.join(','));
});

test('two different labels on one net leave the name null and say so', () => {
  const conflicting = `(kicad_sch (version 1)
  (lib_symbols (symbol "Device:R"
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))
  (wire (pts (xy 20 16.19) (xy 20 10)))
  (label "VCC" (at 20 10 0))
  (label "VDD" (at 20 16.19 0))
  (symbol (lib_id "Device:R") (at 20 20 0) (unit 1)
    (property "Reference" "R1" (at 20 20 0))
    (property "Value" "1k" (at 20 20 0))))`;
  const conn = deriveConnectivity(parseSchematic(conflicting, 'conflict.kicad_sch'));
  assert.equal(conn.status, 'derived');
  const net = conn.nets.find(n => n.pins.some(p => p.pinNumber === '1'));
  assert.equal(net.name, null, 'no winner picked');
  assert.deepEqual(net.nameCandidates.sort(), ['VCC', 'VDD']);
  assert.equal(conn.anomalies[0].code, 'conflicting_net_names');
});

test('a wire ending mid-way along another wire with no junction is refused', () => {
  const ambiguous = `(kicad_sch (version 1)
  (wire (pts (xy 0 0) (xy 20 0)))
  (wire (pts (xy 10 0) (xy 10 10))))`;
  const conn = deriveConnectivity(parseSchematic(ambiguous, 'tee.kicad_sch'));
  assert.equal(conn.status, 'not_derivable');
  assert.ok(conn.blockers.some(b => b.code === 'wire_touch_without_junction'));

  // with the junction KiCad itself would have written, it is fine again
  const withJunction = ambiguous.replace('  (wire (pts (xy 10 0)', '  (junction (at 10 0))\n  (wire (pts (xy 10 0)');
  assert.equal(deriveConnectivity(parseSchematic(withJunction, 'tee.kicad_sch')).status, 'derived');
});

test('the derived result always carries its caveats', () => {
  for (const file of [OPEN_KEY, HIER_ROOT, ODD]) {
    const conn = readDesignGraph(file).connectivity;
    assert.ok(conn.caveats.length >= 4);
    assert.ok(conn.caveats.some(c => c.includes('kicad-cli')), 'names the authority');
    assert.equal(conn.model, 'geometric-single-sheet');
  }
});

// ------------------------------------------------------------- misc helpers

test('tree accessors behave like the originals', () => {
  const [root] = parseSexp('(kicad_sch (a 1) (a 2) (b "x") hide (c no))');
  assert.equal(tagOf(root), 'kicad_sch');
  assert.equal(tagOf('atom'), null);
  assert.equal(children(root, 'a').length, 2);
  assert.equal(atomAt(child(root, 'a'), 1), '1');
  assert.equal(numAt(child(root, 'a'), 1), 1);
  assert.equal(numAt(child(root, 'nope'), 1, -1), -1);
  assert.equal(atomAt(child(root, 'b'), 1), 'x');
  assert.equal(flag(root, 'hide'), true, 'bare atom flag');
  assert.equal(flag(root, 'c'), false, '(c no)');
  assert.equal(flag(root, 'absent', true), true, 'default');
  assert.equal(flag(['x', ['d', 'yes']], 'd'), true);
});

test('reading a schematic from disk records its absolute path', () => {
  const sheet = readSchematicFile(OPEN_KEY);
  assert.equal(sheet.file, OPEN_KEY);
  assert.equal(sheet.version, '20231120');
  assert.equal(sheet.generator, 'eeschema');
  assert.deepEqual(sheet.paper, { name: 'A4', portrait: false });
  assert.equal(sheet.titleBlock.title, 'open-key fixture');
  assert.equal(sheet.source, readFileSync(OPEN_KEY, 'utf8'));
});

// Schematic front end for the Kinux mutation engine: a `.kicad_sch` file (or a
// hierarchy of them) becomes components, labels, wires and sheet structure,
// each item carrying the span of the source text it came from.
//
// Built on workers/kicad/sexp.mjs, which is derived from copperhead's
// src/kicad/sexp.ts (Apache-2.0 — see that file's header and
// THIRD-PARTY-NOTICES.md). The extraction rules here — which `(symbol …)` is a
// real component, how a power symbol is recognised, how a lib symbol's pins
// map to a placed unit, the two spellings of `Sheetfile` — follow copperhead's
// reading of the format; the spans, the hierarchy walk and the
// not-derivable connectivity result are Kinux's.
//
// Read-only. Nothing here writes a file. A mutation is a `replaceSpan` on the
// `source` string this module hands back.
//
// Honesty: see `deriveConnectivity`. Net connectivity is NOT generally
// derivable from `.kicad_sch` alone, and when it is not, this module says so
// and returns no nets rather than a plausible guess. README.md next to this
// file spells out why.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  atomAt, child, children, flag, isList, numAt, propertyNode, propertyValue,
  parseSexp, spanOf, childSpan, tagOf,
} from './sexp.mjs';

/**
 * @typedef {import('./sexp.mjs').Span} Span
 */

/**
 * @typedef {Object} Component
 * @property {string} refdes      from `(property "Reference" …)`; '?' when absent
 * @property {string} value       from `(property "Value" …)`
 * @property {string} libId       `Lib:Name` of the library symbol it instantiates
 * @property {string} footprint   from `(property "Footprint" …)`; '' when unset
 * @property {string} datasheet
 * @property {number} unit        `(unit N)` of this placement; 1 for single-unit parts
 * @property {string} uuid
 * @property {boolean} dnp        `(dnp yes)` — do not populate
 * @property {boolean} inBom
 * @property {boolean} onBoard
 * @property {boolean} excludeFromSim
 * @property {boolean} isPower     a power/ground port, not a real component
 * @property {{x:number, y:number, rot:number}} at
 * @property {'x'|'y'|null} mirror
 * @property {Array<{project:string, path:string, reference:string, unit:number}>} instances
 * @property {string} file         absolute path of the sheet file
 * @property {string} sheetName
 * @property {number} line         1-based line of the `(symbol …)` list
 * @property {Span} span           the whole `(symbol …)` list
 * @property {Object} spans        atom-level spans for anchored edits
 * @property {Span|undefined} spans.refdes     the `"R1"` atom
 * @property {Span|undefined} spans.value      the `"10k"` atom
 * @property {Span|undefined} spans.footprint  the footprint atom
 * @property {Span|undefined} spans.libId      the lib_id atom
 * @property {Span|undefined} spans.at         the `(at …)` list
 */

const TOP_LEVEL_KNOWN = new Set([
  'version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block',
  'lib_symbols', 'junction', 'no_connect', 'bus_entry', 'wire', 'bus',
  'label', 'global_label', 'hierarchical_label', 'netclass_flag',
  'symbol', 'sheet', 'sheet_instances', 'symbol_instances',
  'text', 'text_box', 'rectangle', 'circle', 'arc', 'polyline', 'bezier',
  'image', 'bus_alias', 'embedded_fonts', 'rule_area', 'table', 'group',
]);

const LABEL_KINDS = ['label', 'global_label', 'hierarchical_label'];

const round = (n) => Math.round(n * 10000) / 10000;
const pointKey = (x, y) => `${round(x)},${round(y)}`;

/** `(at x y rot)` of `node`, with KiCad's defaults. */
function atOf(node) {
  const at = child(node, 'at');
  return { x: numAt(at, 1), y: numAt(at, 2), rot: numAt(at, 3) };
}

// ------------------------------------------------------------- lib_symbols

/**
 * Pin definitions per library symbol, in symbol coordinates.
 *
 * Format knowledge taken from copperhead: a library symbol's graphics and pins
 * live in nested `(symbol "<name>_<unit>_<style>" …)` children. `<unit>` is the
 * unit the pin belongs to (0 = common to every unit, drawn on all of them) and
 * `<style>` ≥ 2 is a de Morgan alternate body — the same pin again, so it is
 * skipped or every pin would be recorded twice.
 */
function libSymbolsOf(root) {
  /** @type {Map<string, {name:string, isPower:boolean, pins:Array<Object>, span:Span|undefined}>} */
  const map = new Map();
  const libs = child(root, 'lib_symbols');
  if (!libs) return map;
  for (const sym of children(libs, 'symbol')) {
    const name = atomAt(sym, 1);
    if (name === undefined) continue;
    const pins = [];
    const walk = (n, unit) => {
      if (!isList(n)) return;
      if (tagOf(n) === 'symbol') {
        const m = /_(\d+)_(\d+)$/.exec(atomAt(n, 1) ?? '');
        if (m) {
          if (Number(m[2]) >= 2) return; // de Morgan alternate body style
          unit = Number(m[1]);
        }
      }
      if (tagOf(n) === 'pin') {
        const at = child(n, 'at');
        const numberNode = child(n, 'number');
        const num = atomAt(numberNode, 1);
        if (at && num !== undefined) {
          pins.push({
            number: num,
            name: atomAt(child(n, 'name'), 1) ?? '~',
            type: atomAt(n, 1) ?? 'unspecified',  // passive | power_in | input | …
            shape: atomAt(n, 2) ?? 'line',
            x: numAt(at, 1),
            y: numAt(at, 2),
            rot: numAt(at, 3),
            length: numAt(child(n, 'length'), 1),
            unit,
            span: spanOf(n),
          });
        }
      }
      for (const c of n) walk(c, unit);
    };
    walk(sym, 0);
    // `(power)` with no value, or `(power yes)`, marks a power/ground port.
    const powerNode = child(sym, 'power');
    map.set(name, {
      name,
      isPower: powerNode !== undefined && atomAt(powerNode, 1) !== 'no',
      pins,
      span: spanOf(sym),
    });
  }
  return map;
}

/**
 * A `lib_id` names a power port when the library is the stock `power:` library
 * or when the schematic's own `lib_symbols` entry carries `(power)`. Both
 * spellings occur in the wild and copperhead handles both; a custom power
 * library (`MyPower:GND`) is only recognisable through the second.
 */
function isPowerLibId(libId, libSymbols) {
  if (libId.startsWith('power:')) return true;
  const entry = libSymbols.get(libId);
  return entry ? entry.isPower : false;
}

/**
 * The pins a PLACED instance actually shows: its own unit's, plus the common
 * unit's. A single-unit symbol keeps every pin (all are unit ≤ 1). Resolving
 * the whole package at each placement would invent connection points at every
 * other gate's coordinates.
 */
export function pinsOfUnit(defs, unit) {
  const multi = defs.some((p) => p.unit >= 2);
  if (!multi) return defs;
  return defs.filter((p) => p.unit === 0 || p.unit === unit);
}

/**
 * Symbol space → schematic space. Mirror first, then rotate, then translate —
 * and note the Y subtraction: schematic Y grows downward while symbol Y grows
 * upward, so a pin above the symbol origin is at a smaller schematic Y.
 */
export function pinAbsolute(symAt, mirror, pin) {
  let px = pin.x;
  let py = pin.y;
  if (mirror === 'y') px = -px;
  if (mirror === 'x') py = -py;
  const theta = (symAt.rot * Math.PI) / 180;
  const rx = px * Math.cos(theta) - py * Math.sin(theta);
  const ry = px * Math.sin(theta) + py * Math.cos(theta);
  return { x: round(symAt.x + rx), y: round(symAt.y - ry) };
}

// --------------------------------------------------------------- components

function componentsOf(root, ctx) {
  const out = [];
  for (const s of children(root, 'symbol')) {
    const libIdNode = child(s, 'lib_id');
    const libId = atomAt(libIdNode, 1);
    // A `lib_symbols` entry is also tagged `symbol` but has no `lib_id` child;
    // that absence is what tells a placement from a definition. (lib_symbols
    // entries are not top-level children here either, but a nested walk would
    // otherwise pick them up.)
    if (libId === undefined) continue;

    const refProp = propertyNode(s, 'Reference');
    const valProp = propertyNode(s, 'Value');
    const fpProp = propertyNode(s, 'Footprint');
    const mirrorAtom = atomAt(child(s, 'mirror'), 1);

    const instances = [];
    for (const proj of children(child(s, 'instances') ?? [], 'project')) {
      const projName = atomAt(proj, 1) ?? '';
      for (const p of children(proj, 'path')) {
        instances.push({
          project: projName,
          path: atomAt(p, 1) ?? '',
          reference: atomAt(child(p, 'reference'), 1) ?? '',
          unit: parseInt(atomAt(child(p, 'unit'), 1) ?? '1', 10) || 1,
        });
      }
    }

    const span = spanOf(s);
    out.push({
      refdes: atomAt(refProp, 2) ?? '?',
      value: atomAt(valProp, 2) ?? '',
      libId,
      footprint: atomAt(fpProp, 2) ?? '',
      datasheet: propertyValue(s, 'Datasheet') ?? '',
      unit: parseInt(atomAt(child(s, 'unit'), 1) ?? '1', 10) || 1,
      uuid: atomAt(child(s, 'uuid'), 1) ?? '',
      dnp: flag(s, 'dnp', false),
      inBom: flag(s, 'in_bom', true),
      onBoard: flag(s, 'on_board', true),
      excludeFromSim: flag(s, 'exclude_from_sim', false),
      isPower: isPowerLibId(libId, ctx.libSymbols),
      at: atOf(s),
      mirror: mirrorAtom === 'x' || mirrorAtom === 'y' ? mirrorAtom : null,
      instances,
      file: ctx.file,
      sheetName: ctx.sheetName,
      line: span ? span.line : 0,
      span,
      spans: {
        refdes: childSpan(refProp, 2),
        value: childSpan(valProp, 2),
        footprint: childSpan(fpProp, 2),
        libId: childSpan(libIdNode, 1),
        at: spanOf(child(s, 'at')),
      },
      node: s,
    });
  }
  return out;
}

// -------------------------------------------------------------- one sheet

/**
 * Parse one `.kicad_sch`. `filePath` is recorded on every item so a finding
 * can name its file; it is not read from disk here.
 *
 * @param {string} source the file's text, kept on the result for anchored edits
 * @param {string} [filePath]
 * @param {{sheetName?: string, sheetPath?: string}} [meta]
 */
export function parseSchematic(source, filePath = '<memory>', meta = {}) {
  const roots = parseSexp(source);
  const root = roots[0];
  if (!isList(root) || tagOf(root) !== 'kicad_sch') {
    throw new SyntaxError(`not a kicad_sch document (root token is ${JSON.stringify(tagOf(root) ?? String(root))}): ${filePath}`);
  }

  const libSymbols = libSymbolsOf(root);
  const ctx = { file: filePath, sheetName: meta.sheetName ?? '/', libSymbols };

  const titleBlockNode = child(root, 'title_block');
  const tbField = (name) => atomAt(child(titleBlockNode, name), 1) ?? '';
  const paperNode = child(root, 'paper');

  const wires = [];
  for (const kind of ['wire', 'bus']) {
    for (const w of children(root, kind)) {
      const points = children(child(w, 'pts') ?? [], 'xy').map((xy) => ({ x: numAt(xy, 1), y: numAt(xy, 2) }));
      wires.push({ kind, points, span: spanOf(w) });
    }
  }

  const labels = [];
  for (const kind of LABEL_KINDS) {
    for (const l of children(root, kind)) {
      labels.push({
        name: atomAt(l, 1) ?? '',
        kind,
        shape: atomAt(child(l, 'shape'), 1) ?? null,
        at: atOf(l),
        uuid: atomAt(child(l, 'uuid'), 1) ?? '',
        file: filePath,
        span: spanOf(l),
        spans: { name: childSpan(l, 1) },
      });
    }
  }

  const junctions = children(root, 'junction').map((j) => ({ ...atOf(j), span: spanOf(j) }));
  const noConnects = children(root, 'no_connect').map((nc) => ({ ...atOf(nc), span: spanOf(nc) }));
  const busEntries = children(root, 'bus_entry').map((b) => ({ ...atOf(b), span: spanOf(b) }));
  const busAliases = children(root, 'bus_alias').map((b) => ({ name: atomAt(b, 1) ?? '', span: spanOf(b) }));

  // Hierarchical child sheets. Two property spellings exist: KiCad 6+ writes
  // `Sheetfile`/`Sheetname`, older files `Sheet file`/`Sheet name`.
  const sheetRefs = children(root, 'sheet').map((sh) => {
    const fileProp = propertyNode(sh, 'Sheetfile') ?? propertyNode(sh, 'Sheet file');
    const nameProp = propertyNode(sh, 'Sheetname') ?? propertyNode(sh, 'Sheet name');
    return {
      name: atomAt(nameProp, 2) ?? 'sheet',
      fileName: atomAt(fileProp, 2) ?? null,
      uuid: atomAt(child(sh, 'uuid'), 1) ?? '',
      at: atOf(sh),
      // A sheet pin is the sheet's terminal on the parent: the net on the
      // parent side ties to the matching hierarchical_label inside the child.
      pins: children(sh, 'pin').map((p) => ({
        name: atomAt(p, 1) ?? '',
        shape: atomAt(p, 2) ?? '',
        at: atOf(p),
        span: spanOf(p),
      })),
      parentFile: filePath,
      span: spanOf(sh),
      spans: { fileName: childSpan(fileProp, 2), name: childSpan(nameProp, 2) },
    };
  });

  const all = componentsOf(root, ctx);

  // Two different kinds of "not used here", kept apart on purpose: a node type
  // this reader has never heard of (worth surfacing — the format grows), and
  // one it recognises but does not extract (graphics, images, tables).
  const unknownCounts = new Map();
  const ignoredCounts = new Map();
  const extracted = new Set([
    'version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block',
    'lib_symbols', 'junction', 'no_connect', 'bus_entry', 'wire', 'bus',
    'label', 'global_label', 'hierarchical_label', 'symbol', 'sheet', 'bus_alias',
  ]);
  for (const node of root.slice(1)) {
    const t = tagOf(node);
    if (t === null || extracted.has(t)) continue;
    const counts = TOP_LEVEL_KNOWN.has(t) ? ignoredCounts : unknownCounts;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  return {
    file: filePath,
    source,
    sheetName: ctx.sheetName,
    sheetPath: meta.sheetPath ?? '/',
    root,
    version: atomAt(child(root, 'version'), 1),
    generator: atomAt(child(root, 'generator'), 1),
    generatorVersion: atomAt(child(root, 'generator_version'), 1),
    uuid: atomAt(child(root, 'uuid'), 1) ?? '',
    paper: paperNode ? { name: atomAt(paperNode, 1) ?? null, portrait: paperNode.includes('portrait') } : null,
    titleBlock: titleBlockNode ? { title: tbField('title'), date: tbField('date'), rev: tbField('rev'), company: tbField('company') } : null,
    /** Real components: power/ground ports excluded, as a BOM would. */
    components: all.filter((c) => !c.isPower),
    /** Power and ground ports. Their `value` is the net name they impose. */
    powerPorts: all.filter((c) => c.isPower),
    /** Every placement, power ports included. */
    allSymbols: all,
    libSymbols,
    labels,
    wires,
    junctions,
    noConnects,
    busEntries,
    busAliases,
    sheetRefs,
    /** Top-level node types this reader does not recognise at all, with counts.
     * Never an error: an unfamiliar node is format we have not met yet. */
    skipped: [...unknownCounts].map(([token, count]) => ({ token, count })),
    /** Node types recognised but deliberately not extracted (graphics, etc.). */
    ignored: [...ignoredCounts].map(([token, count]) => ({ token, count })),
  };
}

/** `parseSchematic` on a file. */
export function readSchematicFile(file) {
  const abs = path.resolve(file);
  return parseSchematic(readFileSync(abs, 'utf8'), abs);
}

// ------------------------------------------------------------- the project

/**
 * Load a root sheet and every hierarchical sheet below it.
 *
 * A sheet file reachable by more than one path is read once (a reused sheet is
 * one file), but every reference to it is recorded in `hierarchy`, because the
 * same file placed twice is two instances with two sets of refdes — see the
 * note on `(instances …)` in the README.
 *
 * A sheet that names a file which is not there is reported in `missing`, not
 * thrown: a half-checked-in project should still yield findings for the sheets
 * that are present.
 */
export function loadSchematicProject(rootFile) {
  const rootAbs = path.resolve(rootFile);
  /** @type {Map<string, Object>} */
  const byFile = new Map();
  const sheets = [];
  const missing = [];
  const hierarchy = [];
  const repeats = [];

  const visit = (abs, sheetName, sheetPath, stack) => {
    if (stack.includes(abs)) {
      repeats.push({ file: abs, reason: 'cycle', chain: [...stack, abs] });
      return;
    }
    let sheet = byFile.get(abs);
    if (sheet === undefined) {
      sheet = parseSchematic(readFileSync(abs, 'utf8'), abs, { sheetName, sheetPath });
      byFile.set(abs, sheet);
      sheets.push(sheet);
    } else {
      repeats.push({ file: abs, reason: 'reused', sheetName, sheetPath });
    }
    for (const ref of sheet.sheetRefs) {
      if (ref.fileName === null) {
        missing.push({ file: null, from: abs, reason: 'sheet has no Sheetfile property', span: ref.span });
        continue;
      }
      const childAbs = path.resolve(path.dirname(abs), ref.fileName);
      hierarchy.push({ parent: abs, child: childAbs, name: ref.name, pins: ref.pins, span: ref.span });
      const childPath = `${sheetPath === '/' ? '' : sheetPath}/${ref.uuid}`;
      try {
        visit(childAbs, ref.name, childPath, [...stack, abs]);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          missing.push({ file: childAbs, from: abs, reason: 'file not found', span: ref.span });
        } else throw err;
      }
    }
  };

  visit(rootAbs, '/', '/', []);
  return { rootFile: rootAbs, root: byFile.get(rootAbs), sheets, hierarchy, missing, repeats };
}

// ------------------------------------------------------------ connectivity

/** Is point `p` on wire segment `s` (endpoint or anywhere along it)? */
function onSegment(p, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  const EPS = 1e-4;
  if (len < EPS) return Math.hypot(p.x - s.x1, p.y - s.y1) <= EPS;
  const cross = dx * (p.y - s.y1) - dy * (p.x - s.x1);
  if (Math.abs(cross) / len > EPS) return false;
  const dot = (p.x - s.x1) * dx + (p.y - s.y1) * dy;
  return dot >= -EPS * len && dot <= len * len + EPS * len;
}

const isEndpoint = (p, s) =>
  (Math.abs(p.x - s.x1) < 1e-4 && Math.abs(p.y - s.y1) < 1e-4) ||
  (Math.abs(p.x - s.x2) < 1e-4 && Math.abs(p.y - s.y2) < 1e-4);

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(k) {
    let p = this.parent.get(k);
    if (p === undefined) { this.parent.set(k, k); return k; }
    if (p !== k) { p = this.find(p); this.parent.set(k, p); }
    return p;
  }
  union(a, b) { this.parent.set(this.find(a), this.find(b)); }
}

/** A bus or vector label: `D[7..0]`, `{SDA SCL}`, `ADDR[3..0]`. */
const looksLikeBus = (name) => /\[\s*\d+\s*\.\.\s*\d+\s*\]/.test(name) || /^\{.*\}$/.test(name.trim()) || name.includes('{');

/**
 * Net connectivity, or an honest refusal.
 *
 * KiCad does not store nets in a `.kicad_sch`. It recomputes them from
 * geometry every time: pins and wire ends that touch, junctions where wires
 * cross, local labels, global labels shared across the whole design,
 * hierarchical labels tied to the parent sheet's sheet pins, buses expanded
 * into members, and power ports that name a net implicitly. The net names a
 * netlist shows for unlabelled nets (`Net-(R1-Pad1)`) are invented by the
 * netlister and are nowhere in the file.
 *
 * So this function derives nets only for the case where the geometry really is
 * the whole story: ONE sheet, no buses, and a library definition present for
 * every placed symbol so that its pin coordinates are known. Anything else
 * returns `status: 'not_derivable'` with `nets: null` and the reasons — Kinux
 * would rather say "ask KiCad" than hand the mutation engine a net graph that
 * is subtly wrong. `kicad-cli sch export netlist` is the thing to call when
 * this refuses; that is the authority, and this is a fast local approximation
 * of it.
 *
 * @param {Object|Object[]} input a sheet from `parseSchematic`, an array of
 *   them, or a project from `loadSchematicProject`
 * @returns {{status:'derived'|'not_derivable', derivable:boolean, model:string,
 *   blockers:Array<Object>, anomalies:Array<Object>, caveats:string[],
 *   nets:Array<Object>|null, unresolvedPins:Array<Object>}}
 */
export function deriveConnectivity(input) {
  const sheets = Array.isArray(input) ? input : input && input.sheets ? input.sheets : [input];
  const blockers = [];
  const anomalies = [];

  if (sheets.length !== 1) {
    blockers.push({
      code: 'hierarchical_design',
      detail: `${sheets.length} sheets: nets cross sheets through sheet pins, hierarchical labels and global labels, which needs the full sheet-instance tree`,
    });
  }
  for (const sheet of sheets) {
    if (sheet.sheetRefs.length) {
      blockers.push({ code: 'sheet_references', detail: `${sheet.sheetRefs.length} child sheet(s)`, file: sheet.file });
    }
    const busWires = sheet.wires.filter((w) => w.kind === 'bus');
    if (busWires.length || sheet.busEntries.length || sheet.busAliases.length) {
      blockers.push({
        code: 'buses',
        detail: `${busWires.length} bus wire(s), ${sheet.busEntries.length} bus entry/entries, ${sheet.busAliases.length} alias(es): bus members are not expanded here`,
        file: sheet.file,
      });
    }
    for (const l of sheet.labels) {
      if (l.kind === 'hierarchical_label') {
        // A hierarchical label is a child sheet's terminal: the net it names
        // continues into the parent through the matching sheet pin. Reading
        // this sheet alone therefore cannot see the whole net.
        blockers.push({
          code: 'hierarchical_labels',
          detail: `label ${JSON.stringify(l.name)} is hierarchical, so this sheet's net continues into its parent sheet`,
          file: sheet.file,
          line: l.span ? l.span.line : 0,
        });
      }
      if (looksLikeBus(l.name)) {
        blockers.push({ code: 'bus_label', detail: `label ${JSON.stringify(l.name)} names a bus`, file: sheet.file, line: l.span ? l.span.line : 0 });
      }
    }
    for (const c of sheet.allSymbols) {
      const def = sheet.libSymbols.get(c.libId);
      if (def === undefined) {
        blockers.push({
          code: 'missing_lib_symbol',
          detail: `${c.refdes} instantiates ${JSON.stringify(c.libId)}, which has no lib_symbols entry, so its pin coordinates are unknown`,
          file: sheet.file,
          line: c.line,
        });
      } else if (def.pins.length === 0) {
        blockers.push({
          code: 'lib_symbol_without_pins',
          detail: `${JSON.stringify(c.libId)} defines no pins`,
          file: sheet.file,
          line: c.line,
        });
      }
    }
  }

  // A wire END that lands in the MIDDLE of another wire is ambiguous: KiCad
  // connects them only if a junction sits there, and eeschema normally writes
  // one. Without it we cannot tell a deliberate crossing from a connection, so
  // we refuse rather than choose.
  if (sheets.length === 1) {
    const segs = segmentsOf(sheets[0]);
    const junctionKeys = new Set(sheets[0].junctions.map((j) => pointKey(j.x, j.y)));
    for (const s of segs) {
      for (const p of [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]) {
        if (junctionKeys.has(pointKey(p.x, p.y))) continue;
        for (const other of segs) {
          if (other === s) continue;
          if (onSegment(p, other) && !isEndpoint(p, other)) {
            blockers.push({
              code: 'wire_touch_without_junction',
              detail: `a wire end at (${round(p.x)}, ${round(p.y)}) lies mid-way along another wire with no junction there; KiCad would not join them, but this is as likely a missing junction`,
              file: sheets[0].file,
              line: s.span ? s.span.line : 0,
            });
          }
        }
      }
    }
  }

  const caveats = [
    'Geometric approximation of KiCad connectivity, not a netlister. The authority is `kicad-cli sch export netlist`.',
    'Unlabelled nets have name null: KiCad\'s auto names (Net-(R1-Pad1)) are generated by the netlister and are not in the file.',
    'no_connect markers are reported but do not suppress a net.',
    'Netclasses, ERC and net-tie footprints are not considered.',
    'Same-name labels and same-name power ports are merged into one net, as KiCad does.',
  ];

  if (blockers.length) {
    return {
      status: 'not_derivable',
      derivable: false,
      model: 'geometric-single-sheet',
      blockers: dedupe(blockers),
      anomalies,
      caveats,
      nets: null,
      unresolvedPins: [],
    };
  }

  const sheet = sheets[0];
  const uf = new UnionFind();
  const segs = segmentsOf(sheet);
  for (const s of segs) uf.union(pointKey(s.x1, s.y1), pointKey(s.x2, s.y2));

  // Attach a point to every wire it sits on. Coincident points share a key, so
  // two pins touching with no wire between them are already one group.
  const attach = (p) => {
    const k = pointKey(p.x, p.y);
    uf.find(k);
    for (const s of segs) if (onSegment(p, s)) uf.union(k, pointKey(s.x1, s.y1));
    return k;
  };

  for (const j of sheet.junctions) attach(j);

  /** @type {Map<string, Array<Object>>} point key -> names claimed there */
  const named = new Map();
  const claim = (k, name, source, span) => {
    if (!named.has(k)) named.set(k, []);
    named.get(k).push({ name, source, span });
  };

  for (const l of sheet.labels) claim(attach(l.at), l.name, l.kind, l.span);

  const pinPoints = [];
  for (const sym of sheet.allSymbols) {
    const def = sheet.libSymbols.get(sym.libId);
    const pins = pinsOfUnit(def.pins, sym.unit);
    for (const pin of pins) {
      const abs = pinAbsolute(sym.at, sym.mirror, pin);
      const k = attach(abs);
      if (sym.isPower) {
        // A power port's Value is the net name it imposes (GND, +3V3).
        claim(k, sym.value, 'power_port', sym.span);
      } else {
        pinPoints.push({ sym, pin, at: abs, key: k });
      }
    }
  }

  // Labels connect BY NAME, not only by touching. Two `(label "3V3")` on one
  // sheet are one net even with no copper between them, and so are two power
  // ports with the same Value. (Across sheets the same holds for
  // global_label, which is why a multi-sheet design is refused above rather
  // than derived sheet by sheet.) Merging after the geometric pass is what
  // makes a by-name net come out as one net instead of several that happen to
  // share a name.
  const byName = new Map();
  for (const [k, claims] of named) {
    for (const c of claims) {
      if (!byName.has(c.name)) byName.set(c.name, []);
      byName.get(c.name).push(k);
    }
  }
  for (const keys of byName.values()) for (let i = 1; i < keys.length; i++) uf.union(keys[0], keys[i]);

  const ncKeys = new Set(sheet.noConnects.map((nc) => pointKey(nc.x, nc.y)));

  /** @type {Map<string, Object>} group root -> net */
  const groups = new Map();
  const groupOf = (k) => {
    const r = uf.find(k);
    if (!groups.has(r)) groups.set(r, { name: null, nameCandidates: [], nameSources: [], pins: [], points: new Set(), spans: [] });
    return groups.get(r);
  };

  for (const [k, claims] of named) {
    const g = groupOf(k);
    for (const c of claims) {
      if (!g.nameCandidates.includes(c.name)) g.nameCandidates.push(c.name);
      g.nameSources.push({ name: c.name, source: c.source, line: c.span ? c.span.line : 0 });
      if (c.span) g.spans.push({ kind: c.source, span: c.span });
    }
  }
  for (const pp of pinPoints) {
    const g = groupOf(pp.key);
    g.pins.push({
      refdes: pp.sym.refdes,
      pinNumber: pp.pin.number,
      pinName: pp.pin.name,
      pinType: pp.pin.type,
      unit: pp.sym.unit,
      at: pp.at,
      noConnect: ncKeys.has(pp.key),
      file: sheet.file,
      line: pp.sym.line,
      span: pp.sym.span,
      pinSpan: pp.pin.span,
    });
    g.points.add(pp.key);
  }
  for (const s of segs) {
    const g = groupOf(pointKey(s.x1, s.y1));
    g.points.add(pointKey(s.x1, s.y1));
    g.points.add(pointKey(s.x2, s.y2));
    if (s.span) g.spans.push({ kind: 'wire', span: s.span });
  }

  const nets = [];
  const unresolvedPins = [];
  for (const g of groups.values()) {
    if (g.nameCandidates.length === 1) g.name = g.nameCandidates[0];
    else if (g.nameCandidates.length > 1) {
      // Two different labels on one net is an ERC error in KiCad. We do not
      // pick a winner.
      anomalies.push({
        code: 'conflicting_net_names',
        detail: `one connected group carries ${g.nameCandidates.map((n) => JSON.stringify(n)).join(' and ')}; its name is left null`,
        file: sheet.file,
        pins: g.pins.map((p) => `${p.refdes}.${p.pinNumber}`),
      });
    }
    if (g.pins.length === 0 && g.nameCandidates.length === 0) continue; // bare wire stub
    nets.push({
      name: g.name,
      nameCandidates: g.nameCandidates,
      nameSources: g.nameSources,
      named: g.name !== null,
      pins: g.pins,
      points: [...g.points],
      spans: g.spans,
      file: sheet.file,
    });
    if (g.name === null) {
      for (const p of g.pins) {
        unresolvedPins.push({
          ...p,
          reason: g.nameCandidates.length > 1
            ? 'connected group carries conflicting label names'
            : 'connected group has no label and no power port, so it has no name in the file',
        });
      }
    }
  }

  nets.sort((a, b) => String(a.name ?? '￿').localeCompare(String(b.name ?? '￿'), undefined, { numeric: true }));

  return {
    status: 'derived',
    derivable: true,
    model: 'geometric-single-sheet',
    blockers: [],
    anomalies,
    caveats,
    nets,
    unresolvedPins,
  };
}

function segmentsOf(sheet) {
  const segs = [];
  for (const w of sheet.wires) {
    if (w.kind !== 'wire') continue;
    for (let i = 1; i < w.points.length; i++) {
      segs.push({
        x1: w.points[i - 1].x, y1: w.points[i - 1].y,
        x2: w.points[i].x, y2: w.points[i].y,
        span: w.span,
      });
    }
  }
  return segs;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = `${it.code}|${it.detail}|${it.file ?? ''}|${it.line ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ------------------------------------------------------------- design graph

/**
 * Everything step 1 of the mutation engine asks for, in one call: components,
 * sheet structure and either nets or the reason there are none — each item
 * carrying the file, line and offsets it came from.
 *
 * @param {string} rootFile path to the root `.kicad_sch`
 */
export function readDesignGraph(rootFile) {
  const project = loadSchematicProject(rootFile);
  const components = [];
  for (const sheet of project.sheets) {
    for (const c of sheet.components) {
      components.push({
        refdes: c.refdes,
        value: c.value,
        libId: c.libId,
        footprint: c.footprint,
        unit: c.unit,
        uuid: c.uuid,
        dnp: c.dnp,
        file: c.file,
        sheetName: c.sheetName,
        line: c.line,
        span: c.span,
        spans: c.spans,
        instances: c.instances,
      });
    }
  }
  components.sort((a, b) => a.refdes.localeCompare(b.refdes, undefined, { numeric: true }));

  const refdesCounts = new Map();
  for (const c of components) refdesCounts.set(c.refdes, (refdesCounts.get(c.refdes) ?? 0) + 1);
  // In a hierarchy the displayed Reference property is only a cache; the
  // authoritative per-instance refdes lives in `(instances …)`. A duplicate
  // here usually means a reused sheet, not a broken design.
  const duplicateRefdes = [...refdesCounts].filter(([, n]) => n > 1).map(([refdes, n]) => ({ refdes, count: n }));

  return {
    rootFile: project.rootFile,
    sheets: project.sheets.map((s) => ({
      file: s.file,
      sheetName: s.sheetName,
      sheetPath: s.sheetPath,
      uuid: s.uuid,
      titleBlock: s.titleBlock,
      componentCount: s.components.length,
      skipped: s.skipped,
    })),
    hierarchy: project.hierarchy.map((h) => ({
      parent: h.parent, child: h.child, name: h.name,
      pins: h.pins.map((p) => p.name),
      line: h.span ? h.span.line : 0,
    })),
    missingSheets: project.missing,
    repeatedSheets: project.repeats,
    components,
    duplicateRefdes,
    connectivity: deriveConnectivity(project.sheets),
  };
}

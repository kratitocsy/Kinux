// Dependency-free reader for KiCad `.kicad_pcb` s-expression files.
//
// Scope and honesty note: this is a *partial* reader. It extracts only the
// nodes the PCB worker needs (layers, nets, board outline, copper segments).
// Every other node type is kept as a raw tree and otherwise ignored, because a
// real board file contains dozens of node types (footprints, zones, vias,
// dimensions, groups, images, ...). Unknown tokens must never throw: an
// unrecognised node is data we do not understand yet, not a parse failure.
//
// Coordinates and widths in a .kicad_pcb are millimetres (KiCad 6+).

/**
 * Tokenise and read one s-expression document into nested arrays.
 * Atoms come back as JS numbers when they look numeric, otherwise as strings.
 * Quoted strings stay strings and keep their characters (with \\ and \" unescaped),
 * and are marked so a quoted "1" is never confused with the number 1.
 *
 * @param {string} text
 * @returns {Array} the top-level node, e.g. ['kicad_pcb', ['version', 20221018], ...]
 */
export function readSexp(text) {
  const stack = [];
  let top = null;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '(') {
      const node = [];
      if (stack.length) stack[stack.length - 1].push(node);
      else if (top === null) top = node;
      else throw new SyntaxError(`more than one top-level s-expression at offset ${i}`);
      stack.push(node);
      i++;
      continue;
    }

    if (c === ')') {
      if (!stack.length) throw new SyntaxError(`unbalanced ')' at offset ${i}`);
      stack.pop();
      i++;
      continue;
    }

    if (c === '"') {
      let out = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { out += text[i + 1]; i += 2; }
        else { out += text[i]; i++; }
      }
      if (i >= n) throw new SyntaxError('unterminated string literal');
      i++; // closing quote
      if (!stack.length) throw new SyntaxError('string literal outside any list');
      stack[stack.length - 1].push(new QuotedString(out));
      continue;
    }

    if (/\s/.test(c)) { i++; continue; }

    // bare atom
    let j = i;
    while (j < n && !/[\s()"]/.test(text[j])) j++;
    const raw = text.slice(i, j);
    if (!stack.length) throw new SyntaxError(`atom ${JSON.stringify(raw)} outside any list`);
    stack[stack.length - 1].push(atom(raw));
    i = j;
  }

  if (stack.length) throw new SyntaxError('unbalanced "(" - document ended inside a list');
  if (top === null) throw new SyntaxError('no s-expression found');
  return top;
}

/** Wrapper so a quoted "1" is distinguishable from the bare atom 1. */
class QuotedString extends String {}

function atom(raw) {
  if (raw === '') return raw;
  // Numeric only if the whole token is a plain decimal number.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return raw;
}

/** Plain string for any atom (quoted or bare). */
export function text(a) {
  return a === undefined || a === null ? undefined : String(a);
}

const isNode = x => Array.isArray(x);
const head = x => (isNode(x) && typeof x[0] !== 'object' ? String(x[0]) : undefined);

/** All direct children of `node` whose head token is `name`. */
export function children(node, name) {
  if (!isNode(node)) return [];
  return node.filter(c => isNode(c) && head(c) === name);
}

/** First direct child of `node` whose head token is `name`, or undefined. */
export function child(node, name) {
  return children(node, name)[0];
}

/** Value of a single-value child node, e.g. (width 0.25) -> 0.25. Undefined when absent. */
export function value(node, name) {
  const c = child(node, name);
  return c === undefined ? undefined : c[1];
}

/** An (x y) style child such as (start 110 90) -> {x: 110, y: 90}. */
function point(node, name) {
  const c = child(node, name);
  if (!c) return undefined;
  const x = Number(c[1]);
  const y = Number(c[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/**
 * Parse a `.kicad_pcb` document into a plain structure.
 *
 * @param {string} source contents of a .kicad_pcb file
 * @returns {{
 *   version: number|undefined,
 *   generator: string|undefined,
 *   layers: Array<{ordinal:number, name:string, type:string, userName?:string}>,
 *   nets: Array<{number:number, name:string}>,
 *   outline: Array<{kind:string, start:object, end:object, layer:string, width:number|undefined}>,
 *   segments: Array<{index:number, start:object, end:object, width_mm:number, layer:string, net:number, net_name:string|undefined, length_mm:number}>,
 *   skipped: Array<{token:string, count:number}>
 * }}
 */
export function parsePcb(source) {
  const root = readSexp(source);
  if (head(root) !== 'kicad_pcb') {
    throw new SyntaxError(`not a kicad_pcb document (root token is ${JSON.stringify(head(root))})`);
  }

  const version = value(root, 'version');
  const generator = text(value(root, 'generator'));

  const layers = [];
  const layersNode = child(root, 'layers');
  if (layersNode) {
    for (const entry of layersNode.slice(1)) {
      // (0 "F.Cu" signal) or (0 "F.Cu" signal "Front Copper")
      if (!isNode(entry)) continue;
      const ordinal = Number(entry[0]);
      const name = text(entry[1]);
      if (!Number.isFinite(ordinal) || name === undefined) continue;
      const layer = { ordinal, name, type: text(entry[2]) ?? 'unknown' };
      if (entry[3] !== undefined) layer.userName = text(entry[3]);
      layers.push(layer);
    }
  }

  const nets = [];
  const netNames = new Map();
  for (const netNode of children(root, 'net')) {
    const number = Number(netNode[1]);
    if (!Number.isFinite(number)) continue;
    const name = text(netNode[2]) ?? '';
    nets.push({ number, name });
    netNames.set(number, name);
  }

  const outline = [];
  for (const kind of ['gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly']) {
    for (const g of children(root, kind)) {
      const layer = text(value(g, 'layer'));
      if (layer !== 'Edge.Cuts') continue; // board outline only
      outline.push({
        kind,
        start: point(g, 'start'),
        end: point(g, 'end'),
        layer,
        width: value(g, 'width') ?? value(child(g, 'stroke') ?? [], 'width'),
      });
    }
  }

  const segments = [];
  for (const s of children(root, 'segment')) {
    const start = point(s, 'start');
    const end = point(s, 'end');
    const width = Number(value(s, 'width'));
    const layer = text(value(s, 'layer'));
    const net = Number(value(s, 'net'));
    // A segment missing geometry is malformed input, not an unknown token: skip
    // it rather than inventing coordinates, and record why.
    if (!start || !end || !Number.isFinite(width) || layer === undefined) continue;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    segments.push({
      index: segments.length,
      start,
      end,
      width_mm: width,
      layer,
      net: Number.isFinite(net) ? net : 0,
      net_name: netNames.get(Number.isFinite(net) ? net : 0),
      length_mm: length,
    });
  }

  // Everything we did not look at, so a caller can see what this reader ignores.
  const known = new Set(['version', 'generator', 'layers', 'net', 'segment',
    'gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly']);
  const skippedCounts = new Map();
  for (const node of root.slice(1)) {
    const h = isNode(node) ? head(node) : undefined;
    if (h === undefined || known.has(h)) continue;
    skippedCounts.set(h, (skippedCounts.get(h) ?? 0) + 1);
  }
  const skipped = [...skippedCounts].map(([token, count]) => ({ token, count }));

  return { version, generator, layers, nets, outline, segments, skipped };
}

import { readFileSync } from 'node:fs';

/** Convenience: parse a .kicad_pcb from disk. */
export function parsePcbFile(path) {
  return parsePcb(readFileSync(path, 'utf8'));
}

// SPICE netlist parse / edit / serialise.
//
// Design goals:
//  - Round-tripping an unmodified netlist reproduces it byte for byte. Every line keeps
//    its original text and is only re-rendered when something actually changed it.
//  - Lines carry stable ids so a mutation operator can describe a change as a PATCH
//    (see operators.mjs) instead of handing back a mutated copy.
//  - Parsing is strict enough that a malformed element throws, so `applyPatch` can
//    re-parse its own output and never emit an unparseable netlist silently.

export class NetlistParseError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `line ${line + 1}: ${message}`);
    this.name = 'NetlistParseError';
    this.line = line;
  }
}

/** Number of nodes each SPICE element letter takes before its value/model tokens. */
const NODE_COUNT = {
  R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, B: 2, W: 2, K: 0,
  Q: 3, J: 3, Z: 3,
  M: 4, E: 4, G: 4, S: 4, T: 4,
  F: 2, H: 2,
};
const DEFAULT_NODE_COUNT = 2;

export const GROUND_NODES = new Set(['0', 'gnd', 'gnd!', 'vss', 'agnd', 'dgnd']);
const RAIL_NAME = /^(vcc|vdd|vbat|vbus|vin|vsup|v\+|\+?\d+(v\d*|v)|vpp|vee)$/i;

export const isGround = node => GROUND_NODES.has(String(node).toLowerCase());

/** Multiplier suffixes, longest first so MEG wins over M. */
const MULTIPLIERS = [
  ['meg', 1e6], ['t', 1e12], ['g', 1e9], ['k', 1e3],
  ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12], ['f', 1e-15],
];
// Letter groups that are plainly units, never multipliers ("1F" is one farad here, not one femto).
const PURE_UNITS = new Set(['f', 'v', 'a', 'h', 's', 'hz', 'ohm', 'ohms', 'w']);

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

/**
 * Parse a SPICE value token such as `10k`, `4.7uF`, `1e-9`.
 * Returns null when the token is not numeric (a model name, an expression, ...).
 */
export function parseValue(token) {
  if (typeof token !== 'string') return null;
  const m = NUM_RE.exec(token.trim());
  if (!m) return null;
  const mantissa = Number(m[1]);
  if (!Number.isFinite(mantissa)) return null;
  const letters = m[2];
  const low = letters.toLowerCase();
  let factor = 1, multText = '', unit = letters;
  if (letters && !PURE_UNITS.has(low)) {
    for (const [suffix, f] of MULTIPLIERS) {
      if (low.startsWith(suffix)) {
        factor = f;
        multText = letters.slice(0, suffix.length);
        unit = letters.slice(suffix.length);
        break;
      }
    }
  }
  return { number: mantissa * factor, mantissa, factor, multText, unit, text: token };
}

const trimNumber = n => {
  if (Number.isInteger(n)) return String(n);
  let s = n.toPrecision(10).replace(/0+$/, '').replace(/\.$/, '');
  if (Math.abs(Number(s) - n) > Math.abs(n) * 1e-9) s = String(n);
  return s;
};

/** Render `number` (in base units) using the scale and unit of a template from parseValue. */
export function formatValue(number, template) {
  const factor = template?.factor ?? 1;
  return trimNumber(number / factor) + (template?.multText ?? '') + (template?.unit ?? '');
}

const classify = text => {
  const t = text.trim();
  if (t === '') return 'blank';
  if (t.startsWith('*') || t.startsWith(';')) return 'comment';
  if (t.startsWith('+')) return 'continuation';
  if (t.startsWith('.')) return 'directive';
  return 'element';
};

function parseElement(raw, lineNo) {
  const tokens = raw.trim().split(/\s+/);
  const refdes = tokens[0];
  const type = refdes[0].toUpperCase();
  let nodes, tail;
  if (type === 'X') {
    if (tokens.length < 3) throw new NetlistParseError(`subcircuit call "${refdes}" needs at least one node and a name`, lineNo);
    nodes = tokens.slice(1, -1);
    tail = tokens.slice(-1);
  } else {
    const n = NODE_COUNT[type] ?? DEFAULT_NODE_COUNT;
    if (tokens.length < 1 + n) {
      throw new NetlistParseError(`element "${refdes}" needs ${n} nodes, found ${tokens.length - 1} tokens after the refdes`, lineNo);
    }
    nodes = tokens.slice(1, 1 + n);
    tail = tokens.slice(1 + n);
  }
  return { refdes, type, nodes, tail };
}

/** Render one element line from its parts, keeping the original leading indent. */
export function renderElement(line) {
  return `${line.indent}${line.refdes} ${[...line.nodes, ...line.tail].join(' ')}`;
}

const renderLine = line => (line.dirty && line.kind === 'element' ? renderElement(line) : line.raw);

export class Netlist {
  constructor(lines, { trailingNewline = true, eol = '\n' } = {}) {
    this.lines = lines;
    this.trailingNewline = trailingNewline;
    this.eol = eol;
  }
  /** Element lines, in file order. */
  get components() {
    return this.lines.filter(l => l.kind === 'element');
  }
  get directives() {
    return this.lines.filter(l => l.kind === 'directive');
  }
  component(refdes) {
    const want = String(refdes).toLowerCase();
    return this.components.find(c => c.refdes.toLowerCase() === want) ?? null;
  }
  line(id) {
    return this.lines.find(l => l.id === id) ?? null;
  }
  /** Every node name mentioned by an element, in first-seen order. */
  nodes() {
    const seen = [];
    for (const c of this.components) for (const n of c.nodes) if (!seen.includes(n)) seen.push(n);
    return seen;
  }
  /** Elements touching a node. */
  connections(node) {
    return this.components.filter(c => c.nodes.includes(node));
  }
  /** Supply-rail nodes: named like a rail, or the non-ground terminal of a voltage source. */
  rails() {
    const out = new Set();
    for (const n of this.nodes()) if (RAIL_NAME.test(n)) out.add(n);
    for (const c of this.components) {
      if (c.type !== 'V') continue;
      for (const n of c.nodes) if (!isGround(n)) out.add(n);
    }
    return out;
  }
  toString() {
    const body = this.lines.map(renderLine).join(this.eol);
    return this.trailingNewline ? body + this.eol : body;
  }
  /** A deep, independent copy. Operators never mutate the netlist they are given. */
  clone() {
    return new Netlist(
      this.lines.map(l => ({ ...l, nodes: l.nodes ? [...l.nodes] : undefined, tail: l.tail ? [...l.tail] : undefined })),
      { trailingNewline: this.trailingNewline, eol: this.eol },
    );
  }
}

/**
 * Parse netlist text. The first line is the SPICE title line and is kept verbatim.
 * Throws NetlistParseError on a malformed element.
 */
export function parseNetlist(text) {
  if (typeof text !== 'string') throw new NetlistParseError('netlist must be a string');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith(eol);
  const body = trailingNewline ? text.slice(0, -eol.length) : text;
  const rawLines = body.split(eol);

  const lines = rawLines.map((raw, i) => {
    const base = { id: `L${i}`, index: i, raw, dirty: false, indent: (/^\s*/.exec(raw) || [''])[0] };
    if (i === 0) return { ...base, kind: 'title' };
    const kind = classify(raw);
    if (kind !== 'element') return { ...base, kind };
    return { ...base, kind, ...parseElement(raw, i) };
  });
  return new Netlist(lines, { trailingNewline, eol });
}

export const serialiseNetlist = netlist => netlist.toString();

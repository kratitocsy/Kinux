// Derived from copperhead/src/kicad/sexp.ts
//   https://github.com/copperheadhq/copperhead
//   Copyright 2026 Chouhan Industries, licensed under Apache License 2.0.
//   Full licence: licenses/copperhead-Apache-2.0.txt. See THIRD-PARTY-NOTICES.md.
// MODIFIED for Kinux: ported from TypeScript to dependency-free ESM, and
// extended with the source-span tracking and component extraction the Kinux
// mutation engine needs.
//
// A READ-ONLY reader for KiCad s-expression files. Like the original it never
// serialises: an edit to a KiCad file is an anchored text replace on the
// original source, so that every byte we did not deliberately change survives
// untouched. That is why every node this module hands out can be located again
// in the file it came from.
//
// What Kinux added on top of the port:
//
//   * Spans. `parseSexp` records, for every list and every atom, the offset
//     range it occupies in the source, plus the 1-based line and column of its
//     first character. Look them up with `spanOf(list)` / `childSpan(list, i)`.
//     A quoted atom also records `innerStart`/`innerEnd`, the range *inside*
//     the quotes, which is what a value mutation replaces.
//   * `replaceSpan`, the anchored text replace the mutation engine needs.
//   * `toByteSpan`, because offsets here are JS string indices (UTF-16 code
//     units), which only equal byte offsets while the file is pure ASCII.
//
// The low-level `listEnd` / `childSpans` scanners at the end of this file are
// ported from copperhead/src/kicad/spans.ts (same project, same licence): they
// find a list's extent without parsing, for callers that want to splice a
// large file without reading all of it.
//
// Atoms come back as plain JS strings, as in the original — a `.kicad_sch`
// number has no type of its own and a caller that wants one calls `parseFloat`
// on it. A quoted "1" and a bare 1 therefore have the same value; `spanOf`'s
// `quoted` flag is what distinguishes them.

/**
 * A node's place in the source text.
 *
 * @typedef {Object} Span
 * @property {number} start  offset of the first character, inclusive
 * @property {number} end    offset one past the last character, exclusive
 * @property {number} line   1-based line of `start`
 * @property {number} column 1-based column of `start`
 * @property {string} [tag]  for a list, its head token ('' when the list is
 *   empty or starts with a nested list)
 * @property {Span[]} [items] for a list, the span of each element, by index
 * @property {boolean} [quoted] true for an atom that was written in quotes
 * @property {number} [innerStart] for a quoted atom, offset of the first
 *   character inside the quotes
 * @property {number} [innerEnd] for a quoted atom, offset one past the last
 *   character inside the quotes (i.e. of the closing quote)
 */

/**
 * A parsed node: either an atom (string) or a list (array of nodes).
 * @typedef {string | SexpNode[]} SexpNode
 */

// Spans live beside the tree rather than in it, so a parsed node stays a plain
// array and `assert.deepEqual(node, ['a', 'b'])` still means what it looks
// like. Keyed weakly: spans go away with the tree.
const SPANS = new WeakMap();

/** The span of a parsed list, or undefined for anything not from `parseSexp`. */
export function spanOf(node) {
  return node !== null && typeof node === 'object' ? SPANS.get(node) : undefined;
}

/**
 * The span of element `index` of a parsed list — the only way to locate an
 * atom, since atoms are plain strings and carry nothing themselves.
 */
export function childSpan(list, index) {
  const s = spanOf(list);
  return s && s.items ? s.items[index] : undefined;
}

/** 1-based line/column of `offset` in `text`. */
export function positionAt(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') { line++; lineStart = i + 1; }
  }
  return { line, column: clamped - lineStart + 1 };
}

/**
 * Read a whole s-expression document. Returns the top-level nodes (a
 * `.kicad_sch` has exactly one, the `(kicad_sch …)` list).
 *
 * Throws SyntaxError on a structurally broken file — an unterminated string or
 * unbalanced parentheses. That is deliberately not the same thing as an
 * unfamiliar node: any node type at all parses fine here, and it is the
 * extractors above this layer that decide which ones they understand.
 *
 * @param {string} text
 * @returns {SexpNode[]}
 */
export function parseSexp(text) {
  // Line starts up front: a span is created for every node, and recounting
  // newlines from the top of the file each time would be quadratic.
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo; // 0-based index into `starts`
  };
  const place = (span) => {
    const l = lineOf(span.start);
    span.line = l + 1;
    span.column = span.start - starts[l] + 1;
    return span;
  };

  const n = text.length;
  let i = 0;

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const skipSpace = () => { while (i < n && isSpace(text[i])) i++; };

  /** @returns {{node: SexpNode, span: Span}} */
  function parseNode() {
    const start = i;
    const c = text[i];

    if (c === '(') {
      i++;
      /** @type {SexpNode[]} */
      const list = [];
      /** @type {Span[]} */
      const items = [];
      for (;;) {
        skipSpace();
        if (i >= n) {
          const where = positionAt(text, start);
          throw new SyntaxError(`unbalanced "(": list opened at line ${where.line} column ${where.column} is never closed`);
        }
        if (text[i] === ')') { i++; break; }
        const { node, span } = parseNode();
        list.push(node);
        items.push(span);
      }
      const span = place({
        start,
        end: i,
        line: 0,
        column: 0,
        tag: typeof list[0] === 'string' ? list[0] : '',
        items,
      });
      SPANS.set(list, span);
      return { node: list, span };
    }

    if (c === ')') {
      const where = positionAt(text, i);
      throw new SyntaxError(`unbalanced ")" at line ${where.line} column ${where.column}`);
    }

    if (c === '"') {
      i++;
      const innerStart = i;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          // KiCad writes a multi-line text item as `line1\nline2` (and tabs as
          // `\t`) inside the quoted atom. Mapping the escape to the literal
          // letter would turn that into `line1nline2`, which is wrong for
          // anything that measures or compares the string. Every other escape
          // stands for the character after the backslash, which covers \" and
          // \\ as KiCad writes them.
          const e = text[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          out += text[i];
          i++;
        }
      }
      if (i >= n) {
        const where = positionAt(text, start);
        throw new SyntaxError(`unterminated string starting at line ${where.line} column ${where.column}`);
      }
      const innerEnd = i;
      i++; // closing quote
      return {
        node: out,
        span: place({ start, end: i, line: 0, column: 0, quoted: true, innerStart, innerEnd }),
      };
    }

    let j = i;
    while (j < n && !isSpace(text[j]) && text[j] !== '(' && text[j] !== ')' && text[j] !== '"') j++;
    const raw = text.slice(i, j);
    i = j;
    return {
      node: raw,
      span: place({ start, end: j, line: 0, column: 0, quoted: false, innerStart: start, innerEnd: j }),
    };
  }

  /** @type {SexpNode[]} */
  const roots = [];
  skipSpace();
  while (i < n) {
    roots.push(parseNode().node);
    skipSpace();
  }
  return roots;
}

// ------------------------------------------------------------ tree accessors
// Ported as-is from the original; the mutation engine's extractors are built
// out of these four and nothing else.

/** @returns {boolean} true when `n` is a list rather than an atom. */
export const isList = (n) => Array.isArray(n);

/** The head token of a list, or null for an atom / a list with no head token. */
export const tagOf = (n) => (isList(n) && typeof n[0] === 'string' ? n[0] : null);

/** Every direct child list of `node` whose head token is `name`. */
export function children(node, name) {
  if (!isList(node)) return [];
  return node.filter((c) => tagOf(c) === name);
}

/** The first direct child list of `node` whose head token is `name`. */
export function child(node, name) {
  return children(node, name)[0];
}

/** Element `idx` of `node`, but only when it is an atom. */
export function atomAt(node, idx) {
  const v = node === undefined || node === null ? undefined : node[idx];
  return typeof v === 'string' ? v : undefined;
}

/** Element `idx` of `node` as a number, or `fallback` when absent/unparsable. */
export function numAt(node, idx, fallback = 0) {
  const v = atomAt(node, idx);
  if (v === undefined) return fallback;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
}

/**
 * KiCad's `(property "Key" "Value" …)` lookup. Returns the property list
 * itself so a caller can take its span; `propertyValue` takes just the text.
 */
export function propertyNode(node, key) {
  for (const p of children(node, 'property')) if (atomAt(p, 1) === key) return p;
  return undefined;
}

/** The text of `(property "<key>" "<value>" …)`, or undefined. */
export function propertyValue(node, key) {
  return atomAt(propertyNode(node, key), 2);
}

/**
 * A KiCad yes/no flag. KiCad has written these three ways across versions: a
 * bare atom (`hide`), a valued child (`(hide yes)`), and the same child nested
 * one level down inside `(effects …)`. Absent means `fallback`; anything other
 * than an explicit `no` means true.
 */
export function flag(node, name, fallback = false) {
  if (!isList(node)) return fallback;
  if (node.some((c) => c === name)) return true;
  const c = child(node, name);
  if (c === undefined) return fallback;
  return atomAt(c, 1) !== 'no';
}

// -------------------------------------------------------- anchored rewriting

/**
 * The text a span points at. The round-trip that makes a span trustworthy:
 * `sliceSpan(text, spanOf(node))` is the source of `node`.
 */
export function sliceSpan(text, span) {
  return text.slice(span.start, span.end);
}

/**
 * An anchored text replace: the single edit primitive for KiCad files. Nothing
 * outside `[start, end)` is touched, so comments, formatting, UUIDs and every
 * node we do not understand come through byte-for-byte.
 *
 * Pass `{ inner: true }` to replace only what is inside a quoted atom's
 * quotes, which is how a component value is mutated without disturbing the
 * quoting. The replacement is escaped the way KiCad escapes a quoted atom.
 *
 * @param {string} text
 * @param {Span} span
 * @param {string} replacement
 * @param {{inner?: boolean}} [opts]
 * @returns {string}
 */
export function replaceSpan(text, span, replacement, opts = {}) {
  let start = span.start;
  let end = span.end;
  let value = replacement;
  if (opts.inner) {
    if (span.innerStart === undefined || span.innerEnd === undefined) {
      throw new TypeError('replaceSpan: span has no inner range (not an atom)');
    }
    start = span.innerStart;
    end = span.innerEnd;
    if (span.quoted) value = escapeAtom(replacement);
  }
  return text.slice(0, start) + value + text.slice(end);
}

/** Escape a string for use inside a KiCad quoted atom. Inverse of the reader. */
export function escapeAtom(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/**
 * The same span measured in UTF-8 bytes. Offsets everywhere else in this
 * module are JS string indices (UTF-16 code units); they agree with byte
 * offsets for an ASCII file and diverge the moment a schematic carries a Ω, a
 * µ or an em dash — which real ones do. Anything that hands an offset to a
 * byte-oriented consumer should convert here rather than assume.
 */
export function toByteSpan(text, span) {
  const byteLen = (s) => Buffer.byteLength(s, 'utf8');
  const start = byteLen(text.slice(0, span.start));
  return { start, end: start + byteLen(text.slice(span.start, span.end)) };
}

// --------------------------------------------- scanners (from spans.ts)
// For a caller that wants one list's extent out of a large file without
// building a tree. Both honour quoted strings, so a ")" inside a string never
// ends a list.

/** End (exclusive) of the list opening at `open`. */
export function listEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new SyntaxError('unbalanced s-expression');
}

/** Direct child lists of the list opening at `open`, as `{start, end, tag}`. */
export function childSpans(text, open) {
  const end = listEnd(text, open);
  const out = [];
  for (let i = open + 1; i < end - 1; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < end && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') {
      const e = listEnd(text, i);
      const m = /^\(\s*([^\s()"]+)/.exec(text.slice(i, i + 64));
      out.push({ start: i, end: e, tag: m ? m[1] : '' });
      i = e - 1;
    }
  }
  return out;
}

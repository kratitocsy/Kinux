// Derived from copperhead/src/kicad/spice.ts
//   https://github.com/copperheadhq/copperhead
//   Copyright 2026 Chouhan Industries, licensed under Apache License 2.0.
//   Full licence: licenses/copperhead-Apache-2.0.txt. See THIRD-PARTY-NOTICES.md.
// MODIFIED for Kinux: ported from TypeScript to dependency-free ESM; wired to
// Kinux's ngspice runner (absent upstream, where this module is never imported);
// verdicts mapped to the Kinux contract, where NOT_CHECKED and ERROR are never
// a pass; assertion output forced through Kinux's .control allowlist sanitizer.
//
// What this file is: a closed, reviewable assertion language for circuit
// verification, plus the compiler that turns it into an ngspice deck and the
// mapping from ngspice's measurements back to Kinux verdicts.
//
//   measurables   V(<net>)  I(<refdes>)  corner(<net>)
//   point         optional `at <number>` (a sweep/time point)
//   comparators   between <a> and <b>   < <x>   > <x>
//   analyses      op | dc | ac | tran, each with its own sweep parameters
//   scope         sheet <path> | nets <a>, <b>
//   sources       <port>=<number>
//
// Two rules govern everything below.
//
//  1. HONESTY (contracts/README.md rule 1). An assertion that could not
//     actually be evaluated -- unparseable text, a net ngspice cannot resolve,
//     a measurement it refused to take, a non-convergent run, a missing model,
//     a deck the sanitizer rejected -- is NOT_CHECKED or ERROR with a
//     reason_code. It is never PASS and never FAIL. The decision itself is made
//     by verdict.mjs/evaluateCheck, so there is one implementation of that rule
//     in the worker, not two.
//
//  2. NO NEW INJECTION ROUTE. Assertions are attacker-controlled text that ends
//     up inside a `.control` block, and a `.control` block executes shell
//     commands even under `ngspice -b` (see sanitize.mjs). So: every target and
//     every refdes must match a narrow allowlist regex, numbers are re-emitted
//     from their parsed float value rather than echoed as the user typed them,
//     measure names are generated here and not taken from input, and the
//     finished deck is handed to sanitize() before it can reach the binary.
//     compileSimulationDeck() reports a deck that fails the sanitizer as a
//     refusal; it never strips and runs it anyway.

import { sanitize, describeViolations } from './sanitize.mjs';
import { runNetlist } from './run.mjs';
import { evaluateCheck } from './verdict.mjs';

/**
 * @typedef {'op'|'dc'|'ac'|'tran'} SpiceAnalysisKind
 *
 * @typedef {{kind: SpiceAnalysisKind, params: string[], raw: string}} SpiceAnalysis
 *   The analysis and its sweep parameters, e.g. `tran 1u 6m`. Upstream stored
 *   only the kind, which cannot produce a runnable deck for dc/ac/tran.
 *
 * @typedef {{kind: 'sheet', sheet: string}|{kind: 'nets', nets: string[]}} SimulationScope
 *
 * @typedef {{raw: string, value: number, unit: string}} SpiceNumber
 *
 * @typedef {{kind: 'voltage'|'current'|'corner', target: string}} SpiceMeasurable
 *
 * @typedef {{kind: 'between', lower: SpiceNumber, upper: SpiceNumber}
 *          |{kind: 'less-than', bound: SpiceNumber}
 *          |{kind: 'greater-than', bound: SpiceNumber}} SpiceComparator
 *
 * @typedef {{raw: string, line: number, measurable: SpiceMeasurable,
 *            comparator: SpiceComparator, at: SpiceNumber|null}} SimulationAssertion
 *
 * @typedef {{port: string, value: SpiceNumber, line: number}} SimulationSource
 *
 * @typedef {{line: number, scope: SimulationScope, analysis: SpiceAnalysis,
 *            sources: SimulationSource[], assertions: SimulationAssertion[]}} SimulationBlock
 *
 * @typedef {{test_id: string, subject: string, verdict: 'PASS'|'FAIL'|'NOT_CHECKED'|'ERROR',
 *            measured?: number, limit?: string|number, units?: string,
 *            reason_code?: string, reason?: string, assertion?: string}} AssertionResult
 */

/** A parse or compile refusal that always names its line and a machine code. */
export class SimulationParseError extends Error {
  /**
   * @param {number} line 1-based source line
   * @param {string} message human text
   * @param {string} code structured reason, e.g. `invalid_number`
   */
  constructor(line, message, code = 'invalid_syntax') {
    super(`line ${line}: ${message}`);
    this.name = 'SimulationParseError';
    this.line = line;
    this.code = code;
    // Every refusal maps onto a contract reason_code. A refused assertion was
    // not evaluated, so it is NOT_CHECKED -- not a silently dropped line.
    this.reason_code = 'netlist_unsupported';
  }
}

export const ANALYSES = new Set(['op', 'dc', 'ac', 'tran']);

/** Net / refdes names we are willing to put inside `v( )`, `i( )` or `@x[i]`. */
const SAFE_TARGET = /^[A-Za-z0-9_./:+-]+$/;
/** Measure names we generate ourselves; checked anyway, since they reach the deck. */
const SAFE_MEASURE_NAME = /^[a-z_][a-z0-9_]*$/;
/** One token of an analysis parameter list, e.g. `1u`, `dec`, `V1`, `-5`.
 *  A leading `.` is excluded on purpose: `analysis: tran 1u 6m .endc ...` would
 *  otherwise put a dot directive on the control line we build. */
const SAFE_PARAM_TOKEN = /^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/;
const MAX_PARAM_TOKENS = 8;

const SI_MULTIPLIERS = Object.freeze({
  '': 1,
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
});

/** Units each measurable accepts, so `V(out) < 25uA` is caught at parse time. */
const UNITS_FOR = {
  voltage: new Set(['', 'v', 'volt', 'volts']),
  current: new Set(['', 'a', 'amp', 'amps', 'ampere', 'amperes']),
  corner: new Set(['', 'hz', 'hertz']),
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a SPICE-style number: an optional sign, digits, an optional SI
 * multiplier and an optional unit. `25uA` -> 25e-6 with unit `A`.
 * @param {string} raw
 * @param {number} [line]
 * @returns {SpiceNumber}
 */
export function parseSpiceNumber(raw, line = 1) {
  const token = String(raw ?? '').trim();
  const match =
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?([a-z]*)$/i.exec(token);
  if (!match) {
    throw new SimulationParseError(line, `invalid SPICE number "${raw}"`, 'invalid_number');
  }

  const base = Number(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = SI_MULTIPLIERS[suffix]; // the regex admits only these keys
  const value = base * multiplier;
  if (!Number.isFinite(value)) {
    throw new SimulationParseError(
      line,
      `SPICE number is out of range "${raw}"`,
      'number_out_of_range',
    );
  }

  return { raw: token, value, unit: match[3] ?? '' };
}

/**
 * Parse one assertion from the closed grammar:
 *   `V(net) [at <point>] (between <a> and <b> | < <x> | > <x>)`
 * @param {string} raw
 * @param {number} [line]
 * @returns {SimulationAssertion}
 */
export function parseSpiceAssertion(raw, line = 1) {
  const text = String(raw ?? '').trim();
  const measurableMatch = /^(V|I|corner)\(([^()\s]+)\)\s+(.+)$/i.exec(text);
  if (!measurableMatch) {
    throw new SimulationParseError(line, `invalid SPICE assertion "${raw}"`, 'invalid_assertion');
  }

  const target = measurableMatch[2];
  if (!SAFE_TARGET.test(target)) {
    throw new SimulationParseError(
      line,
      `invalid measurable target "${target}"`,
      'invalid_target',
    );
  }

  const token = measurableMatch[1].toLowerCase();
  const kind = token === 'v' ? 'voltage' : token === 'i' ? 'current' : 'corner';
  /** @type {SpiceMeasurable} */
  const measurable = { kind, target };

  let rest = measurableMatch[3].trim();

  // Optional measurement point. Kinux addition: without it a transient
  // assertion can only be an average over the whole window, which is almost
  // never the thing anyone means to assert.
  let at = null;
  const atMatch = /^at\s+(\S+)\s+(.+)$/i.exec(rest);
  if (atMatch) {
    at = parseSpiceNumber(atMatch[1], line);
    rest = atMatch[2].trim();
  }

  /** @type {SpiceComparator} */
  let comparator;
  const betweenMatch = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(rest);
  if (betweenMatch) {
    const lower = parseSpiceNumber(betweenMatch[1], line);
    const upper = parseSpiceNumber(betweenMatch[2], line);
    if (lower.unit.toLowerCase() !== upper.unit.toLowerCase()) {
      throw new SimulationParseError(line, 'between bounds use different units', 'unit_mismatch');
    }
    if (lower.value >= upper.value) {
      throw new SimulationParseError(
        line,
        'between lower bound must be less than upper bound',
        'bounds_not_ordered',
      );
    }
    comparator = { kind: 'between', lower, upper };
  } else {
    const singleMatch = /^([<>])\s*(\S+)$/.exec(rest);
    if (!singleMatch) {
      throw new SimulationParseError(line, `invalid comparator "${rest}"`, 'invalid_comparator');
    }
    const bound = parseSpiceNumber(singleMatch[2], line);
    comparator =
      singleMatch[1] === '<' ? { kind: 'less-than', bound } : { kind: 'greater-than', bound };
  }

  // Kinux addition: the bound's unit has to belong to the measurable.
  const allowed = UNITS_FOR[kind];
  for (const n of comparatorNumbers(comparator)) {
    if (!allowed.has(n.unit.toLowerCase())) {
      throw new SimulationParseError(
        line,
        `unit "${n.unit}" does not belong to ${kind === 'corner' ? 'corner()' : kind} ` +
          `(expected one of: ${[...allowed].filter(Boolean).join(', ')}, or none)`,
        'unit_not_for_measurable',
      );
    }
  }

  return { raw: text, line, measurable, comparator, at };
}

/** @param {SpiceComparator} c @returns {SpiceNumber[]} */
function comparatorNumbers(c) {
  return c.kind === 'between' ? [c.lower, c.upper] : [c.bound];
}

/**
 * Parse every `## Simulation` section out of a Markdown document. Fenced code
 * blocks and HTML comments are not live input. Taken from upstream essentially
 * unchanged; it is careful and well covered.
 * @param {string} markdown
 * @returns {SimulationBlock[]}
 */
export function parseSimulationBlocks(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const blocks = [];
  let openFence = null;
  let inDocumentComment = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const fence = markdownFence(line);
    if (openFence) {
      if (fence) openFence = toggleFence(openFence, fence);
      continue;
    }
    if (inDocumentComment) {
      if (line.includes('-->')) inDocumentComment = false;
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inDocumentComment = true;
      continue;
    }
    if (!/^##\s+Simulation\s*$/i.test(line)) continue;

    const headingLine = index + 1;
    const body = [];
    let cursor = index + 1;
    let inComment = false;
    let bodyFence = null;

    for (; cursor < lines.length; cursor++) {
      const text = lines[cursor];
      const trimmed = text.trim();
      const bodyFenceMarker = markdownFence(trimmed);
      if (bodyFence) {
        if (bodyFenceMarker) bodyFence = toggleFence(bodyFence, bodyFenceMarker);
        continue;
      }
      if (inComment) {
        if (trimmed.includes('-->')) inComment = false;
        continue;
      }
      if (bodyFenceMarker) {
        bodyFence = bodyFenceMarker;
        continue;
      }
      if (/^#{1,6}\s+/.test(trimmed)) break;
      if (trimmed.startsWith('<!--')) {
        if (!trimmed.includes('-->')) inComment = true;
        continue;
      }
      if (trimmed.startsWith('.') || /^[A-Za-z]+\s*:/.test(trimmed)) {
        body.push({ text: trimmed, line: cursor + 1 });
      }
    }

    blocks.push(parseSimulationBlock(body, headingLine));
    index = cursor - 1;
  }

  return blocks;
}

function markdownFence(line) {
  const m = /^(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : null;
}

function toggleFence(openFence, marker) {
  if (!openFence) return marker;
  if (marker[0] === openFence[0] && marker.length >= openFence.length) return null;
  return openFence;
}

/**
 * @param {Array<{text: string, line: number}>} body
 * @param {number} headingLine
 * @returns {SimulationBlock}
 */
function parseSimulationBlock(body, headingLine) {
  let scope;
  let analysis;
  const sources = [];
  const assertions = [];

  for (const entry of body) {
    if (entry.text.startsWith('.')) {
      // A raw ngspice statement in a doc block is refused outright: it is the
      // one thing the closed grammar exists to prevent.
      throw new SimulationParseError(
        entry.line,
        `raw ngspice statement "${entry.text.split(/\s/, 1)[0]}" is not allowed`,
        'raw_statement_not_allowed',
      );
    }

    const fieldMatch = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(entry.text);
    if (!fieldMatch) {
      throw new SimulationParseError(
        entry.line,
        `expected "field: value", got "${entry.text}"`,
        'malformed_field',
      );
    }

    const field = fieldMatch[1].toLowerCase();
    const value = fieldMatch[2].trim();

    switch (field) {
      case 'scope':
        if (scope) throw new SimulationParseError(entry.line, 'duplicate scope', 'duplicate_field');
        scope = parseScope(value, entry.line);
        break;
      case 'analysis':
        if (analysis) {
          throw new SimulationParseError(entry.line, 'duplicate analysis', 'duplicate_field');
        }
        analysis = parseAnalysis(value, entry.line);
        break;
      case 'source':
      case 'sources':
        sources.push(parseSource(value, entry.line));
        break;
      case 'assert':
        assertions.push(parseSpiceAssertion(value, entry.line));
        break;
      default:
        throw new SimulationParseError(
          entry.line,
          `unknown Simulation field "${field}"`,
          'unknown_field',
        );
    }
  }

  if (!scope) {
    throw new SimulationParseError(
      headingLine,
      'Simulation block is missing scope',
      'missing_scope',
    );
  }
  if (!analysis) {
    throw new SimulationParseError(
      headingLine,
      'Simulation block is missing analysis',
      'missing_analysis',
    );
  }
  if (assertions.length === 0) {
    throw new SimulationParseError(
      headingLine,
      'Simulation block needs at least one assertion',
      'no_assertions',
    );
  }

  return { line: headingLine, scope, analysis, sources, assertions };
}

/**
 * `analysis: tran 1u 6m` -> kind plus its parameter tokens. Every token is
 * allowlisted, because these tokens are written straight into the deck.
 * @param {string} raw
 * @param {number} line
 * @returns {SpiceAnalysis}
 */
export function parseAnalysis(raw, line = 1) {
  const text = String(raw ?? '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const kind = (parts.shift() ?? '').toLowerCase();
  if (!ANALYSES.has(kind)) {
    throw new SimulationParseError(line, `unsupported analysis "${text}"`, 'unsupported_analysis');
  }
  if (parts.length > MAX_PARAM_TOKENS) {
    throw new SimulationParseError(
      line,
      `analysis "${kind}" has ${parts.length} parameters, at most ${MAX_PARAM_TOKENS} are allowed`,
      'invalid_analysis_params',
    );
  }
  for (const token of parts) {
    if (!SAFE_PARAM_TOKEN.test(token)) {
      throw new SimulationParseError(
        line,
        `analysis parameter "${token}" is not a plain value`,
        'invalid_analysis_params',
      );
    }
  }
  if (kind === 'op' && parts.length > 0) {
    throw new SimulationParseError(
      line,
      'op analysis takes no parameters',
      'invalid_analysis_params',
    );
  }
  if (kind === 'ac' && parts.length > 0 && !['dec', 'oct', 'lin'].includes(parts[0].toLowerCase())) {
    throw new SimulationParseError(
      line,
      `ac analysis must sweep dec, oct or lin, got "${parts[0]}"`,
      'invalid_analysis_params',
    );
  }
  return { kind: /** @type {SpiceAnalysisKind} */ (kind), params: parts, raw: text };
}

/** @returns {SimulationScope} */
function parseScope(raw, line) {
  const match = /^(sheet|nets)(?:\s+(.*))?$/i.exec(raw);
  if (!match) {
    throw new SimulationParseError(
      line,
      'scope must be "sheet <path>" or "nets <a>, <b>"',
      'invalid_scope',
    );
  }

  const scopeValue = (match[2] ?? '').trim();
  if (match[1].toLowerCase() === 'sheet') {
    if (scopeValue.length === 0) {
      throw new SimulationParseError(line, 'sheet scope is empty', 'empty_sheet_scope');
    }
    return { kind: 'sheet', sheet: scopeValue };
  }

  const netList = scopeValue.replace(/^\[(.*)\]$/, '$1');
  const nets = netList
    .split(',')
    .map(net => net.trim())
    .filter(net => net.length > 0);
  if (nets.length === 0 || nets.some(net => !SAFE_TARGET.test(net))) {
    throw new SimulationParseError(
      line,
      'net scope must contain comma-separated net names',
      'invalid_net_list',
    );
  }
  return { kind: 'nets', nets: [...new Set(nets)] };
}

/** @returns {SimulationSource} */
function parseSource(raw, line) {
  const match = /^([A-Za-z_][A-Za-z0-9_./:+-]*)\s*=\s*(\S+)$/.exec(raw);
  if (!match) {
    throw new SimulationParseError(line, 'source must be "<port>=<number>"', 'invalid_source');
  }
  return { port: match[1], value: parseSpiceNumber(match[2], line), line };
}

/**
 * Parse a list of assertion strings without throwing: the caller gets the ones
 * that parsed and a structured refusal for each that did not, so a malformed
 * assertion is reported rather than dropped.
 * @param {Array<string|SimulationAssertion>} inputs
 * @param {{startLine?: number}} [opts]
 * @returns {{assertions: SimulationAssertion[],
 *            errors: Array<{raw: string, line: number, code: string, message: string}>}}
 */
export function parseAssertions(inputs, opts = {}) {
  const startLine = opts.startLine ?? 1;
  const assertions = [];
  const errors = [];
  (inputs ?? []).forEach((input, i) => {
    const line = startLine + i;
    if (input && typeof input === 'object') {
      assertions.push(input);
      return;
    }
    try {
      assertions.push(parseSpiceAssertion(String(input), line));
    } catch (err) {
      if (!(err instanceof SimulationParseError)) throw err;
      errors.push({ raw: String(input), line: err.line, code: err.code, message: err.message });
    }
  });
  return { assertions, errors };
}

/* -------------------------------------------------------------------------- */
/* Compiling                                                                  */
/* -------------------------------------------------------------------------- */

/** Numbers reach the deck as a plain float literal, never as the user's text. */
function literal(n) {
  return Number(n).toExponential(12);
}

/** Current through V/E/H sources is `i(name)`; everything else is `@name[i]`. */
function currentExpression(target) {
  return /^[vehVEH]/.test(target)
    ? { expr: `i(${target})`, save: null }
    : { expr: `@${target.toLowerCase()}[i]`, save: `@${target.toLowerCase()}[i]` };
}

/**
 * Compile one assertion into the control-block lines that take its value, plus
 * the Kinux check object that decides the verdict.
 *
 * Kinux differs from upstream here in three ways, each for a reason:
 *  * no `.meas ... PARAM='<value> - <bound>'` margin measures. ngspice only
 *    evaluates `param=` against parse-time parameters, not against the result
 *    of another measurement, so those lines do not compute what upstream
 *    intends; and they interpolate the user's own number text into a deck
 *    expression. The comparison happens in JavaScript instead, on the float
 *    ngspice reported.
 *  * `.meas op` does not exist in ngspice (it refuses with `failed!`), so an
 *    operating-point value is taken with `let`/`print` after `op`.
 *  * an `at <point>` clause compiles to `FIND ... AT=`; without one a swept
 *    analysis falls back to upstream's `AVG`.
 *
 * @param {SimulationAssertion} assertion
 * @param {SpiceAnalysis|SpiceAnalysisKind} analysis
 * @param {string} [name] generated measure name (lowercase identifier)
 * @returns {{name: string, lines: string[], saves: string[],
 *            check: {measure: string, min?: number, max?: number, units?: string},
 *            expression: string}}
 */
export function compileSpiceAssertion(assertion, analysis, name = `assertion_${assertion.line}`) {
  const a = typeof analysis === 'string' ? { kind: analysis, params: [], raw: analysis } : analysis;
  if (!SAFE_MEASURE_NAME.test(name)) {
    throw new SimulationParseError(
      assertion.line,
      `invalid measure name "${name}"`,
      'invalid_measure_name',
    );
  }
  const { measurable, at } = assertion;
  if (!SAFE_TARGET.test(measurable.target)) {
    // Belt and braces: a hand-built assertion object never reaches the deck
    // without passing the same allowlist the parser applies.
    throw new SimulationParseError(
      assertion.line,
      `invalid measurable target "${measurable.target}"`,
      'invalid_target',
    );
  }

  const lines = [];
  const saves = [];
  let expression;

  if (measurable.kind === 'corner') {
    if (a.kind !== 'ac') {
      throw new SimulationParseError(
        assertion.line,
        'corner() requires an ac analysis',
        'corner_requires_ac',
      );
    }
    if (at) {
      throw new SimulationParseError(
        assertion.line,
        'corner() is itself a frequency; it takes no "at" point',
        'at_not_supported',
      );
    }
    expression = `vdb(${measurable.target})`;
    lines.push(`meas ac ${name} WHEN ${expression}=-3 FALL=1`);
  } else {
    if (measurable.kind === 'voltage') {
      expression = `v(${measurable.target})`;
    } else {
      const cur = currentExpression(measurable.target);
      expression = cur.expr;
      if (cur.save) saves.push(cur.save);
    }

    if (a.kind === 'op') {
      if (at) {
        throw new SimulationParseError(
          assertion.line,
          'an op analysis has no sweep, so it takes no "at" point',
          'at_not_supported',
        );
      }
      lines.push(`let ${name} = ${expression}`, `print ${name}`);
    } else if (at) {
      lines.push(`meas ${a.kind} ${name} FIND ${expression} AT=${literal(at.value)}`);
    } else {
      lines.push(`meas ${a.kind} ${name} AVG ${expression}`);
    }
  }

  const c = assertion.comparator;
  const units = comparatorNumbers(c)[0].unit || undefined;
  /** @type {{measure: string, min?: number, max?: number, units?: string}} */
  const check = { measure: name };
  if (c.kind === 'between') {
    check.min = c.lower.value;
    check.max = c.upper.value;
  } else if (c.kind === 'less-than') {
    check.max = c.bound.value;
  } else {
    check.min = c.bound.value;
  }
  if (units) check.units = units;

  return { name, lines, saves, check, expression };
}

/** `between 3.25 and 3.35` -> `3.25 .. 3.35`, for the result's `limit` field. */
export function describeComparator(c) {
  if (c.kind === 'between') return `${c.lower.raw} .. ${c.upper.raw}`;
  return c.kind === 'less-than' ? `< ${c.bound.raw}` : `> ${c.bound.raw}`;
}

/** The exact comparison, including strictness. Upstream's margin measures made
 *  `between` inclusive and `<`/`>` strict; that distinction is preserved. */
export function satisfies(measured, c) {
  if (c.kind === 'between') return measured >= c.lower.value && measured <= c.upper.value;
  if (c.kind === 'less-than') return measured < c.bound.value;
  return measured > c.bound.value;
}

/** Strip the deck terminator and anything after it, so we can append. */
function withoutEnd(netlist) {
  const lines = String(netlist ?? '').replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex(l => /^\s*\.end\s*$/i.test(l));
  return (at === -1 ? lines : lines.slice(0, at)).join('\n').replace(/\s+$/, '');
}

/**
 * Assemble netlist + sources + analysis + measurements into one deck, and run
 * it past the sanitizer. Nothing here executes anything.
 *
 * @param {string} netlist the circuit, untrusted
 * @param {{analysis: SpiceAnalysis|SpiceAnalysisKind, assertions: Array<string|SimulationAssertion>,
 *          sources?: SimulationSource[]}} block
 * @param {{namePrefix?: string}} [opts]
 * @returns {{deck: string|null, ok: boolean, checks: Array<object>,
 *            errors: Array<{raw: string, line: number, code: string, message: string}>,
 *            violations: Array<object>, reason: string|null, reason_code: string|null}}
 */
export function compileSimulationDeck(netlist, block, opts = {}) {
  const prefix = opts.namePrefix ?? 'k';
  if (!SAFE_MEASURE_NAME.test(prefix)) {
    throw new SimulationParseError(0, `invalid name prefix "${prefix}"`, 'invalid_measure_name');
  }

  const errors = [];
  let analysis;
  try {
    analysis =
      typeof block.analysis === 'string' ? parseAnalysis(block.analysis, 0) : block.analysis;
    if (!analysis || !ANALYSES.has(analysis.kind)) {
      throw new SimulationParseError(0, 'Simulation block is missing analysis', 'missing_analysis');
    }
    for (const token of analysis.params ?? []) {
      if (!SAFE_PARAM_TOKEN.test(token)) {
        throw new SimulationParseError(
          0,
          `analysis parameter "${token}" is not a plain value`,
          'invalid_analysis_params',
        );
      }
    }
    if (analysis.kind !== 'op' && (analysis.params ?? []).length === 0) {
      // Upstream could not build a runnable deck here at all: it never captured
      // sweep parameters. Refusing is honest; guessing a sweep is not.
      throw new SimulationParseError(
        0,
        `analysis "${analysis.kind}" needs its sweep parameters, e.g. "tran 1u 6m"`,
        'analysis_params_required',
      );
    }
  } catch (err) {
    if (!(err instanceof SimulationParseError)) throw err;
    return {
      deck: null,
      ok: false,
      checks: [],
      errors: [{ raw: String(block.analysis ?? ''), line: err.line, code: err.code, message: err.message }],
      violations: [],
      reason: err.message,
      reason_code: err.reason_code,
      blocking: true,
    };
  }

  const parsed = parseAssertions(block.assertions ?? []);
  errors.push(...parsed.errors);

  const measureLines = [];
  const saves = new Set();
  const checks = [];
  parsed.assertions.forEach((assertion, i) => {
    const name = `${prefix}${i + 1}`;
    try {
      const compiled = compileSpiceAssertion(assertion, analysis, name);
      measureLines.push(...compiled.lines);
      for (const s of compiled.saves) saves.add(s);
      checks.push({ ...compiled.check, assertion, name });
    } catch (err) {
      if (!(err instanceof SimulationParseError)) throw err;
      errors.push({ raw: assertion.raw, line: err.line, code: err.code, message: err.message });
    }
  });

  const sourceLines = (block.sources ?? []).map((s, i) => {
    if (!SAFE_TARGET.test(s.port)) {
      throw new SimulationParseError(s.line ?? 0, `invalid source port "${s.port}"`, 'invalid_source');
    }
    return `V${prefix}src${i + 1} ${s.port} 0 DC ${literal(s.value.value)}`;
  });

  const control = ['.control'];
  if (saves.size > 0) control.push(`save ${[...saves].join(' ')} all`);
  control.push([analysis.kind, ...(analysis.params ?? [])].join(' ').trim());
  control.push(...measureLines);
  control.push('.endc');

  const deck = [
    withoutEnd(netlist),
    ...(sourceLines.length ? ['* sources driven by the Simulation block', ...sourceLines] : []),
    ...control,
    '.end',
    '',
  ].join('\n');

  // The deck goes nowhere near ngspice until the allowlist sanitizer approves
  // it. A rejection is reported, never stripped and retried.
  const s = sanitize(deck);
  if (!s.ok) {
    return {
      deck,
      ok: false,
      checks,
      errors,
      violations: s.violations,
      reason: `compiled deck rejected by the ngspice sanitizer:\n${describeViolations(s.violations)}`,
      reason_code: 'netlist_unsupported',
      blocking: true,
    };
  }

  return {
    deck,
    ok: checks.length > 0,
    checks,
    errors,
    violations: [],
    reason: checks.length > 0 ? null : 'no assertion in this block could be compiled',
    reason_code: checks.length > 0 ? null : 'netlist_unsupported',
    blocking: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                   */
/* -------------------------------------------------------------------------- */

/** @returns {AssertionResult} */
function notChecked(test_id, subject, reason_code, reason, assertion) {
  const out = {
    test_id,
    subject,
    verdict: 'NOT_CHECKED',
    reason_code,
    reason: String(reason ?? '').slice(0, 2000),
  };
  if (assertion) out.assertion = assertion;
  return out;
}

/**
 * ngspice names the vector it could not resolve (`no such vector as v(x)`,
 * `RHS "v(x)" invalid`). Finding that line turns "measurement missing" into
 * "that net does not exist", which is what the reader needs.
 */
function unresolvedVector(run, assertion) {
  const blob = `${run?.stdout ?? ''}\n${run?.stderr ?? ''}`;
  const target = assertion.measurable.target.toLowerCase();
  for (const raw of blob.split('\n')) {
    const line = raw.trim();
    const l = line.toLowerCase();
    if (!l.includes(target)) continue;
    if (/no such vector|rhs .* invalid|not available|unknown node/.test(l)) return line;
  }
  return null;
}

/**
 * Decide one assertion against a finished run.
 *
 * The honesty decision is delegated to verdict.mjs/evaluateCheck, which owns
 * every "we could not check this" path (blocked deck, failed run, measurement
 * missing, ngspice reported the measurement failed). Only when that returns a
 * real PASS/FAIL do we re-decide the boundary with the assertion's own
 * comparator, because `<` and `>` are strict while evaluateCheck's min/max are
 * inclusive.
 *
 * @param {object} run result of run.mjs runNetlist()
 * @param {{measure: string, min?: number, max?: number, units?: string,
 *          assertion: SimulationAssertion, name: string}} check
 * @param {{test_id: string, subject?: string}} ids
 * @returns {AssertionResult}
 */
export function evaluateAssertion(run, check, ids) {
  const test_id = ids.test_id;
  const subject = ids.subject ?? 'baseline';
  const { assertion } = check;

  const base = evaluateCheck(run, {
    test_id,
    subject,
    measure: check.measure,
    min: check.min,
    max: check.max,
    units: check.units,
  });

  if (base.verdict !== 'PASS' && base.verdict !== 'FAIL') {
    const out = { ...base, assertion: assertion.raw };
    const unresolved = unresolvedVector(run, assertion);
    if (unresolved) {
      out.reason =
        `ngspice could not resolve "${assertion.measurable.target}" (${unresolved}); ` +
        `the net or device named in "${assertion.raw}" may not exist in this netlist`;
    }
    return out;
  }

  const pass = satisfies(base.measured, assertion.comparator);
  const out = {
    ...base,
    verdict: pass ? 'PASS' : 'FAIL',
    limit: describeComparator(assertion.comparator),
    assertion: assertion.raw,
  };
  delete out.reason_code;
  delete out.reason;
  return out;
}

/**
 * The whole job: compile a netlist plus a Simulation block into a deck, run it
 * through Kinux's sanitizer and runner, and return one contract-shaped verdict
 * per assertion.
 *
 * Every assertion gets exactly one result. An assertion that could not be
 * parsed, compiled, sanitized or measured comes back NOT_CHECKED or ERROR with
 * a reason_code -- never PASS, never FAIL.
 *
 * @param {string} netlist the circuit, untrusted
 * @param {{analysis: SpiceAnalysis|string, assertions: Array<string|SimulationAssertion>,
 *          sources?: SimulationSource[], scope?: SimulationScope}} block
 * @param {{testIdPrefix?: string, subject?: string, timeoutMs?: number,
 *          namePrefix?: string}} [opts]
 * @returns {Promise<{deck: string|null, run: object|null, results: AssertionResult[],
 *                    compile: object}>}
 */
export async function verifySimulation(netlist, block, opts = {}) {
  const subject = opts.subject ?? 'baseline';
  const idPrefix = opts.testIdPrefix ?? 'spice';
  const compile = compileSimulationDeck(netlist, block, { namePrefix: opts.namePrefix });
  const results = [];

  // 1. Assertions that never became deck lines.
  compile.errors.forEach((e, i) => {
    results.push(
      notChecked(
        `${idPrefix}:${e.line}:e${i + 1}`,
        subject,
        'netlist_unsupported',
        e.message,
        e.raw,
      ),
    );
  });

  // 2. A deck-level refusal (bad analysis, sanitizer rejection) sinks every
  //    assertion in the block -- as NOT_CHECKED, not as a failure.
  if (compile.blocking || !compile.deck) {
    for (const c of compile.checks) {
      results.push(
        notChecked(
          `${idPrefix}:${c.assertion.line}:${c.name}`,
          subject,
          compile.reason_code ?? 'netlist_unsupported',
          compile.reason ?? 'the deck could not be compiled',
          c.assertion.raw,
        ),
      );
    }
    return { deck: compile.deck, run: null, results, compile };
  }

  if (compile.checks.length === 0) {
    return { deck: compile.deck, run: null, results, compile };
  }

  // 3. Run it. runNetlist sanitizes again on its own: the deck is checked by
  //    the one authoritative implementation on the path to the binary.
  const run = await runNetlist(compile.deck, { timeoutMs: opts.timeoutMs });

  for (const c of compile.checks) {
    results.push(
      evaluateAssertion(run, c, {
        test_id: `${idPrefix}:${c.assertion.line}:${c.name}`,
        subject,
      }),
    );
  }

  return { deck: compile.deck, run, results, compile };
}

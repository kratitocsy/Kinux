// Derived from copperhead/src/kicad/report.ts
//   https://github.com/copperheadhq/copperhead
//   Copyright 2026 Chouhan Industries, licensed under Apache License 2.0.
//   Full licence: licenses/copperhead-Apache-2.0.txt. See THIRD-PARTY-NOTICES.md.
// MODIFIED for Kinux: ported from TypeScript to dependency-free ESM; results
// mapped to the Kinux verdict contract, where NOT_CHECKED and ERROR are never
// a pass; gated on the installed kicad-cli version, since KiCad 7 cannot run
// ERC or DRC at all.
//
// WHAT THIS MODULE IS
//
// Step S2.6: parse `kicad-cli`'s ERC and DRC JSON reports into one shape, then
// turn that shape into a Kinux verdict. It is driven entirely by report JSON,
// so it is testable without KiCad; the only part that touches the binary is the
// version gate, which is reused from kicad-cli.mjs rather than duplicated.
//
// THE TWO THINGS THAT ARE REPORTED BUT NEVER FAIL (both inherited, both
// hard-won in the upstream project, issue #314 there):
//
//   1. DRC's `unconnected_items` - connections still left as ratsnest. A draft
//      board legitimately has unrouted nets. They are COUNTED and reported,
//      and they never make the verdict FAIL.
//   2. Findings every one of whose items belongs to a SINGLE footprint (a stock
//      USB-C footprint's pad sitting 0.18 mm from its own peg hole). Placement
//      cannot move them and layout may not edit library footprints, so they
//      are reported beside the result, not as failures.
//
// The exceptions to (2) matter as much as the rule, and are kept verbatim in
// spirit: a short (`shorting_items`) is an electrical fault whichever footprint
// it sits in; a reference carried by two footprints names neither, so what lies
// between them may be two overlapping parts; and a footprint KiCad cannot vouch
// for (`lib_footprint_mismatch`, `lib_footprint_issues`) is never excused,
// because what is inside it is not known to be the library's doing. If the
// board could not be read for its references at all, nothing is excused.
//
// HONESTY, which is Kinux's own addition and is not negotiable: verdicts are
// PASS, FAIL, NOT_CHECKED or ERROR; NOT_CHECKED and ERROR always carry a
// reason_code from the frozen enum in contracts/event.schema.json; a check that
// did not run never looks like a pass. On this container (kicad-cli 7.0.11)
// every ERC and DRC request is NOT_CHECKED, because `sch erc` and `pcb drc`
// arrived in KiCad 8.0.

import { readFile } from 'node:fs/promises';

import { runDrc, runErc } from './kicad-cli.mjs';

export const VERDICTS = { PASS: 'PASS', FAIL: 'FAIL', NOT_CHECKED: 'NOT_CHECKED', ERROR: 'ERROR' };

// ------------------------------------------------------------------ parsing

function normItem(i) {
  const item = { description: String(i?.description ?? '') };
  if (i?.pos?.x !== undefined) item.x = i.pos.x;
  if (i?.pos?.y !== undefined) item.y = i.pos.y;
  return item;
}

function normViolation(v, sheet) {
  const out = {
    severity: v?.severity ?? 'error',
    type: v?.type ?? 'unknown',
    description: v?.description ?? '',
  };
  if (sheet !== undefined) out.sheet = sheet;
  out.items = (v?.items ?? []).map(normItem);
  return out;
}

/**
 * Does a finding put two different nets in contact? Only a short does: two
 * schematic nets wired onto coincident or overlapping pads of one stock part is
 * an electrical fault whichever footprint it sits in, so it is never
 * library-intrinsic. A clearance between a footprint's own pads is the
 * library's geometry even across nets (a USB-C receptacle's DP/DM pads sit
 * closer than the board rule), and placement cannot change it.
 */
export function joinsNets(v) {
  return v.type === 'shorting_items';
}

/**
 * The one footprint every item of a finding belongs to, or null. KiCad names a
 * footprint's items "Pad A1 [GND] of J1 on F.Cu", "NPTH pad of J1"; a track,
 * zone, or board-edge item names none, so it never counts as intrinsic. An
 * unannotated reference ("REF**", "R?") is not a name either: it is the
 * library's default, so two such parts overlapping would read as one.
 */
export function footprintOwner(v) {
  if (!v.items?.length) return null;
  let owner = null;
  for (const i of v.items) {
    const ref = /\bof (\S+)/.exec(i.description)?.[1];
    if (!ref || !/^[A-Za-z#_][\w#.-]*$/.test(ref) || (owner !== null && ref !== owner)) return null;
    owner = ref;
  }
  return owner;
}

/**
 * References carried by more than one footprint on a board (a mis-annotated
 * board, or two parts pasted in pcbnew). Read with a pattern, not the parser:
 * the reference is the first atom after `(property "Reference"` (KiCad 8+) or
 * `(fp_text reference` (older, where KiCad 5 leaves it unquoted).
 */
export function duplicateFootprintRefs(boardText) {
  const seen = new Set();
  const dupes = new Set();
  for (const m of String(boardText).matchAll(/\((?:property\s+"Reference"|fp_text\s+reference)\s+"?([^"\s)]+)/g)) {
    if (seen.has(m[1])) dupes.add(m[1]);
    seen.add(m[1]);
  }
  return dupes;
}

/**
 * Normalize a kicad-cli ERC or DRC JSON report into one shape. ERC nests
 * violations per sheet; DRC has top-level `violations` plus `unconnected_items`
 * and `schematic_parity`. Tolerant of missing fields across KiCad versions.
 *
 * @param {unknown} raw parsed report JSON
 * @param {'erc'|'drc'} source
 * @param {{duplicateRefs?: Set<string>, excuse?: boolean}} [opts]
 *   `excuse: false` when the board's references could not be read: then nothing
 *   is excused, rather than everything that happens to name one reference.
 * @returns {{ok: boolean, source: string, violations: object[], unrouted?: number, intrinsic?: object[]}}
 */
export function normalizeReport(raw, source, opts = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const violations = [];
  for (const sheet of r.sheets ?? []) {
    for (const v of sheet?.violations ?? []) violations.push(normViolation(v, sheet?.path));
  }
  // A footprint KiCad cannot vouch for is never excused: one that no longer
  // matches its library was edited on the board, and one whose library KiCad
  // cannot find (`lib_footprint_issues`) was never compared at all, so what
  // lies inside either is not known to be the library's doing.
  const unvouched = new Set(
    (r.violations ?? [])
      .filter(v => v?.type === 'lib_footprint_mismatch' || v?.type === 'lib_footprint_issues')
      .flatMap(v => (v?.items ?? []).map(i => /^Footprint (\S+)/.exec(i?.description ?? '')?.[1]))
      .filter(Boolean),
  );
  const duplicate = opts.duplicateRefs ?? new Set();
  const intrinsic = [];
  for (const v of r.violations ?? []) {
    const n = normViolation(v);
    const owner = source === 'drc' && opts.excuse !== false ? footprintOwner(n) : null;
    if (owner && !unvouched.has(owner) && !duplicate.has(owner) && !joinsNets(n)) intrinsic.push(n);
    else violations.push(n);
  }
  for (const v of r.schematic_parity ?? []) violations.push(normViolation(v));
  // Unrouted connections are a COUNT, not violations: `ok` means nothing
  // routed or placed is wrong, not that the board is finished.
  const unrouted = r.unconnected_items?.length ?? 0;
  const out = { ok: violations.length === 0, source, violations };
  if (source === 'drc') {
    out.unrouted = unrouted;
    out.intrinsic = intrinsic;
  }
  return out;
}

/** One-line-per-finding rendering, for logs and for a human reading a result. */
export function formatViolations(report) {
  const unrouted = report.unrouted ? ` (${report.unrouted} connection(s) unrouted, left as ratsnest)` : '';
  const intrinsic = report.intrinsic?.length
    ? `\n  ${report.intrinsic.length} finding(s) inside a single library footprint, not a placement problem: `
      + report.intrinsic.map(v => `${footprintOwner(v)} ${v.type}`).join(', ')
    : '';
  if (report.ok) return `${report.source.toUpperCase()}: clean${unrouted}${intrinsic}`;
  const lines = [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)${unrouted}${intrinsic}`];
  for (const v of report.violations) {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`  ${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`    - ${i.description}${pos}`);
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ verdict layer

const SOURCES = new Set(['erc', 'drc']);

function errorResult({ test_id, subject, detail_code, reason, source }) {
  return {
    test_id,
    subject,
    verdict: VERDICTS.ERROR,
    reason_code: 'tool_error', // the frozen enum has no "unparsable report" entry
    detail_code,
    reason: String(reason ?? '').slice(0, 2000),
    check: source ? `${source}_report` : 'kicad_report',
  };
}

/**
 * Parse report JSON text. Never throws. Malformed or truncated text comes back
 * as {ok:false}; it must never be mistaken for an empty (clean) report.
 * @returns {{ok: true, raw: object} | {ok: false, detail_code: string, reason: string}}
 */
export function parseReportJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, detail_code: 'report_empty', reason: 'the report file is empty: kicad-cli wrote nothing' };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      detail_code: 'report_unparsable',
      reason: `the report is not valid JSON (truncated or corrupt): ${String(err.message ?? err)}`,
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail_code: 'report_not_an_object', reason: `the report parsed to ${Array.isArray(raw) ? 'an array' : typeof raw}, not a report object` };
  }
  return { ok: true, raw };
}

/**
 * Turn a normalized report into a Kinux verdict.
 *
 * PASS means: the report was read, and nothing routed or placed is wrong.
 * Unrouted ratsnest and single-footprint findings travel with the result and
 * never change the verdict.
 */
export function reportVerdict(report, { test_id, subject = 'baseline' } = {}) {
  const out = {
    test_id: test_id ?? `${report.source}_report`,
    subject,
    verdict: report.ok ? VERDICTS.PASS : VERDICTS.FAIL,
    check: `${report.source}_report`,
    source: report.source,
    violations: report.violations,
    violation_count: report.violations.length,
    summary: formatViolations(report),
  };
  if (report.source === 'drc') {
    out.unrouted = report.unrouted;
    out.intrinsic = report.intrinsic;
    out.intrinsic_count = report.intrinsic.length;
  }
  if (!report.ok) {
    out.reason = `${report.source.toUpperCase()}: ${report.violations.length} violation(s)`;
  }
  return out;
}

/**
 * Parse report JSON text and produce a verdict in one step.
 *
 * @param {object} o
 * @param {string} o.text      the report file's contents
 * @param {'erc'|'drc'} o.source
 * @param {string} [o.test_id]
 * @param {string} [o.subject]
 * @param {string} [o.boardText] the .kicad_pcb text, for DRC: a reference on
 *   two footprints excuses nothing. Pass `null` to say the board could not be
 *   read, which excuses nothing at all.
 */
export function evaluateReportText({ text, source, test_id, subject = 'baseline', boardText }) {
  if (!SOURCES.has(source)) {
    return errorResult({
      test_id: test_id ?? 'kicad_report', subject,
      detail_code: 'unknown_report_source',
      reason: `report source must be 'erc' or 'drc', got ${JSON.stringify(source)}`,
    });
  }
  const parsed = parseReportJson(text);
  if (!parsed.ok) {
    return errorResult({
      test_id: test_id ?? `${source}_report`, subject, source,
      detail_code: parsed.detail_code, reason: parsed.reason,
    });
  }
  let opts = {};
  if (source === 'drc') {
    if (boardText === null) opts = { excuse: false };
    else if (typeof boardText === 'string') opts = { duplicateRefs: duplicateFootprintRefs(boardText) };
  }
  return reportVerdict(normalizeReport(parsed.raw, source, opts), { test_id, subject });
}

/** Same, from a file on disk. A report that cannot be read is ERROR, not PASS. */
export async function evaluateReportFile({ reportPath, ...rest }) {
  let text;
  try {
    text = await readFile(reportPath, 'utf8');
  } catch (err) {
    // No report on disk usually means kicad-cli bailed before checking at all,
    // typically because the design file does not load in KiCad.
    return errorResult({
      test_id: rest.test_id ?? `${rest.source}_report`,
      subject: rest.subject ?? 'baseline',
      source: SOURCES.has(rest.source) ? rest.source : undefined,
      detail_code: 'report_missing',
      reason: `no report at ${reportPath}: ${String(err.message ?? err)}`,
    });
  }
  return evaluateReportText({ text, ...rest });
}

/**
 * The whole check: ask kicad-cli.mjs to run ERC or DRC, then parse whatever
 * report it produced.
 *
 * On this container the version gate in kicad-cli.mjs answers first and this
 * returns its NOT_CHECKED result (reason_code `tool_missing`, detail_code
 * `kicad_cli_too_old`, naming the version found and the version required).
 * That gate is reused, not reimplemented, and its result is never a PASS.
 *
 * @param {object} o
 * @param {'erc'|'drc'} o.source
 * @param {string} o.input       the .kicad_sch (erc) or .kicad_pcb (drc)
 * @param {string} [o.reportPath] where the run wrote its JSON report; on a
 *   KiCad 8+ machine kicad-cli.mjs supplies this itself.
 * @param {string} [o.test_id]
 * @param {string} [o.subject]
 * @param {function} [o._run] injection point for tests: stands in for
 *   runErc/runDrc so the parse-and-verdict path can be exercised without KiCad.
 */
export async function runCheck({ source, input, reportPath, test_id, subject = 'baseline', _run, ...opts } = {}) {
  if (!SOURCES.has(source)) {
    return errorResult({
      test_id: test_id ?? 'kicad_report', subject,
      detail_code: 'unknown_report_source',
      reason: `check source must be 'erc' or 'drc', got ${JSON.stringify(source)}`,
    });
  }
  const run = _run ?? (source === 'erc' ? runErc : runDrc);
  let res;
  try {
    res = await run({ input, ...opts });
  } catch (err) {
    return errorResult({
      test_id: test_id ?? `${source}_report`, subject, source,
      detail_code: 'kicad_cli_failed',
      reason: `kicad-cli ${source} failed: ${String(err.message ?? err).split('\n')[0]}`,
    });
  }

  // The version gate (or a missing binary) already decided: pass it through
  // with its reason_code intact, and attach the test identity. Never a PASS.
  if (res && (res.verdict === VERDICTS.NOT_CHECKED || res.verdict === VERDICTS.ERROR)) {
    return { ...res, test_id: test_id ?? `${source}_report`, subject, source };
  }

  const path = res?.report ?? res?.report_path ?? reportPath;
  if (!path) {
    return errorResult({
      test_id: test_id ?? `${source}_report`, subject, source,
      detail_code: 'report_missing',
      reason: `kicad-cli ${source} returned no report path, so nothing could be parsed`,
    });
  }
  let boardText;
  if (source === 'drc' && input) {
    boardText = await readFile(input, 'utf8').then(t => t, () => null);
  }
  return evaluateReportFile({ reportPath: path, source, test_id, subject, boardText });
}

/** ERC on a schematic. NOT_CHECKED on KiCad 7, which has no `sch erc`. */
export function checkErc(o = {}) {
  return runCheck({ ...o, source: 'erc' });
}

/** DRC on a board. NOT_CHECKED on KiCad 7, which has no `pcb drc`. */
export function checkDrc(o = {}) {
  return runCheck({ ...o, source: 'drc' });
}

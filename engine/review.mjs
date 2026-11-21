// Design review by proposals: agents propose, deterministic verifiers decide.
//
// The pattern is Copperhead's model review (docs/LEARNINGS.md section 7),
// rebuilt on Kinux's own verifiers. A reviewer (a person, or an agent such as
// a Claude Code subagent for one domain) never writes a free-text verdict. It
// submits structured PROPOSALS, and each is accepted or rejected here, at once,
// by code that cannot be argued with:
//
//   citation     {doc, quote}                  the quote must occur verbatim (whitespace folded)
//                                              in a document of the bundle; the line is returned
//   fact         {claim:'part_value', ref, value}
//                {claim:'connected', net, pins:['R4.1', ...]}   each pin is on that net
//                {claim:'net_members', net, pins:[...]}         the COMPLETE member list: a
//                                              statement of absence needs the whole net
//   measurement  {probe:'V(NET)'|'I(PART)', analysis, sources?, at?}
//                                              run on ngspice; the solver's number is the result,
//                                              and the proposal may not carry its own value
//   finding      {title, severity, premises:[ids], statement?}
//                                              accepted only if every premise was accepted, with at
//                                              least one citation (what is required) and at least
//                                              one fact or measurement (what the design does)
//   question     {text}                        recorded open, for a person; never a finding
//
// Everything a reviewer can see is one closed bundle with a hash. Every
// proposal and decision is logged; replay() re-runs the verifiers over the log
// with no model and must produce the same decisions and the same report.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { verifySimulation } from '../workers/ngspice/assertions.mjs';

export const KINDS = new Set(['citation', 'fact', 'measurement', 'finding', 'question']);
export const SEVERITIES = new Set(['blocking', 'major', 'minor', 'info']);
const sha = s => createHash('sha256').update(s).digest('hex');
const fold = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const netName = n => String(n ?? '').replace(/^\//, '');

/**
 * Build the closed bundle a review sees.
 * @param {{design: {comps: Array, nets: Array}, deck: string, documents: Array<{path: string}>,
 *          sweep?: object, compat?: string|null, timeoutMs?: number}} input
 */
export function buildBundle({ design, deck, documents = [], sweep = null, compat = null, timeoutMs = 120_000 }) {
  const parts = new Map(design.comps.map(c => [c.ref, { ref: c.ref, value: c.value, part: c.part ?? null, footprint: c.footprint ?? null }]));
  const nets = new Map();
  for (const n of design.nets) nets.set(netName(n.name), new Set(n.nodes.map(x => `${x.ref}.${x.pin}`)));
  const docs = new Map();
  for (const d of documents) {
    const text = readFileSync(d.path, 'utf8');
    docs.set(d.name ?? basename(d.path), { name: d.name ?? basename(d.path), text, lines: text.split('\n'), sha256: sha(text) });
  }
  const hash = sha(JSON.stringify({
    parts: [...parts.values()],
    nets: [...nets.entries()].map(([k, v]) => [k, [...v].sort()]).sort(),
    docs: [...docs.values()].map(d => [d.name, d.sha256]).sort(),
    deck: sha(deck), compat,
  }));
  return { parts, nets, docs, deck, sweep, compat, timeoutMs, hash };
}

/** What a reviewer is shown: everything it may reason over, nothing it may not. */
export function describeBundle(b) {
  return {
    bundle_hash: b.hash,
    parts: [...b.parts.values()],
    nets: Object.fromEntries([...b.nets.entries()].map(([k, v]) => [k, [...v].sort()])),
    documents: [...b.docs.values()].map(d => ({ name: d.name, sha256: d.sha256, lines: d.lines.length })),
    sweep: b.sweep,
    measurable: 'measurements run on the simulated circuit, which holds the modelled parts only',
  };
}

/** Read a document of the bundle, so a reviewer quotes what is there. */
export function readDocument(b, name, from = 1, to = Infinity) {
  const d = b.docs.get(name);
  if (!d) return null;
  const lo = Math.max(1, from | 0), hi = Math.min(d.lines.length, to === Infinity ? d.lines.length : to | 0);
  return { name, from: lo, to: hi, text: d.lines.slice(lo - 1, hi).map((l, i) => `${lo + i}: ${l}`).join('\n') };
}

const reject = reason => ({ status: 'rejected', reason });

function verifyCitation(b, p) {
  const d = b.docs.get(p.doc);
  if (!d) return reject(`no document "${p.doc}" in the bundle`);
  const q = fold(p.quote ?? '');
  if (q.length < 12) return reject('a citation must quote at least 12 characters');
  // Folded, a quote may span lines. Find the first line where it is complete,
  // then the latest line it can start on.
  if (!fold(d.text).includes(q)) return reject(`the quote does not occur in ${p.doc}`);
  let end = 0;
  while (!fold(d.lines.slice(0, end + 1).join(' ')).includes(q)) end += 1;
  let start = end;
  while (!fold(d.lines.slice(start, end + 1).join(' ')).includes(q)) start -= 1;
  return { status: 'verified', evidence: { doc: p.doc, line: start + 1, doc_sha256: d.sha256 } };
}

function verifyFact(b, p) {
  if (p.claim === 'part_value') {
    const part = b.parts.get(p.ref);
    if (!part) return reject(`no part ${p.ref} in the design`);
    if (fold(part.value) !== fold(p.value)) return reject(`${p.ref} is "${part.value}", not "${p.value}"`);
    return { status: 'verified', evidence: { ref: p.ref, value: part.value } };
  }
  if (p.claim === 'connected' || p.claim === 'net_members') {
    const net = b.nets.get(netName(p.net));
    if (!net) return reject(`no net "${p.net}" in the design`);
    const pins = (p.pins ?? []).map(String);
    if (!pins.length) return reject('name at least one pin, as REF.PIN');
    const missing = pins.filter(x => !net.has(x));
    if (missing.length) return reject(`not on ${p.net}: ${missing.join(', ')}`);
    if (p.claim === 'net_members' && pins.length !== net.size) {
      return reject(`${p.net} has ${net.size} members, not ${pins.length}; a complete list is needed to claim what is absent`);
    }
    return { status: 'verified', evidence: { net: netName(p.net), members: [...net].sort() } };
  }
  return reject(`unknown fact claim "${p.claim}"`);
}

async function verifyMeasurement(b, p) {
  if ('value' in p || 'measured' in p) return reject('a measurement may not carry its own value: the solver supplies it');
  if (!/^(V|I)\([A-Za-z0-9_./:+-]+\)$/i.test(p.probe ?? '')) return reject('probe must be V(NET) or I(PART)');
  const at = p.at === undefined ? '' : ` at ${p.at}`;
  const assertion = `${p.probe}${at} between -1e30 and 1e30`;
  const sources = Object.entries(p.sources ?? {}).map(([port, v]) => ({ port, value: { raw: String(v), value: Number(v), unit: '' } }));
  if (sources.some(s => !Number.isFinite(s.value.value))) return reject('source values must be numbers');
  const out = await verifySimulation(b.deck, { analysis: p.analysis ?? 'op', assertions: [assertion], sources },
    { compat: b.compat, timeoutMs: b.timeoutMs, testIdPrefix: 'review' });
  const r = out.results[0];
  if (!r || (r.verdict !== 'PASS' && r.verdict !== 'FAIL')) return reject(`the solver could not measure it: ${r?.reason_code ?? 'no result'} ${String(r?.reason ?? '').split('\n')[0]}`);
  return { status: 'verified', evidence: { probe: p.probe, analysis: p.analysis ?? 'op', sources: p.sources ?? {}, at: p.at ?? null, measured: r.measured, solver: 'ngspice' } };
}

function verifyFinding(p, decided) {
  if (!SEVERITIES.has(p.severity)) return reject(`severity must be one of ${[...SEVERITIES].join(', ')}`);
  if (!p.title || String(p.title).length < 8) return reject('a finding needs a title');
  const premises = (p.premises ?? []).map(String);
  if (!premises.length) return reject('a finding must name its premises');
  const bad = premises.filter(id => decided.get(id)?.status !== 'verified');
  if (bad.length) return reject(`premises not verified: ${bad.join(', ')}`);
  const kinds = premises.map(id => decided.get(id).kind);
  if (!kinds.includes('citation')) return reject('a finding needs at least one verified citation: what is required');
  if (!kinds.some(k => k === 'fact' || k === 'measurement')) return reject('a finding needs at least one verified fact or measurement: what the design does');
  return { status: 'verified', evidence: { premises } };
}

/** A review session over one bundle. */
export function createReview(bundle) {
  const log = [];
  const decided = new Map();
  async function propose(proposal, { domain = null } = {}) {
    const p = { ...proposal };
    const id = `P${log.length + 1}`;
    let decision;
    if (!KINDS.has(p.kind)) decision = reject(`kind must be one of ${[...KINDS].join(', ')}`);
    else if (p.kind === 'citation') decision = verifyCitation(bundle, p);
    else if (p.kind === 'fact') decision = verifyFact(bundle, p);
    else if (p.kind === 'measurement') decision = await verifyMeasurement(bundle, p);
    else if (p.kind === 'finding') decision = verifyFinding(p, decided);
    else decision = { status: 'open', evidence: null };
    const entry = { id, domain, kind: p.kind ?? null, proposal: p, ...decision };
    log.push(entry);
    decided.set(id, entry);
    return entry;
  }
  return { propose, log, decided, bundle };
}

/** Re-run every verifier over a recorded log, with no model. Decisions must match. */
export async function replay(bundle, log) {
  const r = createReview(bundle);
  const mismatches = [];
  for (const e of log) {
    const again = await r.propose(e.proposal, { domain: e.domain });
    if (again.status !== e.status) mismatches.push({ id: e.id, recorded: e.status, replayed: again.status });
  }
  return { review: r, mismatches };
}

/** The report, rendered only from what the verifiers decided. */
export function renderReport(review) {
  const { log, bundle } = review;
  const byId = new Map(log.map(e => [e.id, e]));
  const findings = log.filter(e => e.kind === 'finding' && e.status === 'verified');
  const order = { blocking: 0, major: 1, minor: 2, info: 3 };
  findings.sort((a, b) => order[a.proposal.severity] - order[b.proposal.severity] || a.id.localeCompare(b.id));
  const premise = id => {
    const e = byId.get(id);
    if (e.kind === 'citation') return `${id} cites ${e.evidence.doc} line ${e.evidence.line}: "${e.proposal.quote}"`;
    if (e.kind === 'fact' && e.proposal.claim === 'part_value') return `${id} fact: ${e.evidence.ref} = ${e.evidence.value}`;
    if (e.kind === 'fact') return `${id} fact: ${e.evidence.net} = {${e.evidence.members.join(', ')}}`;
    if (e.kind === 'measurement') {
      const src = Object.entries(e.evidence.sources).map(([k, v]) => `${k}=${v}`).join(', ');
      return `${id} ngspice measured ${e.evidence.probe}${e.evidence.at ? ` at ${e.evidence.at}` : ''} = ${e.evidence.measured} (${e.evidence.analysis}${src ? `; ${src}` : ''})`;
    }
    return id;
  };
  const count = k => log.filter(e => e.status === k).length;
  const out = [`# Design review`, '', `Bundle ${bundle.hash}. ${log.length} proposals: ${count('verified')} verified, ${count('rejected')} rejected, ${count('open')} open questions.`,
    'Rendered from the verifiers\' decisions only. A finding is listed only if every premise was verified; its wording is the proposer\'s.', ''];
  out.push(`## Findings (${findings.length})`, '');
  for (const f of findings) {
    out.push(`### [${f.proposal.severity}] ${f.proposal.title}${f.domain ? ` (${f.domain})` : ''}`, '');
    if (f.proposal.statement) out.push(`Proposer's wording: ${f.proposal.statement}`, '');
    for (const id of f.proposal.premises) out.push(`- ${premise(id)}`);
    out.push('');
  }
  const qs = log.filter(e => e.kind === 'question');
  out.push(`## Open questions for a person (${qs.length})`, '');
  for (const q of qs) out.push(`- ${q.id}${q.domain ? ` (${q.domain})` : ''}: ${q.proposal.text}`);
  out.push('');
  return out.join('\n');
}

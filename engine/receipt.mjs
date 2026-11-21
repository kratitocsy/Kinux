// The evidence receipt for a `kinux verify` run (ROADMAP R7).
//
// A receipt holds hashes of everything that can change the answer: the design, the checks, the
// operator set, the tool versions, and the verdicts that came out. Two runs of the same inputs
// with the same tools give the same receipt_id. The format lives in contracts/receipt.schema.json
// and the builder in server/queue/receipt.mjs; this only gathers the engine's inputs.
// The idea of a hashed input bundle that fixes what was verified follows Copperhead's review
// pipeline (see docs/LEARNINGS.md section 7); no code was copied.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildReceipt, verifyReceipt } from '../server/queue/receipt.mjs';
import { sha256, canonicalJSON } from '../server/queue/cache.mjs';
import { OPERATORS } from './operators.mjs';

const ENGINE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * @param {object} p
 * @param {object} p.outcome   what runVerification returned
 * @param {object} p.report    what buildReport returned
 * @param {Array<{path:string,text:string}>} p.inputs  the files given to the run, as text
 * @param {object[]} [p.operators]  the operators used (default: all)
 * @param {number} [p.limit]   mutant limit, if one was set: it changes the answer
 */
export function makeReceipt({ outcome, report, inputs, operators = OPERATORS, limit = null }) {
  const suiteMaterial = outcome.suite.blocks.map(b => ({ kind: b.kind, analysis: b.analysis?.raw ?? null, assertions: b.assertions.map(a => a.raw) }));
  const verdicts = {
    baseline: outcome.baseline.results.map(r => [r.test_id, r.verdict]),
    mutants: report.mutants.map(m => [m.mutant_id, m.status, m.killed_by ?? null]),
  };
  return buildReceipt({
    engineVersion: ENGINE_VERSION,
    // Paths are reduced to file names so a receipt made on one machine matches another's.
    inputs: inputs.map(i => ({ path: basename(i.path), sha256: sha256(i.text) })),
    toolVersions: outcome.tool_versions,
    seeds: {},
    checkSetSha: sha256(canonicalJSON(suiteMaterial)),
    operatorSetSha: sha256(canonicalJSON({ operators: operators.map(o => o.id).sort(), limit: Number.isFinite(limit) ? limit : null })),
    resultHashes: [sha256(canonicalJSON(verdicts))],
    score: report.score,
  });
}

export { verifyReceipt };

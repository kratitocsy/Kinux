// Evidence receipts: hashes of everything that went into a run, so it can be reproduced.
// Conforms to contracts/receipt.schema.json and is proven with validateReceipt from
// contracts/check-run.mjs. The rules live in contracts/, not here.
import { createHash } from 'node:crypto';
import { computeScore, validateReceipt } from '../../contracts/check-run.mjs';
import { canonicalJSON, hashInputs } from './cache.mjs';

/** The exact wording contracts/receipt.schema.json requires. Do not paraphrase. */
export const DISCLAIMER = 'Pre-check linter. Not a certification and not a substitute for engineering sign-off.';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const assertHash = (h, what) => {
  if (!HASH_RE.test(String(h))) throw new TypeError(`${what} must be "sha256:<64 hex>", got ${h}`);
  return String(h);
};

/** A zero-mutant score, for runs where nothing was checkable. */
export const EMPTY_SCORE = computeScore([]);

/**
 * Normalise a score: pass a list of mutant statuses, or an already-computed runScore.
 */
export function toScore(score) {
  if (Array.isArray(score)) return computeScore(score);
  if (score && typeof score === 'object') {
    const want = computeScore([]);
    const out = {};
    for (const k of Object.keys(want)) {
      if (!(k in score)) throw new TypeError(`score is missing ${k}`);
      out[k] = score[k];
    }
    return out;
  }
  return computeScore([]);
}

/**
 * The material a receipt_id is computed over: everything that can change the answer.
 * `created` and `signature` are deliberately excluded, so two runs of the same inputs
 * with the same tools and seeds produce the same receipt_id.
 */
export function receiptMaterial(r) {
  return {
    v: r.v,
    engine_version: r.engine_version,
    inputs: r.inputs,
    tool_versions: r.tool_versions,
    seeds: r.seeds,
    check_set_sha: r.check_set_sha,
    operator_set_sha: r.operator_set_sha,
    result_hashes: r.result_hashes,
    score: r.score,
    disclaimer: r.disclaimer,
  };
}

export function receiptHash(r) { return sha(canonicalJSON(receiptMaterial(r))); }

/**
 * Build a receipt.
 *
 * @param {object} spec
 * @param {string} spec.engineVersion
 * @param {Array<{path:string,sha256:string}>} spec.inputs   already hashed (use hashInputs/buildReceiptAsync for files)
 * @param {Object<string,string>} spec.toolVersions
 * @param {Object<string,number>} [spec.seeds]               integers only
 * @param {string} spec.checkSetSha
 * @param {string} spec.operatorSetSha
 * @param {string[]} [spec.resultHashes]
 * @param {string} [spec.cacheKey]  the content-addressed cache key; carried as the
 *                                  first entry of result_hashes (the schema is closed,
 *                                  so there is no separate field for it in v1)
 * @param {object|string[]} [spec.score]  a runScore, or a list of mutant statuses
 * @param {string|Date} [spec.created]
 * @returns {object} a receipt that validates against contracts/receipt.schema.json
 */
export function buildReceipt(spec) {
  if (!spec || !spec.engineVersion) throw new TypeError('receipt needs an engineVersion');

  const inputs = (spec.inputs || []).map(i => ({
    path: String(i.path),
    sha256: assertHash(i.sha256, `input hash for ${i.path}`),
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const tool_versions = {};
  for (const k of Object.keys(spec.toolVersions || {}).sort()) {
    tool_versions[k] = String(spec.toolVersions[k]);
  }

  const seeds = {};
  for (const k of Object.keys(spec.seeds || {}).sort()) {
    const n = spec.seeds[k];
    if (!Number.isInteger(n)) throw new TypeError(`seed ${k} must be an integer, got ${n}`);
    seeds[k] = n;
  }

  const result_hashes = [];
  if (spec.cacheKey) result_hashes.push(assertHash(spec.cacheKey, 'cacheKey'));
  for (const h of spec.resultHashes || []) {
    const v = assertHash(h, 'result hash');
    if (!result_hashes.includes(v)) result_hashes.push(v);
  }

  const created = spec.created
    ? (spec.created instanceof Date ? spec.created.toISOString() : new Date(spec.created).toISOString())
    : new Date().toISOString();

  const receipt = {
    v: 1,
    receipt_id: 'sha256:' + '0'.repeat(64), // replaced below
    created,
    engine_version: String(spec.engineVersion),
    inputs,
    tool_versions,
    seeds,
    check_set_sha: assertHash(spec.checkSetSha, 'check_set_sha'),
    operator_set_sha: assertHash(spec.operatorSetSha, 'operator_set_sha'),
    result_hashes,
    score: toScore(spec.score),
    disclaimer: DISCLAIMER,
  };
  receipt.receipt_id = receiptHash(receipt);
  if (spec.signature) receipt.signature = String(spec.signature);
  return receipt;
}

/** Same, but hashes file inputs from disk (strings or { path, content } are accepted). */
export async function buildReceiptAsync(spec) {
  return buildReceipt({ ...spec, inputs: await hashInputs(spec.inputs || []) });
}

/** True when receipt_id still matches the receipt's own contents. */
export function verifyReceipt(receipt) {
  const errors = [];
  const { ok, errors: schemaErrors } = validateReceipt(receipt);
  if (!ok) errors.push(...schemaErrors);
  if (receipt && receipt.disclaimer !== DISCLAIMER) errors.push('/disclaimer is not the fixed contract wording');
  if (receipt && receipt.receipt_id !== receiptHash(receipt)) errors.push('/receipt_id does not match the receipt contents');
  return { ok: errors.length === 0, errors };
}

export { validateReceipt };
export default buildReceipt;

// Content-addressed result cache.
//
// The key is a sha256 over a canonical encoding of everything that can change the
// answer: tool name, tool version, the hash of every input file, the arguments, the
// seeds and the environment pins. Change any one byte of any one of them and the key
// changes. The key is exported so it can be carried in a receipt.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export const sha256 = buf => 'sha256:' + createHash('sha256').update(buf).digest('hex');

/** Deterministic JSON: object keys sorted, no incidental whitespace, undefined dropped. */
export function canonicalJSON(value) {
  const enc = v => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('cannot canonicalise non-finite number');
      return JSON.stringify(v);
    }
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'undefined' || t === 'function') return 'null';
    if (t === 'bigint') return JSON.stringify(v.toString());
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + enc(v[k])).join(',') + '}';
  };
  return enc(value);
}

/** sha256 of a file, streamed. */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve('sha256:' + h.digest('hex')));
  });
}

/**
 * Normalise inputs into [{ path, sha256 }], sorted by path.
 * Accepts: a string path (hashed from disk), { path, sha256 }, or { path, content }.
 */
export async function hashInputs(inputs = []) {
  const out = [];
  for (const item of inputs) {
    if (typeof item === 'string') {
      out.push({ path: item, sha256: await hashFile(item) });
    } else if (item && typeof item.sha256 === 'string') {
      if (!HASH_RE.test(item.sha256)) throw new TypeError(`bad input hash for ${item.path}: ${item.sha256}`);
      out.push({ path: String(item.path), sha256: item.sha256 });
    } else if (item && item.content != null) {
      out.push({ path: String(item.path), sha256: sha256(item.content) });
    } else if (item && item.path) {
      out.push({ path: String(item.path), sha256: await hashFile(item.path) });
    } else {
      throw new TypeError('input needs a path, and either a sha256 or content');
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * The cache key for a job.
 * @param {{tool:string, toolVersion:string, inputs:Array, args?:any, seeds?:object, env?:object, schemaVersion?:number}} spec
 * @returns {{key:string, material:object}} key is "sha256:<hex>"; material is what was hashed.
 */
export function cacheKeySync(spec) {
  if (!spec || !spec.tool) throw new TypeError('cacheKey needs a tool name');
  if (spec.toolVersion == null) throw new TypeError('cacheKey needs a tool version');
  const inputs = (spec.inputs || []).map(i => {
    if (!i || typeof i.sha256 !== 'string' || !HASH_RE.test(i.sha256)) {
      throw new TypeError('cacheKeySync needs inputs as { path, sha256 }; use cacheKey() to hash files');
    }
    return { path: String(i.path), sha256: i.sha256 };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const material = {
    kv: Number(spec.schemaVersion ?? 1),      // bump to invalidate every key
    tool: String(spec.tool),
    tool_version: String(spec.toolVersion),
    inputs,
    args: spec.args ?? null,
    seeds: spec.seeds ?? null,
    env: spec.env ?? null,
  };
  return { key: sha256(canonicalJSON(material)), material };
}

/** Same, but hashes file inputs from disk first. */
export async function cacheKey(spec) {
  return cacheKeySync({ ...spec, inputs: await hashInputs(spec.inputs || []) });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  version    TEXT NOT NULL,
  material   TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  last_hit   INTEGER
);
CREATE INDEX IF NOT EXISTS cache_tool ON cache (tool, version);
`;

export class ResultCache {
  constructor(path = ':memory:', opts = {}) {
    this.path = path;
    this.now = opts.now || (() => Date.now());
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)};`);
    this.db.exec(SCHEMA);
    this.stats = { hits: 0, misses: 0 };
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  /** @returns {null | {key, result, createdAt, hits}} */
  get(key) {
    const row = this.db.prepare('SELECT * FROM cache WHERE key = ?').get(key);
    if (!row) { this.stats.misses++; return null; }
    this.db.prepare('UPDATE cache SET hits = hits + 1, last_hit = ? WHERE key = ?').run(this.now(), key);
    this.stats.hits++;
    return { key, result: JSON.parse(row.result), createdAt: row.created_at, hits: row.hits + 1 };
  }
  has(key) { return !!this.db.prepare('SELECT 1 FROM cache WHERE key = ?').get(key); }

  put(key, result, material = {}) {
    if (!HASH_RE.test(key)) throw new TypeError(`bad cache key: ${key}`);
    this.db.prepare(`INSERT INTO cache (key, tool, version, material, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET result = excluded.result`)
      .run(key, String(material.tool ?? ''), String(material.tool_version ?? ''),
           canonicalJSON(material), JSON.stringify(result ?? null), this.now());
    return key;
  }
  delete(key) { this.db.prepare('DELETE FROM cache WHERE key = ?').run(key); }
  size() { return this.db.prepare('SELECT COUNT(*) n FROM cache').get().n; }

  /**
   * Return the cached result for `spec`, or run `fn` once and store it.
   * @returns {Promise<{key, result, cached:boolean}>}
   */
  async run(spec, fn) {
    const { key, material } = spec && spec.key
      ? { key: spec.key, material: spec.material || {} }
      : await cacheKey(spec);
    const hit = this.get(key);
    if (hit) return { key, result: hit.result, cached: true };
    const result = await fn(key, material);
    this.put(key, result, material);
    return { key, result, cached: false };
  }
}

/** Convenience: read a file and hash its bytes (for callers building input lists). */
export async function fileInput(path) {
  return { path, sha256: sha256(await readFile(path)) };
}

export default ResultCache;

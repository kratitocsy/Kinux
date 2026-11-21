// Static import-graph walker for the "a model never judges" rule (ROADMAP R10).
//
// Starting from the files that produce verdicts and scores, follow every
// import to its file and collect every module specifier the graph can load.
// It is conservative on purpose:
//  * comments are NOT stripped, so a commented-out import still counts;
//  * `import(` with anything other than a string literal is a finding, because
//    a computed specifier cannot be checked;
//  * `require(` is a finding (this is an ES-module codebase).
// A false alarm costs a line of review. A miss would let a model judge.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const STATIC = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_LITERAL = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_ANY = /\bimport\s*\(\s*([^)\s]?)/g;
const REQUIRE = /\brequire\s*\(/g;

/**
 * @param {string[]} entries absolute paths
 * @param {string} root      repository root, for readable paths
 * @returns {{files: string[], external: Map<string, Set<string>>, findings: string[]}}
 */
export function walkImports(entries, root) {
  const seen = new Set();
  const external = new Map();   // bare specifier -> files importing it
  const findings = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) { findings.push(`${relative(root, file)}: imported but not found`); continue; }
    const text = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    const specs = new Set();
    for (const re of [STATIC, DYNAMIC_LITERAL]) for (const m of text.matchAll(re)) specs.add(m[1]);
    for (const m of text.matchAll(DYNAMIC_ANY)) {
      if (m[1] !== "'" && m[1] !== '"') findings.push(`${rel}: import() with a computed specifier cannot be checked`);
    }
    if (REQUIRE.test(text)) findings.push(`${rel}: uses require()`);
    REQUIRE.lastIndex = 0;
    for (const spec of specs) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        queue.push(resolve(dirname(file), spec));
      } else {
        if (!external.has(spec)) external.set(spec, new Set());
        external.get(spec).add(rel);
      }
    }
  }
  return { files: [...seen].map(f => relative(root, f)).sort(), external, findings };
}

/** Python `import x` / `from x import y` top-level module names. */
export function pythonImports(text) {
  const out = new Set();
  for (const m of text.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)) out.add(m[1].split('.')[0]);
  return out;
}

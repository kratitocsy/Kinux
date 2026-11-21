// R10: "agents propose, solvers decide", enforced by the build.
//
// Everything that produces a verdict or a score is walked through its import
// graph. The graph may load only Node's built-ins, the schema validator and
// our own files. A model SDK, the MCP SDK, anything under mcp/ or an agents
// folder, require(), or an import() whose target cannot be read, fails here.
// This matters more since D12: Kinux will now also design, and the designer
// must never be reachable from the code that judges its work.
//
// The positive controls build a small module tree that does import a model SDK
// and prove the walker finds it, so this test cannot pass vacuously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

import { walkImports, pythonImports } from './helpers/import-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The verdict and scoring path. Add to this list, never remove from it. */
export const VERDICT_ENTRIES = [
  'contracts/check-run.mjs',
  'workers/reason-codes.mjs',
  'workers/ngspice/verdict.mjs',
  'workers/ngspice/assertions.mjs',
  'workers/ngspice/run.mjs',
  'workers/thermal/assertions.mjs',
  'workers/fea/study.mjs',
  'workers/motion/verify.mjs',
  'workers/pcb/erc-drc-report.mjs',
  'engine/runner.mjs',
  'engine/report.mjs',
  'engine/equivalence.mjs',
  'engine/operators.mjs',
  'engine/kicad-adapter.mjs',
  'engine/coverage.mjs',
  'engine/review.mjs',
  'engine/cli.mjs',
  'server/queue/receipt.mjs',
];

const ALLOWED_PACKAGES = new Set(['ajv', 'ajv/dist/2020.js', 'ajv-formats']);
const isBuiltin = s => s.startsWith('node:') || builtinModules.includes(s);
const FORBIDDEN_LOCAL = /(^|\/)(mcp|agents?|villain|builder)(\/|$)/i;
// Python modules a solver child may import. A model SDK is not among them.
const ALLOWED_PY = new Set(['hashlib', 'json', 'math', 'os', 'sys', 'xml', 'mujoco', 'numpy']);

function audit(entries, root) {
  const g = walkImports(entries.map(e => join(root, e)), root);
  const problems = [...g.findings];
  for (const [spec, from] of g.external) {
    if (isBuiltin(spec) || ALLOWED_PACKAGES.has(spec)) continue;
    problems.push(`${spec} is imported by ${[...from].join(', ')}`);
  }
  for (const f of g.files) if (FORBIDDEN_LOCAL.test(f)) problems.push(`${f} is an agent-side file on the verdict path`);
  return { g, problems };
}

test('the verdict and scoring path imports only Node built-ins, the schema validator and our own code', () => {
  const { g, problems } = audit(VERDICT_ENTRIES, ROOT);
  assert.ok(g.files.length >= VERDICT_ENTRIES.length, `walked ${g.files.length} files`);
  assert.deepEqual(problems, [], `the verdict path reaches:\n  ${problems.join('\n  ')}`);
});

test('the Python solver child imports no model SDK', () => {
  const mods = pythonImports(readFileSync(join(ROOT, 'workers/motion/sim.py'), 'utf8'));
  assert.ok(mods.has('mujoco'), 'the scan sees the real imports');
  assert.deepEqual([...mods].filter(m => !ALLOWED_PY.has(m)), []);
});

test('positive control: a model SDK two imports deep is found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-r10-'));
  writeFileSync(join(dir, 'verdict.mjs'), "import { helper } from './helper.mjs';\nexport const v = helper;\n");
  writeFileSync(join(dir, 'helper.mjs'), "import Anthropic from '@anthropic-ai/sdk';\nexport const helper = 1;\n");
  const { problems } = audit(['verdict.mjs'], dir);
  assert.ok(problems.some(p => p.startsWith('@anthropic-ai/sdk')), problems.join('; '));
});

test('positive control: dynamic imports, computed imports, require() and agent folders are all caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-r10-'));
  mkdirSync(join(dir, 'mcp'));
  writeFileSync(join(dir, 'a.mjs'), [
    "const m = await import('openai');",
    "const name = 'x'; const n = await import(name);",
    "const r = require('fs');",
    "import './mcp/server.mjs';",
  ].join('\n'));
  writeFileSync(join(dir, 'mcp', 'server.mjs'), 'export {};\n');
  const { problems } = audit(['a.mjs'], dir);
  for (const want of [/^openai /, /computed specifier/, /require\(\)/, /mcp\/server\.mjs is an agent-side file/]) {
    assert.ok(problems.some(p => want.test(p)), `missing ${want} in: ${problems.join('; ')}`);
  }
});

test('positive control: a model SDK in the Python child is found', () => {
  const mods = pythonImports('import json\nfrom anthropic import Anthropic\n');
  assert.deepEqual([...mods].filter(m => !ALLOWED_PY.has(m)), ['anthropic']);
});

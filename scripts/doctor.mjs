#!/usr/bin/env node
// kinux doctor: what this machine can do, and what `npm test` will therefore run.
// No model and no network. Exits 1 only when Node itself is too old.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAll, planSuites, TOOLS } from './tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = { ok: 'ok     ', invisible: 'HIDDEN ', missing: 'MISSING' };

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
const nodeOk = major > 22 || (major === 22 && minor >= 13);
console.log(`${nodeOk ? 'ok     ' : 'TOO OLD'} node ${process.versions.node}  (needs 22.13 or later, for node:sqlite)`);

const status = await probeAll();
for (const t of TOOLS) {
  const s = status[t.id];
  const detail = s.state === 'ok' ? `${s.version}  ${s.path}` : s.reason;
  console.log(`${MARK[s.state]} ${t.id.padEnd(10)} ${detail}`);
}

// Optional tools: informational, never a reason to skip a suite.
const py = process.env.KINUX_PYTHON || join(ROOT, '.venv/bin/python');
let mujoco = 'MISSING';
if (existsSync(py)) {
  try { mujoco = `ok      ${execFileSync(py, ['-I', '-c', 'import mujoco;print(mujoco.__version__)'], { timeout: 15000 }).toString().trim()}`; }
  catch { mujoco = 'MISSING (interpreter found, but it cannot import mujoco)'; }
}
console.log(`${mujoco.startsWith('ok') ? 'ok     ' : 'MISSING'} mujoco     ${mujoco.replace(/^(ok\s+|MISSING\s*)/, '')}  (motion tests skip without it)`);

let playwright = 'MISSING';
try { createRequire(import.meta.url)('playwright'); playwright = 'ok'; } catch { /* not installed */ }
console.log(`${playwright === 'ok' ? 'ok     ' : 'MISSING'} playwright  browser tests skip without it: npm install --no-save playwright && npx playwright install chromium`);

const files = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs')).sort();
const plan = planSuites(files, status);
const skipped = plan.filter(p => !p.run);
console.log(`\nnpm test will run ${plan.length - skipped.length} of ${plan.length} suites.`);
for (const p of skipped) console.log(`  skip ${p.name.padEnd(20)} ${p.reason}`);
if (skipped.length) console.log('`npm run test:all` runs every suite regardless, and fails where a tool is missing.');
for (const p of plan.filter(p => p.unlisted)) console.log(`  NOTE ${p.name} is not listed in scripts/tools.mjs SUITES; add it.`);
process.exit(nodeOk ? 0 : 1);

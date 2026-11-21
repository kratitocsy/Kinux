#!/usr/bin/env node
// npm test. Runs every suite whose tools are present, and says plainly which it skipped and why.
//   node scripts/test.mjs            skip suites whose solver is missing
//   node scripts/test.mjs --all      run everything; a missing tool fails (use this in CI)

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAll, planSuites } from './tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runAll = process.argv.includes('--all') || process.env.KINUX_RUN_ALL === '1';

const files = readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs')).sort();
const plan = planSuites(files, await probeAll(), { runAll });

for (const p of plan.filter(p => !p.run)) console.log(`SKIPPED suite ${p.name}: ${p.reason}`);
for (const p of plan.filter(p => p.unlisted)) console.log(`NOTE: ${p.name} is not listed in scripts/tools.mjs SUITES`);

const run = plan.filter(p => p.run).map(p => join('tests', p.file));
const skipped = plan.length - run.length;
if (skipped) console.log(`${skipped} suite(s) skipped because a tool is missing. Run \`npm run doctor\` for details, or \`npm run test:all\` to run them anyway.\n`);

const child = spawn(process.execPath, ['--test', ...run], { cwd: ROOT, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));

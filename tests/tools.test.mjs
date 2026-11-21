// The tool probe and the suite planner behind `npm run doctor` and `npm test`.
//
// These use synthetic tools in a temp directory, so they pass on any machine,
// whether or not ngspice, CalculiX or KiCad are installed. That matters: the
// whole point of this code is to behave sensibly when a tool is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeTool, planSuites, which, suiteName, SUITES, WORKER_PATH } from '../scripts/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function fakeTool(dir, name, versionLine) {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\necho "${versionLine}"\n`);
  await chmod(p, 0o755);
  return p;
}

const FAKE = (over = {}) => ({
  id: 'fake', bin: 'kinux-fake-tool', env: 'KINUX_FAKE_BIN', args: ['--version'], workerPath: true,
  version: t => /fake-(\d+\.\d+)/.exec(t)?.[1], ...over,
});

test('a tool named by its override is found and its version is read', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await fakeTool(dir, 'whatever', 'fake-7.3 banner');

  const s = await probeTool(FAKE(), { PATH: WORKER_PATH, KINUX_FAKE_BIN: bin });
  assert.equal(s.state, 'ok');
  assert.equal(s.version, '7.3');
  assert.equal(s.path, bin);
});

test('a tool that is not there is missing, with a reason that names it', async () => {
  const s = await probeTool(FAKE(), { PATH: WORKER_PATH });
  assert.equal(s.state, 'missing');
  assert.match(s.reason, /kinux-fake-tool not found/);
});

test('an override pointing at nothing is missing, never silently replaced by another copy', async () => {
  const s = await probeTool(FAKE(), { PATH: WORKER_PATH, KINUX_FAKE_BIN: '/no/such/tool' });
  assert.equal(s.state, 'missing');
});

test('a tool installed where the workers will not look is reported as HIDDEN, with the fix', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await fakeTool(dir, 'kinux-fake-tool', 'fake-2.1');

  // On the caller's PATH, but not on /usr/bin:/bin, which is all the workers search (K22).
  const s = await probeTool(FAKE(), { PATH: `${dir}:${WORKER_PATH}` });
  assert.equal(s.state, 'invisible');
  assert.equal(s.path, bin);
  assert.match(s.reason, /workers only search \/usr\/bin:\/bin/);
  assert.match(s.reason, /KINUX_FAKE_BIN=/);
});

test('a tool the workers find through the ordinary PATH (kicad-cli) is not reported as hidden', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await fakeTool(dir, 'kinux-fake-tool', 'fake-9.9');

  const s = await probeTool(FAKE({ workerPath: false }), { PATH: `${dir}:${WORKER_PATH}` });
  assert.equal(s.state, 'ok');
  assert.equal(s.version, '9.9');
});

test('a file that runs but reports no version is not trusted as the tool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = await fakeTool(dir, 'x', 'some unrelated output');
  const s = await probeTool(FAKE(), { PATH: WORKER_PATH, KINUX_FAKE_BIN: bin });
  assert.equal(s.state, 'missing');
  assert.match(s.reason, /did not report a version/);
});

test('which() checks an absolute path and refuses a non-executable one', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = join(dir, 'plain');
  await writeFile(p, 'data');                    // no execute bit
  assert.equal(which(p), null);
  assert.equal(which('/no/such/thing'), null);
});

// ---- the planner ------------------------------------------------------------

const ok = id => ({ id, state: 'ok', version: '1' });
const gone = id => ({ id, state: 'missing', reason: `${id} not found` });

test('a suite whose tool is missing is skipped with the reason; the others still run', () => {
  const files = ['contracts.test.mjs', 'engine.test.mjs', 'fea.test.mjs'];
  const plan = planSuites(files, { ngspice: gone('ngspice'), ccx: ok('ccx'), gmsh: ok('gmsh'), 'kicad-cli': ok('kicad-cli') });
  const by = Object.fromEntries(plan.map(p => [p.name, p]));

  assert.equal(by.contracts.run, true);
  assert.equal(by.fea.run, true);
  assert.equal(by.engine.run, false);
  assert.match(by.engine.reason, /ngspice: ngspice not found/);
});

test('a suite that needs two tools is skipped when either is missing, and both are named', () => {
  const plan = planSuites(['fea.test.mjs'], { ccx: gone('ccx'), gmsh: gone('gmsh') });
  assert.equal(plan[0].run, false);
  assert.match(plan[0].reason, /ccx/);
  assert.match(plan[0].reason, /gmsh/);
});

test('--all skips nothing, so CI cannot pass by quietly leaving suites out', () => {
  const plan = planSuites(['engine.test.mjs', 'fea.test.mjs'], {}, { runAll: true });
  assert.ok(plan.every(p => p.run));
});

test('a tool that is installed but hidden also skips its suite, and says how to fix it', () => {
  const hidden = { id: 'ngspice', state: 'invisible', reason: 'found at /opt/homebrew/bin/ngspice, but workers only search /usr/bin:/bin; set KINUX_NGSPICE_BIN=/opt/homebrew/bin/ngspice' };
  const plan = planSuites(['engine.test.mjs'], { ngspice: hidden });
  assert.equal(plan[0].run, false);
  assert.match(plan[0].reason, /KINUX_NGSPICE_BIN/);
});

test('a suite nobody listed still runs, and is flagged so it gets listed', () => {
  const plan = planSuites(['brand-new.test.mjs'], {});
  assert.equal(plan[0].run, true);
  assert.equal(plan[0].unlisted, true);
});

test('every test file in tests/ is listed in SUITES, so a new suite cannot dodge the skip logic', async () => {
  const files = (await readdir(HERE)).filter(f => f.endsWith('.test.mjs'));
  const unlisted = files.map(suiteName).filter(n => !(n in SUITES));
  assert.deepEqual(unlisted, [], `add these to SUITES in scripts/tools.mjs: ${unlisted.join(', ')}`);
});

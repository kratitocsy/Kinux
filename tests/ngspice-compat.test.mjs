// ngspice compatibility mode (-D ngbehavior=psa), for vendor PSpice models.
//
// TI's TLC555 and TPS5430 models only load in psa mode. It matters for more
// than loading: measured with ngspice 42, PSpice's LIMIT() silently evaluates
// to 0 in the default mode, where the right answer is 3 (STATUS K28). A vendor
// model that uses it would give a believable wrong number. So the mode is a
// run setting the person chooses (never read from a design file), only known
// modes are accepted, and the mode is recorded with the run's tool versions.
//
// The decks are our own, written to show the difference; expected values are
// hand-evaluated: LIMIT(2*2, 0, 3) = 3 and IF(2 > 1, 7, 0) = 7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNetlist, compatArgs } from '../workers/ngspice/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const deck = expr => `* compat\nV1 in 0 DC 2\nR0 in 0 1k\nE1 out 0 VALUE={${expr}}\nR1 out 0 1k\n.control\nop\nprint v(out)\n.endc\n.end\n`;
const vout = r => Number(/^v\(out\)\s*=\s*(\S+)/m.exec(r.stdout)?.[1]);

test('only known modes become arguments', () => {
  assert.deepEqual(compatArgs('psa'), ['-D', 'ngbehavior=psa']);
  assert.deepEqual(compatArgs(null), []);
  assert.throws(() => compatArgs('psa; touch /tmp/x'));
});

test('psa mode evaluates PSpice LIMIT() correctly; the default mode silently returns 0 (K28)', async () => {
  const psa = await runNetlist(deck('LIMIT(V(in)*2,0,3)'), { compat: 'psa' });
  assert.equal(psa.ok, true, psa.reason);
  assert.equal(vout(psa), 3);
  assert.equal(psa.tool_versions.ngspice_compat, 'psa', 'the mode is recorded with the run');
  const plain = await runNetlist(deck('LIMIT(V(in)*2,0,3)'));
  assert.equal(plain.ok, true);
  assert.equal(vout(plain), 0, 'if this changes, ngspice fixed LIMIT(); update STATUS K28');
});

test('a PSpice IF() fails loudly without psa and works with it', async () => {
  assert.equal((await runNetlist(deck('IF(V(in)>1,7,0)'))).ok, false);
  assert.equal(vout(await runNetlist(deck('IF(V(in)>1,7,0)'), { compat: 'psa' })), 7);
});

test('an unknown mode is a refused run, not a silent default', async () => {
  const r = await runNetlist(deck('V(in)'), { compat: 'spice3' });
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, 'tool_error');
  assert.match(r.reason, /unsupported ngspice compatibility mode/);
});

test('the CLI passes the mode to every simulation, and refuses unknown modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-compat-'));
  writeFileSync(join(dir, 'd.cir'), '* if\nV1 in 0 DC 2\nR0 in 0 1k\nE1 out 0 VALUE={IF(V(in)>1,7,0)}\nR1 out 0 1k\n.end\n');
  writeFileSync(join(dir, 'c.md'), '## Simulation\n\nscope: nets [out]\nanalysis: op\nassert: V(out) between 6.9 and 7.1\n');
  const run = (extra, out) => {
    try {
      execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(dir, 'd.cir'), '--checks', join(dir, 'c.md'),
        '--out', join(dir, out), '--threshold', '0', '--quiet', ...extra], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
      return 0;
    } catch (e) { return e.status; }
  };
  assert.equal(run(['--ngspice-compat', 'bogus'], 'x'), 2);
  assert.equal(run(['--ngspice-compat', 'psa'], 'psa'), 0);
  const r = JSON.parse(readFileSync(join(dir, 'psa', 'report.json'), 'utf8'));
  assert.equal(r.baseline.passed, 1, JSON.stringify(r.baseline));
  assert.equal(r.baseline.results[0].measured, 7);
  run([], 'plain');
  const p = JSON.parse(readFileSync(join(dir, 'plain', 'report.json'), 'utf8'));
  assert.notEqual(p.baseline.results[0].verdict, 'PASS', 'without psa the IF() deck cannot pass');
});

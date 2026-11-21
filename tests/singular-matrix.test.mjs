// K26: a singular-matrix solve is not a measurement.
//
// ngspice 42 exits 0 after "Warning: singular matrix" and prints a solution.
// For a capacitor with one terminal opened in an op check, that solution is
// wrong for the WHOLE circuit: V(vcc) reads 0 with a 5 V source attached.
// The engine took it for a measurement and scored a "kill" that no real fault
// caused. NOT_CHECKED and ERROR are never a kill (CONTRIBUTING rule 1), and a
// solve ngspice itself flagged as singular is a solve that did not happen.
//
// Everything here runs the real ngspice; the expected values are hand-derived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNetlist } from '../workers/ngspice/run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 5 V source across 10k/10k: V(mid) = 2.5 V by hand. C1 sits across the rail.
const deck = c1Node => `* singular-matrix probe
V1 vcc 0 DC 5
R1 vcc mid 10k
R2 mid 0 10k
C1 ${c1Node} 0 10u
.control
op
print v(mid) v(vcc)
.endc
.end
`;

test('positive control: the intact circuit solves and V(mid) is 2.5 V by hand', async () => {
  const r = await runNetlist(deck('vcc'));
  assert.equal(r.ok, true, r.reason);
  const read = name => Number(new RegExp(`^${name}\\s*=\\s*(\\S+)`, 'm').exec(r.stdout)?.[1]);
  assert.ok(Math.abs(read('v\\(mid\\)') - 2.5) < 1e-6, `V(mid) = ${read('v\\(mid\\)')}`);
  assert.ok(Math.abs(read('v\\(vcc\\)') - 5) < 1e-6);
});

test('a singular-matrix solve is NOT_CHECKED material (sim_nonconverge), never a result (K26)', async () => {
  const r = await runNetlist(deck('NC_C1_0'));   // C1's rail terminal opened: the node holds only a capacitor
  assert.match(r.stdout + r.stderr, /singular matrix/i, 'ngspice did warn: if not, this test no longer probes the bug');
  assert.equal(r.ok, false, 'a run ngspice flagged as singular must not be usable');
  assert.equal(r.reason_code, 'sim_nonconverge');
});

function runCli(suite, out) {
  execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(ROOT, 'engine/fixtures/divider-rc.cir'),
    '--checks', join(ROOT, `engine/fixtures/checks-${suite}.md`), '--out', out, '--threshold', '0'],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).mutants;
}

test('opening a bypass capacitor is never scored as a kill by an op-only suite (K26)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-sing-'));
  try {
    const byId = Object.fromEntries(runCli('weak', dir).map(m => [m.mutant_id, m]));
    for (const id of ['M-open_connection-C1.0', 'M-open_connection-C2.0']) {
      assert.notEqual(byId[id].status, 'killed', `${id} was scored a kill by a solve ngspice flagged singular`);
      assert.equal(byId[id].status, 'not_checked', id);
    }
    // A genuine kill must survive the fix: opening the source really does collapse the rail.
    assert.equal(byId['M-open_connection-V1.0'].status, 'killed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

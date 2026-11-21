// R7: `kinux verify` writes a receipt that validates, and its id moves when anything
// that can change the answer moves. Runs the real ngspice through the real CLI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../engine/cli.mjs';
import { verifyReceipt } from '../engine/receipt.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'fixtures');
let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'kinux-receipt-'));
  copyFileSync(join(FIX, 'divider-rc.cir'), join(work, 'a.cir'));
  copyFileSync(join(FIX, 'checks-thorough.md'), join(work, 'thorough.md'));
  copyFileSync(join(FIX, 'checks-weak.md'), join(work, 'weak.md'));
  // Same circuit with one resistor changed.
  writeFileSync(join(work, 'b.cir'), readFileSync(join(FIX, 'divider-rc.cir'), 'utf8').replace('R3 mid out 1k', 'R3 mid out 2k'));
});

let n = 0;
async function receipt(design, checks, extra = []) {
  const out = join(work, `out${n++}`);
  const code = await main(['verify', join(work, design), '--checks', join(work, checks), '--out', out, '--quiet', '--limit', '6', ...extra], {});
  assert.ok(code === 0 || code === 1, `verify exited ${code}`);
  return JSON.parse(readFileSync(join(out, 'receipt.json'), 'utf8'));
}

test('the receipt validates and its id matches its contents', async () => {
  const r = await receipt('a.cir', 'thorough.md');
  const v = verifyReceipt(r);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(r.inputs.map(i => i.path), ['a.cir', 'thorough.md']);
  assert.match(r.tool_versions.ngspice, /^ngspice/);
});

test('the same inputs give the same receipt_id', async () => {
  const a = await receipt('a.cir', 'thorough.md');
  const b = await receipt('a.cir', 'thorough.md');
  assert.equal(a.receipt_id, b.receipt_id);
});

test('the id changes when the design, the checks, the operators or the limit change', async () => {
  const base = (await receipt('a.cir', 'thorough.md')).receipt_id;
  assert.notEqual((await receipt('b.cir', 'thorough.md')).receipt_id, base, 'design');
  assert.notEqual((await receipt('a.cir', 'weak.md')).receipt_id, base, 'checks');
  assert.notEqual((await receipt('a.cir', 'thorough.md', ['--operators', 'value_drift_5'])).receipt_id, base, 'operators');
  assert.notEqual((await receipt('a.cir', 'thorough.md', ['--limit', '4'])).receipt_id, base, 'limit');
});

test('a tampered receipt is rejected', async () => {
  const r = await receipt('a.cir', 'thorough.md');
  r.score.killed += 1;
  assert.equal(verifyReceipt(r).ok, false);
});

test('cleanup', () => rmSync(work, { recursive: true, force: true }));

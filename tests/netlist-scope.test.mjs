// Subcircuit scope in the engine's netlist parser (K27, and vendor models).
//
// A `.subckt ... .ends` body is someone else's model (TI's TLC555 has 25 of
// them). Its lines are kept verbatim and are NOT design components: the engine
// must not mutate them (that would measure the vendor's model, not the design)
// and must not offer their local nodes as top-level nodes. Before this, an
// output short could land inside a subcircuit and short nothing (K27).
// Behavioural E/G sources (`E1 out 0 VALUE={...}`) have two nodes, not four.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNetlist } from '../engine/netlist.mjs';
import { generateMutants } from '../engine/operators.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The last element in the file is inside the subcircuit, as in the fang buck deck.
const DECK = `* scope
V1 in 0 DC 5
R1 in n 1k
R2 n 0 1k
X1 n 0 blk
.subckt blk a b
Rinner a mid 1meg
Cinner mid b 1n
.ends blk
.end
`;

test('subcircuit bodies are kept verbatim and are not design components', () => {
  const nl = parseNetlist(DECK);
  assert.equal(nl.toString(), DECK, 'round trip is byte-identical');
  assert.deepEqual(nl.components.map(c => c.refdes), ['V1', 'R1', 'R2', 'X1']);
  assert.ok(!nl.nodes().includes('mid'), 'a subcircuit-local node is not a top-level node');
});

test('no mutant edits a line inside a subcircuit, and every inserted short lands at top level', () => {
  const nl = parseNetlist(DECK);
  const mutants = generateMutants(nl);
  assert.ok(mutants.length > 0);
  for (const m of mutants) {
    assert.ok(!/inner/i.test(m.target ?? ''), `${m.mutant_id} targets ${m.target}`);
    const lines = m.text.split('\n');
    const s = lines.findIndex(l => /^\.subckt/i.test(l));
    const e = lines.findIndex(l => /^\.ends/i.test(l));
    assert.deepEqual(lines.slice(s, e + 1), DECK.split('\n').slice(5, 9), `${m.mutant_id} changed the subcircuit body`);
  }
  assert.ok(!mutants.some(m => m.operator === 'output_short' && m.target === 'mid'));
});

test('K27: an output short on a top-level node really shorts it (real ngspice)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-scope-'));
  writeFileSync(join(dir, 'd.cir'), DECK);
  // V(n) = 5 * 1k/(1k + 1k || 1meg) ~ 2.4988 V by hand.
  writeFileSync(join(dir, 'c.md'), '## Simulation\n\nscope: nets [n]\nanalysis: op\nassert: V(n) between 2.4 and 2.6\n');
  execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(dir, 'd.cir'), '--checks', join(dir, 'c.md'),
    '--out', join(dir, 'o'), '--threshold', '0', '--quiet', '--operators', 'output_short'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  const r = JSON.parse(readFileSync(join(dir, 'o', 'report.json'), 'utf8'));
  const short = r.mutants.find(m => m.target === 'n');
  assert.ok(short, JSON.stringify(r.mutants.map(m => m.mutant_id)));
  assert.equal(short.status, 'killed', 'a short to ground on n must pull V(n) out of 2.4..2.6');
});

test('behavioural E and G sources have two nodes; a four-node E still parses', () => {
  const nl = parseNetlist('* b\nV1 in 0 DC 2\nE1 out 0 VALUE={V(in)*2}\nG1 0 out2 VALUE = {V(in)*1m}\nE2 o3 0 TABLE {V(in)} = (0,0) (5,10)\nE3 o4 0 in 0 2\n.end\n');
  const by = Object.fromEntries(nl.components.map(c => [c.refdes, c.nodes]));
  assert.deepEqual(by.E1, ['out', '0']);
  assert.deepEqual(by.G1, ['0', 'out2']);
  assert.deepEqual(by.E2, ['o3', '0']);
  assert.deepEqual(by.E3, ['o4', '0', 'in', '0']);
});

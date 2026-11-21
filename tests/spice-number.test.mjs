// K10: the engine's number parser must read a SPICE value the way ngspice does.
//
// The engine edits a netlist and records `from` / `to` values in its mutant
// metadata. If its idea of "3.3F" differs from the solver's, the evidence is
// wrong by 15 orders of magnitude while the netlist text still looks fine.
//
// The reference here is the real ngspice binary, not either parser: each token
// is put on a voltage source and ngspice reports what it read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseValue } from '../engine/netlist.mjs';
import { parseSpiceNumber, parseSpiceAssertion } from '../workers/ngspice/assertions.mjs';

const NGSPICE = process.env.KINUX_NGSPICE_BIN || 'ngspice';

/** What ngspice itself reads for `token`, via `V1 1 0 DC <token>`. */
function ngspiceReads(token, dir) {
  const file = join(dir, 'tok.cir');
  writeFileSync(file, `tok\nV1 1 0 DC ${token}\nR1 1 0 1k\n.control\nop\nprint v(1)\n.endc\n.end\n`);
  const out = execFileSync(NGSPICE, ['-b', file], { encoding: 'utf8', timeout: 20_000 });
  const m = /^v\(1\)\s*=\s*(\S+)/m.exec(out);
  assert.ok(m, `ngspice printed no v(1) for ${token}:\n${out}`);
  return Number(m[1]);
}

const same = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-6;

// Expected values are written out by hand so the test cannot pass vacuously
// when ngspice and a parser are wrong in the same way.
const CORPUS = [
  ['3.3F', 3.3e-15],   // the K10 case: femto, not farad
  ['1F', 1e-15],
  ['1fF', 1e-15],
  ['3.3Farad', 3.3e-15],
  ['1A', 1e-18],       // atto, not ampere
  ['2.5a', 2.5e-18],
  ['1mil', 25.4e-6],   // a mil is 25.4 micrometres of value, not a milli
  ['1MEG', 1e6], ['1Meg', 1e6], ['1meg', 1e6],
  ['1MF', 1e-3],       // M is milli
  ['1uF', 1e-6], ['10pF', 10e-12], ['1mH', 1e-3], ['1k', 1e3], ['2.2n', 2.2e-9],
  ['5V', 5], ['2s', 2], ['1Hz', 1], ['1ohm', 1], ['1W', 1], ['1H', 1],
  ['1e-9', 1e-9], ['-4.7k', -4.7e3],
];

test('the engine reads each token as the real ngspice does (K10)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-num-'));
  try {
    const bad = [];
    for (const [token, expected] of CORPUS) {
      const solver = ngspiceReads(token, dir);
      assert.ok(same(solver, expected), `hand value for ${token} is ${expected} but ngspice read ${solver}: fix the test corpus`);
      const engine = parseValue(token)?.number;
      if (!(typeof engine === 'number' && same(engine, solver))) bad.push(`${token}: ngspice ${solver}, engine ${engine}`);
    }
    assert.deepEqual(bad, [], `the engine disagrees with ngspice on:\n  ${bad.join('\n  ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the engine and the assertion grammar agree on every token a check can actually carry (K10)', () => {
  const bad = [];
  const compared = [];
  for (const [token] of CORPUS) {
    // Only tokens the whole grammar accepts: `V(out) < 1mil` is refused (unit "il"),
    // so a check can never carry a misread mil.
    let a;
    try { a = parseSpiceAssertion(`V(out) < ${token}`); } catch { continue; }
    const grammar = parseSpiceNumber(token).value;
    assert.ok(a.comparator, 'the assertion parsed');
    compared.push(token);
    // A bare trailing A is an ampere in a check and atto in a netlist; see the next test.
    if (/a$/i.test(token) && !/farad/i.test(token)) continue;
    if (!same(parseValue(token).number, grammar)) bad.push(`${token}: engine ${parseValue(token).number}, grammar ${grammar}`);
  }
  for (const must of ['3.3F', '1F', '1MEG', '2.2n']) assert.ok(compared.includes(must), `${must} was not compared (compared: ${compared})`);
  assert.deepEqual(bad, []);
});

test('a bare A is an ampere in a check but atto in a netlist, and the difference is deliberate', () => {
  assert.equal(parseSpiceNumber('2A').value, 2);
  assert.equal(parseSpiceNumber('2A').unit, 'A');
  assert.ok(same(parseValue('2A').number, 2e-18));
});

test('mutating a value keeps its scale and its text (round trip through the fix)', async () => {
  const { formatValue } = await import('../engine/netlist.mjs');
  for (const t of ['3.3F', '1A', '1mil', '10k', '4.7uF']) {
    const v = parseValue(t);
    assert.equal(formatValue(v.number, v), t, `rendering ${t} unchanged`);
    assert.ok(same(parseValue(formatValue(v.number * 10, v)).number, v.number * 10), `10x of ${t}`);
  }
});

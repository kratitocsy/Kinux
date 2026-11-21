// Load the example design and its two check suites.
//
// The suites are Markdown documents in Kinux's Simulation-block grammar; they
// are parsed by workers/ngspice/assertions.mjs (parseSimulationBlocks), so the
// checks in examples/ and the checks the worker runs are literally the same
// text. Nothing here writes ngspice by hand.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSimulationBlocks, verifySimulation } from '../../workers/ngspice/assertions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const NETLIST_PATH = join(HERE, 'phase-leg-support.cir');
export const SUITE_PATHS = Object.freeze({
  thorough: join(HERE, 'checks-thorough.md'),
  weak: join(HERE, 'checks-weak.md'),
});

/** @returns {Promise<string>} the baseline netlist text */
export function loadNetlist() {
  return readFile(NETLIST_PATH, 'utf8');
}

/**
 * @param {'thorough'|'weak'} name
 * @returns {Promise<Array<object>>} parsed Simulation blocks
 */
export async function loadSuite(name) {
  const path = SUITE_PATHS[name];
  if (!path) throw new Error(`unknown suite "${name}"`);
  const blocks = parseSimulationBlocks(await readFile(path, 'utf8'));
  if (blocks.length === 0) throw new Error(`suite "${name}" has no Simulation blocks`);
  return blocks;
}

/**
 * Run every block of one suite against one netlist and return a flat list of
 * contract-shaped assertion results.
 *
 * @param {string} netlist
 * @param {Array<object>} blocks
 * @param {{subject?: string, timeoutMs?: number}} [opts]
 */
export async function runSuite(netlist, blocks, opts = {}) {
  const subject = opts.subject ?? 'baseline';
  const results = [];
  for (let i = 0; i < blocks.length; i++) {
    const out = await verifySimulation(netlist, blocks[i], {
      subject,
      testIdPrefix: `spice:b${i + 1}`,
      timeoutMs: opts.timeoutMs,
    });
    results.push(...out.results);
  }
  return results;
}

/**
 * Contract rule 2, implemented once: a mutant counts as caught only if the
 * baseline PASSES a check and the mutant FAILS that same check. NOT_CHECKED and
 * ERROR are never a catch and never a pass.
 *
 * @param {Array<object>} baseline results of runSuite on the baseline
 * @param {Array<object>} mutant   results of runSuite on the mutant
 * @returns {{caught: boolean, killedBy: string[], notChecked: string[]}}
 */
export function killVerdict(baseline, mutant) {
  const basePassed = new Set(
    baseline.filter(r => r.verdict === 'PASS').map(r => r.test_id),
  );
  const killedBy = mutant
    .filter(r => r.verdict === 'FAIL' && basePassed.has(r.test_id))
    .map(r => r.assertion ?? r.test_id);
  const notChecked = mutant
    .filter(r => r.verdict === 'NOT_CHECKED' || r.verdict === 'ERROR')
    .map(r => r.assertion ?? r.test_id);
  return { caught: killedBy.length > 0, killedBy, notChecked };
}

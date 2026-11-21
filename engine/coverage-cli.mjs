#!/usr/bin/env node
// `kinux coverage` -- the coverage-gap report as its own small command, so it does not
// touch engine/cli.mjs. No solver is run; the design and the checks are only read.
//
//   node engine/coverage-cli.mjs <design.cir> --checks <checks.md|checks.json>
//        [--requirement "text"]... [--requirements-file <file>] [--json] [--fail-on-gaps]
//
// --requirements-file: one requirement per non-empty line; lines starting with # are skipped.
// Exit: 0 report written, 1 with --fail-on-gaps and any uncovered part/net, 2 usage or input error.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseNetlist } from './netlist.mjs';
import { loadSuite } from './cli.mjs';
import { analyseCoverage, renderCoverage } from './coverage.mjs';

export const USAGE = `kinux coverage -- which nets, parts and requirements can no check see?

  node engine/coverage-cli.mjs <design.cir> --checks <checks.md|checks.json> [options]

  --requirement <text>      a requirement to relate to the checks (repeatable)
  --requirements-file <f>   one requirement per line
  --json                    print the report as JSON
  --fail-on-gaps            exit 1 when any part or net is uncovered
  -h, --help                this text
`;

export function main(argv, io = {}) {
  const log = io.log ?? (s => process.stdout.write(s + '\n'));
  const err = io.error ?? (s => process.stderr.write(s + '\n'));
  let design = null, checks = null, json = false, fail = false;
  const reqs = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
      if (a === '-h' || a === '--help') { log(USAGE); return 0; }
      else if (a === '--checks') checks = next();
      else if (a === '--requirement') reqs.push(next());
      else if (a === '--requirements-file') reqs.push(...readFileSync(resolve(next()), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')));
      else if (a === '--json') json = true;
      else if (a === '--fail-on-gaps') fail = true;
      else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
      else if (!design) design = a;
      else throw new Error(`unexpected argument ${a}`);
    }
    if (!design) throw new Error('a design netlist is required');
    if (!checks) throw new Error('--checks is required');
  } catch (e) { err(String(e.message)); err(USAGE); return 2; }
  let report;
  try {
    report = analyseCoverage(parseNetlist(readFileSync(resolve(design), 'utf8')), loadSuite(resolve(checks)), reqs);
  } catch (e) { err(`could not read the inputs: ${e.message}`); return 2; }
  log(json ? JSON.stringify(report, null, 2) : renderCoverage(report, { title: design }));
  return fail && (report.summary.parts.uncovered || report.summary.nets.uncovered) ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) process.exit(main(process.argv.slice(2)));

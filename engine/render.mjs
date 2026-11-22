// Render a finished run's 3D board with Blender, each part tinted by what the
// run found: a picture for reports and decks, not a verdict.
//
//   node engine/render.mjs <run-dir> [--out render.png] [--samples 32] [--size 1600x1000]
//
// The geometry is KiCad's own export from the run (views/board.glb), the
// colours are the worst mutant status on each part from the run's report.json,
// and a JSON sidecar beside the image records the run, the design hash and
// every colour used, so the picture can always be traced to solver output.
// Blender is an optional external tool (GPL, run as a separate program, never
// linked); without it the command says so and exits 3.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const BLENDER = process.env.KINUX_BLENDER_BIN || 'blender';
export const STATUS_RGB = { survived: [0.84, 0.27, 0.27], error: [0.72, 0.47, 0.12], not_checked: [0.54, 0.56, 0.6], killed: [0.18, 0.62, 0.36] };
const RANK = { survived: 0, error: 1, not_checked: 2, killed: 3, equivalent: 4 };

/** Worst status per part, from a report's mutants. Equivalent mutants colour nothing. */
export function tintsFromReport(report) {
  const worst = new Map();
  for (const m of report.mutants ?? []) {
    const cur = worst.get(m.target);
    if (!cur || RANK[m.status] < RANK[cur]) worst.set(m.target, m.status);
  }
  const tints = {}, legend = {};
  for (const [ref, status] of worst) {
    if (!STATUS_RGB[status]) continue;
    tints[ref] = STATUS_RGB[status];
    legend[ref] = status;
  }
  return { tints, legend };
}

export async function renderRun(runDir, { out, samples = 32, width = 1600, height = 1000, bin = BLENDER } = {}) {
  const glb = join(runDir, 'views', 'board.glb');
  if (!existsSync(glb)) throw Object.assign(new Error(`no 3D board in ${runDir} (views/board.glb); run kinux verify on a KiCad design with a board`), { code: 2 });
  const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'));
  const { tints, legend } = tintsFromReport(report);
  const work = mkdtempSync(join(tmpdir(), 'kinux-render-'));
  const tintsPath = join(work, 'tints.json');
  writeFileSync(tintsPath, JSON.stringify(tints));
  const png = resolve(out ?? join(runDir, 'render.png'));
  let stdout;
  try {
    ({ stdout } = await execFileAsync(bin, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1',
      '--python', join(HERE, 'render', 'blender_render.py'), '--', glb, tintsPath, png, String(samples), String(width), String(height)],
    { timeout: 30 * 60_000, maxBuffer: 64 << 20, env: { ...process.env, HOME: work } }));
  } catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('Blender is not installed (apt-get install blender), so nothing was rendered'), { code: 3 });
    throw new Error(`Blender failed: ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' | ')}`);
  }
  const line = String(stdout).split('\n').find(l => l.startsWith('KINUX_RENDER '));
  const done = line ? JSON.parse(line.slice('KINUX_RENDER '.length)) : { tinted: [] };
  const sidecar = {
    image: png, bytes: existsSync(png) ? statSync(png).size : 0,
    run_id: report.run_id, design_hash: report.design_hash, score_text: report.score_text,
    geometry: 'views/board.glb, exported by kicad-cli from the design',
    colours: 'worst mutant status per part, from report.json; a tint over KiCad\'s own materials',
    legend, tinted_in_image: done.tinted, renderer: `Blender (Cycles, CPU, ${samples} samples)`,
    not_shown: Object.keys(legend).filter(r => !done.tinted.includes(r)),
  };
  writeFileSync(png.replace(/\.png$/i, '') + '.json', `${JSON.stringify(sidecar, null, 1)}\n`);
  return sidecar;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const [w, h] = String(flag('--size', '1600x1000')).split('x').map(Number);
  if (!args[0]) { console.error('usage: node engine/render.mjs <run-dir> [--out render.png] [--samples 32] [--size 1600x1000]'); process.exit(2); }
  renderRun(resolve(args[0]), { out: flag('--out'), samples: Number(flag('--samples', 32)), width: w, height: h })
    .then(s => console.log(`rendered ${s.image} (${s.bytes} B): ${s.tinted_in_image.length} parts tinted; sidecar ${s.image.replace(/\.png$/i, '')}.json`))
    .catch(e => { console.error(e.message); process.exit(e.code === 3 ? 3 : e.code === 2 ? 2 : 1); });
}

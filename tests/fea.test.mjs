// Tests for the FEA worker (workers/fea). Every solve here runs the REAL
// CalculiX (ccx) and Gmsh binaries -- nothing is mocked. If either is missing
// the suite fails loudly rather than skipping: a skipped honesty test is
// worse than none.
//
// Units throughout: mm, N, MPa, tonne/mm^3, s, K, mW.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvent } from '../contracts/check-run.mjs';
import { toolVersions, runBinary, CCX_BIN, GMSH_BIN } from '../workers/fea/exec.mjs';
import { STEEL } from '../workers/fea/materials.mjs';
import { sanitizeGeo, boxGeo } from '../workers/fea/geo.mjs';
import { meshGeometry } from '../workers/fea/mesh.mjs';
import { sanitizeInp } from '../workers/fea/inp-sanitize.mjs';
import { runCcx, block } from '../workers/fea/ccx.mjs';
import { convergence, judge, toTestResultEvent } from '../workers/fea/study.mjs';
import { cantileverStatic, conductionRod, thermalStressBar, cantileverModal, judgeSlice, SLICE_CHECKS } from '../workers/fea/slices.mjs';

const DESIGN_HASH = 'sha256:' + 'f'.repeat(64);
let seq = 0;
/** Every result produced in this file is wrapped and validated as a contract event. */
const allEvents = [];
function asEvent(result) {
  const ev = toTestResultEvent(result, { run_id: 'fea-test', seq: seq++, design_hash: DESIGN_HASH });
  allEvents.push(ev);
  return ev;
}

/** Each slice once, shared by the tests below (the solves are the slow part). */
const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
const STATIC = () => once('static', () => cantileverStatic({ material: STEEL }));
const MODAL = () => once('modal', () => cantileverModal({ material: STEEL }));

const pct = x => `${(x * 100).toFixed(4)}%`;
function show(slice, judged) {
  for (const { result, details } of judged) {
    console.log(`[${slice}] ${result.test_id}: ${result.verdict} -- ${result.reason}`);
    if (details.rel_error !== undefined) console.log(`[${slice}]   calculix=${details.converged_value} analytic=${details.analytic} error=${pct(details.rel_error)} levels=${details.mesh_sizes.join(',')}`);
  }
}

test('ccx and gmsh are really installed and report versions for the receipt', async () => {
  const v = await toolVersions({ force: true });
  assert.equal(v.ccx.available, true, `ccx: ${v.ccx.error}`);
  assert.equal(v.gmsh.available, true, `gmsh: ${v.gmsh.error}`);
  assert.equal(v.ids.calculix, 'ccx-2.21');
  assert.match(v.ids.gmsh, /^gmsh-4\./);
});

// ---------------------------------------------------------------- slice 1
test('static: cantilever tip deflection and bending stress match beam theory', async () => {
  // Hand calculation. Steel E = 210000 MPa, nu = 0.3. L = 200, b = h = 10 mm.
  //   I = b h^3 / 12 = 10 * 1000 / 12 = 833.333 mm^4
  //   delta = F L^3 / (3 E I) = 100 * 8e6 / (3 * 210000 * 833.333) = 1.52381 mm
  //   at x = L/2: M = F (L - L/2) = 100 * 100 = 1e4 N mm, c = h/2 = 5 mm
  //   sigma = M c / I = 1e4 * 5 / 833.333 = 60.000 MPa
  // Expected FEA departures: Timoshenko shear adds F L / (k G A) = 100*200 /
  // (0.833 * 80769 * 100) = 0.0030 mm (+0.19%); the fully clamped root
  // (Poisson contraction suppressed) stiffens slightly. Net: within 1%.
  // The stress is read at mid-span, 100 mm (10 depths) from the clamped root,
  // so Saint-Venant end effects have decayed; deflection is the primary check.
  // Elements: quadratic tetrahedra C3D10 (linear C3D4 lock in bending; see the
  // coarse-mesh test below). Tolerances: deflection 1%, stress 2%; convergence
  // 0.5% (deflection) / 1% (stress) between the two finest of 3 meshes.
  const r = await STATIC();
  assert.equal(r.study.ok, true, r.study.reason);
  assert.equal(r.study.levels.length, 3);
  assert.ok(Math.abs(r.analytic.tip_deflection - 1.5238095) < 1e-6);
  assert.ok(Math.abs(r.analytic.sigma_midspan - 60) < 1e-9);
  // Equilibrium: the root reaction balances the applied 100 N.
  for (const l of r.study.levels) assert.ok(Math.abs(l.values.root_reaction_z - 100) < 1e-3, `reaction ${l.values.root_reaction_z}`);
  const judged = judgeSlice(r);
  show('static', judged);
  for (const { result } of judged) {
    assert.equal(result.verdict, 'PASS', result.reason);
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
  const [defl, stress] = judged;
  assert.ok(defl.details.rel_error <= 0.01);
  assert.ok(stress.details.rel_error <= 0.02);
});

// ---------------------------------------------------------------- slice 2
test('thermal conduction: rod with fixed end temperatures follows the linear profile', async () => {
  // Hand calculation. k = 50 W/(m K) = 50 mW/(mm K). L = 100, A = 10*10 = 100 mm^2.
  //   T(x) = T0 + (T1 - T0) x / L, T0 = 100, T1 = 0 (other faces insulated)
  //   Q = k A (T0 - T1) / L = 50 * 100 * 100 / 100 = 5000 mW = 5 W
  // Tolerances: Q within 0.1%; every node within 1e-3 K of the line.
  // Note: a linear field is represented exactly by these elements, so this
  // slice checks units, boundary conditions and reaction output, not
  // discretisation error. The convergence rule still runs on 3 meshes.
  const r = await conductionRod({ material: STEEL });
  assert.equal(r.study.ok, true, r.study.reason);
  assert.equal(r.analytic.heat_flow, 5000);
  const judged = judgeSlice(r);
  show('conduction', judged);
  for (const { result } of judged) {
    assert.equal(result.verdict, 'PASS', result.reason);
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
});

// ---------------------------------------------------------------- slice 3
test('thermal stress: bar held at both ends and heated gives -E alpha dT', async () => {
  // Hand calculation. E = 210000 MPa, alpha = 1.2e-5 /K, dT = 100 K.
  //   sigma = -E alpha dT = -210000 * 1.2e-5 * 100 = -252 MPa (compression)
  // Ends held axially (u_x = 0 on both end faces), free to expand sideways, so
  // the stress is uniaxial and uniform; checked on the mean over all
  // integration points, tolerance 0.1%, and the spread must be ~0.
  const r = await thermalStressBar({ material: STEEL });
  assert.equal(r.study.ok, true, r.study.reason);
  assert.ok(Math.abs(r.analytic.sigma_axial + 252) < 1e-9);
  for (const l of r.study.levels) assert.ok(l.values.sigma_spread < 0.01, `spread ${l.values.sigma_spread} MPa`);
  const judged = judgeSlice(r);
  show('thermal_stress', judged);
  for (const { result } of judged) {
    assert.equal(result.verdict, 'PASS', result.reason);
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
});

// ---------------------------------------------------------------- slice 4
test('modal: cantilever first natural frequency matches the beam formula', async () => {
  // Hand calculation. rho = 7.85e-9 t/mm^3, A = 100 mm^2, L = 200 mm, I = 833.333 mm^4.
  //   EI = 210000 * 833.333 = 1.75e8 N mm^2
  //   rho A L^4 = 7.85e-9 * 100 * 1.6e9 = 1256 t mm
  //   f1 = (1.8751^2 / 2 pi) sqrt(EI / (rho A L^4)) = 0.55959 * 373.27 = 208.88 Hz
  // The square section gives two equal first modes (bending in y and z).
  // Tolerance 1%; convergence 0.5% over 3 meshes.
  const r = await MODAL();
  assert.equal(r.study.ok, true, r.study.reason);
  assert.ok(Math.abs(r.analytic.f1 - 208.879) < 0.01, `analytic ${r.analytic.f1}`);
  const fin = r.study.levels.at(-1).values.frequencies;
  assert.ok(Math.abs(fin[1] - fin[0]) / fin[0] < 0.001, 'first two modes should coincide for a square section');
  const judged = judgeSlice(r);
  show('modal', judged);
  for (const { result } of judged) {
    assert.equal(result.verdict, 'PASS', result.reason);
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
});

// ------------------------------------------------------- convergence honesty
test('a single too-coarse mesh with no refinement can never PASS', async () => {
  // One mesh, size 20 mm on a 10 mm deep beam. Whatever number it gives, one
  // level cannot show convergence.
  const r = await cantileverStatic({ material: STEEL, meshSizes: [20] });
  assert.equal(r.study.ok, true, r.study.reason);
  for (const { result } of judgeSlice(r)) {
    assert.equal(result.verdict, 'NOT_CHECKED');
    assert.equal(result.reason_code, 'mesh_not_converged');
    assert.equal(result.measured, undefined, 'an unconverged value must not be reported as the measurement');
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
});

test('three coarse linear-tet meshes that lock in bending are caught as not converged', async () => {
  // C3D4 at 20 / 15 / 10 mm gives roughly 0.40, 0.56, 0.69 mm against the true
  // 1.52 mm: believable, badly wrong, and still changing ~25% per step.
  const r = await cantileverStatic({ material: STEEL, order: 1, meshSizes: [20, 15, 10] });
  assert.equal(r.study.ok, true, r.study.reason);
  const finest = r.study.levels.at(-1).values.tip_deflection;
  assert.ok(finest < 0.8 * r.analytic.tip_deflection, `locked deflection ${finest}`);
  for (const { result } of judgeSlice(r)) {
    assert.equal(result.verdict, 'NOT_CHECKED', result.reason);
    assert.equal(result.reason_code, 'mesh_not_converged');
    assert.equal(validateEvent(asEvent(result)).ok, true);
  }
});

test('convergence rule: needs 3 levels, a small last change, and a settling sequence', () => {
  assert.equal(convergence([1, 1], 0.01).converged, false);
  assert.equal(convergence([1.0, 1.05, 1.051], 0.01).converged, true);
  assert.equal(convergence([1.0, 1.2, 1.3], 0.01).converged, false);
  // last change 0.9% but growing from 0.1%: wandering, not settling
  assert.equal(convergence([1.0, 1.001, 1.01], 0.01).converged, false);
  assert.equal(convergence([1, NaN, 1], 0.01).converged, false);
});

test('a converged result against a design limit can FAIL (the check has teeth)', async () => {
  // Same converged study; a design limit of 1.0 mm deflection is exceeded by 1.52 mm.
  const r = await STATIC();
  const { result } = judge(r.study, { test_id: 'fea.cantilever.deflection_limit', key: 'tip_deflection', units: 'mm', convTol: 0.005, max: 1.0, label: 'tip deflection vs 1 mm limit' });
  assert.equal(result.verdict, 'FAIL', result.reason);
  assert.ok(result.measured > 1.5);
  assert.equal(validateEvent(asEvent(result)).ok, true);
});

// ------------------------------------------------------------ input errors
test('missing material properties give NOT_CHECKED / no_material_data without solving', async () => {
  const noE = { name: 'mystery filament', nu: 0.35, density: 1.2e-9 };
  const noRho = { name: 'steel without density', E: 210000, nu: 0.3 };
  const noK = { name: 'no conductivity', E: 210000, nu: 0.3 };
  const cases = [
    await cantileverStatic({ material: noE }),
    await cantileverModal({ material: noRho }),
    await conductionRod({ material: noK }),
    await thermalStressBar({ material: { ...STEEL, expansion: undefined } }),
  ];
  for (const r of cases) {
    assert.equal(r.study.ok, false);
    assert.equal(r.study.levels.length, 0, 'nothing may be solved without material data');
    for (const { result } of judgeSlice(r)) {
      assert.equal(result.verdict, 'NOT_CHECKED');
      assert.equal(result.reason_code, 'no_material_data');
      assert.equal(validateEvent(asEvent(result)).ok, true);
    }
  }
});

test('broken geometry gives NOT_CHECKED / mesh_failed', async () => {
  // A "volume" bounded by a single open triangle: Gmsh cannot mesh it.
  const openShell = [
    'Point(1) = {0, 0, 0}; Point(2) = {10, 0, 0}; Point(3) = {0, 10, 0};',
    'Line(1) = {1, 2}; Line(2) = {2, 3}; Line(3) = {3, 1};',
    'Curve Loop(1) = {1, 2, 3}; Plane Surface(1) = {1};',
    'Surface Loop(1) = {1}; Volume(1) = {1};',
    'Physical Volume("solid") = {1}; Physical Surface("xmin") = {1}; Physical Surface("xmax") = {1};',
  ].join('\n');
  assert.equal(sanitizeGeo(openShell).ok, true, 'the geometry is safe, just broken');
  const a = await cantileverStatic({ material: STEEL, geoText: openShell });
  // A zero-length box: OpenCASCADE refuses a degenerate box.
  const b = await thermalStressBar({ material: STEEL, L: 0 });
  for (const r of [a, b]) {
    assert.equal(r.study.ok, false);
    assert.equal(r.study.reason_code, 'mesh_failed', r.study.reason);
    for (const { result } of judgeSlice(r)) {
      assert.equal(result.verdict, 'NOT_CHECKED');
      assert.equal(result.reason_code, 'mesh_failed');
      assert.equal(validateEvent(asEvent(result)).ok, true);
    }
  }
});

// ---------------------------------------------------------- reproducibility
test('a solve is byte-reproducible: same mesh, same deck, same job.dat', async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await cantileverStatic({ material: STEEL, meshSizes: [5] }));
  const lv = runs.map(r => r.study.levels[0]);
  for (const l of lv.slice(1)) {
    assert.equal(l.deck_sha256, lv[0].deck_sha256, 'gmsh mesh -> deck must be identical');
    assert.equal(l.dat_sha256, lv[0].dat_sha256, 'ccx job.dat must be byte-identical');
    assert.equal(l.values.tip_deflection, lv[0].values.tip_deflection);
  }
  // And it matches the first level of the full study.
  assert.equal(lv[0].dat_sha256, (await STATIC()).study.levels[0].dat_sha256);
});

// ------------------------------------------------------------- input safety
// A one-element C3D8 cube, 100 N over 1 mm^2, so sigma_zz = 100 MPa.
const CUBE = (extra = '', set = 'ALLN') => `*HEADING
cube
*NODE
1,0,0,0
2,1,0,0
3,1,1,0
4,0,1,0
5,0,0,1
6,1,0,1
7,1,1,1
8,0,1,1
*ELEMENT,TYPE=C3D8,ELSET=EALL
1,1,2,3,4,5,6,7,8
*NSET,NSET=BOT
1,2,3,4
*NSET,NSET=TOP
5,6,7,8
*NSET,NSET=ALLN
1,2,3,4,5,6,7,8
${extra}*MATERIAL,NAME=STEEL
*ELASTIC
210000,0.3
*SOLID SECTION,ELSET=EALL,MATERIAL=STEEL
*BOUNDARY
BOT,3,3
1,1,2
2,2,2
*STEP
*STATIC
*CLOAD
TOP,3,25
*NODE PRINT,NSET=${set}
U
*EL PRINT,ELSET=EALL
S
*END STEP
`;

test('THREAT IS REAL: raw ccx follows *INCLUDE outside its directory, in any spelling', async () => {
  // This runs ccx WITHOUT the sanitizer to prove what the sanitizer is for.
  const root = await mkdtemp(join(tmpdir(), 'kinux-fea-threat-'));
  try {
    await writeFile(join(root, 'outside.inp'), '*NSET,NSET=OUTSIDE\n7\n');
    const job = join(root, 'job');
    await mkdir(job);
    for (const card of ['*INCLUDE,INPUT=../outside.inp', '* incl ude , input = ../outside.inp']) {
      await writeFile(join(job, 'j.inp'), CUBE(card + '\n', 'OUTSIDE'));
      const r = await runBinary(CCX_BIN, ['-i', 'j'], { cwd: job, timeoutMs: 20_000 });
      assert.match(r.stdout, /Job finished/);
      const dat = await readFile(join(job, 'j.dat'), 'utf8');
      assert.match(dat, /for set OUTSIDE/, `ccx read ../outside.inp via "${card}"`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('*INCLUDE containment: the worker never lets a deck read outside its own files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kinux-fea-inc-'));
  try {
    await writeFile(join(root, 'outside.inp'), '*NSET,NSET=OUTSIDE\n7\n');
    const hostile = [
      '*INCLUDE,INPUT=../outside.inp',
      `*INCLUDE,INPUT=${join(root, 'outside.inp')}`,
      '*INCLUDE,INPUT=/etc/passwd',
      '* incl ude , input = ../outside.inp',
      '*include,input=..\\outside.inp',
      '*INCLUDE,INPUT="../outside.inp"',
      '*INCLUDEX,INPUT=outside.inp',
      '*INCLUDE,INPUT=outside.inp', // bare name, but NOT supplied with the design
      '*SUBMODEL,TYPE=NODE,INPUT=../global.frd',
      '*RESTART,READ',
      '*VIEWFACTOR,READ,INPUT=../vf',
      '*SUBSTRUCTURE MATRIX OUTPUT,FILENAME=/tmp/x',
      '*USER MATERIAL,CONSTANTS=1',
      '*NODE FILE,FILENAME=../x\nU',
      '*NODE PRINT,NSET=ALLN,\nINPUT=../outside.inp\nU',
      '*NOT A KEYWORD',
      '1,2,3' + ' '.repeat(140) + '*INCLUDE,INPUT=../outside.inp',
    ];
    for (const card of hostile) {
      const deck = CUBE(card + '\n');
      const s = sanitizeInp(deck);
      assert.equal(s.ok, false, `sanitizer must reject: ${card}`);
      const r = await runCcx(deck);
      assert.equal(r.ok, false);
      assert.equal(r.blocked, true, `ccx must not run for: ${card}`);
      assert.equal(r.stage, 'sanitize');
      const { result } = judge({ ok: false, reason_code: r.reason_code, reason: r.reason }, { test_id: 'fea.deck', key: 'x', units: '', convTol: 0.01, max: 1, label: 'deck' });
      assert.equal(result.verdict, 'NOT_CHECKED');
      assert.equal(validateEvent(asEvent(result)).ok, true);
    }
    // Contact is refused with its own reason code.
    const c = sanitizeInp(CUBE('*CONTACT PAIR,INTERACTION=SI,TYPE=SURFACE TO SURFACE\nA,B\n'));
    assert.equal(c.ok, false);
    assert.equal(c.reason_code, 'unsupported_contact');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('*INCLUDE of a file supplied with the design is inlined and solves correctly', async () => {
  const files = { 'sets.inp': '** extra sets\n*NSET,NSET=CORNER\n7\n' };
  const deck = CUBE('*INCLUDE, INPUT=sets.inp\n', 'CORNER');
  const s = sanitizeInp(deck, { files });
  assert.equal(s.ok, true, JSON.stringify(s.violations));
  assert.doesNotMatch(s.deck, /^\s*\*\s*INCLUDE/im, 'ccx must never see an *INCLUDE');
  const r = await runCcx(deck, { files });
  assert.equal(r.ok, true, r.reason);
  const st = block(r, 'stresses', 'EALL');
  for (const row of st.rows) assert.ok(Math.abs(row[4] - 100) < 1e-6, `szz ${row[4]}`); // 100 N / 1 mm^2
  assert.ok(block(r, 'displacements', 'CORNER'));
  // A supplied file cannot itself reach outside.
  const nested = { 'sets.inp': '*INCLUDE,INPUT=../outside.inp\n' };
  assert.equal(sanitizeInp(deck, { files: nested }).ok, false);
  const cyc = { 'sets.inp': '*INCLUDE,INPUT=sets.inp\n' };
  assert.equal(sanitizeInp(deck, { files: cyc }).ok, false);
});

test('THREAT IS REAL: a Gmsh .geo runs shell commands; the worker refuses it', async () => {
  const geo = 'SystemCall "echo OWNED > pwned.txt";\nSetFactory("OpenCASCADE");\nBox(1) = {0,0,0,1,1,1};\n';
  const dir = await mkdtemp(join(tmpdir(), 'kinux-fea-geo-'));
  try {
    await writeFile(join(dir, 'm.geo'), geo);
    await runBinary(GMSH_BIN, ['m.geo', '-3', '-o', 'm.msh', '-nt', '1'], { cwd: dir, timeoutMs: 20_000 });
    assert.equal(existsSync(join(dir, 'pwned.txt')), true, 'raw gmsh executed SystemCall');
  } finally { await rm(dir, { recursive: true, force: true }); }

  for (const bad of [
    geo,
    'Include "/etc/passwd";',
    'Merge "../part.step";',
    'Solver.Executable0 = "/bin/sh";',
    'General.NumThreads = 4;',
    'x = 1; Printf("%g", x) > "/tmp/out";',
    'Save "../mesh.msh";',
    'Box(1) = {0,0,0, Lx, 1, 1};', // Lx never assigned
  ]) {
    assert.equal(sanitizeGeo(bad).ok, false, `must reject: ${bad}`);
    const m = await meshGeometry({ geoText: bad }, { size: 1 });
    assert.equal(m.ok, false);
    assert.equal(m.blocked, true, `gmsh must not run for: ${bad}`);
  }
  // Ordinary parametric geometry passes the same sanitizer.
  assert.equal(sanitizeGeo(boxGeo({ L: 200, W: 10, H: 10 })).ok, true);
  assert.equal(sanitizeGeo('L = 20; SetFactory("OpenCASCADE"); Box(1) = {0,0,0, L, 2, 2}; Physical Volume("solid") = {1};').ok, true);
});

test('the standard checks state their tolerances', () => {
  for (const [slice, checks] of Object.entries(SLICE_CHECKS)) {
    for (const c of checks) {
      assert.ok(c.convTol > 0, `${slice}/${c.test_id} convTol`);
      assert.ok(c.relTol > 0 || c.max !== undefined, `${slice}/${c.test_id} tolerance or limit`);
    }
  }
});

test('every result produced in this file is a valid contract event', () => {
  assert.ok(allEvents.length >= 20, `only ${allEvents.length} events`);
  for (const ev of allEvents) {
    const { ok, errors } = validateEvent(ev);
    assert.equal(ok, true, errors.join('; '));
    if (ev.data.verdict === 'NOT_CHECKED' || ev.data.verdict === 'ERROR') assert.ok(ev.data.reason_code);
    if (ev.data.verdict === 'PASS') assert.equal(typeof ev.data.measured, 'number');
  }
});

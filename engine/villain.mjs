// The Villain: an agent that searches for the faults that hurt most.
//
// The fixed operators (engine/operators.mjs) inject the same twelve kinds of
// fault into every design. The Villain is whatever agent is attached over MCP
// with --role villain; it reads the design and the checks and proposes its own
// faults, in a CLOSED grammar, aiming for one thing: a fault that every check
// still passes, but that changes what the circuit does.
//
// Kinux, not the agent, decides everything about each proposal:
//
//   1. The fault is checked against the grammar and turned into a patch by the
//      same applyPatch every fixed mutant goes through (re-parsed, or refused).
//   2. The whole check suite runs on the faulted netlist (real ngspice), and the
//      fault is classified by the same rule as every mutant: killed only by a
//      check that FAILs on it and PASSed on the baseline; NOT_CHECKED and ERROR
//      are never a kill and never a survival.
//   3. HARM is measured, also by ngspice, independently of the checks: every
//      net voltage and every block source current, under each block's own
//      analysis and sources, on the baseline and on the faulted design. For an
//      operating point the feature is the value; for a transient it is the
//      minimum, maximum, time-average and the number of mid-level crossings
//      (phase-independent, so an oscillator that is merely shifted in time is
//      not counted as harmed). Harm is the largest relative change of any
//      feature: |faulted − baseline| / scale, where scale is the baseline
//      vector's own magnitude or swing, floored at 50 mV or 1 µA so a quiet net
//      cannot look infinitely harmed.
//
// "Missed and harmful" (survived, harm ≥ HARMFUL) is the Villain's prize: a
// real hole in the check suite, with the net and the number that show it.
// A survived fault with harm below the threshold is reported as low-harm: the
// checks may be right not to care. Nothing here is a model judgement; the
// log replays without any model (replayVillain).

import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseNetlist, parseValue, formatValue, renderElement, isGround } from './netlist.mjs';
import { applyPatch, OPERATORS, operatorById, PatchError } from './operators.mjs';
import { BaselineGate, classifyMutant, runChecks, normaliseSuite } from './runner.mjs';
import { runNetlist } from '../workers/ngspice/run.mjs';
import { parseWrdata } from './waveforms.mjs';
import { trapezoidAverage } from './part-power.mjs';

export const HARMFUL = 0.05;
export const MAX_NETS = 40;
export const MAX_FAULTS = 200;
const SAFE_NET = /^[A-Za-z0-9_./:+-]+$/;
const VALUE_TYPES = new Set(['R', 'C', 'L', 'V', 'I']);
const sha256 = t => `sha256:${createHash('sha256').update(String(t)).digest('hex')}`;

export class VillainError extends Error {}

export const GRAMMAR = {
  value: '{kind:"value", ref, factor}: multiply a part\'s value (R, C, L, V, I) by factor, 0.001..1000, not 1. A wrong reel, drift, a mis-typed value.',
  open: '{kind:"open", ref, pin}: disconnect one pin (1-based) of a part. A cold joint, a missing via.',
  short: '{kind:"short", a, b, ohms?}: connect two existing nets through ohms (default 0.001; 0.001..1e9). b may be "0" for ground. A solder bridge, a leak, contamination.',
  operator: '{kind:"operator", operator, target}: one of the fixed operators\' own faults, by operator id and target (see catalog).',
};

/** Top-level nets, ground excluded, in first-seen order. */
const netsOf = nl => nl.nodes().filter(n => !isGround(n));

/** Turn a proposed fault into a patch, or refuse it with a reason. */
export function faultPatch(netlist, fault, n = 1) {
  if (!fault || typeof fault !== 'object') throw new VillainError('a fault is an object with a "kind"');
  const comp = ref => {
    const c = netlist.component(String(ref ?? ''));
    if (!c) throw new VillainError(`no part "${ref}" in the netlist (parts: ${netlist.components.map(x => x.refdes).join(', ')})`);
    return c;
  };
  const replace = (c, text) => ({ type: 'replace', line_id: c.id, text });
  switch (fault.kind) {
    case 'value': {
      const c = comp(fault.ref);
      const f = Number(fault.factor);
      if (!VALUE_TYPES.has(c.type)) throw new VillainError(`${c.refdes} is a ${c.type} element; a value fault needs R, C, L, V or I`);
      if (!Number.isFinite(f) || f < 1e-3 || f > 1e3 || f === 1) throw new VillainError('factor must be a number from 0.001 to 1000, not 1');
      const idx = c.tail.findIndex(t => parseValue(t));
      if (idx < 0) throw new VillainError(`${c.refdes} has no plain numeric value to change (${c.tail.join(' ')})`);
      const v = parseValue(c.tail[idx]);
      const tail = [...c.tail]; tail[idx] = formatValue(v.number * f, v);
      return { operator: 'villain_value', target: c.refdes, layer: 'netlist', description: `${c.refdes} value ×${f} (${v.text} -> ${tail[idx]})`,
        changes: [replace(c, renderElement({ indent: c.indent, refdes: c.refdes, nodes: c.nodes, tail }))], meta: { kind: 'value_change', factor: f } };
    }
    case 'open': {
      const c = comp(fault.ref);
      const pin = Number(fault.pin);
      if (!Number.isInteger(pin) || pin < 1 || pin > c.nodes.length) throw new VillainError(`${c.refdes} has pins 1..${c.nodes.length}`);
      const nodes = [...c.nodes]; const was = nodes[pin - 1];
      nodes[pin - 1] = `NC_V${n}_${c.refdes}_${pin}`;
      return { operator: 'villain_open', target: c.refdes, layer: 'netlist', description: `${c.refdes} pin ${pin} opened (was on ${was})`,
        changes: [replace(c, renderElement({ indent: c.indent, refdes: c.refdes, nodes, tail: c.tail }))], meta: { kind: 'topology' } };
    }
    case 'short': {
      const nets = new Set(netsOf(netlist));
      const a = String(fault.a ?? ''), b = String(fault.b ?? '0');
      for (const x of [a, b]) if (!isGround(x) && !nets.has(x)) throw new VillainError(`no net "${x}" (nets: ${[...nets].join(', ')})`);
      if (a === b || (isGround(a) && isGround(b))) throw new VillainError('a short needs two different nets');
      const ohms = fault.ohms === undefined ? 1e-3 : Number(fault.ohms);
      if (!Number.isFinite(ohms) || ohms < 1e-3 || ohms > 1e9) throw new VillainError('ohms must be 0.001..1e9');
      const last = netlist.components[netlist.components.length - 1];
      return { operator: 'villain_short', target: `${a}~${b}`, layer: 'netlist', description: `${a} shorted to ${isGround(b) ? 'ground' : b} through ${ohms} ohm`,
        changes: [{ type: 'insert_after', line_id: last.id, text: `RVIL${n} ${a} ${b} ${ohms}` }], meta: { kind: 'topology', ohms } };
    }
    case 'operator': {
      const op = operatorById(String(fault.operator ?? ''));
      if (!op) throw new VillainError(`no operator "${fault.operator}" (${OPERATORS.map(o => o.id).join(', ')})`);
      const cand = op.candidates(netlist).find(c => c.key === String(fault.target));
      if (!cand) throw new VillainError(`${op.id} has no target "${fault.target}" (targets: ${op.candidates(netlist).map(c => c.key).join(', ')})`);
      return op.build(netlist, cand);
    }
    default:
      throw new VillainError(`unknown fault kind "${fault.kind}"; kinds: ${Object.keys(GRAMMAR).join(', ')}`);
  }
}

/**
 * Every fault mode Kinux knows for one element, in the grammar: its value
 * moved both ways (tolerance, wrong reel, wrong decade), each pin opened, its
 * pins shorted together, each pin shorted to ground, each pin bridged to every
 * neighbouring net, and every fixed operator that targets it. A starting
 * point: the element agent may add its own (a bisected factor, a leak).
 */
export function elementModes(nl, ref) {
  const c = nl.component(ref);
  if (!c) throw new VillainError(`no part "${ref}"`);
  const modes = [];
  if (VALUE_TYPES.has(c.type) && c.tail.some(t => parseValue(t))) {
    for (const factor of [0.1, 0.5, 0.9, 1.1, 2, 10]) modes.push({ kind: 'value', ref: c.refdes, factor, why: factor === 0.9 || factor === 1.1 ? 'tolerance (±10%)' : factor === 0.5 || factor === 2 ? 'wrong value (×2)' : 'wrong decade' });
  }
  c.nodes.forEach((n, i) => modes.push({ kind: 'open', ref: c.refdes, pin: i + 1, why: `pin ${i + 1} (${n}) not connected` }));
  const own = [...new Set(c.nodes)];
  if (own.length >= 2) for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) {
    if (isGround(own[i]) && isGround(own[j])) continue;
    modes.push({ kind: 'short', a: isGround(own[i]) ? own[j] : own[i], b: isGround(own[i]) ? own[i] : own[j], why: `${c.refdes} shorted across ${own[i]}–${own[j]}` });
  }
  for (const n of own) if (!isGround(n) && !own.some(isGround)) modes.push({ kind: 'short', a: n, b: '0', why: `${n} at ${c.refdes} shorted to ground` });
  const neighbours = new Set();
  for (const n of own) for (const other of nl.connections(n)) for (const m of other.nodes) if (!own.includes(m) && !isGround(m)) neighbours.add(m);
  for (const n of own) if (!isGround(n)) for (const m of neighbours) modes.push({ kind: 'short', a: n, b: m, ohms: 0.001, why: `bridge from ${c.refdes}'s ${n} to neighbouring ${m}` });
  for (const op of OPERATORS) for (const cand of op.candidates(nl)) {
    const p = op.build(nl, cand);
    if (p.target === c.refdes) modes.push({ kind: 'operator', operator: op.id, target: cand.key, why: op.title });
  }
  return modes;
}

/** Which checks look at an element: a V()/f() check on one of its nets, or an I() check through it. */
export function observers(nl, suite, ref) {
  const c = nl.component(ref);
  const nets = new Set(c ? c.nodes : []);
  const out = [];
  for (const b of suite.blocks) for (const a of b.assertions ?? []) {
    const m = a.measurable;
    if (!m) continue;
    const hit = ((m.kind === 'voltage' || m.kind === 'frequency') && nets.has(m.target))
      || (m.kind === 'current' && String(m.target).toLowerCase() === String(ref).toLowerCase());
    if (hit) out.push({ id: `${suite.id}:${b.prefix}:${a.line}`, check: a.raw, how: m.kind === 'current' ? 'through it' : `on its net ${m.target}` });
  }
  return out;
}

/**
 * The largest voltage the circuit's own sources could plausibly put on a net,
 * times FLOAT_MARGIN. A baseline node voltage beyond it is not a voltage: it is
 * a floating net the solver could not pin down (a block that drives only some
 * inputs leaves the rest of the circuit with no reference), and its value says
 * nothing. Such vectors are reported as unmeasured, never used as evidence.
 */
export const FLOAT_MARGIN = 100;
export function plausibleVoltage(netlistText, block) {
  let max = 1;
  for (const c of parseNetlist(netlistText).components) {
    if (c.type !== 'V') continue;
    for (const t of c.tail) { const v = parseValue(t); if (v) max = Math.max(max, Math.abs(v.number)); }
  }
  for (const s of block.sources ?? []) max = Math.max(max, Math.abs(Number(s.value.value)));
  return max * FLOAT_MARGIN;
}

/** Run one block and record every net voltage and source current. */
async function behaviourBlock(netlistText, block, nets, { compat, timeoutMs, bound = Infinity }) {
  const body = netlistText.split('\n').filter(l => !/^\s*\.end\s*$/i.test(l)).join('\n');
  const sources = (block.sources ?? []).map((s, i) => `Vksrc${i + 1} ${s.port} 0 DC ${Number(s.value.value).toExponential(12)}`);
  const vecs = [...nets.map(n => `v(${n})`), ...sources.map((_, i) => `i(vksrc${i + 1})`)];
  if (!vecs.length) return { ok: true, vectors: {} };
  const deck = [body, ...sources, '.control', 'set wr_singlescale', 'set wr_vecnames',
    [block.analysis.kind, ...(block.analysis.params ?? [])].join(' '), `wrdata beh.dat ${vecs.join(' ')}`, '.endc', '.end', ''].join('\n');
  const run = await runNetlist(deck, { compat, timeoutMs, allowWriteFiles: ['beh.dat'], keepDir: true });
  try {
    if (!run.ok || !run.run_dir) return { ok: false, reason_code: run.reason_code, reason: run.reason };
    let text;
    try { text = readFileSync(join(run.run_dir, 'beh.dat'), 'utf8'); } catch { return { ok: false, reason_code: 'tool_error', reason: 'no behaviour data written' }; }
    const { cols } = parseWrdata(text);
    if (cols.length !== vecs.length + 1) return { ok: false, reason_code: 'tool_error', reason: 'behaviour data has the wrong shape' };
    const t = cols[0];
    const vectors = {};
    vecs.forEach((name, i) => {
      const y = cols[i + 1];
      const floating = name.startsWith('v(') && y.some(x => Math.abs(x) > bound);
      if (block.analysis.kind !== 'tran') { vectors[name] = { dc: y[0], ...(floating ? { floating: true } : {}) }; return; }
      const lo = Math.min(...y), hi = Math.max(...y);
      vectors[name] = { min: lo, max: hi, mean: trapezoidAverage(t, y), y, t, ...(floating ? { floating: true } : {}) };
    });
    return { ok: true, vectors };
  } finally {
    if (run.run_dir) rmSync(run.run_dir, { recursive: true, force: true });
  }
}

/** Mid-level crossings of y at the baseline's own mid level. */
const crossings = (y, level) => { let n = 0; for (let i = 1; i < y.length; i++) if ((y[i - 1] - level) * (y[i] - level) < 0) n++; return n; };

/** Behaviour of a netlist: per block, per vector, its features. */
export async function behaviour(netlistText, suite, nets, opts = {}) {
  const blocks = [];
  for (const block of suite.blocks) {
    if (block.kind === 'thermal' || !block.analysis) continue;
    // The bound comes from the design as given (opts.boundFrom), so a fault cannot move it.
    const bound = plausibleVoltage(opts.boundFrom ?? netlistText, block);
    blocks.push({ prefix: block.prefix, kind: block.analysis.kind, bound, ...(await behaviourBlock(netlistText, block, nets, { ...opts, bound })) });
  }
  return blocks;
}

/**
 * How much a faulted design's behaviour differs from the baseline's.
 * @returns {{harm: number|null, top: Array, unmeasured: string[]}}
 */
export function harmOf(base, mut) {
  const deltas = [], unmeasured = [];
  for (const b of base) {
    const m = mut.find(x => x.prefix === b.prefix);
    if (!b.ok) continue;
    if (!m?.ok) { unmeasured.push(`${b.prefix}: ${m?.reason_code ?? 'not run'}`); continue; }
    const floating = Object.entries(b.vectors).filter(([, v]) => v.floating).map(([n]) => n);
    if (floating.length) unmeasured.push(`${b.prefix}: ${floating.length} net(s) float on the baseline (beyond ±${b.bound} V, e.g. ${floating[0]} = ${b.vectors[floating[0]].dc ?? b.vectors[floating[0]].max}); not used as evidence`);
    for (const [name, bv] of Object.entries(b.vectors)) {
      const mv = m.vectors[name];
      if (!mv || bv.floating) continue;
      const floor = name.startsWith('i(') ? 1e-6 : 0.05;
      // The fault leaves this net with no reference: it changed, but the solver's number is not a voltage.
      if (name.startsWith('v(') && ['dc', 'min', 'max'].some(k => k in mv && Math.abs(mv[k]) > b.bound)) {
        deltas.push({ block: b.prefix, vector: name, feature: 'floats under the fault', baseline: bv.dc ?? bv.mean, faulted: null, rel: 1 });
        continue;
      }
      const add = (feature, x, y, scale) => deltas.push({ block: b.prefix, vector: name, feature, baseline: x, faulted: y, rel: Math.abs(y - x) / Math.max(scale, floor) });
      if ('dc' in bv) { add('dc', bv.dc, mv.dc, Math.abs(bv.dc)); continue; }
      const scale = Math.max(Math.abs(bv.max), Math.abs(bv.min), bv.max - bv.min);
      add('min', bv.min, mv.min, scale); add('max', bv.max, mv.max, scale); add('mean', bv.mean, mv.mean, scale);
      const level = (bv.max + bv.min) / 2;
      if (bv.max - bv.min > floor) {
        const cb = crossings(bv.y, level), cm = crossings(mv.y, level);
        deltas.push({ block: b.prefix, vector: name, feature: 'crossings', baseline: cb, faulted: cm, rel: Math.abs(cm - cb) / Math.max(cb, 1) });
      }
    }
  }
  deltas.sort((a, b) => b.rel - a.rel);
  return { harm: deltas.length ? deltas[0].rel : null, top: deltas.slice(0, 5), unmeasured };
}

/** What the Villain reads: parts, nets, checks, the grammar and the fixed catalog. */
function briefOf(nl, suite, gate, baselineResults) {
  return {
    grammar: GRAMMAR,
    goal: `Find faults every check still passes but that change behaviour: harm >= ${HARMFUL} (relative change of a net voltage or source current, measured by ngspice). Killed faults show the checks work; missed harmful ones show where they do not.`,
    parts: nl.components.map(c => ({ ref: c.refdes, type: c.type, nodes: c.nodes, value: c.tail.join(' ') })),
    nets: netsOf(nl).map(n => ({ net: n, parts: nl.connections(n).map(c => c.refdes) })),
    checks: baselineResults.map(r => ({ id: r.test_id, check: r.assertion, baseline: r.verdict, measured: r.measured ?? null, can_catch_faults: gate.canKill(r.test_id) })),
    analyses: suite.blocks.filter(b => b.analysis).map(b => ({ block: b.prefix, analysis: b.analysis.raw, sources: (b.sources ?? []).map(s => `${s.port}=${s.value.value}`) })),
    catalog: OPERATORS.map(o => ({ operator: o.id, summary: o.summary, targets: o.candidates(nl).map(c => c.key) })),
  };
}

/**
 * A Villain session over one design and one suite. `inject` is the only way a
 * fault is tried; every record goes to `log` (JSON-serialisable, replayable).
 */
export function createVillain({ netlist: netlistText, suite: rawSuite, compat = null, timeoutMs = 120_000, budget = MAX_FAULTS }) {
  const suite = normaliseSuite(rawSuite);
  const nl = parseNetlist(netlistText);
  const nets = netsOf(nl).filter(n => SAFE_NET.test(n)).slice(0, MAX_NETS);
  const log = [];
  const inflight = new Map(); // netlist sha -> id, for faults still being solved
  let issued = 0;
  let basePromise = null;

  const tried = ref => log.filter(r => r.target === ref || (r.fault.ref === ref) || (r.fault.kind === 'short' && nl.component(ref)?.nodes.some(n => n === r.fault.a || n === r.fault.b)));
  const sorted = () => [...log].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

  const session = {
    get log() { return sorted(); },
    design_hash: sha256(netlistText),
    init() {
      return (basePromise ??= (async () => {
        const checks = await runChecks(netlistText, suite, { compat, timeoutMs });
        const gate = new BaselineGate(checks.results);
        const beh = await behaviour(netlistText, suite, nets, { compat, timeoutMs });
        return { checks: checks.results, gate, beh };
      })());
    },
    /** The whole design, or with `ref` one element: its pins, neighbours, the checks that see it, its fault modes. */
    async brief({ ref } = {}) {
      const b = await session.init();
      if (ref) {
        const c = nl.component(ref);
        if (!c) throw new VillainError(`no part "${ref}" (parts: ${nl.components.map(x => x.refdes).join(', ')})`);
        return {
          design_hash: session.design_hash, budget_left: budget - issued, grammar: GRAMMAR, goal: briefOf(nl, suite, b.gate, b.checks).goal,
          element: { ref: c.refdes, type: c.type, value: c.tail.join(' '), pins: c.nodes.map((n, i) => ({ pin: i + 1, net: n, also_on_net: nl.connections(n).filter(x => x !== c).map(x => x.refdes) })) },
          observed_by: observers(nl, suite, c.refdes),
          checks: b.checks.map(r => ({ id: r.test_id, check: r.assertion, baseline: r.verdict, measured: r.measured ?? null })),
          analyses: suite.blocks.filter(x => x.analysis).map(x => ({ block: x.prefix, analysis: x.analysis.raw, sources: (x.sources ?? []).map(s2 => `${s2.port}=${s2.value.value}`) })),
          modes: elementModes(nl, c.refdes),
          tried: tried(c.refdes).map(r => ({ id: r.id, fault: r.fault, status: r.status, harm: r.harm })),
        };
      }
      return { design_hash: session.design_hash, budget_left: budget - issued, ...briefOf(nl, suite, b.gate, b.checks),
        tried: sorted().map(r => ({ id: r.id, fault: r.fault, status: r.status, harm: r.harm, agent: r.agent })) };
    },
    /** How to split the work: one entry per element, with how many fault modes it has and whether any check sees it. */
    async plan() {
      await session.init();
      return {
        design_hash: session.design_hash, budget_left: budget - issued,
        elements: nl.components.filter(c => !/^V(KSRC|KP)/i.test(c.refdes)).map(c => {
          const obs = observers(nl, suite, c.refdes);
          return { ref: c.refdes, type: c.type, nets: c.nodes, modes: elementModes(nl, c.refdes).length, observed_by: obs.length, tried: tried(c.refdes).length,
            unobserved: obs.length === 0 };
        }),
        advice: 'Dispatch one element agent per element (in parallel). Unobserved elements (no check on their nets or through them) and elements with many modes come first. Split the budget across them.',
      };
    },
    async inject(fault, { agent = null } = {}) {
      const b = await session.init();
      if (issued >= budget) throw new VillainError(`the budget of ${budget} faults is used up`);
      let p, applied;
      try {
        p = faultPatch(nl, fault, issued + 1);
        applied = applyPatch(nl, p);
      } catch (e) {
        if (e instanceof VillainError || e instanceof PatchError) throw new VillainError(`refused: ${e.message}`);
        throw e;
      }
      const key = sha256(applied.text);
      const dup = log.find(r => r.netlist_sha256 === key);
      if (dup) throw new VillainError(`refused: the same faulted circuit as ${dup.id} (${dup.description})`);
      if (inflight.has(key)) throw new VillainError(`refused: the same faulted circuit as ${inflight.get(key)}, still being solved`);
      issued += 1;
      const id = `V${issued}`;
      inflight.set(key, id);
      try {
        const checks = await runChecks(applied.text, suite, { subject: id, compat, timeoutMs });
        const cls = classifyMutant(b.gate, checks.results);
        const mbeh = await behaviour(applied.text, suite, nets, { compat, timeoutMs, boundFrom: netlistText });
        const h = harmOf(b.beh, mbeh);
        const rec = {
          id, agent, fault, description: p.description, target: p.target, netlist_sha256: key,
          status: cls.status, killed_by: cls.killed_by, why: cls.why,
          harm: h.harm, harmful: h.harm !== null && h.harm >= HARMFUL,
          evidence: h.top.map(d => ({ ...d, rel: Number(d.rel.toPrecision(4)) })), unmeasured: h.unmeasured,
          results: checks.results.map(r => ({ test_id: r.test_id, verdict: r.verdict, measured: r.measured ?? null, reason_code: r.reason_code ?? null })),
        };
        log.push(rec);
        return rec;
      } finally {
        inflight.delete(key);
      }
    },
    report() {
      const all = sorted();
      const missedHarmful = all.filter(r => r.status === 'survived' && r.harmful).sort((a, b) => b.harm - a.harm);
      const count = st => all.filter(r => r.status === st).length;
      const perElement = {};
      for (const c of nl.components) {
        const rs = tried(c.refdes);
        if (!rs.length) continue;
        const modes = elementModes(nl, c.refdes).length;
        perElement[c.refdes] = { tried: rs.length, modes, killed: rs.filter(r => r.status === 'killed').length, missed: rs.filter(r => r.status === 'survived').length,
          missed_harmful: rs.filter(r => r.status === 'survived' && r.harmful).map(r => r.id), observed_by: observers(nl, suite, c.refdes).length };
      }
      return {
        tried: all.length, killed: count('killed'), survived: count('survived'), not_checked: count('not_checked'), errors: count('error'),
        agents: [...new Set(all.map(r => r.agent).filter(Boolean))],
        missed_harmful: missedHarmful.map(r => ({ id: r.id, agent: r.agent, description: r.description, harm: r.harm, worst: r.evidence[0] })),
        missed_low_harm: all.filter(r => r.status === 'survived' && !r.harmful).map(r => ({ id: r.id, description: r.description, harm: r.harm })),
        per_element: perElement,
        untouched: nl.components.map(c => c.refdes).filter(r => !perElement[r]),
      };
    },
  };
  return session;
}

/** Re-run every fault in a log with no model, and say whether each record reproduces. */
export async function replayVillain(opts, log) {
  const s = createVillain(opts);
  const out = [];
  for (const r of log) {
    const again = await s.inject(r.fault, { agent: r.agent ?? null });
    out.push({ id: r.id, same: again.status === r.status && again.netlist_sha256 === r.netlist_sha256
      && JSON.stringify(again.killed_by) === JSON.stringify(r.killed_by) && again.harmful === r.harmful });
  }
  return out;
}

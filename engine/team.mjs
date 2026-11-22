// A team of agents improving one check suite without stepping on each other.
//
// Like a finite-element solver splitting a model into elements that meet at
// shared boundary nodes, Kinux splits the circuit into REGIONS that meet at
// INTERFACE nets:
//
//   * Ground, the supply rails and any net that ties many parts together are
//     interfaces (the boundary nodes). Every other net joins the parts on it.
//     The connected groups that remain are the natural regions; the smallest
//     are merged into the neighbour they share most nets with, until there are
//     at most `k`. Every part is in exactly one region (decomposition is
//     disjoint and complete).
//   * A region OWNS its parts (I(part)) and its interior nets (V(), f()). The
//     interface nets belong to the lead, under the region id "interfaces".
//
// Work is handed out by LEASE: claiming a region returns a secret; a check is
// accepted only with the lease of the region that owns what it measures. One
// lease per region, so no two agents work on the same region and no agent can
// add checks in another's.
//
// Every proposal goes through ONE queue (like a merge queue), and is judged
// against the suite as it stands at that moment:
//
//   1. grammar: the line parses as a check in the suite's own grammar, into an
//      existing block (its analysis and sources);
//   2. ownership: what it measures belongs to the proposer's region;
//   3. the design as drawn PASSES it (a check that fails the design catches
//      nothing; that is a finding for a person, returned as such);
//   4. target: it FAILS on at least one of the region's faults that no check
//      catches yet (a check that adds nothing is not added);
//   5. integration: with the check in, the whole suite is run again on the
//      design and must still pass every check that passed before, and the
//      global score must not go down. Only then is it committed.
//
// The faults are the fixed operators' mutants (engine/operators.mjs), each
// assigned to the region of the part (or net) it targets.

import { createHash, randomBytes } from 'node:crypto';
import { parseNetlist, isGround } from './netlist.mjs';
import { generateMutants } from './operators.mjs';
import { BaselineGate, classifyMutant, runChecks, normaliseSuite } from './runner.mjs';
import { parseSpiceAssertion, verifySimulation, parseAnalysis, parseSource } from '../workers/ngspice/assertions.mjs';
import { behaviour } from './villain.mjs';

/** Killed / checkable, with the counts. NOT_CHECKED and ERROR are in neither. */
export function computeScore(statuses) {
  const n = st => statuses.filter(x => x === st).length;
  const killed = n('killed'), survived = n('survived');
  return { killed, survived, not_checked: n('not_checked'), errors: n('error'), total: statuses.length, score: killed + survived ? killed / (killed + survived) : null };
}

const sha = t => createHash('sha256').update(String(t)).digest('hex');
export class TeamError extends Error {}

/**
 * Split a netlist into disjoint regions meeting at interface nets.
 * @returns {{regions: Array<{id, parts: string[], nets: string[]}>, interfaces: string[], regionOf: Map, netOwner: Map}}
 */
export function decompose(netlistText, { k = 6, hubDegree = null } = {}) {
  const nl = parseNetlist(netlistText);
  const parts = nl.components.filter(c => c.type !== 'K');
  const rails = nl.rails();
  const degree = n => nl.connections(n).length;
  const hub = hubDegree ?? Math.max(4, Math.ceil(parts.length / 3));
  const isInterface = n => isGround(n) || rails.has(n) || degree(n) >= hub;

  const parent = new Map(parts.map(c => [c.refdes, c.refdes]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  for (const n of nl.nodes()) {
    if (isInterface(n)) continue;
    const on = nl.connections(n).map(c => c.refdes).filter(r => parent.has(r));
    for (let i = 1; i < on.length; i++) union(on[0], on[i]);
  }
  let groups = [...parts.reduce((m, c) => { const r = find(c.refdes); (m.get(r) ?? m.set(r, []).get(r)).push(c.refdes); return m; }, new Map()).values()];
  const netsOf = refs => new Set(refs.flatMap(r => nl.component(r).nodes).filter(n => !isGround(n)));
  // Merge the smallest region into the one it shares most nets with (ties: the smaller, then by name).
  while (groups.length > k) {
    groups.sort((a, b) => a.length - b.length || a[0].localeCompare(b[0]));
    const [small, ...rest] = groups;
    const mine = netsOf(small);
    const score = g => [...netsOf(g)].filter(n => mine.has(n)).length;
    rest.sort((a, b) => score(b) - score(a) || a.length - b.length || a[0].localeCompare(b[0]));
    rest[0].push(...small);
    groups = rest;
  }
  groups = groups.map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
  const regionOf = new Map();
  const regions = groups.map((g, i) => ({ id: `G${i + 1}`, parts: g }));
  for (const r of regions) for (const p of r.parts) regionOf.set(p, r.id);
  const netOwner = new Map();
  for (const n of nl.nodes()) {
    if (isGround(n)) continue;
    const owners = new Set(nl.connections(n).map(c => regionOf.get(c.refdes)).filter(Boolean));
    netOwner.set(n, !isInterface(n) && owners.size === 1 ? [...owners][0] : 'interfaces');
  }
  for (const r of regions) r.nets = [...netOwner].filter(([, o]) => o === r.id).map(([n]) => n);
  const interfaces = [...netOwner].filter(([, o]) => o === 'interfaces').map(([n]) => n);
  return { regions, interfaces, regionOf, netOwner };
}

/**
 * What kind of element a part is. From the KiCad library entry when the design
 * has one (Device:LED, Device:Polyfuse, Timer:TLC555xD...), else from the
 * netlist element and its model name. Unknown is 'other', never a guess.
 */
export function partKind(comp, info = null) {
  const lib = `${info?.lib ?? ''}:${info?.part ?? ''}`.toLowerCase();
  const model = (comp.type === 'X' ? comp.tail.at(-1) : comp.tail.find(t => /^[a-z]/i.test(t)) ?? '').toLowerCase();
  if (/led/.test(lib) || /^d.*led|led_/.test(model)) return 'led';
  if (/polyfuse|fuse|ptc/.test(lib) || /fuse|ptc|mf.?smf/.test(model)) return 'fuse';
  if (/tvs|zener|esd/.test(lib)) return 'protection_diode';
  if (/:d(_|$)|diode|1n4148|schottky/.test(lib) || comp.type === 'D') return 'diode';
  if (/potentiometer|trim/.test(lib)) return 'potentiometer';
  if (/switch|sw_/.test(lib)) return 'switch';
  if (/:r$|:r_/.test(lib) || comp.type === 'R') return 'resistor';
  if (/:c$|:c_|:cp/.test(lib) || comp.type === 'C') return 'capacitor';
  if (/:l$|:l_/.test(lib) || comp.type === 'L') return 'inductor';
  if (comp.type === 'I' || comp.type === 'V') return 'source';
  if (comp.type === 'X' || comp.type === 'U') return 'ic';
  if (comp.type === 'Q' || comp.type === 'M') return 'transistor';
  return 'other';
}

/**
 * The specialist a region needs, from the kinds of its parts. Active parts
 * (ICs, stand-in loads, transistors) dominate, then emitters, then protection
 * and power-path parts, then energy storage; a region of resistors alone is a
 * passive network.
 */
export const SPECIALISTS = {
  active: 'ICs, MCU stand-in loads, transistors, regulators: supply current, pin levels, reset and enable lines',
  emitter: 'LEDs and their current-setting resistors: channel current, forward voltage, brightness matching',
  protection: 'fuses, series diodes, TVS and ESD parts: the power path, drops, leakage, reverse blocking',
  storage: 'capacitors and inductors: decoupling, timing, filters; what DC can and cannot see',
  passive: 'resistor networks: dividers, pull-ups and pull-downs, sense and bias resistors',
};
export function specialtyOf(kinds) {
  const has = k => kinds.includes(k);
  if (has('ic') || has('source') || has('transistor')) return 'active';
  if (has('led')) return 'emitter';
  if (has('fuse') || has('diode') || has('protection_diode')) return 'protection';
  if (has('capacitor') || has('inductor')) return kinds.every(k => k === 'capacitor' || k === 'inductor') || kinds.filter(k => k === 'capacitor' || k === 'inductor').length >= kinds.length / 2 ? 'storage' : 'passive';
  return 'passive';
}

/** Who owns what an assertion measures: a region id, 'interfaces', or null (unknown target). */
export function ownerOf(assertion, d) {
  const m = assertion.measurable;
  if (!m) return null;
  if (m.kind === 'voltage' || m.kind === 'frequency') return d.netOwner.get(m.target) ?? null;
  if (m.kind === 'current') {
    const ref = [...d.regionOf.keys()].find(r => r.toLowerCase() === String(m.target).toLowerCase());
    if (ref) return d.regionOf.get(ref);
    if (/^vksrc\d+$/i.test(m.target)) return 'interfaces'; // a block's own source: the whole board's supply
  }
  return null;
}

/** Render a suite (normalised blocks) back to the markdown grammar it came from. */
export function renderSuite(suite, commits = []) {
  const by = new Map(commits.filter(c => !c.retracted).map(c => [`${c.block}:${c.raw}`, c]));
  const out = ['# Check suite (built by a Kinux team)', '', 'Checks added by region agents are marked with the region and the faults they catch.', ''];
  for (const b of suite.blocks) {
    if (!b.analysis || !(b.assertions ?? []).length) continue;
    out.push('## Simulation', '');
    if (b.why) out.push(`<!-- block added by the lead: ${b.why} -->`);
    if (b.scope?.kind === 'nets') out.push(`scope: nets [${b.scope.nets.join(', ')}]`);
    out.push(`analysis: ${b.analysis.raw}`);
    for (const s of b.sources ?? []) out.push(`source: ${s.port}=${s.value.raw ?? s.value.value}`);
    for (const a of b.assertions) {
      const c = by.get(`${b.prefix}:${a.raw}`);
      out.push(`assert: ${a.raw}`);
      if (c) out.push(`<!-- ${c.id}: region ${c.region}${c.agent ? ` (${c.agent})` : ''}; catches ${c.kills.join(', ')} -->`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** Run `fn` over items with at most `n` at once, keeping order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

export function createTeam({ netlist: netlistText, suite: rawSuite, compat = null, timeoutMs = 120_000, k = 6, jobs = 4, partInfo = {} }) {
  let suite = normaliseSuite(rawSuite);
  suite = { ...suite, blocks: suite.blocks.map(b => ({ ...b, assertions: [...(b.assertions ?? [])] })) };
  const nl = parseNetlist(netlistText);
  const d = decompose(netlistText, { k });
  const leases = new Map(); // region -> {secret, agent}
  const commits = [];
  const rejected = [];
  let state = null; // {gate, baseline, mutants: [{...m, region, results:Map, status}]}
  let queue = Promise.resolve();
  let nextLine = 100000;
  const blockValues = {}; // prefix -> {vector: value or {min,max,mean}}, from the solve that admitted the block
  const retracted = [];
  // Blocks the lead added but nobody has put a check in yet are not run: a block with no checks judges nothing.
  const runnable = () => ({ ...suite, blocks: suite.blocks.filter(b => !b.analysis || (b.assertions ?? []).length) });

  const regionOfMutant = m => d.regionOf.get(m.target) ?? d.netOwner.get(m.target) ?? 'interfaces';
  const regionIds = () => [...d.regions.map(r => r.id), 'interfaces'];

  async function init() {
    if (state) return state;
    const base = await runChecks(netlistText, runnable(), { compat, timeoutMs });
    const gate = new BaselineGate(base.results);
    const mutants = generateMutants(nl);
    const judged = await pool(mutants, jobs, async m => {
      const r = await runChecks(m.text, runnable(), { subject: m.mutant_id, compat, timeoutMs });
      const cls = classifyMutant(gate, r.results);
      return { mutant_id: m.mutant_id, target: m.target, description: m.description, text: m.text, region: regionOfMutant(m),
        results: new Map(r.results.map(x => [x.test_id, x])), status: cls.status, killed_by: cls.killed_by };
    });
    state = { gate, baseline: base.results, mutants: judged };
    return state;
  }

  const scoreOf = list => computeScore(list.map(m => m.status));
  const regionView = id => {
    const ms = state.mutants.filter(m => m.region === id);
    const s = scoreOf(ms);
    const r = d.regions.find(x => x.id === id);
    const kinds = (r?.parts ?? []).map(p => partKind(nl.component(p), partInfo[p.replace(/^X(?=[A-Z])/, '')] ?? partInfo[p] ?? null));
    const specialty = id === 'interfaces' ? 'interfaces' : specialtyOf(kinds);
    return { region: id, parts: r?.parts ?? [], kinds, specialty, specialist: id === 'interfaces' ? 'lead' : `kinux-spec-${specialty}`,
      nets: r?.nets ?? d.interfaces, faults: ms.length, killed: s.killed, survived: s.survived,
      not_checked: s.not_checked + s.errors, score: s.score, leased_to: leases.get(id)?.agent ?? null };
  };

  const team = {
    decomposition: d,
    get suite() { return suite; },
    commits, rejected,
    async partition() {
      await init();
      return {
        regions: regionIds().map(regionView),
        interfaces: d.interfaces,
        global: scoreOf(state.mutants),
        specialists: SPECIALISTS,
        rule: 'Each region owns its parts (I(part)) and interior nets (V(), f()). Interface nets and the block sources (I(Vksrc..)) belong to "interfaces", the lead\'s region. Claim a region to work on it; one lease per region.',
      };
    },
    async claim(region, agent = null) {
      await init();
      if (!regionIds().includes(region)) throw new TeamError(`no region "${region}" (regions: ${regionIds().join(', ')})`);
      if (leases.has(region)) throw new TeamError(`region ${region} is already leased to ${leases.get(region).agent ?? 'another agent'}`);
      const secret = randomBytes(9).toString('base64url');
      leases.set(region, { secret, agent });
      return { region, lease: secret, note: 'Pass this lease to the one agent that works on this region. It is the only way to add a check there.' };
    },
    async brief(region) {
      await init();
      if (!regionIds().includes(region)) throw new TeamError(`no region "${region}"`);
      const owned = new Set(region === 'interfaces' ? d.interfaces : d.regions.find(r => r.id === region).nets);
      const parts = region === 'interfaces' ? [] : d.regions.find(r => r.id === region).parts;
      const ownedChecks = suite.blocks.flatMap(b => (b.assertions ?? []).filter(a => ownerOf(a, d) === region).map(a => ({ block: b.prefix, check: a.raw })));
      return {
        ...regionView(region),
        you_may_measure: [...[...owned].map(n => `V(${n})`), ...parts.map(p => `I(${p})`), ...(region === 'interfaces' ? suite.blocks.flatMap(b => (b.sources ?? []).map((_, i) => `I(Vksrc${i + 1})`)) : [])].filter((x, i, a) => a.indexOf(x) === i),
        parts: parts.map(p => { const c = nl.component(p); return { ref: p, type: c.type, nodes: c.nodes, value: c.tail.join(' ') }; }),
        blocks: suite.blocks.filter(b => b.analysis).map(b => ({ block: b.prefix, analysis: b.analysis.raw, sources: (b.sources ?? []).map(s => `${s.port}=${s.value.value}`),
          ...(b.why ? { why: b.why } : {}), checks: (b.assertions ?? []).length,
          // What the design does in this block, on what you may measure: the centre for your limits.
          ...(blockValues[b.prefix] ? { values: Object.fromEntries(Object.entries(blockValues[b.prefix]).filter(([k]) => region === 'interfaces' || owned.has(k.slice(2, -1)))) } : {}) })),
        baseline: state.baseline.map(r => ({ id: r.test_id, check: r.assertion, verdict: r.verdict, measured: r.measured ?? null })),
        checks_in_region: ownedChecks,
        survivors: state.mutants.filter(m => m.region === region && m.status === 'survived').map(m => ({ id: m.mutant_id, fault: m.description })),
        target: region === 'interfaces'
          ? 'You are the lead. Add stimulus blocks (kinux_propose_block) where faults cannot show in the blocks that exist; add checks on interface nets, which may catch any region\'s survivors; retract a committed check you judge unrealistic.'
          : 'Add checks that catch your region\'s survivors. Each check must pass on the design and catch at least one survivor.',
        ...(region === 'interfaces' ? { all_survivors: state.mutants.filter(m => m.status === 'survived').map(m => ({ id: m.mutant_id, region: m.region, fault: m.description })) } : {}),
      };
    },
    /** Propose one check line into a block. Serialised: judged against the suite as it stands. */
    propose({ region, lease, block, check, agent = null }) {
      const job = queue.then(() => judge({ region, lease, block, check, agent }));
      queue = job.catch(() => {});
      return job;
    },
    /** The lead adds a block: an analysis and the stimulus that puts the circuit in a real operating condition. */
    proposeBlock(args) {
      const job = queue.then(() => judgeBlock(args));
      queue = job.catch(() => {});
      return job;
    },
    /** The lead takes back a committed check it judges unrealistic; the faults only it caught survive again. */
    retract(args) {
      const job = queue.then(() => judgeRetract(args));
      queue = job.catch(() => {});
      return job;
    },
    async status() {
      await init();
      return { regions: regionIds().map(regionView), global: scoreOf(state.mutants), suite_sha256: `sha256:${sha(renderSuite(suite))}`,
        blocks_added: suite.blocks.filter(b => b.why).map(b => ({ block: b.prefix, analysis: b.analysis.raw, why: b.why, checks: b.assertions.length })),
        retracted: retracted.map(({ id, reason, global_after }) => ({ id, reason, global_after })),
        commits: commits.map(({ id, region, agent, block, raw, kills, global_after, retracted: r }) => ({ id, region, agent, block, check: raw, kills, global_after, ...(r ? { retracted: true } : {}) })),
        rejected: rejected.length };
    },
    render() { return renderSuite(suite, commits); },
  };

  async function judge({ region, lease, block, check, agent }) {
    await init();
    const reject = (code, reason, extra = {}) => { const r = { status: 'rejected', code, reason, region, agent, block, check, ...extra }; rejected.push(r); return r; };
    const l = leases.get(region);
    if (!l || l.secret !== lease) return reject('no_lease', `region ${region} needs its lease: claim it first, and only the holder may add checks there`);
    const b = suite.blocks.find(x => x.prefix === block);
    if (!b || !b.analysis) return reject('no_block', `no simulation block "${block}" (blocks: ${suite.blocks.filter(x => x.analysis).map(x => x.prefix).join(', ')})`);
    let a;
    try { a = parseSpiceAssertion(String(check), nextLine); } catch (e) { return reject('grammar', e.message); }
    const owner = ownerOf(a, d);
    if (owner !== region) return reject('not_yours', owner ? `${check} measures something region ${owner} owns` : `${check} measures something no region owns (not in this netlist)`);
    if (b.assertions.some(x => x.raw === a.raw)) return reject('duplicate', `block ${block} already has "${a.raw}"`);
    const line = nextLine++;
    a = { ...a, line };
    const one = { analysis: b.analysis, assertions: [a], sources: b.sources };
    const tid = `${suite.id}:${b.prefix}:${line}`;
    // 3. The design must pass it.
    const bl = await verifySimulation(netlistText, one, { subject: 'baseline', testIdPrefix: `${suite.id}:${b.prefix}`, compat, timeoutMs });
    const br = bl.results[0];
    if (!br || br.verdict !== 'PASS') return reject('fails_design', `the design as drawn gives ${br?.verdict ?? 'nothing'}${br?.measured !== undefined ? ` (measured ${br.measured})` : ''}${br?.reason ? `: ${br.reason}` : ''}. A check the design fails catches nothing; if the design is wrong, that is for a person.`, { measured: br?.measured ?? null });
    // 4. It must catch at least one of the region's survivors.
    // An interface net (a rail) sees the whole board: the lead's checks may catch any region's survivors.
    // Faults not caught yet: survivors, and faults no check could judge so far (a new block can make
    // them checkable, so they are judged too; leaving them out made the team under-count).
    const OPEN = new Set(['survived', 'not_checked', 'error']);
    const targets = state.mutants.filter(m => (region === 'interfaces' || m.region === region) && OPEN.has(m.status));
    const hits = await pool(targets, jobs, async m => {
      const r = await verifySimulation(m.text, one, { subject: m.mutant_id, testIdPrefix: `${suite.id}:${b.prefix}`, compat, timeoutMs });
      return { m, r: r.results[0] };
    });
    const kills = hits.filter(h => h.r?.verdict === 'FAIL');
    if (!kills.length) return reject('catches_nothing', `it catches none of the ${targets.length} faults region ${region} has not caught yet`, { measured: br.measured });
    // 5. Integrate: commit the check, re-run the whole suite on the design, and re-judge the faults it caught.
    const before = scoreOf(state.mutants);
    const prevBlocks = suite.blocks;
    suite = { ...suite, blocks: suite.blocks.map(x => (x.prefix === block ? { ...x, assertions: [...x.assertions, a] } : x)) };
    const again = await runChecks(netlistText, runnable(), { compat, timeoutMs });
    const lost = state.baseline.filter(r => r.verdict === 'PASS' && again.results.find(x => x.test_id === r.test_id)?.verdict !== 'PASS');
    const newBase = again.results.find(x => x.test_id.startsWith(`${tid}:`));
    if (lost.length || newBase?.verdict !== 'PASS') {
      suite = { ...suite, blocks: prevBlocks };
      return reject('integration', `with the check in, the suite no longer passes the design: ${lost.map(r => r.test_id).join(', ') || newBase?.test_id}`);
    }
    const gate = new BaselineGate(again.results);
    for (const { m, r } of hits) {
      // The single-check run numbers it k1; in the suite it has the id the full run gave it.
      // Every judged fault keeps its result, caught or not, so a later check sees the same evidence a fresh run would.
      if (r) m.results.set(newBase.test_id, { ...r, test_id: newBase.test_id });
      const cls = classifyMutant(gate, [...m.results.values()]);
      m.status = cls.status; m.killed_by = cls.killed_by;
    }
    state.gate = gate; state.baseline = again.results;
    const after = scoreOf(state.mutants);
    if (after.score !== null && before.score !== null && after.score < before.score) {
      throw new Error(`integration invariant broken: global score fell from ${before.score} to ${after.score}`);
    }
    const commit = { status: 'committed', id: `C${commits.length + 1}`, region, agent, block, raw: a.raw, test_id: newBase.test_id, measured: br.measured,
      kills: kills.map(h => h.m.mutant_id), region_after: regionView(region), global_before: before.score, global_after: after.score,
      suite_sha256: `sha256:${sha(renderSuite(suite))}` };
    commits.push(commit);
    return commit;
  }

  const leadOk = lease => leases.get('interfaces')?.secret === lease;

  async function judgeBlock({ lease, analysis, sources = {}, why = '', agent = null }) {
    await init();
    const reject = (code, reason) => { const r = { status: 'rejected', code, reason, kind: 'block', analysis, sources, agent }; rejected.push(r); return r; };
    if (!leadOk(lease)) return reject('no_lease', 'only the lead (the holder of the "interfaces" lease) adds blocks: stimulus crosses regions');
    if (!String(why).trim()) return reject('no_reason', 'say which real operating condition this block stands for (why), e.g. "MCU sinking all four LED cathodes at full brightness"');
    let an;
    try { an = parseAnalysis(String(analysis)); } catch (e) { return reject('grammar', e.message); }
    if (an.kind !== 'op' && an.kind !== 'tran') return reject('grammar', 'a block is an op or tran analysis');
    const entries = Object.entries(sources ?? {});
    if (entries.length > 12) return reject('too_many', 'at most 12 sources in a block');
    const nets = new Set(nl.nodes());
    const designDriven = new Set(nl.components.filter(c => c.type === 'V').flatMap(c => c.nodes));
    const parsed = [];
    for (const [net, v] of entries) {
      if (isGround(net)) return reject('bad_source', 'ground cannot be driven');
      if (!nets.has(net)) return reject('bad_source', `no net "${net}" in the netlist`);
      if (designDriven.has(net)) return reject('bad_source', `${net} is already driven by a source in the design`);
      let src;
      try { src = parseSource(`${net}=${v}`, 0); } catch (e) { return reject('grammar', e.message); }
      if (!Number.isFinite(src.value.value) || Math.abs(src.value.value) > 1000) return reject('bad_source', `${net}: a source from -1000 to 1000 V`);
      parsed.push(src);
    }
    const key = `${an.raw}|${parsed.map(x => `${x.port}=${x.value.value}`).sort().join(',')}`;
    const dup = suite.blocks.find(b => b.analysis && `${b.analysis.raw}|${(b.sources ?? []).map(x => `${x.port}=${x.value.value}`).sort().join(',')}` === key);
    if (dup) return reject('duplicate', `block ${dup.prefix} already has this analysis and stimulus`);
    const prefix = `b${suite.blocks.length}`;
    const block = { prefix, index: suite.blocks.length, line: 0, scope: { kind: 'nets', nets: parsed.map(x => x.port).length ? parsed.map(x => x.port) : d.interfaces.slice(0, 1) },
      analysis: an, sources: parsed, assertions: [], why: String(why).slice(0, 300) };
    // The design must solve under it, and every net must have a real value.
    const probeNets = nl.nodes().filter(n => !isGround(n) && /^[A-Za-z0-9_./:+-]+$/.test(n)).slice(0, 40);
    const [beh] = await behaviour(netlistText, { blocks: [block] }, probeNets, { compat, timeoutMs });
    if (!beh?.ok) return reject('does_not_solve', `the design does not solve under this block: ${beh?.reason_code ?? ''} ${String(beh?.reason ?? '').split('\n')[0]}`);
    const floating = Object.entries(beh.vectors).filter(([, v]) => v.floating).map(([k]) => k);
    const values = Object.fromEntries(Object.entries(beh.vectors).filter(([, v]) => !v.floating)
      .map(([k, v]) => [k, 'dc' in v ? v.dc : { min: v.min, max: v.max, mean: v.mean }]));
    suite = { ...suite, blocks: [...suite.blocks, block] };
    blockValues[prefix] = values;
    return { status: 'committed', kind: 'block', block: prefix, analysis: an.raw, sources: parsed.map(x => `${x.port}=${x.value.value}`), why: block.why, values,
      floating, note: floating.length ? `${floating.length} net(s) float in this block and cannot be checked in it: ${floating.join(', ')}` : 'every net has a defined value in this block' };
  }

  async function judgeRetract({ lease, commit: id, reason = '', agent = null }) {
    await init();
    if (!leadOk(lease)) return { status: 'rejected', code: 'no_lease', reason: 'only the lead retracts checks' };
    if (!String(reason).trim()) return { status: 'rejected', code: 'no_reason', reason: 'say why the check is unrealistic' };
    const c = commits.find(x => x.id === id && !x.retracted);
    if (!c) return { status: 'rejected', code: 'no_commit', reason: `no live commit ${id}` };
    const before = scoreOf(state.mutants);
    suite = { ...suite, blocks: suite.blocks.map(b => (b.prefix === c.block ? { ...b, assertions: b.assertions.filter(a => a.raw !== c.raw) } : b)) };
    const again = await runChecks(netlistText, runnable(), { compat, timeoutMs });
    const gate = new BaselineGate(again.results);
    for (const m of state.mutants) {
      if (!m.results.has(c.test_id)) continue;
      m.results.delete(c.test_id);
      const cls = classifyMutant(gate, [...m.results.values()]);
      m.status = cls.status; m.killed_by = cls.killed_by;
    }
    state.gate = gate; state.baseline = again.results;
    c.retracted = true;
    const after = scoreOf(state.mutants);
    const rec = { status: 'retracted', id, reason: String(reason).slice(0, 300), agent, global_before: before.score, global_after: after.score,
      survive_again: state.mutants.filter(m => m.status === 'survived' && c.kills.includes(m.mutant_id)).map(m => m.mutant_id) };
    retracted.push(rec);
    return rec;
  }

  return team;
}

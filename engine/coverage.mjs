// Coverage-gap report: which nets, parts and requirements can NO check see?
//
// Computed from the design and its checks alone, BEFORE any mutant is run. It
// is a structural analysis. It never calls a solver and never says a part's
// faults WOULD be caught: it says which parts could not possibly be caught,
// because nothing a check measures can depend on them. It is validated against
// the real mutation engine in spikes/coverage/validate.mjs and tests/coverage.test.mjs
// (precision and recall against actual survivors are reported in
// spikes/coverage/README.md, with the cases where it is wrong).
//
// WHAT "TOUCH" MEANS. A check reads from the design in exactly one way: an
// assertion names a measurable. V(net), corner(net) and f(net) read a node voltage.
// I(refdes), P(refdes) and T(refdes) read the current through, power in, and
// temperature of a part. Only those parsed assertions count. A name in a
// netlist comment, a requirement, prose around a check, an HTML comment or a
// `scope:` line is NOT a measurement (a `scope:` net is reported as "named,
// never asserted"). Given the observations, three relations, strongest first:
//
//  1. DIRECT. The check measures this net, or probes this part by name.
//
//  2. INFLUENCE. The part (or net) can change a measured quantity. The graph
//     follows conduction, in the analysis that check uses: at op/dc a
//     capacitor is open and an inductor is a wire; in ac/tran a capacitor
//     conducts. Ground and every node held by an ideal voltage source (a chain
//     of V sources, or an E/H output, to ground) are "stiff": nothing on the
//     load side can move them, so propagation stops there, and the source
//     itself is what influences everything on the other side. A part whose
//     terminals are all stiff (a capacitor across the supply, at DC) cannot
//     move any node voltage and is uncovered, unless a check probes the
//     source's current. Controlled sources and gates/switch controls are
//     directed edges: the controlling nets influence what is controlled, never
//     the reverse. So a net that feeds only a controlled element whose output
//     reaches no measurement is uncovered.
//
//  3. CONTROL (dangling sense stub). A net that no check measures, that only a
//     pin which reads nothing (inside the subcircuit it ends only in passives
//     to ideally driven nets) and passives touch, and that hangs off the rest
//     of the circuit through exactly one non-stiff net. This is an open
//     feedback loop: the divider is drawn, the pin is wired, nothing reads it.
//     Such a stub is removed from the influence graph: its parts can only
//     load a measured node, which this report does not count as a way to
//     see a fault in them. It is the one rule that goes beyond pure
//     reachability; it was written for the fang buck deck (spikes/fang) and is
//     checked for false positives on the other designs.
//
// WHAT IT CANNOT SEE (stated, because a coverage report that hides this lies):
//  - It is structural. "Covered" means a check CAN depend on the part, not
//    that its faults move the reading outside the check's band. A gate pulldown
//    (RGS in examples/phase-leg-support) on a node an ideal driver holds through
//    10 ohm is structurally covered; every mutant survives anyway because the
//    pulldown barely changes the node. Magnitudes and tolerances are
//    invisible here. Recall is bounded by this and is measured, not assumed.
//  - Over-approximation is deliberate: unknown element types, opaque
//    subcircuits, transistors and transmission lines conduct between all pins,
//    so an uncovered claim stays reliable and a covered claim stays weak.
//  - AC analysis is treated like tran: a source with no AC magnitude still
//    counts as influencing. Initial conditions (uic), .param expressions,
//    continuation lines and nested .subckt definitions are not modelled.
//  - A part in a subcircuit body is one report row for all instances of that
//    body; it is covered if ANY instance is, which is what a mutation of the
//    body sees.
//  - Requirements are matched to the design by exact net or part names, never
//    by meaning. A purely numeric net name ("5") is never matched from prose.
//    Pass {text, nets, parts} to map one explicitly.

import { isGround } from './netlist.mjs';

export const COVERAGE_SCHEMA = 'kinux.coverage/1';

const MAX_PARTS = 20000;
const MAX_DEPTH = 8;

const lc = s => String(s).toLowerCase();

/* ------------------------------------------------------------------------ */
/* 1. Flatten subcircuits into one graph. Design text is hostile: depth and  */
/*    size are bounded, recursion is refused, Maps hold every name.         */
/* ------------------------------------------------------------------------ */

function flatten(netlist) {
  const subckts = new Map();
  const top = [];
  let cur = null;
  for (const line of netlist.lines) {
    if (line.kind === 'directive') {
      const t = line.raw.trim().split(/\s+/);
      const k = lc(t[0]);
      if (k === '.subckt' && !cur && t[1]) {
        cur = { name: lc(t[1]), ports: t.slice(2).filter(x => !x.includes('=')).map(lc), elems: [] };
        subckts.set(cur.name, cur);
      } else if (k === '.ends') cur = null;
    } else if (line.kind === 'element') (cur ? cur.elems : top).push(line);
  }

  const parts = [];
  const pins = [];   // one record per subcircuit port of every expanded instance
  const notes = [];
  let overflow = false;

  const expand = (elems, mapNode, path, stack) => {
    for (const el of elems) {
      if (parts.length >= MAX_PARTS) { overflow = true; return; }
      const nodes = el.nodes.map(mapNode);
      const part = {
        key: `${path}${el.id}`, id: el.id, refdes: el.refdes, qname: lc(path + el.refdes),
        type: el.type, nodes, tail: el.tail, path, inBody: path !== '', opaque: false, children: [],
      };
      parts.push(part);
      if (el.type !== 'X') continue;
      const subName = lc(el.tail[0] ?? '');
      const sub = subckts.get(subName);
      if (!sub || sub.ports.length !== nodes.length || stack.length >= MAX_DEPTH || stack.includes(subName)) {
        part.opaque = true;
        notes.push(`${el.refdes}: subcircuit "${el.tail[0]}" is ${!sub ? 'not defined in this file' : stack.includes(subName) ? 'recursive' : stack.length >= MAX_DEPTH ? 'nested too deeply' : 'called with the wrong pin count'}; treated as an opaque part whose pins all conduct`);
        continue;
      }
      const inst = `${path}${lc(el.refdes)}.`;
      const portMap = new Map(sub.ports.map((p, i) => [p, nodes[i]]));
      const inner = n => (portMap.has(lc(n)) ? portMap.get(lc(n)) : isGround(n) ? '0' : inst + lc(n));
      const before = parts.length;
      expand(sub.elems, inner, inst, [...stack, subName]);
      part.children = parts.slice(before).filter(p => p.path === inst).map(p => p.key);
      // Pin records: what inside the body touches each port's local node.
      sub.ports.forEach((p, i) => {
        const touching = parts.slice(before).filter(q => q.path === inst && q.nodes.some((_, k) => lc(sub.elems.find(e => e.id === q.id).nodes[k]) === p));
        pins.push({ inst: part.key, instRefdes: el.refdes, port: p, outer: nodes[i], body: touching.map(q => q.key) });
      });
    }
  };
  expand(top, n => (isGround(n) ? '0' : lc(n)), '', []);
  if (overflow) notes.push(`more than ${MAX_PARTS} elements after expanding subcircuits; the rest are not analysed`);
  return { parts, pins, notes };
}

/* ------------------------------------------------------------------------ */
/* 2. Per-element electrical roles                                          */
/* ------------------------------------------------------------------------ */

const TWO_TERMINAL_PASSIVE = new Set(['R', 'C', 'L']);

/**
 * What an element does to the influence graph.
 *   group    nodes that are conductively tied together (and that the part touches)
 *   touches  nodes the part touches without tying them together (current sources)
 *   directed [{from: nodes[], fromBranch: partName|null}] -> controls `to`
 *   driver   {pos, neg, kind} for ideal voltage-like sources
 */
function roleOf(part, conductC) {
  const n = part.nodes;
  const t = part.type;
  const exprNodes = () => {
    const out = [];
    for (const m of part.tail.join(' ').matchAll(/[vi]\(([^()\s,]+)(?:,([^()\s]+))?\)/gi)) {
      for (const g of [m[1], m[2]]) if (g) out.push(isGround(g) ? '0' : part.path + lc(g));
    }
    return out;
  };
  switch (t) {
    case 'R': case 'L': case 'D': return { group: [n[0], n[1]] };
    case 'C': return conductC ? { group: [n[0], n[1]] } : { open: true };
    case 'V': return { driver: { pos: n[0], neg: n[1], kind: 'V' } };
    case 'I': return { touches: [n[0], n[1]] };
    case 'E': return { driver: { pos: n[0], neg: n[1], kind: 'E', ctrlNodes: [n[2], n[3]] } };
    case 'H': return { driver: { pos: n[0], neg: n[1], kind: 'H', ctrlBranch: lc(part.tail[0] ?? '') } };
    case 'G': return { touches: [n[0], n[1]], directed: [{ from: [n[2], n[3]], to: [n[0], n[1]] }] };
    case 'F': return { touches: [n[0], n[1]], directed: [{ from: [], fromBranch: lc(part.tail[0] ?? ''), to: [n[0], n[1]] }] };
    case 'B':
      if (/^\s*v\s*=/i.test(part.tail.join(' '))) return { driver: { pos: n[0], neg: n[1], kind: 'B', ctrlNodes: exprNodes() } };
      return { touches: [n[0], n[1]], directed: [{ from: exprNodes(), to: [n[0], n[1]] }] };
    case 'S': return { group: [n[0], n[1]], directed: [{ from: [n[2], n[3]], to: [n[0], n[1]] }] };
    case 'W': return { group: [n[0], n[1]], directed: [{ from: [], fromBranch: lc(part.tail[0] ?? ''), to: [n[0], n[1]] }] };
    case 'M': return { group: [n[0], n[2], n[3]], directed: [{ from: [n[1]], to: [n[0], n[2]] }] };
    case 'K': return { coupling: part.tail.slice(0, 2).map(lc) };
    case 'X': return part.opaque ? { group: [...n] } : { structural: true };
    default: return { group: [...n] };   // Q, J, Z, T and anything unknown: every pin conducts
  }
}

/* ------------------------------------------------------------------------ */
/* 3. The influence graph for one analysis mode                             */
/* ------------------------------------------------------------------------ */

class Graph {
  constructor(parts, conductC, hubNodes) {
    this.parts = parts;
    this.hubNodes = hubNodes;                 // nodes removed as dangling sense stubs
    this.byName = new Map();
    for (const p of parts) { this.byName.set(p.qname, p); if (!p.inBody && !this.byName.has(lc(p.refdes))) this.byName.set(lc(p.refdes), p); }
    this.removed = new Set();                 // parts removed with a hub
    for (const p of parts) if (p.nodes.some(x => hubNodes.has(x))) this.removed.add(p.key);

    const live = parts.filter(p => !this.removed.has(p.key));
    this.live = live;
    const roles = new Map(live.map(p => [p.key, roleOf(p, conductC)]));
    this.roles = roles;

    // Stiff nodes: ground, plus anything an ideal source holds against a stiff node.
    this.drivers = new Map([['0', []]]);      // cut node -> driver parts
    const sources = live.filter(p => roles.get(p.key).driver);
    let changed = true;
    const resolved = new Set();
    while (changed) {
      changed = false;
      for (const s of sources) {
        if (resolved.has(s.key)) continue;
        const { pos, neg } = roles.get(s.key).driver;
        const a = this.drivers.has(pos), b = this.drivers.has(neg);
        if (a === b) continue;
        const other = a ? neg : pos, base = a ? pos : neg;
        this.drivers.set(other, [s, ...this.drivers.get(base)]);
        resolved.add(s.key); changed = true;
      }
    }
    this.unresolvedSources = sources.filter(s => !resolved.has(s.key));

    // Conductive groups -> union-find over non-cut nodes.
    this.parent = new Map();
    const find = x => { let r = x; while (this.parent.get(r) !== r) r = this.parent.get(r); let c = x; while (c !== r) { const nx = this.parent.get(c); this.parent.set(c, r); c = nx; } return r; };
    this.find = find;
    const add = x => { if (!this.parent.has(x)) this.parent.set(x, x); };
    for (const p of live) for (const x of p.nodes) add(x);
    const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) this.parent.set(ra, rb); };
    const groupOf = p => {
      const r = roles.get(p.key);
      let g = r.group ? [...r.group] : [];
      if (this.unresolvedSources.includes(p)) g = [r.driver.pos, r.driver.neg];   // floating source: a wire
      if (r.coupling) for (const name of r.coupling) { const q = this.byName.get(name); if (q) g.push(...q.nodes); }
      return g.filter(x => !this.drivers.has(x));
    };
    this.touchesOf = new Map();               // part key -> nodes it touches (all, cut or not)
    for (const p of live) {
      const r = roles.get(p.key);
      let all = [...(r.group ?? []), ...(r.touches ?? [])];
      if (r.driver) all.push(r.driver.pos, r.driver.neg);
      if (r.coupling) for (const name of r.coupling) { const q = this.byName.get(name); if (q) all.push(...q.nodes); }
      if (r.open || r.structural) all = [];
      this.touchesOf.set(p.key, all);
      const g = groupOf(p);
      for (let i = 1; i < g.length; i++) union(g[0], g[i]);
    }
    // Components: parts touching a non-cut node of the component.
    this.compParts = new Map();
    this.compNodes = new Map();
    for (const x of this.parent.keys()) if (!this.drivers.has(x)) {
      const c = find(x);
      (this.compNodes.get(c) ?? this.compNodes.set(c, new Set()).get(c)).add(x);
    }
    this.partsAt = new Map();                 // node -> conducting parts touching it
    for (const p of live) for (const x of new Set(this.touchesOf.get(p.key))) {
      (this.partsAt.get(x) ?? this.partsAt.set(x, []).get(x)).push(p);
      if (!this.drivers.has(x)) {
        const c = find(x);
        (this.compParts.get(c) ?? this.compParts.set(c, new Set()).get(c)).add(p);
      }
    }
    // Directed edges, indexed by the component they feed.
    this.dirIn = new Map();
    for (const p of live) for (const e of roles.get(p.key).directed ?? []) {
      for (const to of e.to) {
        if (this.drivers.has(to) || !this.parent.has(to)) continue;
        const c = find(to);
        (this.dirIn.get(c) ?? this.dirIn.set(c, []).get(c)).push({ part: p, ...e });
      }
    }
  }

  isCut(node) { return this.drivers.has(node); }

  /** Every part and node whose change can move the voltage at `start`. */
  influenceOfNode(start, acc = { parts: new Set(), nodes: new Set() }, seen = new Set()) {
    const stack = [start];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      acc.nodes.add(x);
      if (this.isCut(x)) {
        for (const d of this.drivers.get(x)) {
          acc.parts.add(d.key);
          const dr = this.roles.get(d.key).driver;
          for (const c of dr.ctrlNodes ?? []) stack.push(c);
          if (dr.ctrlBranch) this.influenceOfBranch(this.byName.get(dr.ctrlBranch), acc, seen);
        }
        continue;
      }
      if (!this.parent.has(x)) continue;
      const c = this.find(x);
      if (seen.has('comp:' + c)) continue;
      seen.add('comp:' + c);
      for (const n of this.compNodes.get(c) ?? []) { acc.nodes.add(n); seen.add(n); }
      for (const p of this.compParts.get(c) ?? []) {
        acc.parts.add(p.key);
        for (const n of this.touchesOf.get(p.key)) if (this.isCut(n)) stack.push(n);   // its stiff side: the source moves the load
      }
      for (const e of this.dirIn.get(c) ?? []) {
        acc.parts.add(e.part.key);
        for (const f of e.from) stack.push(f);
        if (e.fromBranch) this.influenceOfBranch(this.byName.get(e.fromBranch), acc, seen);
      }
    }
    return acc;
  }

  /** Every part whose change can move the current through `part`. */
  influenceOfBranch(part, acc = { parts: new Set(), nodes: new Set() }, seen = new Set()) {
    if (!part) return acc;
    acc.parts.add(part.key);
    const role = this.roles.get(part.key);
    const nodes = part.nodes.slice(0, role?.driver || part.type === 'V' ? 2 : part.nodes.length);
    for (const x of nodes) this.influenceOfNode(x, acc, seen);
    if (role?.driver) {
      // A source's current is the sum of everything wired to it.
      for (const x of nodes) for (const q of this.partsAt.get(x) ?? []) {
        if (q === part) continue;
        acc.parts.add(q.key);
        for (const y of this.touchesOf.get(q.key)) this.influenceOfNode(y, acc, seen);
      }
    }
    return acc;
  }
}

/* ------------------------------------------------------------------------ */
/* 4. Observations: what the loaded check suite really measures             */
/* ------------------------------------------------------------------------ */

function observationsOf(suite) {
  const blocks = Array.isArray(suite) ? suite : suite?.blocks ?? [];
  const obs = [];
  const scoped = { nets: new Set(), parts: new Set() };
  blocks.forEach((b, bi) => {
    const rawKind = b.analysis?.kind ?? 'op';
    const analysis = rawKind === 'ac' ? 'ac' : rawKind === 'tran' ? 'tran' : 'op';
    if (b.scope?.kind === 'nets') for (const x of b.scope.nets) scoped.nets.add(lc(x));
    if (Array.isArray(b.scope)) for (const x of b.scope) scoped.parts.add(lc(x));
    for (const a of b.assertions ?? []) {
      const m = a.measurable;
      if (!m?.target) continue;
      obs.push({ block: bi, line: a.line ?? null, check: a.raw, analysis, kind: m.kind, target: String(m.target) });
    }
  });
  return { obs, scoped };
}

/* ------------------------------------------------------------------------ */
/* 5. Dangling sense stubs (CONTROL)                                        */
/* ------------------------------------------------------------------------ */

function findHubs(flat, measuredNodes, probedParts, cutNodes) {
  const hubs = new Map();   // node -> {pins:[...], anchor}
  const byKey = new Map(flat.parts.map(p => [p.key, p]));
  const pinsByNode = new Map();
  for (const pin of flat.pins) (pinsByNode.get(pin.outer) ?? pinsByNode.set(pin.outer, []).get(pin.outer)).push(pin);
  for (const [node, pins] of pinsByNode) {
    if (node === '0' || cutNodes.has(node) || measuredNodes.has(node)) continue;
    const deadEnd = pin => pin.body.every(k => {
      const q = byKey.get(k);
      if (!TWO_TERMINAL_PASSIVE.has(q.type)) return false;
      const other = q.nodes.find(x => x !== node) ?? node;
      return other === node || cutNodes.has(other);
    });
    if (!pins.every(deadEnd)) continue;
    const pinBody = new Set(pins.flatMap(p => p.body));
    const others = flat.parts.filter(p => p.nodes.includes(node) && !pinBody.has(p.key) && p.type !== 'X');
    if (!others.every(p => TWO_TERMINAL_PASSIVE.has(p.type))) continue;
    if ([...pinBody, ...others.map(p => p.key)].some(k => probedParts.has(k))) continue;
    const anchors = new Set();
    for (const p of others) for (const x of p.nodes) if (x !== node && !cutNodes.has(x)) anchors.add(x);
    if (anchors.size > 1) continue;     // a through path, not a stub
    hubs.set(node, { pins, anchors: [...anchors], parts: [...pinBody, ...others.map(p => p.key)] });
  }
  return hubs;
}

/* ------------------------------------------------------------------------ */
/* 6. The report                                                            */
/* ------------------------------------------------------------------------ */

/**
 * @param {import('./netlist.mjs').Netlist} netlist  parsed design
 * @param {{blocks: object[]}|object[]} suite        as returned by engine/cli.mjs loadSuite
 * @param {Array<string|{id?:string,text:string,nets?:string[],parts?:string[]}>} [requirements]
 */
export function analyseCoverage(netlist, suite, requirements = []) {
  const flat = flatten(netlist);
  const { obs, scoped } = observationsOf(suite);
  const parts = flat.parts;
  const byQ = new Map(parts.map(p => [p.qname, p]));
  const byBare = new Map();
  for (const p of parts) { const k = lc(p.refdes); (byBare.get(k) ?? byBare.set(k, []).get(k)).push(p); }
  const nodeNames = new Map();     // lowercase -> display
  for (const p of parts) for (const n of p.nodes) if (n !== '0' && !nodeNames.has(n)) nodeNames.set(n, n);
  const resolvePart = name => byQ.get(lc(name)) ?? (byBare.get(lc(name)) ?? [])[0] ?? null;

  // Resolve every observation to nodes/parts. Unresolvable targets are findings, not coverage.
  const resolved = [];
  const checks = [];
  for (const o of obs) {
    const r = { ...o, node: null, part: null, problem: null };
    if (o.kind === 'voltage' || o.kind === 'corner' || o.kind === 'frequency') {
      const n = isGround(o.target) ? '0' : lc(o.target);
      if (n === '0') r.problem = 'measures ground, which is 0 V by definition; it can detect nothing';
      else if (!nodeNames.has(n)) r.problem = `net "${o.target}" is not in the design`;
      else r.node = n;
    } else {
      const p = resolvePart(o.target);
      if (!p) r.problem = `part "${o.target}" is not in the design`;
      else r.part = p;
    }
    resolved.push(r);
  }
  const measuredNodes = new Set(resolved.filter(r => r.node).map(r => r.node));
  const probedParts = new Set(resolved.filter(r => r.part).map(r => r.part.key));

  // Stiff nodes are mode independent (ideal sources are never open): compute once.
  const g0 = new Graph(parts, false, new Set());
  const cutNodes = new Set(g0.drivers.keys());
  const hubs = findHubs(flat, measuredNodes, probedParts, cutNodes);
  const hubNodes = new Set(hubs.keys());

  const modes = { static: new Graph(parts, false, hubNodes), dynamic: new Graph(parts, true, hubNodes) };
  const modeOf = a => (a === 'op' ? 'static' : 'dynamic');

  const influence = (graphs, r) => {
    const g = graphs[modeOf(r.analysis)];
    if (r.node) return g.influenceOfNode(r.node);
    if (r.part) return g.influenceOfBranch(g.byName.get(r.part.qname) ?? r.part);
    return { parts: new Set(), nodes: new Set() };
  };

  const partWhy = new Map();       // key -> [{how, check}]
  const nodeWhy = new Map();
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  for (const r of resolved) {
    const inf = influence(modes, r);
    const tag = { check: r.check, analysis: r.analysis };
    for (const k of inf.parts) push(partWhy, k, { how: r.part && r.part.key === k ? 'probed' : 'influence', ...tag });
    for (const x of inf.nodes) push(nodeWhy, x, { how: r.node === x ? 'measured' : 'influence', ...tag });
    if (r.part) for (const x of new Set(r.part.nodes)) if (!nodeWhy.has(x)) push(nodeWhy, x, { how: 'influence', ...tag });
  }
  const dynParts = new Set(), dynNodes = new Set();
  for (const r of resolved) { const inf = influence(modes, { ...r, analysis: 'tran' }); inf.parts.forEach(k => dynParts.add(k)); inf.nodes.forEach(k => dynNodes.add(k)); }

  // Checks that cannot detect any part fault.
  for (const r of resolved) {
    const row = { check: r.check, line: r.line, analysis: r.analysis, measures: `${r.kind}(${r.target})`, status: 'ok', reason: null, parts_that_can_move_it: null };
    if (r.problem) { row.status = 'unresolved'; row.reason = r.problem; }
    else {
      const inf = influence(modes, r);
      const sourcesOnly = r.node && modes.static.isCut(r.node);
      const real = [...inf.parts].filter(k => { const p = parts.find(q => q.key === k); return p && !['V', 'E', 'H', 'B'].includes(p.type); });
      row.parts_that_can_move_it = real.length;
      if (sourcesOnly) { row.status = 'blind'; row.reason = `net ${r.target} is held by an ideal source; only that source can move it, so no passive part fault is visible here`; }
    }
    checks.push(row);
  }

  // ---- parts -------------------------------------------------------------
  const partRows = new Map();
  const childParts = new Map(parts.map(p => [p.key, p.children]));
  const hubOfPart = new Map();
  for (const [node, h] of hubs) for (const k of h.parts) hubOfPart.set(k, { node, ...h });
  const covered = new Set(partWhy.keys());
  const dedupeWhy = list => { const seen = new Set(); return list.filter(w => { const k = `${w.how}|${w.check}`; if (seen.has(k)) return false; seen.add(k); return true; }); };

  const rowFor = p => {
    if (p.type === 'X') {
      if (p.opaque) return { status: 'unknown', reason_code: 'opaque_subcircuit', reason: `subcircuit instance with no usable definition; its pins are treated as conducting, so it is never reported as uncovered` };
      const kids = p.children.map(k => partRows.get(k) ?? rowFor(parts.find(q => q.key === k)));
      const any = kids.find(k => k.status === 'covered');
      return any ? { status: 'covered', via: 'influence', evidence: [{ how: 'influence', check: `through ${any.refdes}`, analysis: null }] }
        : { status: 'uncovered', reason_code: 'no_internal_part_reaches_a_measurement', reason: `no part inside ${p.refdes} can move anything a check measures` };
    }
    const why = partWhy.get(p.key);
    if (why) {
      const ev = dedupeWhy(why);
      return { status: 'covered', via: ev.some(w => w.how === 'probed') ? 'probed' : 'influence', evidence: ev };
    }
    const hub = hubOfPart.get(p.key);
    if (hub) {
      const pin = hub.pins[0];
      return { status: 'uncovered', reason_code: 'dangling_control',
        reason: `net ${hub.node} feeds only pin ${pin.port.toUpperCase()} of ${pin.instRefdes}, which reads nothing (inside it ends only in passives to ideally driven nets); this part belongs to a sense/feedback stub ${hub.anchors[0] ? `hanging off net ${hub.anchors[0]}` : 'connected to nothing else'} that no check can see (an open loop)${hub.anchors[0] ? '; it can only load a measured node' : ''}` };
    }
    if (p.type === 'C' && dynParts.has(p.key)) return { status: 'uncovered', reason_code: 'capacitor_open_at_dc', reason: 'a capacitor can move a measured node only in ac/tran, and every check that reaches it runs at op/dc, where a capacitor is an open circuit' };
    const touching = p.nodes.filter(x => x !== '0');
    if (!['V', 'I', 'E', 'G', 'F', 'H', 'B'].includes(p.type) && p.nodes.every(x => cutNodes.has(x))) {
      return { status: 'uncovered', reason_code: 'only_between_ideal_nets', reason: 'every terminal is on ground or a net an ideal source holds, so it cannot change any node voltage; only a probe of a source current could see it, and none does' };
    }
    if (['V', 'I', 'E', 'G', 'F', 'H', 'B'].includes(p.type)) return { status: 'uncovered', reason_code: 'source_not_observed', reason: 'no measured quantity depends on this source' };
    return { status: 'uncovered', reason_code: 'no_path_to_a_measurement', reason: touching.length ? `no conductive path (in the analyses the checks use) from nets ${touching.join(', ')} to any measured net or probed part` : 'connected to nothing' };
  };
  const out = { parts: [] };
  // children first so instance rows can use them
  for (const p of parts) if (p.type !== 'X') partRows.set(p.key, { ...rowFor(p), refdes: p.refdes });
  const merged = new Map();
  for (const p of parts) {
    const row = p.type === 'X' ? { ...rowFor(p), refdes: p.refdes } : partRows.get(p.key);
    const id = p.id;                           // one row per source line
    const prev = merged.get(id);
    const entry = { refdes: p.refdes, type: p.type, line: Number(id.slice(1)) + 1, in_subcircuit: p.inBody, instances: 1, ...row };
    if (!prev) { merged.set(id, entry); continue; }
    prev.instances += 1;
    if (row.status === 'covered' && prev.status !== 'covered') Object.assign(prev, entry, { instances: prev.instances });
  }
  out.parts = [...merged.values()];

  // ---- nets --------------------------------------------------------------
  const netRows = [];
  for (const [n] of nodeNames) {
    const why = nodeWhy.get(n);
    const row = { net: n, internal: n.includes('.'), stiff: cutNodes.has(n) };
    if (why) {
      const ev = dedupeWhy(why);
      Object.assign(row, { status: 'covered', via: ev.some(w => w.how === 'measured') ? 'measured' : 'influence', evidence: ev.slice(0, 5) });
    } else if (hubs.has(n)) {
      const h = hubs.get(n);
      Object.assign(row, { status: 'uncovered', reason_code: 'dangling_control', reason: `feeds only pin ${h.pins[0].port.toUpperCase()} of ${h.pins[0].instRefdes}, which reads nothing, ${h.anchors[0] ? `plus passives to net ${h.anchors[0]}` : 'and nothing else'}: an open feedback/sense loop` });
    } else if (cutNodes.has(n)) {
      Object.assign(row, { status: 'uncovered', reason_code: 'ideal_net_unobserved', reason: 'held by an ideal source, and nothing a check measures depends on it' });
    } else if (dynNodes.has(n)) {
      Object.assign(row, { status: 'uncovered', reason_code: 'capacitor_open_at_dc', reason: 'reached only through a capacitor, and every check that would reach it runs at op/dc' });
    } else {
      Object.assign(row, { status: 'uncovered', reason_code: 'no_path_to_a_measurement', reason: 'no conductive path (in the analyses the checks use) to any measured net or probed part' });
    }
    if (row.status === 'uncovered' && scoped.nets.has(n)) row.named_in_scope_only = true;
    netRows.push(row);
  }

  // ---- requirements ------------------------------------------------------
  const netSet = new Set(nodeNames.keys());
  const partNames = new Set([...byBare.keys(), ...byQ.keys()]);
  const reqRows = (requirements ?? []).map((r, i) => {
    const item = typeof r === 'string' ? { text: r } : r;
    const id = item.id ?? `REQ-${i + 1}`;
    const names = new Set(), nets = new Set(), pts = new Set();
    const addNet = x => { const k = lc(x); if (netSet.has(k)) nets.add(k); };
    const addPart = x => { const p = resolvePart(x); if (p) pts.add(p); };
    for (const x of item.nets ?? []) addNet(x);
    for (const x of item.parts ?? []) addPart(x);
    for (const tok of String(item.text).split(/[^A-Za-z0-9_.]+/).filter(Boolean)) {
      const k = lc(tok);
      if (/^\d+$/.test(k)) continue;            // a bare number is never a net name from prose
      if (netSet.has(k)) nets.add(k);
      if (partNames.has(k)) addPart(tok);
    }
    for (const n of nets) names.add(`net ${n}`);
    for (const p of pts) names.add(`part ${p.refdes}`);
    const row = { id, text: item.text, mapped_to: [...names] };
    if (!names.size) return { ...row, status: 'unmapped', reason: 'names no net or part of this design, so it cannot be related to any check by this analysis (not the same as covered)' };
    const direct = [...nets].filter(n => measuredNodes.has(n)).map(n => `V(${n})`).concat([...pts].filter(p => probedParts.has(p.key)).map(p => `I(${p.refdes})`));
    if (direct.length) return { ...row, status: 'covered', via: 'measured', evidence: direct };
    const inf = [...nets].filter(n => nodeWhy.has(n)).map(n => `net ${n}`).concat([...pts].filter(p => partRows.get(p.key)?.status === 'covered' || merged.get(p.id)?.status === 'covered').map(p => `part ${p.refdes}`));
    if (inf.length) return { ...row, status: 'indirect', via: 'influence', evidence: inf, reason: 'nothing it names is measured or probed, but a check reads something these can move' };
    return { ...row, status: 'uncovered', reason: 'no check measures, probes or can be moved by anything this requirement names' };
  });

  const count = (rows, f) => rows.filter(f).length;
  const summary = {
    parts: { total: out.parts.length, covered: count(out.parts, r => r.status === 'covered'), uncovered: count(out.parts, r => r.status === 'uncovered'), unknown: count(out.parts, r => r.status === 'unknown') },
    nets: { total: netRows.length, covered: count(netRows, r => r.status === 'covered'), uncovered: count(netRows, r => r.status === 'uncovered') },
    requirements: { total: reqRows.length, covered: count(reqRows, r => r.status === 'covered'), indirect: count(reqRows, r => r.status === 'indirect'), uncovered: count(reqRows, r => r.status === 'uncovered'), unmapped: count(reqRows, r => r.status === 'unmapped') },
    checks: { total: checks.length, blind: count(checks, c => c.status === 'blind'), unresolved: count(checks, c => c.status === 'unresolved') },
  };
  return {
    schema: COVERAGE_SCHEMA,
    summary,
    parts: out.parts,
    nets: netRows,
    requirements: reqRows,
    checks,
    notes: flat.notes,
    scope_named_not_asserted: { nets: [...scoped.nets].filter(n => !measuredNodes.has(n)), parts: [...scoped.parts].filter(n => { const p = resolvePart(n); return !p || !probedParts.has(p.key); }) },
    limits: [
      'Structural: "covered" means a check can depend on the part, not that its faults leave the check\'s band.',
      'Magnitudes are not modelled: a weak shunt on a strongly driven node is structurally covered.',
      'Unknown element types and opaque subcircuits conduct on every pin (covered claims are weak, uncovered claims are strong).',
      'AC treats every source as able to drive; uic and .param expressions are not modelled.',
    ],
  };
}

/** Plain-text rendering of an analyseCoverage report. */
export function renderCoverage(rep, { title = 'coverage gaps' } = {}) {
  const L = [];
  const s = rep.summary;
  L.push(`${title} (structural, computed before any mutant is run)`);
  L.push(`  parts:  ${s.parts.covered} covered, ${s.parts.uncovered} UNCOVERED, ${s.parts.unknown} unknown of ${s.parts.total}`);
  L.push(`  nets:   ${s.nets.covered} covered, ${s.nets.uncovered} UNCOVERED of ${s.nets.total} (ground excluded)`);
  if (s.requirements.total) L.push(`  requirements: ${s.requirements.covered} covered, ${s.requirements.indirect} indirect, ${s.requirements.uncovered} UNCOVERED, ${s.requirements.unmapped} unmapped of ${s.requirements.total}`);
  L.push(`  checks: ${s.checks.total} assertions, ${s.checks.blind} blind, ${s.checks.unresolved} unresolved`);
  const gaps = rep.parts.filter(p => p.status !== 'covered');
  if (gaps.length) { L.push('', 'Parts no check can see:'); for (const p of gaps) L.push(`  ${p.refdes.padEnd(10)} ${p.status === 'unknown' ? 'UNKNOWN ' : ''}[${p.reason_code}] ${p.reason}`); }
  const ng = rep.nets.filter(n => n.status !== 'covered');
  if (ng.length) { L.push('', 'Nets no check can see:'); for (const n of ng) L.push(`  ${n.net.padEnd(10)} [${n.reason_code}] ${n.reason}${n.named_in_scope_only ? ' (named in a scope line but never asserted)' : ''}`); }
  const rg = rep.requirements.filter(r => r.status !== 'covered');
  if (rg.length) { L.push('', 'Requirements:'); for (const r of rg) L.push(`  ${r.id} ${r.status.toUpperCase()}: ${r.text} -- ${r.reason}`); }
  const cb = rep.checks.filter(c => c.status !== 'ok');
  if (cb.length) { L.push('', 'Checks that cannot detect a part fault:'); for (const c of cb) L.push(`  ${c.check} -- ${c.reason}`); }
  if (rep.notes.length) { L.push('', 'Notes:', ...rep.notes.map(n => `  ${n}`)); }
  L.push('', 'Limits: ' + rep.limits.join(' '));
  return L.join('\n');
}

// Pure mutation operators.
//
// An operator never returns a mutated netlist. It returns a PATCH: a list of line-level
// changes plus metadata. `applyPatch` is the only way to turn a patch into a netlist, and
// it re-parses its own output, so an operator can never produce an unparseable netlist
// silently - a broken patch throws PatchError instead.
//
// Every operator is deterministic: candidates are produced in a stable sorted order and
// each one carries a stable id and a human description.

import { parseNetlist, parseValue, formatValue, renderElement, isGround, NetlistParseError } from './netlist.mjs';

export class PatchError extends Error {
  constructor(message, patch, cause) {
    super(message);
    this.name = 'PatchError';
    this.patch = patch;
    this.cause = cause;
  }
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const sorted = list => [...list].sort(byKey);
const num = comp => parseValue(comp.tail[0]);

/** Build the replacement text for an element whose nodes and/or tail changed. */
const elementText = (comp, { nodes = comp.nodes, tail = comp.tail } = {}) =>
  renderElement({ indent: comp.indent, refdes: comp.refdes, nodes, tail });

const patch = ({ operator, target, description, changes, meta = {} }) =>
  ({ operator, target, description, layer: 'netlist', changes, meta });

const replace = (comp, text) => ({ type: 'replace', line_id: comp.id, text });
const remove = comp => ({ type: 'remove', line_id: comp.id });
const insertAfter = (line, text) => ({ type: 'insert_after', line_id: line.id, text });

/**
 * Apply a patch and re-parse the result.
 * @returns {{netlist: import('./netlist.mjs').Netlist, text: string}}
 */
export function applyPatch(netlist, p) {
  const byId = new Map(netlist.lines.map(l => [l.id, l]));
  for (const c of p.changes) {
    if (!byId.has(c.line_id)) throw new PatchError(`patch ${p.operator} targets unknown line ${c.line_id}`, p);
  }
  const out = [];
  for (const line of netlist.lines) {
    const changes = p.changes.filter(c => c.line_id === line.id);
    const replaced = changes.find(c => c.type === 'replace');
    const removed = changes.find(c => c.type === 'remove');
    if (removed && replaced) throw new PatchError(`patch ${p.operator} both replaces and removes ${line.id}`, p);
    if (replaced) out.push(replaced.text);
    else if (!removed) out.push(line.raw === undefined ? '' : (line.dirty ? renderElement(line) : line.raw));
    for (const c of changes) if (c.type === 'insert_after') out.push(c.text);
  }
  const text = out.join(netlist.eol) + (netlist.trailingNewline ? netlist.eol : '');
  try {
    return { netlist: parseNetlist(text), text };
  } catch (err) {
    if (err instanceof NetlistParseError) {
      throw new PatchError(`patch ${p.operator} on ${p.target} produced an unparseable netlist: ${err.message}`, p, err);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

const DRIFTABLE = new Set(['R', 'C', 'L']);

const valueDrift = percent => ({
  id: `value_drift_${percent}`,
  title: `Value drift ${percent}%`,
  summary: `A passive component's value is ${percent}% above nominal - the kind of drift tolerance, temperature or a wrong reel gives you.`,
  candidates(nl) {
    return sorted(nl.components
      .filter(c => DRIFTABLE.has(c.type) && num(c))
      .map(c => ({ key: c.refdes, comp: c })));
  },
  build(nl, cand) {
    const v = num(cand.comp);
    const next = v.number * (1 + percent / 100);
    const tail = [formatValue(next, v), ...cand.comp.tail.slice(1)];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} value drifted +${percent}% (${v.text} -> ${tail[0]})`,
      changes: [replace(cand.comp, elementText(cand.comp, { tail }))],
      meta: { kind: 'value_change', relative: percent / 100, from: v.number, to: next },
    });
  },
});

/** Resistors from a rail to a non-ground node: pull-ups (and pull-downs' mirror image). */
const pullupCandidates = nl => {
  const rails = nl.rails();
  return sorted(nl.components
    .filter(c => c.type === 'R' && num(c))
    .filter(c => c.nodes.some(n => rails.has(n)) && c.nodes.some(n => !rails.has(n) && !isGround(n)))
    .map(c => ({ key: c.refdes, comp: c })));
};

const pullupRemoved = {
  id: 'pullup_removed',
  title: 'Pull-up removed',
  summary: 'The pull-up resistor is gone; the node floats. Checks that only look at a driven state never notice.',
  candidates: pullupCandidates,
  build(nl, cand) {
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} (pull-up to ${[...nl.rails()].find(r => cand.comp.nodes.includes(r))}) removed`,
      changes: [remove(cand.comp)],
      meta: { kind: 'remove' },
    });
  },
};

const pullupX10 = {
  id: 'pullup_x10',
  title: 'Pull-up x10',
  summary: 'The pull-up is ten times weaker than intended - still works on the bench, fails on a noisy or leaky node.',
  candidates: pullupCandidates,
  build(nl, cand) {
    const v = num(cand.comp);
    const tail = [formatValue(v.number * 10, v), ...cand.comp.tail.slice(1)];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} pull-up weakened x10 (${v.text} -> ${tail[0]})`,
      changes: [replace(cand.comp, elementText(cand.comp, { tail }))],
      meta: { kind: 'value_change', relative: 9, from: v.number, to: v.number * 10 },
    });
  },
};

const bypassCapRemoved = {
  id: 'bypass_cap_removed',
  title: 'Bypass capacitor removed',
  summary: 'A decoupling capacitor between a rail and ground is gone. A DC-only check cannot see this at all.',
  candidates(nl) {
    const rails = nl.rails();
    return sorted(nl.components
      .filter(c => c.type === 'C')
      .filter(c => c.nodes.some(isGround) && c.nodes.some(n => rails.has(n)))
      .map(c => ({ key: c.refdes, comp: c })));
  },
  build(nl, cand) {
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} bypass capacitor removed`,
      changes: [remove(cand.comp)],
      meta: { kind: 'remove' },
    });
  },
};

const DIVIDER_SHIFT = 0.25;

const dividerRatioOff = {
  id: 'divider_ratio_off',
  title: 'Divider ratio off',
  summary: `The bottom leg of a resistor divider is ${DIVIDER_SHIFT * 100}% off, so the divided voltage is wrong.`,
  candidates(nl) {
    const rails = nl.rails();
    const out = [];
    for (const mid of nl.nodes()) {
      if (isGround(mid) || rails.has(mid)) continue;
      const touching = nl.connections(mid).filter(c => c.type === 'R' && num(c));
      const top = touching.find(c => c.nodes.some(n => rails.has(n)));
      const bottom = touching.find(c => c !== top && c.nodes.some(isGround));
      if (top && bottom) out.push({ key: mid, mid, top, comp: bottom });
    }
    return sorted(out);
  },
  build(nl, cand) {
    const v = num(cand.comp);
    const next = v.number * (1 + DIVIDER_SHIFT);
    const tail = [formatValue(next, v), ...cand.comp.tail.slice(1)];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `divider at ${cand.mid}: ${cand.comp.refdes} +${DIVIDER_SHIFT * 100}% (${v.text} -> ${tail[0]}), ratio against ${cand.top.refdes} shifted`,
      changes: [replace(cand.comp, elementText(cand.comp, { tail }))],
      meta: { kind: 'value_change', relative: DIVIDER_SHIFT, from: v.number, to: next },
    });
  },
};

const openConnection = {
  id: 'open_connection',
  title: 'Open connection',
  summary: 'One terminal is left unconnected - a cold joint, a missing via, a net that was never routed.',
  candidates(nl) {
    const out = [];
    for (const c of nl.components) {
      if (c.nodes.length < 2) continue;
      const i = c.nodes.findIndex(n => !isGround(n));
      const slot = i === -1 ? 0 : i;
      out.push({ key: `${c.refdes}.${slot}`, comp: c, slot });
    }
    return sorted(out);
  },
  build(nl, cand) {
    const nodes = [...cand.comp.nodes];
    const was = nodes[cand.slot];
    nodes[cand.slot] = `NC_${cand.comp.refdes}_${cand.slot}`;
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} terminal ${cand.slot + 1} opened (was on ${was}, now dangling ${nodes[cand.slot]})`,
      changes: [replace(cand.comp, elementText(cand.comp, { nodes }))],
      meta: { kind: 'topology' },
    });
  },
};

const SHORT_VALUE = '1m';

const outputShort = {
  id: 'output_short',
  title: 'Output short',
  summary: 'An internal node is shorted to ground - solder bridge, pinched wire, probe slip.',
  candidates(nl) {
    const rails = nl.rails();
    return sorted(nl.nodes()
      .filter(n => !isGround(n) && !rails.has(n) && nl.connections(n).length >= 2)
      .map(n => ({ key: n, node: n })));
  },
  build(nl, cand) {
    const last = nl.components[nl.components.length - 1];
    const text = `RSHORT_${cand.node} ${cand.node} 0 ${SHORT_VALUE}`;
    return patch({
      operator: this.id, target: cand.node,
      description: `node ${cand.node} shorted to ground through ${SHORT_VALUE}ohm`,
      changes: [insertAfter(last, text)],
      meta: { kind: 'topology' },
    });
  },
};

const diodeFlip = {
  id: 'diode_flip',
  title: 'Diode flipped',
  summary: 'A diode is fitted backwards. Reverse protection and rectification quietly stop working.',
  candidates(nl) {
    return sorted(nl.components.filter(c => c.type === 'D').map(c => ({ key: c.refdes, comp: c })));
  },
  build(nl, cand) {
    const nodes = [cand.comp.nodes[1], cand.comp.nodes[0], ...cand.comp.nodes.slice(2)];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} reversed (anode/cathode swapped: ${cand.comp.nodes.join(',')} -> ${nodes.join(',')})`,
      changes: [replace(cand.comp, elementText(cand.comp, { nodes }))],
      meta: { kind: 'topology' },
    });
  },
};

const railSwap = {
  id: 'rail_swap',
  title: 'Rail swap',
  summary: 'Supply and ground are swapped on one part - the classic reversed-footprint failure.',
  candidates(nl) {
    const rails = nl.rails();
    return sorted(nl.components
      .filter(c => c.nodes.some(n => rails.has(n)) && c.nodes.some(isGround))
      .map(c => ({ key: c.refdes, comp: c })));
  },
  build(nl, cand) {
    const rails = nl.rails();
    const nodes = [...cand.comp.nodes];
    const ri = nodes.findIndex(n => rails.has(n));
    const gi = nodes.findIndex(isGround);
    [nodes[ri], nodes[gi]] = [nodes[gi], nodes[ri]];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} rail and ground swapped (${cand.comp.nodes[ri]} <-> ${cand.comp.nodes[gi]})`,
      changes: [replace(cand.comp, elementText(cand.comp, { nodes }))],
      meta: { kind: 'topology' },
    });
  },
};

const pinSwap = {
  id: 'pin_swap',
  title: 'Pin swap',
  summary: 'Two pins of a multi-terminal part are swapped - a footprint or symbol pin-numbering mistake.',
  candidates(nl) {
    const out = [];
    for (const c of nl.components) {
      if (c.nodes.length < 3) continue;
      if (c.nodes[0] === c.nodes[1]) continue;
      out.push({ key: `${c.refdes}.0-1`, comp: c, a: 0, b: 1 });
    }
    return sorted(out);
  },
  build(nl, cand) {
    const nodes = [...cand.comp.nodes];
    [nodes[cand.a], nodes[cand.b]] = [nodes[cand.b], nodes[cand.a]];
    return patch({
      operator: this.id, target: cand.comp.refdes,
      description: `${cand.comp.refdes} pins ${cand.a + 1} and ${cand.b + 1} swapped (${cand.comp.nodes.join(',')} -> ${nodes.join(',')})`,
      changes: [replace(cand.comp, elementText(cand.comp, { nodes }))],
      meta: { kind: 'topology' },
    });
  },
};

export const OPERATORS = [
  valueDrift(5), valueDrift(10), valueDrift(20),
  pullupRemoved, pullupX10, bypassCapRemoved, dividerRatioOff,
  openConnection, outputShort, diodeFlip, railSwap, pinSwap,
];

export const operatorById = id => OPERATORS.find(o => o.id === id) ?? null;

const safeId = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');

/**
 * Generate every mutant the given operators can make, in a deterministic order.
 * Each mutant carries its patch, the applied netlist and a stable mutant_id.
 * @returns {Array<{mutant_id,operator,target,description,layer,origin,patch,netlist,text}>}
 */
export function generateMutants(netlist, { operators = OPERATORS, limit = Infinity } = {}) {
  const mutants = [];
  for (const op of operators) {
    for (const cand of op.candidates(netlist)) {
      if (mutants.length >= limit) return mutants;
      const p = op.build(netlist, cand);
      const applied = applyPatch(netlist, p); // throws PatchError if the result will not parse
      mutants.push({
        mutant_id: `M-${safeId(op.id)}-${safeId(cand.key)}`,
        operator: op.id,
        operator_title: op.title,
        target: p.target,
        description: p.description,
        layer: p.layer,
        origin: 'fixed',
        patch: p,
        netlist: applied.netlist,
        text: applied.text,
      });
    }
  }
  return mutants;
}

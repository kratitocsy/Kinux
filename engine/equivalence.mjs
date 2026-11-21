// Conservative detection of equivalent mutants.
//
// An "equivalent mutant" is a mutant that cannot possibly be caught, because it
// is not a different circuit: the text changed but the design did not, or it
// changed by less than the simulator can resolve. Contract rule 6 keeps
// equivalents out of the score entirely, so marking a mutant equivalent REMOVES
// it from the denominator. That makes a false positive here the most dangerous
// mistake in the whole engine: it is how a tool quietly flatters itself, by
// declaring the mutants nobody caught to be mutants nobody could catch.
//
// Therefore: WHEN UNSURE, NOT EQUIVALENT. Only two facts are accepted as proof.
//
//   1. TEXTUAL. After normalisation the mutant netlist is the same netlist.
//      Normalisation drops comments, blank lines, indentation and letter case,
//      and sorts the body, because SPICE does not care about the order of
//      element lines. It never rewrites a value, a node name or a refdes.
//
//   2. BELOW RESOLUTION. The mutant only changed a component value, and it
//      changed it by less than RELATIVE_RESOLUTION. That is 1e-6: three orders
//      of magnitude below ngspice's default reltol (1e-3), and below the ~7
//      significant figures ngspice prints, so no measurement could separate the
//      two circuits even in principle.
//
// Everything else is NOT equivalent, including cases a human can see are
// equivalent. A removed bypass capacitor that no DC check could ever notice is
// a SURVIVOR, not an equivalent: the check suite genuinely failed to cover it.
// A rail/ground swap on a symmetric two-terminal part (`C1 vcc 0` -> `C1 0 vcc`)
// really is the same circuit, but proving that needs a topology comparison that
// knows which parts are symmetric, which this module does not do. Such a mutant
// is reported as a survivor. That is the safe direction: it lowers the score.

import { parseValue } from './netlist.mjs';

/** A value change smaller than this (relative) is below anything ngspice resolves. */
export const RELATIVE_RESOLUTION = 1e-6;
/** Absolute floor, for values at or near zero. Farads/henries make this tiny. */
export const ABSOLUTE_RESOLUTION = 1e-18;

/** Reasons this module is willing to give. Nothing else marks a mutant equivalent. */
export const EQUIVALENCE_REASONS = Object.freeze({
  TEXTUAL: 'textually_identical',
  BELOW_RESOLUTION: 'value_below_simulator_resolution',
});

const stripComment = line => {
  const t = line.trim();
  if (t.startsWith('*')) return '';
  // `;` starts a trailing comment in ngspice. A bare `;` line is a comment too.
  const i = t.indexOf(';');
  return (i === -1 ? t : t.slice(0, i)).trim();
};

/**
 * Canonical form of a netlist, for comparison only. Never fed to a simulator.
 * The title line (SPICE line 1) is kept in place; the body is sorted, because
 * the order of element lines does not change the circuit.
 * @param {string} text
 * @returns {string}
 */
export function normaliseNetlist(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const title = (lines[0] ?? '').trim().toLowerCase();
  const body = lines
    .slice(1)
    .map(stripComment)
    .filter(l => l.length > 0)
    .map(l => l.replace(/\s+/g, ' ').toLowerCase())
    .sort();
  return [`.title ${title}`, ...body].join('\n');
}

/** True when two netlists are the same netlist once normalised. */
export const sameNetlist = (a, b) => normaliseNetlist(a) === normaliseNetlist(b);

/**
 * Is this value change below what the simulator could ever resolve?
 * @param {number} from @param {number} to
 */
export function belowResolution(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const delta = Math.abs(to - from);
  if (delta === 0) return true;
  if (delta <= ABSOLUTE_RESOLUTION) return true;
  const scale = Math.max(Math.abs(from), Math.abs(to));
  if (scale === 0) return false;
  return delta / scale < RELATIVE_RESOLUTION;
}

/**
 * Decide whether a mutant is equivalent to the design it came from.
 *
 * @param {string} baselineText the unmutated netlist
 * @param {{text: string, patch?: {meta?: object}}} mutant from generateMutants()
 * @returns {{equivalent: boolean, reason: string|null, detail: string|null}}
 */
export function classifyEquivalence(baselineText, mutant) {
  const no = { equivalent: false, reason: null, detail: null };
  if (!mutant || typeof mutant.text !== 'string') return no;

  if (sameNetlist(baselineText, mutant.text)) {
    return {
      equivalent: true,
      reason: EQUIVALENCE_REASONS.TEXTUAL,
      detail: 'the mutated netlist is the baseline netlist once comments, blank lines, indentation, case and line order are normalised',
    };
  }

  const meta = mutant.patch?.meta ?? {};
  if (meta.kind === 'value_change' && belowResolution(meta.from, meta.to)) {
    const rel = Math.abs(meta.to - meta.from) / Math.max(Math.abs(meta.from), Math.abs(meta.to), Number.MIN_VALUE);
    return {
      equivalent: true,
      reason: EQUIVALENCE_REASONS.BELOW_RESOLUTION,
      detail: `value moved from ${meta.from} to ${meta.to}, a relative change of ${rel.toExponential(2)}, below the ${RELATIVE_RESOLUTION} resolution floor`,
    };
  }

  // A value change that re-rendered to the same text is already caught above by
  // the textual rule. Anything topological is never equivalent here.
  return no;
}

/**
 * Mutants that are the same circuit as each other (not as the baseline).
 * Reported for information only: a duplicate is still scored, because one of
 * the pair is a real, uncaught fault and dropping it would flatter the score.
 * @param {Array<{mutant_id: string, text: string}>} mutants
 * @returns {Array<{mutant_id: string, same_as: string}>}
 */
export function findDuplicates(mutants) {
  const seen = new Map();
  const out = [];
  for (const m of mutants ?? []) {
    const key = normaliseNetlist(m.text);
    if (seen.has(key)) out.push({ mutant_id: m.mutant_id, same_as: seen.get(key) });
    else seen.set(key, m.mutant_id);
  }
  return out;
}

/**
 * Sanity helper: does this component value token parse to the number the patch
 * claims it wrote? Used by the runner to notice a patch whose rendered text
 * drifted from its own metadata (a rounding bug would otherwise be invisible).
 */
export function renderedValue(token) {
  const v = parseValue(token);
  return v ? v.number : null;
}

// Hand-applied faults for the 48 V phase-leg support slice.
//
// Each mutant is one exact textual substitution against
// `phase-leg-support.cir`. They are written as literal find/replace pairs
// rather than generated, so the fault in each mutant is readable in the diff
// and nothing here depends on engine/ (which a concurrent agent owns).
//
// `applyMutant` throws if the `find` text is not present exactly once, so a
// mutant can never silently become a no-op after the netlist is edited.

/**
 * @typedef {{id: string, label: string, kind: string,
 *            find: string, replace: string, rationale: string}} Mutant
 */

/** @type {Mutant[]} */
export const MUTANTS = [
  {
    id: 'M1-rg-10x',
    label: 'series gate resistor 10 Ohm -> 100 Ohm',
    kind: 'value_10x',
    find: 'RG   drv  gate 10',
    replace: 'RG   drv  gate 100',
    rationale:
      'The classic wrong-value fault. Steady-state Vgs barely moves (11.99 V -> ' +
      '11.88 V), so only a timing assertion can see it.',
  },
  {
    id: 'M2-cfb-removed',
    label: 'bus feedback decoupling capacitor removed',
    kind: 'component_removed',
    find: 'CFB  fb   0    100n',
    replace: '* CFB  fb   0    100n   <- MUTANT: capacitor removed',
    rationale:
      'A capacitor is invisible to a DC operating point. Only a transient that ' +
      'looks at the node before it has settled can tell it is gone.',
  },
  {
    id: 'M3-divider-ratio',
    label: 'feedback divider bottom leg 4.99k -> 49.9k',
    kind: 'divider_ratio',
    find: 'RFB2 fb   0    4.99k',
    replace: 'RFB2 fb   0    49.9k',
    rationale:
      'Divider ratio wrong by 10x: the ADC input goes to 15.98 V on a 3.3 V pin. ' +
      'A liveness check on the same net still passes.',
  },
  {
    id: 'M4-shunt-10x',
    label: 'current-sense shunt 2 mOhm -> 20 mOhm',
    kind: 'value_10x',
    find: 'RSH  sh   0    2m',
    replace: 'RSH  sh   0    20m',
    rationale:
      'Drives the sense output to 8 V and the shunt to 8 W. Large enough that even ' +
      'a loose ADC-range check catches it; included on purpose as the control case.',
  },
  {
    id: 'M5-cf-removed',
    label: 'sense anti-alias filter capacitor removed',
    kind: 'component_removed',
    find: 'CF   adc_i 0   100n',
    replace: '* CF   adc_i 0   100n   <- MUTANT: capacitor removed',
    rationale:
      'Same blind spot as M2, on the current-sense chain. Note that it turns the ' +
      'corner() assertion into NOT_CHECKED, not FAIL: with no pole there is no ' +
      '-3 dB point to find, and NOT_CHECKED is never a catch (contract rule 1).',
  },
  {
    id: 'M6-sense-gain',
    label: 'current-sense amplifier gain 20 V/V -> 2 V/V',
    kind: 'gain_scale',
    find: 'EAMP amp  0    sh 0 20',
    replace: 'EAMP amp  0    sh 0 2',
    rationale:
      'Scale error in the sense chain: 20 A now reads as 2 A. Everything stays ' +
      'inside every plausible sanity range, so only an assertion on the expected ' +
      'value catches it.',
  },
];

/**
 * @param {string} netlist baseline netlist text
 * @param {Mutant} mutant
 * @returns {string} the mutated netlist
 */
export function applyMutant(netlist, mutant) {
  const parts = netlist.split(mutant.find);
  if (parts.length !== 2) {
    throw new Error(
      `mutant ${mutant.id}: expected exactly one occurrence of ${JSON.stringify(mutant.find)}, ` +
        `found ${parts.length - 1}`,
    );
  }
  return parts.join(mutant.replace);
}

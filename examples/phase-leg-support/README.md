# 48 V phase-leg support slice

A small, honestly-labelled demo design for Kinux: the circuit that the mutation
engine, the check suites and the trust score all run against.

**Simulator:** ngspice 42 (`/usr/bin/ngspice`), built-in primitives only.
**Files:** `phase-leg-support.cir` (design), `checks-thorough.md` /
`checks-weak.md` (two check suites in Kinux's own Simulation-block grammar),
`mutants.mjs` (six hand-applied faults), `expected.md` (prediction, then
measurement), `suites.mjs` (loader).

## What this circuit is

Three support networks that sit around **one low-side switch of one phase leg**
of a 48 V three-phase inverter:

1. **Low-side gate drive network** - a 12 V driver output, a 10 Ohm series gate
   resistor, a 10 kOhm gate-source pulldown, and a lumped 4.7 nF gate
   capacitance. The switching node of interest is `gate`.
2. **Low-side shunt current sense** - a 2 mOhm shunt in the return path, a
   gain-20 current-sense amplifier, and a 1 kOhm / 100 nF anti-alias filter
   feeding an ADC input (`adc_i`).
3. **DC-link voltage feedback** - a 100 kOhm / 4.99 kOhm divider off the 48 V
   bus with a 100 nF decoupling capacitor, feeding an ADC input (`fb`).

## What it is a slice of

The plan's eventual target is a real 48 V BLDC driver board (`docs/STEPS.md`
S0.3), which needs sourcing and a licence audit the founder has to sign off.
This circuit is a stand-in for the *support* circuitry of such a board: the
parts you can simulate with built-in primitives, with no vendor SPICE models
and therefore no licence question and no `.include`/`.lib` (both of which
Kinux's sanitizer refuses anyway).

## What it does NOT represent

This is **not a BLDC driver** and must never be described as one. Absent:

- **No MOSFETs.** There is no switch, no R_DS(on), no body diode, no reverse
  recovery, no avalanche. The gate network drives a lumped linear capacitance,
  not a real nonlinear C_iss/C_gd pair, so there is no Miller plateau.
- **No high side.** No bootstrap supply, no level shifter, no dead time, no
  shoot-through mechanism to check.
- **No motor.** No phase inductance, no back-EMF, no commutation, no three
  phases - only one leg's support nets, and the "phase current" is an ideal
  20 A DC current source.
- **No real current-sense amplifier.** `EAMP` is an ideal VCVS (ngspice `E`
  element): infinite bandwidth, no input offset, no common-mode range, no
  supply rails, no output clamp. That is why the sense output reaches 8 V in
  mutant M4 - a real part would clip.
- **No PCB.** No trace resistance or inductance, no shunt parasitic
  inductance, no ground bounce, no layout-dependent sense error.
- **No thermal, no EMC, no efficiency, no protection logic** (no desat, no
  overcurrent comparator, no fault latch).
- **No tolerances or corners.** Nominal values at 27 degC only; no Monte Carlo.

Consequently the pass/fail results here say something true about *these three
networks as modelled* and nothing at all about whether a board built from them
would work.

## Where every component value came from

None of these values are copied from a specific vendor board - there is no
third-party design in this directory, which is the point. They are catalogue
values chosen from stated design rules, listed here so the reasoning is
auditable rather than implied.

| Component | Value | Where it came from |
|---|---|---|
| `VBUS` | 48 V | The target rail in `docs/PLAN.md` / `docs/STEPS.md` S0.3. |
| `VDRV` | 12 V, 20 ns edge | Standard gate-drive rail for a 48 V leg; the 20 ns output edge is a representative figure for a commodity 1.5 A driver. |
| `RG` | 10 Ohm | Chosen so that `RG * CISS` = 47 ns, roughly a tenth of the 500 ns edge budget a 20 kHz PWM leg can afford before switching loss dominates. |
| `CISS` | 4.7 nF | Order of magnitude for a 60-100 V, few-mOhm power MOSFET (Qg ~ 50 nC at 10 V). Lumped and voltage-independent on purpose. |
| `RGS` | 10 kOhm | Conventional gate-source pulldown so the gate is held off while the driver is high-impedance. Large enough not to load the 12 V rail (it costs 0.012 V of Vgs). |
| `ISRC` | 20 A DC (25 A AC) | Representative continuous phase current for a 48 V / ~1 kW drive. The AC magnitude is scaled to 25 A so the sense chain's passband gain is exactly 1.0 V/A-equivalent (0 dB), because `corner()` measures an absolute -3 dB point, not a normalised one. |
| `RSH` | 2 mOhm | 40 mV at 20 A: large enough for a gain-20 amplifier, small enough that I2R = 0.8 W fits a 2 W 2512 shunt. |
| `EAMP` | 20 V/V | The common fixed-gain option on commodity current-sense amplifiers. 20 A -> 0.800 V, which uses a quarter of a 3.3 V ADC span and leaves room for ~80 A of fault current. |
| `RF` / `CF` | 1 kOhm / 100 nF | Anti-alias filter at 1/(2*pi*RF*CF) = 1.59 kHz: about 1/12 of a 20 kHz PWM fundamental, and about 8x above a ~200 Hz current-loop bandwidth. |
| `RFB1` | 100 kOhm | From a quiescent-current budget of under 500 uA off the DC link: 48 V / 105 kOhm = 457 uA. |
| `RFB2` | 4.99 kOhm | Nearest E96 value that puts 48 V at 2.281 V - inside a 3.3 V ADC with headroom up to about 69 V of bus overshoot. |
| `CFB` | 100 nF | With the divider's 4.75 kOhm source impedance this is a 475 us time constant, so a fast bus transient cannot alias into the ADC sampler. |

## The two check suites

Both are Markdown documents parsed by `parseSimulationBlocks` in
`workers/ngspice/assertions.mjs` and compiled to ngspice by
`compileSimulationDeck`. No ngspice is written by hand in this directory
outside the netlist itself.

- `checks-thorough.md` - 15 assertions across four analyses (one `op`, two
  `tran`, one `ac`): rail levels, divider ratio, quiescent and fault currents,
  gate edge timing, peak gate drive current, the two filter time constants and
  the anti-alias corner.
- `checks-weak.md` - 3 loose assertions in a single `op` block. Plausible, not
  sabotaged: it checks the three output nets anyone would name, with bounds
  that read as reasonable sanity limits, and never asks for a transient.

Both suites pass on the baseline. That is required: under contract rule 2 a
mutant counts as caught only if the baseline passes the check and the mutant
fails it, so a check that fails on the baseline can never kill anything.

Measured result: **thorough 6/6 mutants caught, weak 1/6**. See `expected.md`
for the prediction, the measurement and the two places they differed.

## Running it

```
node --test tests/examples.test.mjs
```

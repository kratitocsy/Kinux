# Gate A: the run, written down (R13)

**Status: in progress.** This page records what has been measured, as it is
measured. Numbers here come from runs; anything not yet run says so.

Gate A's pass condition (ROADMAP section 2): scoring runs end to end on 3
boards in under 10 minutes each, with under 30% of survivors equivalent.

Rules applied:

- **Equivalent is strict** (founder's choice, 2026-11-21): the headline counts
  only solver-proven or person-confirmed equivalent survivors. "Benign"
  (requirements still hold) is reported beside it, never inside it.
- **A board whose original design fails its own spec still counts as scored**,
  with the failing check named and the score capped (D13, provisional).
- **Boards are analysed in place and never vendored** (founder's choice): all
  three are CERN-OHL-S. Benches, model files and run outputs live outside the
  repository, in `/home/user/copperheadhq/gate-a/`.

## The boards

| Board | Source | Chosen by |
|---|---|---|
| 555 oscillator | `copperheadhq/copperhead-555-oscillator` | founder (D4) |
| TPS5430 buck converter | `copperheadhq/copperhead-tps5430-buck-converter` | founder (D4) |
| quiet-orbit | `copperheadhq/copperhead-quiet-orbit` | agent-recommended, founder-approved |

## 555 oscillator

**Bench.** KiCad 10 schematic through `engine/kicad-adapter.mjs`; TI's
official TLC555 and SN74LVC1G17 models (unedited), a behavioural LED model
anchored to two BOM numbers, and two bench parts written for the run: the
trimmer at its minimum (end resistance ASSUMED 1 kohm, the SPEC's "up to 1 %")
and the range switch in HI (20 mohm closed, 1 Gohm open). Supply ramped
0 to 5 V in 20 us. ngspice in psa mode (K28). D1, the ESD clamp, is left out:
TI's model file says "CIP: NDA is required", awaiting a person's decision.

**Checkable fraction:** 19 of 20 electrical parts modelled (95%); 2 of 5
semiconductors (the LEDs) are behavioural substitutes, off the timing path.

**Baseline: the original design fails its own spec.** SPEC section 3 requires
the HI range to reach 1 MHz. With the trimmer at its minimum, TI's model
settles at **841 kHz** (measured from 3 ms to 5.5 ms of a 6 ms run; it starts
near 1.03 MHz and drifts down as the CONT capacitor charges). The board's own
README predicted this from its own ngspice study (about 744 kHz worst case).
The frequency check therefore cannot kill any mutant, and the score is capped.

**Mutation run:** in progress (87 mutants, none skipped as equivalent,
`--jobs 4`). Pending: score, interval, survivors, wall time.

## TPS5430 buck converter

Pending. Models exist (TI's TPS5430 model, converted by one line for psa mode;
five of six semiconductors are behavioural stand-ins because the Diodes Inc
site serves a bot challenge). A 20 ms simulation takes 3.5 to 10 minutes
(models agent), so this board is the hardest against the 10-minute limit.

## quiet-orbit

**Bench.** Diotec's 1N4148W model for D1 (official, but from a different maker
than the BOM's Diodes Inc part, whose site serves a bot challenge), Würth's own
PSpice model for the four amber LEDs (exact part number), the polyfuse as its
datasheet R1max of 6 ohm (does not trip), and the ATtiny84A, which has no
model, left out and stood in for by a labelled constant 10 mA load from VCC to
GND (the BOM's reserved budget). psa mode. Checks: the agent-proposed suites,
unedited (all DC).

**Checkable fraction:** 16 of 17 electrical parts (94.1%). The MCU, which
decides everything dynamic on this board, is the one left out.

**Baseline:** all 20 checks pass. LED currents 2.63, 2.97 and 3.31 mA at VBUS
4.75, 5.00 and 5.25 V. Measured design-review finding beside it: the model's
D1 drops 0.913 V at 20 mA, so the BOM's own limit (at most 0.8 V near 20 mA)
is not met, and the Diodes datasheet's own maximum at 10 mA is already
0.855 V: the BOM figure is not backed by any datasheet.

| Suite | Mutants | Score | 95% interval | Wall time (2 jobs, cores shared with the 555 run) |
|---|---|---|---|---|
| thorough | 69 (65 checkable) | **44.6%** (29 killed) | 33.2% to 56.7% | 30 s |
| weak | 69 (63 checkable) | **6.3%** (4 killed) | 2.5% to 15.2% | 24 s |

The intervals do not overlap: on a real board, the weak suite scores lower
than the thorough one, as on the hand-written circuits.

**Cap.** The thorough score is capped at 40% (`run_error`) because one mutant
ended in ERROR: removing R7 leaves its LED and nets as an island, ngspice's
DC solve fails gmin and source stepping, and its "transient op" fallback then
runs past 300 s. That is deterministic, not a machine fault (STATUS K30). The
uncapped score is 44.6%; the capped headline is 40.0%, and both are reported.

**Equivalent fraction (strict).** 36 survivors. Under the suite's own DC
analyses 15 are identical, all capacitor mutants: a DC suite cannot see a
capacitor. Under a power-up transient (`--behaviour "tran 1u 2m uic"`), 12 of
those differ, by up to 100% in charging current, so they are coverage gaps,
not equivalents. **3 of 36 (8.3%) are solver-identical** in every analysis:
each swaps a capacitor's two terminals, and a capacitor has no polarity. The
other 33 are measured differences awaiting a person's judgement
(`gate-a/bench/qo/judging-sheet.md`); 8.3% is a floor.

**Wall time:** 30 s against the 10-minute limit. **Within the limit.**

**What the survivors say about the checks.** Removing an LED's resistor
survives: the check `I(R4) between 2m and 5m` measures the current through R4,
so once R4 is gone it has nothing to measure and is NOT_CHECKED, and nothing
else notices the LED going dark. A probe on a part is blind to that part's own
removal; a check on the LED's anode would catch it (STATUS finding 17).

## Against the pass condition

Pending all three runs. Known already: the 10-minute limit is not met on this
4-core container for the 555 board (one 4 ms simulation takes several minutes
with TI's model, 87 mutants), so Gate A's time condition fails here unless the
work is spread over more cores (K29).

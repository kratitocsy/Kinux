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

Pending. Models are being sourced.

## Against the pass condition

Pending all three runs. Known already: the 10-minute limit is not met on this
4-core container for the 555 board (one 4 ms simulation takes several minutes
with TI's model, 87 mutants), so Gate A's time condition fails here unless the
work is spread over more cores (K29).

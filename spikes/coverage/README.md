# Spike: is the coverage-gap report right?

`engine/coverage.mjs` says, before any mutant runs, which parts and nets no check can see. This
spike runs the real mutation engine (ngspice 42) and counts how often that is true.

```bash
node spikes/coverage/validate.mjs [--fang-dir <dir from spikes/fang/run.sh>] [--json out.json]
```

Ground truth for a part is what the solver did to ALL its mutants: ALL-SURVIVE (>= 1 survived, none
killed) or KILLED-ANY. NOT_CHECKED, ERROR and equivalent mutants are neither; a part with only those is
not evaluable. precision = flagged parts that are ALL-SURVIVE / flagged parts. recall = flagged
parts that are ALL-SURVIVE / ALL-SURVIVE parts. The definition was written before these numbers
and was not changed to improve them.

## Results (2026-11-21, ngspice 42; counts are parts, then nets)

"strict" scores a killed mutant as a kill, as the engine does. "adjusted" does not count a kill by
`open_connection` on a capacitor in an op/dc-only check (see wrong case 1).

| Design / suite | mutants | parts: flagged / ALL-SURVIVE / evaluable | precision (strict) | recall (strict) | precision (adj.) | recall (adj.) |
|---|---|---|---|---|---|---|
| divider-rc / weak | 33 | 6 / 4 / 7 | 4/6 = 67% | 4/4 = 100% | 6/6 = 100% | 6/6 = 100% |
| divider-rc / thorough | 33 | 1 / 0 / 7 | 0/1 = 0% | n/a | 1/1 = 100% | 1/1 = 100% |
| phase-leg / weak | 54 | 3 / 4 / 13 | 0/3 = 0% | 0/4 = 0% | 3/3 = 100% | 3/7 = 43% |
| phase-leg / thorough | 54 | 0 / 1 / 13 | n/a | 0/1 = 0% | n/a | 0/2 = 0% |
| fang rc_filter | 13 | 0 / 1 / 3 | n/a | 0/1 = 0% | n/a | 0/1 = 0% |
| fang buck_regulator | 62 | 5 / 7 / 16 | 5/5 = 100% | 5/7 = 71% | 5/5 = 100% | 5/7 = 71% |
| **pooled (59 part rows)** | | 15 / 17 / 59 | **9/15 = 60%** | **9/17 = 53%** | **15/15 = 100%** | **15/24 = 63%** |

Nets (output_short mutants): pooled 2/2 precision, 2/6 recall. The fang buck's net rows are excluded
because the engine's ground truth is unsound there (wrong case 3). Pooled rows repeat a design under
two suites, so they are not independent samples.

The fang decks are not stored in this repository; `spikes/fang/run.sh` regenerates them.

## Where the report is wrong

1. **Flagged uncovered, but a mutant was killed: capacitors, divider-rc weak (C1, C2), divider-rc
   thorough (C1), phase-leg weak (CISS, CF, CFB).** Every killer is `open_connection` on the
   capacitor in an op-only check. Opening a capacitor terminal leaves a node with only a capacitor on
   it, and ngspice 42 then returns a wrong DC solution for the whole circuit. Measured: with C1 opened,
   `V(vcc)` goes from 5 to 0; with the unrelated CF opened, `V(gate)` goes from 11.99 to 0. The report is
   right that the capacitor cannot affect the reading; the engine records a kill that is a solver
   artefact. That is an engine finding, not fixed here. The "adjusted" columns discount exactly these
   kills (operator `open_connection`, a capacitor, every killing check at op/dc); it is a second
   reading of the same data, not a replacement.
2. **Not flagged, every mutant survives: RGS (phase-leg, both suites), ISRC, RSH, RFB2 and the sense
   nets (weak suite), C1 and Rboot (fang buck).** These are structurally covered: a check can depend
   on them, but the bands are wide or the effect is small. RGS is a 10 kohm pulldown on a gate that a
   12 V source drives through 10 ohm; it cannot be seen by structure alone, only by magnitude. The
   report does not catch the RGS case named in STATUS. Recall is limited by this and the numbers above
   say so.
3. **Net ground truth for the fang buck is unsound.** `output_short` inserts its resistor after the last
   element line of the file. In that deck the last element is inside `.subckt ideal_buck`, so the short is
   placed on a local node of the body and does nothing (node 5 "shorted through 1 mohm" survives a check
   on V(5)). Net rows for files with a `.subckt` are marked not evaluable.
4. **Where it is right and why it matters:** on the fang buck, the 5 parts flagged (R1, R2, Rfb, Ren,
   C2) are all-survive, and the open feedback loop is caught as `dangling_control`. Of the 45 labelled
   buck survivors in `labels.jsonl`, 22 sit on those 5 parts. The other 23 are on parts the report calls covered
   (C1, Rboot and parts inside the model whose faults barely move V(5)).

## What this does not show

Six design-and-suite pairs is a small sample, from four circuits, and the open-loop rule was written
for one of them. The report says nothing about whether a covered part's faults would be caught.

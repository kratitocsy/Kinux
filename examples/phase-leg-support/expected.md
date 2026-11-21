# Prediction, then measurement

Six hand-applied faults (`mutants.mjs`), two check suites, ngspice 42.

**Kill rule (contract rule 2, implemented in `suites.mjs/killVerdict`):** a
mutant is caught by a suite only if some assertion **PASSed on the baseline**
and **FAILs on the mutant**. `NOT_CHECKED` and `ERROR` are never a catch - and
never a pass.

Both suites PASS every assertion on the baseline (15/15 thorough, 3/3 weak),
measured, so every assertion in both suites is eligible to kill.

---

## Part 1 - prediction, written before measuring

Reasoned from the component values by hand, before any mutant was simulated.

| Mutant | Predicted: thorough | Predicted: weak | Reasoning |
|---|---|---|---|
| M1 gate resistor 10 -> 100 Ohm | CAUGHT, by `V(gate) at 250n > 10.5` | SURVIVES | Steady-state Vgs only moves 11.99 -> 11.88 V, so `V(gate) > 5` still passes. The time constant goes 47 ns -> 470 ns, so only the timing assertion sees it. |
| M2 bus decoupling cap removed | CAUGHT, by `V(fb) at 50u < 0.5` | SURVIVES | A capacitor is invisible to a DC operating point. The weak suite is op-only, so it cannot see this at all. |
| M3 divider bottom leg 4.99k -> 49.9k | CAUGHT, by `V(fb) between 2.25 and 2.32`, `V(fb) < 3.0`, `V(fb) at 5m ...` | SURVIVES | fb goes to ~16 V on a 3.3 V ADC pin, but `V(fb) > 1` is a liveness check and 16 > 1. |
| M4 shunt 2m -> 20m | CAUGHT, by `V(sh) < 50m`, `V(adc_i) between 0.78 and 0.82`, both transient `V(adc_i)` assertions | **CAUGHT**, by `V(adc_i) between 0 and 3.3` | The sense output goes to 8 V, far outside even a loose ADC-range bound. Included deliberately as the control case: the weak suite is weak, not useless. |
| M5 sense filter cap removed | CAUGHT, by `V(adc_i) at 50u < 0.5`. `corner(adc_i)` expected to go NOT_CHECKED, not FAIL: with the pole gone there is no -3 dB point to find. | SURVIVES | Same DC-blind spot as M2. |
| M6 sense amp gain 20 -> 2 | CAUGHT, by `V(adc_i) between 0.78 and 0.82` and `V(adc_i) at 5m ...` | SURVIVES | 20 A reads as 2 A. 0.08 V is inside every plausible sanity range, including `0 .. 3.3`. Only an assertion on the *expected* value catches a scale error. |

**Predicted totals: thorough 6/6, weak 1/6. Five mutants survive the weak suite
and are killed by the thorough one.**

---

## Part 2 - measurement

Measured by running both suites against each mutated netlist through
`verifySimulation` and the real `/usr/bin/ngspice` (ngspice 42). All six
mutants, both suites, 452 ms wall clock for the whole sweep.

| Mutant | Thorough | Weak | Killing assertions (thorough) with measured value |
|---|---|---|---|
| M1-rg-10x | **CAUGHT** | SURVIVED | `V(gate) at 250n > 10.5` measured **3.086191 V** |
| M2-cfb-removed | **CAUGHT** | SURVIVED | `V(fb) at 50u < 0.5` measured **2.28136 V** |
| M3-divider-ratio | **CAUGHT** | SURVIVED | `V(fb) between 2.25 and 2.32` = **15.97865**; `V(fb) < 3.0` = **15.97865**; `V(fb) at 5m between 2.25 and 2.32` = **12.42047** |
| M4-shunt-10x | **CAUGHT** | **CAUGHT** | `V(sh) < 50m` = **0.4**; `V(adc_i) between 0.78 and 0.82` = **8**; `V(adc_i) at 50u < 0.5` = **3.147713**; `V(adc_i) at 5m ...` = **8**; `corner(adc_i) between 1.2k and 2.0k` = **22430.67 Hz**. Weak killed by `V(adc_i) between 0 and 3.3` = **8** |
| M5-cf-removed | **CAUGHT** | SURVIVED | `V(adc_i) at 50u < 0.5` measured **0.8 V**. `corner(adc_i)` -> NOT_CHECKED (`ngspice reported 'k1' failed`), which is **not** counted as a catch |
| M6-sense-gain | **CAUGHT** | SURVIVED | `V(adc_i) between 0.78 and 0.82` = **0.08**; `V(adc_i) at 5m ...` = **0.08**. `corner(adc_i)` -> NOT_CHECKED, not counted |

### Measured totals

| Suite | Assertions | Baseline | Mutants caught | Mutation score |
|---|---|---|---|---|
| `checks-thorough.md` | 15 (op 7, tran 3, tran 4, ac 1) | 15/15 PASS | **6 / 6** | **100 %** |
| `checks-weak.md` | 3 (op 3) | 3/3 PASS | **1 / 6** | **17 %** |

**Survived the weak suite, killed by the thorough suite:** M1-rg-10x,
M2-cfb-removed, M3-divider-ratio, M5-cf-removed, M6-sense-gain (5 of 6).

The claim under test - that a weak suite scores lower than a thorough one on
the same design - holds here, measured: 17 % against 100 %.

---

## Part 3 - where the prediction and the measurement differed

The pass/fail outcome was right for all twelve mutant-suite pairs. Two details
were not predicted, both about `corner()`:

1. **M4 also killed `corner(adc_i)`, at 22430.67 Hz.** Not predicted: the
   10x shunt was expected to be a pure DC-level fault. The reason is that
   Kinux's `corner()` compiles to `meas ac ... WHEN vdb(net)=-3 FALL=1`, an
   **absolute** -3 dBV crossing, not a crossing relative to the passband. With
   a 10x shunt the passband rises to +20 dBV, so the absolute -3 dBV point
   moves out to 22.4 kHz even though the RC pole itself has not moved.
2. **M6 turned `corner(adc_i)` into NOT_CHECKED,** not a PASS as predicted. Same
   cause in the other direction: gain 2 puts the passband at -20 dBV, which is
   already below -3 dBV, so there is no falling -3 dBV crossing anywhere in the
   sweep and ngspice reports the measurement failed.

This is a real limitation of the `corner()` measurable worth recording: it only
means "filter corner" when the passband gain is 0 dB, which is why `ISRC`'s AC
magnitude is scaled in the netlist. A gain fault anywhere ahead of the filter
shows up as a corner shift or as an unmeasurable corner. Both behaviours are
*honest* - NOT_CHECKED is reported as NOT_CHECKED and never scored as a catch -
but a future `corner()` normalised to the passband would be a better measurable.

Neither difference changes any kill verdict: M4 was already caught by four
other assertions and M6 by two.

---

## Reproducibility

ngspice 42, run twice in the same container: the four thorough blocks produce
identical `result_hash` values both times (`run.mjs` hashes the parsed
measurements and print tables).

```
op        sha256:2249fd1df3a44df055d2756fc1bd14cbea0878eee0bd3decb668d1fc2dcc424b
tran fast sha256:44a3f661e1a69fe6fccc02d9b49b0e575dad66f17258c8bfc6e039fb5e851cb6
tran slow sha256:bcab83f99987c818225eb620ec757b711a431bdf57267b83985be383220096c9
ac        sha256:c93d0b7a63dc084e8a655ddae0c87100cc13b64a4eda8ec7785d11273d406987
```

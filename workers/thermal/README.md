# Thermal worker (lumped, closed form)

Kinux's first physics domain beyond electrical. It answers one narrow question:
given the power ngspice says a resistor dissipates, how hot does a
**single lumped thermal node** for that part get?

**Model: lumped steady-state, one-way electrical→thermal coupling.** Every
result names this in its `reason`, PASS and FAIL included, so a lumped estimate
is never mistaken for a measured thermal field.

| File | What it does |
|---|---|
| `model.mjs` | Thermal-model data (every value sourced), and the closed-form physics |
| `assertions.mjs` | The closed `## Thermal` grammar, the ngspice current probe, verdicts |

There is no solver binary. The only simulator involved is ngspice, used through
`workers/ngspice/` to measure currents.

## The model

For each component there is one thermal node, tied to ambient by Rθ:

- **Power**, resistors only: `P = I²R`. `I` is the DC current ngspice
  *measures* through the resistor in an operating point (`op`) of the netlist
  under test, baseline or mutant. `R` is that resistor's value read from the
  same netlist, so a mutated value is seen.
- **Steady state:** `ΔT = P · Rθ`, `T = Ta + ΔT`. Rθ is either one
  body-to-ambient figure (`rth_c_per_w`) or a series chain (`rth_chain`, for
  example Rθjc + Rθcs + Rθsa), which for one node is just the sum.
- **Transient** (optional, `at <t>`): `T(t) = Ta + P·Rθ·(1 − e^(−t/τ))`,
  `τ = Rθ·Cθ`. This is a step of constant power at t = 0 applied to a part
  sitting at ambient. At `t = τ` the rise is 63.2 % of the final rise.
- **One-way chain.** Electrical → thermal only. The temperature computed here
  does not feed back into R, and nothing goes back to the electrical side.

### The thermal model file

JSON, one per design. See `examples/phase-leg-support/thermal-model.json`.

```json
{
  "ambient_c": { "value": 40, "source": "assumed: enclosure air" },
  "components": {
    "RSH": {
      "p_max_w":     { "value": 2,   "source": "design_rule: ..." },
      "rth_c_per_w": { "value": 50,  "source": "design_rule: ..." },
      "cth_j_per_k": { "value": 0.1, "source": "assumed: ..." },
      "t_max_c":     { "value": 125, "source": "design_rule: ..." }
    },
    "RG": { "rth_chain": [ { "name": "jc", "value": 300, "source": "assumed: ..." },
                           { "name": "ca", "value": 380, "source": "assumed: ..." } ] }
  }
}
```

**Every value carries its source**, which must start with `datasheet:`,
`design_rule:` or `assumed:`. A value without one is not used. A check that
needs data the model lacks (no entry, no Rθ, no ambient, no Cθ for a transient,
no rating for `< rated`) is **NOT_CHECKED with `reason_code:
no_material_data`**. Missing data never becomes a default, a guess or a pass.

## The grammar

```markdown
## Thermal

scope: parts RSH, RG        (optional, informational)
analysis: op                (optional; the only analysis power comes from)
assert: P(RSH) < rated      (rated = p_max_w from the model)
assert: T(RSH) < 125        (°C)
assert: T(RSH) < rated      (rated = t_max_c)
assert: T(RSH) at 5 < 75    (first-order transient, t in seconds)
assert: P(RG) between 1u and 1m
```

- The measurables are `T(<refdes>)` and `P(<refdes>)`. Comparators are
  `between a and b` (inclusive), `<` and `>` (strict), and `< rated`. Numbers
  go through the ngspice worker's own `parseSpiceNumber`, and units are checked
  against the measurable (`°C`/`C`/`degC`, `W`, `s`).
- It is a closed grammar with no escape hatch. A line starting with `.` is
  refused (`raw_statement_not_allowed`), as is an unknown field, a non-`op`
  analysis, or a refdes outside `^[A-Za-z][A-Za-z0-9_]{0,31}$`. Each refusal is
  a `ThermalParseError` with a line and a `code`. Through `verifyThermal`, a
  refused line becomes NOT_CHECKED (`netlist_unsupported`, with the code as
  `refusal_code` and in `reason`). It is never dropped.
- Nothing from the check text reaches ngspice. The worker builds its own probe
  assertion `I(<refdes>) between -1e12 and 1e12` from the allowlisted refdes.
  The ngspice worker then compiles and sanitizes that probe like any other check.

## Verdicts

PASS / FAIL / NOT_CHECKED / ERROR, per `contracts/README.md`:

| Situation | Verdict | reason_code |
|---|---|---|
| Computed, within limit | PASS | - |
| Computed, outside limit | FAIL | - |
| Missing or unsourced thermal data | NOT_CHECKED | `no_material_data` |
| Not a resistor (no I²R) | NOT_CHECKED | `out_of_scope` |
| Malformed or hostile assertion, unreadable R value, missing part | NOT_CHECKED | `netlist_unsupported` |
| ngspice could not measure the current | inherits the probe's verdict and code | e.g. `sim_nonconverge`, `timeout` |

Each result follows the viewer convention: `layer: "thermal"`, the queued
title is the assertion text (`T(RSH) < rated`), `measured` and `limit` are
numbers (a `between` limit is the string `"a .. b"`), `units` is `°C` or `W`,
and `reason` starts with the model name, then gives the hand working
(`T = Ta + I²R·Rθ = 40 + (20 A)² × 0.002 Ω × 50 K/W = 80 °C`) and the sources.
The full numbers are also in `working`.

## In the engine

A suite may mix `## Simulation` and `## Thermal` blocks. `engine/runner.mjs`
sends `kind: 'thermal'` blocks to `verifyThermal` with `suite.thermalModel`.
Baseline gating is the same `BaselineGate`: a thermal check the baseline did
not PASS can never kill. `runVerification({ extraMutants })` also accepts
hand-written mutants such as `examples/phase-leg-support/mutants.mjs`.

```sh
node engine/cli.mjs verify examples/phase-leg-support/phase-leg-support.cir \
  --checks examples/phase-leg-support/checks-thermal.md \
  --thermal-model examples/phase-leg-support/thermal-model.json --out /tmp/kinux-thermal
```

## Measured on `examples/phase-leg-support` (ngspice 42)

The baseline passes all 7 checks in `checks-thermal.md`:

- RSH: |I| = 20 A, P = 0.8 W, T = 80.0 °C (T(5 s) = 65.28 °C)
- RG: P = 14.37 µW, T = 40.01 °C
- RFB1: P = 20.90 mW, T = 54.21 °C

**M4 (shunt 2 mΩ → 20 mΩ)** is killed by three thermal checks:

- P = 8 W against the 2 W rating
- T = 440 °C against 125 °C
- T(5 s) = 292.8 °C against 75 °C

**Does thermal add anything over electrical here? No.** These runs cover all
12 engine operators (54 generated mutants) plus M1–M6, so 60 mutants in total.

- Thermal alone kills 2 of them: M4, and `output_short` on `gate`. That short
  puts 12 V across RG: P = 14.4 W against 0.125 W, and the lumped T is an
  absurd ~9 800 °C. In reality the part would have failed long before that.
- The weak electrical suite already kills both.
- Measured kill counts: weak 18, weak+thermal 18, thorough 38, thorough+thermal
  38. On this design every power fault also moves a voltage some electrical
  check already watches. For example, `V(sh) < 50m` in the thorough suite is a
  power limit in disguise.

The thermal checks earn their place on a design where dissipation can go wrong
without moving a watched voltage. This design is not one.

## What this does not model

- **No conduction between parts.** Each part is an isolated node to ambient. A
  hot shunt does not heat its neighbour.
- **No copper spreading.** Pad and plane area only enter through whatever
  board the Rθ figure was measured on.
- **No airflow.** No convection model, no fan, no orientation. Ambient is one
  fixed, sourced number.
- **No temperature-dependent resistance.** R stays at its netlist value at any
  T. There is no TCR and no self-heating loop.
- **No coupling back to the electrical side.** The chain is one-way: the
  electrical result is never re-run at temperature.
- It also has no power for anything but resistors, no AC or transient power
  (DC operating point only), no multi-pole thermal network, and no thermal
  field. The "thermal field" panel shows one lumped number per part.

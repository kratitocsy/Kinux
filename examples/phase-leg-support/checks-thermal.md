# Thermal check suite - 48 V phase-leg support slice

Written in Kinux's `## Thermal` grammar (`workers/thermal/assertions.mjs`) and
judged with the lumped model in `thermal-model.json`.

**Model: lumped steady-state, one-way electrical→thermal coupling.** Power is
P = I²R, with I the DC current ngspice measures through each resistor in an
operating point of the netlist under test. T = Ta + P·Rθ. Temperature does not
feed back into resistance, and there is no conduction between parts, no copper
spreading and no airflow. A pass here says the lumped estimate is under the
limit, nothing more.

Hand working for the baseline (Ta = 40 °C):

- RSH: P = (20 A)² × 2 mΩ = 0.8 W; T = 40 + 0.8 × 50 = 80 °C.
  At t = 5 s = τ (Rθ·Cθ = 50 × 0.1): T = 40 + 40 × 0.632 = 65.3 °C.
- RG: I = 12 V / 10.01 kΩ = 1.199 mA; P = 14.4 µW; T ≈ 40.01 °C.
- RFB1: I = 48 V / 104.99 kΩ = 457.2 µA; P = 20.9 mW; T = 40 + 0.0209 × 680 = 54.2 °C.

## Thermal

scope: parts RSH, RG, RFB1
analysis: op
assert: P(RSH) < rated
assert: T(RSH) < rated
assert: T(RSH) at 5 < 75
assert: P(RG) < rated
assert: T(RG) < rated
assert: P(RFB1) < rated
assert: T(RFB1) < rated

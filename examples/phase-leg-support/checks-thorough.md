# Thorough check suite - 48 V phase-leg support slice

Written in Kinux's own Simulation-block grammar (`workers/ngspice/assertions.mjs`).
Every `assert:` line below is parsed by `parseSimulationBlocks` and compiled into
an ngspice deck by `compileSimulationDeck`; none of it is hand-written ngspice.

This is what a careful engineer asserts about these three networks: steady-state
rail levels, the quiescent and fault currents, the gate edge timing, the peak
drive current, the filter corner, and the fact that the two filter capacitors
are actually doing their job.

Baseline measured values are quoted next to each assertion (ngspice 42).

## Simulation

Steady state, driver held on, 20 A in the shunt, 48 V on the bus.

- gate: full enhancement for a 48 V FET needs Vgs >= 10 V; 10.5 V leaves margin
  and catches a pulldown that loads the driver.
- fb: 48 V must land at 2.281 V, inside a 3.3 V ADC, and must never approach it.
- divider current: budget is 500 uA off the DC link.
- shunt drop: 50 mV cap keeps I2R under 1 W in a 2 W 2512 part and keeps the
  sense amp's common mode near ground.
- adc_i: the whole sense chain must scale 20 A to 0.800 V.

scope: nets gate, fb, sh, adc_i
analysis: op
assert: V(gate) > 10.5
assert: V(fb) between 2.25 and 2.32
assert: V(fb) < 3.0
assert: I(RFB1) < 600u
assert: V(sh) < 50m
assert: V(adc_i) between 0.78 and 0.82
assert: I(RSH) between 19 and 21

## Simulation

Gate edge. Driver output ramps 0 -> 12 V over 100..120 ns; UIC so the gate
starts genuinely off.

- 90 ns: the gate must still be off before the driver moves (no shoot-through).
- 250 ns: the gate must be fully enhanced within ~130 ns of the edge, or
  switching loss blows the budget at 20 kHz.
- 120 ns: peak gate current must stay inside a 1.5 A driver rating.

scope: nets gate
analysis: tran 1n 1u uic
assert: V(gate) at 90n < 1.0
assert: V(gate) at 250n > 10.5
assert: I(RG) at 120n < 1.5

## Simulation

Filter and decoupling behaviour from power-on. UIC, so both capacitors start
discharged and their time constants are observable.

- fb at 50 us must still be low: the 100 nF decoupling cap gives ~475 us, so a
  bus transient cannot alias into the ADC sampler. A missing cap shows up here
  and nowhere else.
- adc_i at 50 us must still be low for the same reason (1 k x 100 nF = 100 us).
- both must settle on the correct value by 5 ms.

scope: nets fb, adc_i
analysis: tran 1u 6m uic
assert: V(fb) at 50u < 0.5
assert: V(fb) at 5m between 2.25 and 2.32
assert: V(adc_i) at 50u < 0.5
assert: V(adc_i) at 5m between 0.78 and 0.82

## Simulation

Sense-chain anti-alias corner. The filter must sit well below a 20 kHz PWM
fundamental and well above a ~200 Hz current-loop bandwidth: 1/(2*pi*1k*100n)
= 1.59 kHz.

scope: nets adc_i
analysis: ac dec 50 10 1meg
assert: corner(adc_i) between 1.2k and 2.0k

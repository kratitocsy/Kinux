# Weak check suite - 48 V phase-leg support slice

Same design, same grammar, three loose assertions and a single operating point.

This is the suite the demonstration needs as a control. It is deliberately
*plausible*, not sabotaged: it checks the three output nets anyone would think
of, with bounds that read as reasonable sanity limits, and it never asks for a
transient or an AC sweep. It is close to what you get when a suite is written
from the net names alone - "is the gate on, is the feedback alive, is the sense
output inside the ADC range" - without asking what each network is for.

It passes on the baseline, which is the only thing that makes it a valid suite
under contract rule 2.

## Simulation

scope: nets gate, fb, adc_i
analysis: op
assert: V(gate) > 5
assert: V(fb) > 1
assert: V(adc_i) between 0 and 3.3

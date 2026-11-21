# Output rail check for the open-loop buck fixture

The rail must hold 3.3 V within 3% late in the run.

## Simulation

scope: nets out
analysis: tran 20n 1m
assert: V(out) at 900u between 3.201 and 3.399

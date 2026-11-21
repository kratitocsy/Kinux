# Weak check suite

Deliberately thin: one loose check on the supply rail. The design is far better
covered than this, and the mutation score should say so.

## Simulation

scope: nets [vcc]
analysis: op
assert: V(vcc) between 4 and 6

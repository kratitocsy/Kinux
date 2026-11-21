# Checks for the KiCad divider fixture

R3 is 1M. Read as a megaohm the output sits at 2.485 V; read as SPICE reads
`1M` (a milliohm) it would be pulled to about 0 V, so these bounds also guard
the SI-prefix boundary.

## Simulation

scope: nets [mid, out]
analysis: op
assert: V(mid) between 2.480 and 2.495
assert: V(out) between 2.480 and 2.490
assert: I(V1) between -260u and -240u

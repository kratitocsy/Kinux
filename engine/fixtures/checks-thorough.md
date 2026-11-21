# Thorough check suite

Every internal node pinned to about 1% of its nominal, the supply current
bounded, and two points on the output filter's step response.

## Simulation

scope: nets [vcc, mid, out]
analysis: op
assert: V(vcc) between 4.95 and 5.05
assert: V(mid) between 2.36 and 2.405
assert: V(out) between 2.335 and 2.382
assert: I(V1) between -270u and -255u

## Simulation

scope: nets [out]
analysis: tran 10u 2m
assert: V(out) at 500u between 197m and 201m
assert: V(out) at 1500u between 543m and 555m

# fang's rc_filter requirement, written as a Kinux check

fang's program requires the -3 dB corner of the anti-aliasing filter to hold
between 1.5 and 1.7 kHz. The source is 1 V AC, so the passband is 0 dB and the
absolute -3 dB crossing that `corner()` measures is the corner.

## Simulation

scope: nets 1
analysis: ac dec 100 10 1meg
assert: corner(1) between 1.5k and 1.7k

# fang's buck_regulator rail requirement, written as a Kinux check

fang requires the 3V3 rail to hold 3.3 V within 3% under load. fang's own
question also measures peak-to-peak ripple, which Kinux's grammar cannot
express, so this check is weaker than fang's full question.

## Simulation

scope: nets 5
analysis: tran 10n 1.2m
assert: V(5) at 1.1m between 3.201 and 3.399

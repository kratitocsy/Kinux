# Spike: scoring designs written in Copperhead's `fang`

[`fang`](https://github.com/copperheadhq/fang) is Copperhead's "Hardware as Code"
toolchain (Apache-2.0, version 0.1.0): a design is Python source, and `fang verify`
answers its declared questions with ngspice. It has no mutation testing. This spike
asks whether Kinux can take a `fang` design and tell you how good its checks are.

**Answer: yes, for the two examples that run a simulation.**

```bash
git clone https://github.com/copperheadhq/fang /tmp/fang
spikes/fang/run.sh /tmp/fang          # about 40 seconds; needs Python 3.11+, ngspice, Node 22
```

This runs `fang`, which is third-party code, in a throwaway virtualenv built from a
copy of your clone. Nothing of `fang` is stored in this repository.

## What it does

1. Builds `fang` from a copy into a throwaway virtualenv.
2. Runs `fang verify` on an example, and saves the SPICE deck it builds (`capture.py`).
3. Keeps the circuit and drops fang's analysis wrapper, inlining any `.include`
   because Kinux's sanitizer refuses `.include` on purpose (`convert.py`).
4. Gives that circuit and a check, written in Kinux's grammar from fang's own
   requirement, to `kinux verify`.

## Results

| Example | fang says | Kinux mutation score | 95% interval |
|---|---|---|---|
| `rc_filter` (corner between 1.5 and 1.7 kHz) | PASS, corner 1590 Hz | **62.5%**: 5 killed of 8 checkable, 13 mutants, 5 not checkable | 30.6% to 86.3% |
| `buck_regulator` (3V3 rail within 3%) | PASS | **27.4%**: 17 killed of 62 mutants, all checkable | 17.9% to 39.6% |

What the scores show:

- **`rc_filter`:** a 5% drift in R1 or C1 survives, because fang's band is wide enough to absorb it. A 10% drift is caught. Single-fault testing cannot ask whether two 5% drifts together leave the band (they do: about 1.44 kHz). Opens and shorts leave no -3 dB crossing to measure, so they are `NOT_CHECKED`, never counted as kills.
- **`buck_regulator`:** the requirement, as benched, is nearly blind. Its model is a fixed-duty buck with no control loop, and the model's own header says the feedback divider "draws nothing here". So no drift in the feedback network can change the output, and every such mutant survives. That is correct behaviour for this model. The 27.4% quantifies how little the bench can see.

## Caveats, all of which matter

- **The checks are weaker than fang's own questions.** fang's buck question also measures peak-to-peak ripple, which Kinux's grammar cannot express. So 27.4% is the score of the rail requirement as Kinux can write it, not of fang's full question.
- **22 of the 62 buck mutants are inside the inlined behavioural model**, which are not design faults. On the design's own parts the figure is 9 killed of 40 (22.5%). It is low either way.
- **The deck capture is fragile.** fang has no supported command that writes a verification deck to disk, and `fang sim` refuses whole systems that lack models ("rejected rather than run with a substitute"). `capture.py` wraps an internal method, so it may break when fang changes.
- **Only 2 of 12 examples produce an ngspice deck.** Most declare no question, and `antenna_match` uses an RF tool. The `servo_drive` example, the closest to our target demo, has no simulation question at all: `fang check` reports 46 checks, 0 failed, 7 undecided (interface values it does not know yet).
- **Kinux mutates the circuit, not the Python source.** A fault is applied to the SPICE text, then judged. Mutating a fang program directly would be a deeper integration.
- This is a spike, not an integration. It establishes that the path exists.

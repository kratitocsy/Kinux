# Survivor judging sheet: spikes/survivors/labels.jsonl

Fill in `decision:` (EQUIVALENT, BENIGN, GAP or MODEL) and `reason:` for each survivor you judge.
EQUIVALENT: no check could ever tell it from the original. BENIGN: it changes behaviour, but every
requirement still holds. GAP: a real fault the checks miss. MODEL: the fault is inside a model or a
bench stand-in, not the design. Leave a survivor blank if you are not sure: blank is counted as undecided.
Agent proposals are shown for reference only and count for nothing until you decide.

## divider-rc/M-value_drift_5-C1

- what: C1 value drifted +5% (10u -> 10.5u)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C1 sits across the ideal source V1: op unchanged (0), V(out) changes ~1e-15; only i(V1) inrush spike scales (0.05). All six assertions identical to baseline; no stated requirement on surge current.

decision: 
reason: 

## divider-rc/M-value_drift_5-R3

- what: R3 value drifted +5% (1k -> 1.05k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Measurable shift (max rel 0.017) but every mutant measurement stays inside its ~1% band (e.g. V(out) 2.357379 within 2.335..2.382, step points in band); the design's stated aim is nodes within ~1%.

decision: 
reason: 

## divider-rc/M-value_drift_5-RL

- what: RL value drifted +5% (100k -> 105k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Measurable shift (max rel 0.0027) but every mutant measurement stays inside its ~1% band (e.g. V(out) 2.364865 within 2.335..2.382, step points in band); the design's stated aim is nodes within ~1%.

decision: 
reason: 

## divider-rc/M-value_drift_10-C1

- what: C1 value drifted +10% (10u -> 11u)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C1 sits across the ideal source V1: op unchanged (0), V(out) changes ~1e-15; only i(V1) inrush spike scales (0.1). All six assertions identical to baseline; no stated requirement on surge current.

decision: 
reason: 

## divider-rc/M-value_drift_10-RL

- what: RL value drifted +10% (100k -> 110k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Measurable shift (max rel 0.0052) but every mutant measurement stays inside its ~1% band (e.g. V(out) 2.37069 within 2.335..2.382, step points in band); the design's stated aim is nodes within ~1%.

decision: 
reason: 

## divider-rc/M-value_drift_20-C1

- what: C1 value drifted +20% (10u -> 12u)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C1 sits across the ideal source V1: op unchanged (0), V(out) changes ~1e-15; only i(V1) inrush spike scales (0.2). All six assertions identical to baseline; no stated requirement on surge current.

decision: 
reason: 

## divider-rc/M-value_drift_20-RL

- what: RL value drifted +20% (100k -> 120k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Measurable shift (max rel 0.0095) but every mutant measurement stays inside its ~1% band (e.g. V(out) 2.380952 within 2.335..2.382, step points in band); the design's stated aim is nodes within ~1%.

decision: 
reason: 

## divider-rc/M-bypass_cap_removed-C1

- what: C1 bypass capacitor removed
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C1 removal changes only i(V1) inrush (rel 1.0) and V(out) by 1.1e-6; op unchanged. Checks bound only DC levels and two V(out) points, which stay in band; no requirement on the bypass function is stated and the source is ideal.

decision: 
reason: 

## divider-rc/M-rail_swap-C1

- what: C1 rail and ground swapped (vcc <-> 0)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## phase-leg/M-value_drift_5-CF

- what: CF value drifted +5% (100n -> 105n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1512 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_5-CFB

- what: CFB value drifted +5% (100n -> 105n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only fb decoupling transient changes (max rel 0.048); V(fb) at 50u stays < 0.5 and V(fb) settled value 2.281 unchanged; ac and op unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_5-CISS

- what: CISS value drifted +5% (4.7n -> 4.935n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge slows slightly: V(gate)@250n 11.38 -> 11.28 (>10.5), peak I(RG) 0.987 A (<1.5 A); all gate requirements hold.

decision: 
reason: 

## phase-leg/M-value_drift_5-RF

- what: RF value drifted +5% (1k -> 1.05k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1512 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_5-RG

- what: RG value drifted +5% (10 -> 10.5)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge changes (max rel 0.039) but V(gate)@250n = 11.28 > 10.5 and peak I(RG) 0.940 A < 1.5 A; steady V(gate) 11.986 > 10.5.

decision: 
reason: 

## phase-leg/M-value_drift_5-RGS

- what: RGS value drifted +5% (10k -> 10.5k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only the pulldown current changes (op i(vdrv) rel 0.048); V(gate) changes by ~1e-4 (11.988 -> 11.989); no requirement breached.

decision: 
reason: 

## phase-leg/M-value_drift_10-CF

- what: CF value drifted +10% (100n -> 110n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1443 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_10-CFB

- what: CFB value drifted +10% (100n -> 110n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only fb decoupling transient changes (max rel 0.091); V(fb) at 50u stays < 0.5 and V(fb) settled value 2.281 unchanged; ac and op unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_10-CISS

- what: CISS value drifted +10% (4.7n -> 5.17n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge slows slightly: V(gate)@250n 11.38 -> 11.19 (>10.5), peak I(RG) 0.995 A (<1.5 A); all gate requirements hold.

decision: 
reason: 

## phase-leg/M-value_drift_10-RF

- what: RF value drifted +10% (1k -> 1.1k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1443 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_10-RG

- what: RG value drifted +10% (10 -> 11)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge changes (max rel 0.075) but V(gate)@250n = 11.18 > 10.5 and peak I(RG) 0.905 A < 1.5 A; steady V(gate) 11.986 > 10.5.

decision: 
reason: 

## phase-leg/M-value_drift_10-RGS

- what: RGS value drifted +10% (10k -> 11k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only the pulldown current changes (op i(vdrv) rel 0.091); V(gate) changes by ~1e-4 (11.988 -> 11.989); no requirement breached.

decision: 
reason: 

## phase-leg/M-value_drift_20-CF

- what: CF value drifted +20% (100n -> 120n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1323 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_20-CFB

- what: CFB value drifted +20% (100n -> 120n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only fb decoupling transient changes (max rel 0.17); V(fb) at 50u stays < 0.5 and V(fb) settled value 2.281 unchanged; ac and op unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_20-CISS

- what: CISS value drifted +20% (4.7n -> 5.64n)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge slows slightly: V(gate)@250n 11.38 -> 10.98 (>10.5), peak I(RG) 1.010 A (<1.5 A); all gate requirements hold.

decision: 
reason: 

## phase-leg/M-value_drift_20-RF

- what: RF value drifted +20% (1k -> 1.2k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Anti-alias corner moves 1588 -> 1323 Hz, still inside the stated 1.2k-2.0k window (well below 20 kHz, above ~200 Hz); DC gain 0.8 V unchanged.

decision: 
reason: 

## phase-leg/M-value_drift_20-RG

- what: RG value drifted +20% (10 -> 12)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Gate edge changes (max rel 0.14) but V(gate)@250n = 10.98 > 10.5 and peak I(RG) 0.842 A < 1.5 A; steady V(gate) 11.986 > 10.5.

decision: 
reason: 

## phase-leg/M-value_drift_20-RGS

- what: RGS value drifted +20% (10k -> 12k)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Only the pulldown current changes (op i(vdrv) rel 0.17); V(gate) changes by ~1e-4 (11.988 -> 11.990); no requirement breached.

decision: 
reason: 

## phase-leg/M-divider_ratio_off-gate

- what: divider at gate: RGS +25% (10k -> 12.5k), ratio against RG shifted
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): RGS +25% changes V(gate) only 2e-4 (11.988 -> 11.990) and i(vdrv) 0.2; gate level, edge timing and peak current assertions all remain well in bounds.

decision: 
reason: 

## phase-leg/M-open_connection-RGS.0

- what: RGS terminal 1 opened (was on gate, now dangling NC_RGS_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Opening RGS removes the gate-source pulldown; op V(gate) goes 11.988 -> 12 and i(vdrv) rel change 1.0 (all pulldown current gone). README states RGS exists so the gate is held off when the driver is high-impedance; the driver is an ideal source so no check ever exercises that.

decision: 
reason: 

## phase-leg/M-output_short-amp

- what: node amp shorted to ground through 1mohm
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (not unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Shorting node amp to ground via 1 mohm leaves every voltage unchanged (v(adc_i) rel 0) because EAMP is an ideal VCVS, but i(EAMP) changes by 8e11 (about 800 A forced through the amp output). A real sense-amp output short would kill the 0.800 V sense signal; the suite never looks at amp output current.

decision: 
reason: 

## fang-rc-filter/M-value_drift_5-C1

- what: C1 value drifted +5% (0.00000001 -> 1.050000000e-8)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): +5% drift moves corner 1588 -> 1512 Hz, still inside the stated 1.5k-1.7k requirement band (passes with ~12 Hz margin); the requirement holds, as the spike README also notes.

decision: 
reason: 

## fang-rc-filter/M-value_drift_5-R1

- what: R1 value drifted +5% (10000 -> 10500)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): +5% drift moves corner 1588 -> 1512 Hz, still inside the stated 1.5k-1.7k requirement band (passes with ~12 Hz margin); the requirement holds, as the spike README also notes.

decision: 
reason: 

## fang-rc-filter/M-rail_swap-Vfang_supply0

- what: Vfang_supply0 rail and ground swapped (3 <-> 0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Swapping source terminals inverts the 1 V AC phasor (complex diff rel 2) but magnitude response is identical: corner 1587.775 Hz unchanged. The only stated requirement is the -3 dB corner in 1.5-1.7 kHz, which still holds.

decision: 
reason: 

## fang-buck/M-value_drift_5-C1

- what: C1 value drifted +5% (0.0000001 -> 1.050000000e-7)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_5-C2

- what: C2 value drifted +5% (0.000022 -> 0.0000231)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_5-C3

- what: C3 value drifted +5% (0.000022 -> 0.0000231)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C3 drift changes inductor/supply current (max rel 0.076) but V(5)@1.1m 3.284946 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_5-L1

- what: L1 value drifted +5% (0.0000047 -> 0.000004935)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): L1 drift changes inductor/supply current (max rel 0.075) but V(5)@1.1m 3.284945 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_5-R1

- what: R1 value drifted +5% (64000 -> 67200)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.037 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_5-R2

- what: R2 value drifted +5% (200000 -> 210000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.036 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_5-Rboot

- what: Rboot value drifted +5% (1e6 -> 1050000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_5-Ren

- what: Ren value drifted +5% (1e6 -> 1050000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_5-Rfang_load0

- what: Rfang_load0 value drifted +5% (2.2 -> 2.31)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Rfang_load0 drift changes inductor/supply current (max rel 0.025) but V(5)@1.1m 3.285611 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_5-Rfb

- what: Rfb value drifted +5% (1e9 -> 1050000000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 2.3e-06; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-value_drift_10-C1

- what: C1 value drifted +10% (0.0000001 -> 1.100000000e-7)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_10-C2

- what: C2 value drifted +10% (0.000022 -> 0.0000242)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_10-C3

- what: C3 value drifted +10% (0.000022 -> 0.0000242)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C3 drift changes inductor/supply current (max rel 0.15) but V(5)@1.1m 3.284983 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_10-L1

- what: L1 value drifted +10% (0.0000047 -> 0.00000517)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): L1 drift changes inductor/supply current (max rel 0.14) but V(5)@1.1m 3.284971 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_10-R1

- what: R1 value drifted +10% (64000 -> 70400)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.074 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_10-R2

- what: R2 value drifted +10% (200000 -> 220000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.070 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_10-Rboot

- what: Rboot value drifted +10% (1e6 -> 1100000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_10-Ren

- what: Ren value drifted +10% (1e6 -> 1100000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_10-Rfang_load0

- what: Rfang_load0 value drifted +10% (2.2 -> 2.42)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Rfang_load0 drift changes inductor/supply current (max rel 0.048) but V(5)@1.1m 3.286247 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_10-Rfb

- what: Rfb value drifted +10% (1e9 -> 1100000000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 4.4e-06; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-value_drift_20-C1

- what: C1 value drifted +20% (0.0000001 -> 1.200000000e-7)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_20-C2

- what: C2 value drifted +20% (0.000022 -> 0.0000264)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_20-C3

- what: C3 value drifted +20% (0.000022 -> 0.0000264)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): C3 drift changes inductor/supply current (max rel 0.29) but V(5)@1.1m 3.285055 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_20-L1

- what: L1 value drifted +20% (0.0000047 -> 0.00000564)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): L1 drift changes inductor/supply current (max rel 0.26) but V(5)@1.1m 3.285018 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_20-R1

- what: R1 value drifted +20% (64000 -> 76800)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.145 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_20-R2

- what: R2 value drifted +20% (200000 -> 240000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB node v(9) shifts 0.132 but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-value_drift_20-Rboot

- what: Rboot value drifted +20% (1e6 -> 1200000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_20-Ren

- what: Ren value drifted +20% (1e6 -> 1200000)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-value_drift_20-Rfang_load0

- what: Rfang_load0 value drifted +20% (2.2 -> 2.64)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): BENIGN (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Rfang_load0 drift changes inductor/supply current (max rel 0.091) but V(5)@1.1m 3.287352 stays in 3.201-3.399 (baseline 3.2849); larger L/C/load R only reduce ripple/current. fang's ripple requirement is not expressible in the check but moves in the benign direction.

decision: 
reason: 

## fang-buck/M-value_drift_20-Rfb

- what: Rfb value drifted +20% (1e9 -> 1200000000)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 8.1e-06; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-bypass_cap_removed-C2

- what: C2 bypass capacitor removed
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-open_connection-C1.0

- what: C1 terminal 1 opened (was on 1, now dangling NC_C1_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): EQUIVALENT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Open C1: V(5) identical to 7 digits (3.284908), max rel diff 7.1e-06, only control-waveform timestep jitter. C2 is on an ideal 12 V source and C1 is a bootstrap cap the ideal_buck model does not use, so nothing here can distinguish it (a real bootstrap cap open would matter, but is not expressible in this model).

decision: 
reason: 

## fang-buck/M-open_connection-C2.0

- what: C2 terminal 1 opened (was on 3, now dangling NC_C2_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): EQUIVALENT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Open C2: V(5) identical to 7 digits (3.284908), max rel diff 7.1e-06, only control-waveform timestep jitter. C2 is on an ideal 12 V source and C1 is a bootstrap cap the ideal_buck model does not use, so nothing here can distinguish it (a real bootstrap cap open would matter, but is not expressible in this model).

decision: 
reason: 

## fang-buck/M-open_connection-R1.0

- what: R1 terminal 1 opened (was on 9, now dangling NC_R1_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB divider node 9 jumps (v(9) rel 3.1) but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-open_connection-R2.0

- what: R2 terminal 1 opened (was on 5, now dangling NC_R2_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): REAL_GAP (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): FB divider node 9 jumps (v(9) rel 1.0) but V(5) unchanged (3.284908) because the fixed-duty model ignores feedback. In a real regulated rail the divider sets Vout (3.3 = 0.8*(1+200k/64k)); a +5% R1/R2 drift would move Vout ~3.6-3.8%, beyond the 3% requirement, and an open divider leg would wreck regulation. Check only observes net 5.

decision: 
reason: 

## fang-buck/M-open_connection-Rboot.0

- what: Rboot terminal 1 opened (was on boot, now dangling NC_Rboot_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 7.1e-06; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-open_connection-Ren.0

- what: Ren terminal 1 opened (was on en, now dangling NC_Ren_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 1.6e-06; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-open_connection-Rfb.0

- what: Rfb terminal 1 opened (was on fb, now dangling NC_Rfb_0)
- solver: not solver-identical (the measured difference is in the profile that produced these labels)
- proposed (not confirmed): NOT_A_DESIGN_FAULT (unanimous among agent reviewers)
- an agent reviewer's note (a model's reading, not a measurement): Mutation is inside the inlined ideal_buck behavioural model (field inside_inlined_model true); max rel change 4.8e-05; spike README says these are not design faults.

decision: 
reason: 

## fang-buck/M-output_short-1

- what: node 1 shorted to ground through 1mohm
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-output_short-2

- what: node 2 shorted to ground through 1mohm
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-output_short-5

- what: node 5 shorted to ground through 1mohm
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-output_short-9

- what: node 9 shorted to ground through 1mohm
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-rail_swap-C2

- what: C2 rail and ground swapped (3 <-> 0)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-pin_swap-Shigh.0-1

- what: Shigh pins 1 and 2 swapped (vin,sw,hctl,gnd -> sw,vin,hctl,gnd)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

## fang-buck/M-pin_swap-Slow.0-1

- what: Slow pins 1 and 2 swapped (sw,gnd,lctl,gnd -> gnd,sw,lctl,gnd)
- solver: identical to the original within 0.000001 relative in every analysis
- **solver-identical: counted as EQUIVALENT by measurement; no decision needed**

decision: 
reason: 

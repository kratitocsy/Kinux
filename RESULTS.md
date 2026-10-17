# Results (all simulation, 27 robots, 53 limbs)

Gain = fraction by which a target's error falls when it borrows a donor's data (0 = no help, negative = harm). Targets get 20 samples unless noted. Raw output is in `results/logs/`.

## 1. Part matching (`parts4.py`)
Quadruped legs (Go2, Go1, A1, ANYmal) match each other. G1 and H1 legs match. G1 and H1 arms match. Panda, UR5e and xArm7 arms match. Known failures: Cassie's closed-loop leg is split into fake parts; fixed-base arms are flagged as touching the ground; grippers match only by size.

## 2. Does picking the donor by a simple rule help? (cross-family donors, pick 1 of 15; `logs/baselines_*.txt`)

| Rule | Gravity torque | Contact force |
|---|---|---|
| Joint count | -0.24 | -0.27 |
| Size | +0.04 | -0.16 |
| Hand-made M2 distance | +0.04 | -0.10 |
| Random | -0.02 | -0.13 |
| Best donor in pool | +0.42 | +0.22 |

The hand-made distance beat joint count but not size.

## 3. Learned donor rule, whole robot families held out (`logs/learned_rule_ablation.txt`)

| Rule | Gravity | Contact |
|---|---|---|
| Target + donor + differences | +0.18 | +0.12 |
| **Donor features only** | **+0.18** | **+0.16** |
| Differences only (similarity) | +0.10 | -0.06 |
| Size | -0.02 | -0.08 |
| Joint count | -0.21 | -0.26 |
| Random | 0.00 | -0.12 |

The donor-only rule matches the full rule, so the rule mostly finds good donors, not matching bodies.

## 4. Leg slip proxy (14 leg targets; `logs/slip_legs.txt`)
Learned donor-only rule +0.00, full rule -0.01, size -0.11, joint count -0.17, similarity-only -0.18, hand-made distance -0.24, random -0.25, best in pool +0.12. The learned rules avoided harm; similarity did not help; there was little to gain on this task.

## Not shown
Real walking, manipulation or slip; real hardware; real datasets; more than 27 robots; any task needing a GPU. A similarity effect might appear in dynamic tasks, and we have not tested that.

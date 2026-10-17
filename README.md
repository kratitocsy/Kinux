# Kinux

Early research code for a question: **when a robot has little data, which other robots' data helps it, and which makes it worse?**

Kinux is a long-term project to make robot data and skills shareable across different kinds of robots. This repo holds the first experiments. It is simulation only (MuJoCo), runs on a normal CPU, and uses no real robot.

> Status: early and small. Nothing here is proven for real robots. Negative results are kept on purpose.

## What is here

- `src/parts4.py`, `src/m2lib.py` - split a robot model into parts (legs, arms, fingers) and describe each with simple measurements (joint count, mass share, size, attachment, joint axes, ground contact).
- `src/transfer*.py` - tests: a part with 10 to 40 samples borrows data from a donor part; did its error go down or up?
- `src/gen_*.py`, `src/learn_*.py` - build a table of (target, donor, gain) pairs and test donor-selection rules on **robot families held out from training**.
- `results/` - charts and raw output of every run, including the ones that did not work.

Robots: 27 models from MuJoCo Menagerie (quadrupeds, humanoids, arms, hands), 53 limbs.
Tasks (simple physics, not real walking): gravity torque, torque for a tip force, and a friction-ratio proxy for foot slip.

## Run it

```
pip install -r requirements.txt
cd src
python parts4.py go2_mj_description go1_mj_description g1_mj_description panda_mj_description
python learn_ablate.py grav contact     # uses the saved pairs_*.pkl
```

Generating new pair tables (`gen_*.py`) takes several minutes per task; see `results/logs` for the exact robot list.

## What the experiments found (short version)

See [RESULTS.md](RESULTS.md) for numbers and caveats.

- Choosing a donor by **joint count** was worse than random in every test.
- A **hand-made body-similarity distance** did not beat simple size matching.
- A **rule learned from transfer results** picked better donors than size, joint count or random on unseen robot families (gravity and contact tasks), and avoided most harm on the slip proxy.
- A rule that sees **only the donor's features** did as well as one that sees both robots, so the rule mostly finds *good donors*, not *matching bodies*.
- On the leg slip proxy, body similarity did not help.

## Limits

Simulation only. Simple static tasks. 27 robots. Small networks. One pool of candidates per target. No real data, no real walking or manipulation. These results say little about real robots yet.

## Related work (read before claiming anything is new)

- Cross-Embodiment Offline RL for Heterogeneous Robot Datasets (2026), robot-graph distance and grouping: https://arxiv.org/abs/2602.18025
- Data Analogies Enable Efficient Cross-Embodiment Transfer (2026): https://arxiv.org/abs/2603.06450
- Experience Selection Using Dynamics Similarity for Efficient Multi-Source Transfer Learning Between Robots (2020): https://arxiv.org/abs/2003.13150
- Taskonomy (2018): https://arxiv.org/abs/1804.08328
- Neither Morphological Similarity nor Data Diversity Governs Policy Transfer Across Robot Bodies (July 2026, preprint, not peer reviewed): https://www.preprints.org/manuscript/202607.1034

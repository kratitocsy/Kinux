// Measurements over a recorded trajectory (kinux.mj_trajectory/1).
// Pure functions: no MuJoCo, no I/O. The browser can run the same math.

/** Look up a joint by name. Returns null if absent. */
export function findJoint(traj, name) {
  return traj.joints.find(j => j.name === name) ?? null;
}

/** Column of a 2-D series: series[k][adr] for every sample k. */
export const column = (series, adr) => series.map(row => row[adr]);

/**
 * Times at which a hinge angle crosses `level` going upward (negative to
 * positive slope). The root inside each bracketing sample interval is found on
 * the cubic Hermite interpolant built from qpos AND qvel at both ends, so the
 * crossing time is O(h^4) accurate in the sample interval h, rather than the
 * O(h^2) of a straight line between two samples.
 */
export function upwardCrossings(t, q, v, level = 0) {
  const out = [];
  for (let k = 0; k + 1 < t.length; k++) {
    const a = q[k] - level, b = q[k + 1] - level;
    if (!(a < 0 && b >= 0)) continue;
    const h = t[k + 1] - t[k];
    const H = s => {
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * a + (s3 - 2 * s2 + s) * h * v[k] + (-2 * s3 + 3 * s2) * b + (s3 - s2) * h * v[k + 1];
    };
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (H(mid) < 0) lo = mid; else hi = mid;
    }
    out.push(t[k] + h * (lo + hi) / 2);
  }
  return out;
}

/** Mean period from upward zero crossings: (last - first) / (n - 1). */
export function measurePeriod(traj, jointName) {
  const j = findJoint(traj, jointName);
  if (!j) throw new Error(`no joint ${jointName}`);
  const c = upwardCrossings(traj.t, column(traj.qpos, j.qpos_adr), column(traj.qvel, j.dof_adr));
  if (c.length < 2) return { period: null, crossings: c.length };
  return { period: (c[c.length - 1] - c[0]) / (c.length - 1), crossings: c.length, cycles: c.length - 1 };
}

/** Angle range over every recorded sample. */
export function angleRange(traj, j) {
  let min = Infinity, max = -Infinity;
  for (const row of traj.qpos) { const x = row[j.qpos_adr]; if (x < min) min = x; if (x > max) max = x; }
  return { min, max };
}

/**
 * Settling time: the earliest recorded time after which every sample stays
 * within |q - target| <= band. Returns { settled:false } if the last sample is
 * outside the band, and { settled:true, at_end:true } if only the last sample
 * is inside (the record is too short to show it stays there).
 */
export function settlingTime(traj, j, target, band) {
  const q = column(traj.qpos, j.qpos_adr);
  let k = q.length - 1;
  if (Math.abs(q[k] - target) > band) return { settled: false, t_end: traj.t[k] };
  while (k > 0 && Math.abs(q[k - 1] - target) <= band) k--;
  return { settled: true, t: traj.t[k], at_end: k === q.length - 1 };
}

/** Peak |joint-side actuator torque| over every integration step (from sim.py). */
export function peakJointTorque(traj, j) {
  return traj.peak_qfrc_actuator[j.dof_adr];
}

/** Does any actuator transmit to this joint? */
export function jointIsActuated(traj, j) {
  return traj.actuators.some(a => a.joint === j.name);
}

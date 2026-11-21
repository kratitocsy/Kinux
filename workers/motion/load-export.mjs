// Joint-actuator load export: the motion half of the one-way motion -> structure
// chain (docs/PLAN.md section 6). It reads a recorded trajectory and writes the
// torque a motor-driven joint puts through its housing, in a plain JSON shape a
// structural (FEA) worker can apply as a load. Nothing here imports or calls an
// FEA worker; the shape is the contract. It is documented in README.md.
//
// kinux.joint_load/1
// {
//   "format": "kinux.joint_load/1",
//   "joint": "shoulder",                  hinge joint name in the MJCF
//   "actuators": [{"name","gear"}],       actuators transmitting to this joint
//   "body": "arm", "parent_body": "housing",
//   "axis_local": [x,y,z],                joint axis, in the child body frame
//   "anchor_local": [x,y,z],              joint anchor, child body frame, m
//   "sign": "positive torque turns the child body about +axis by the right-hand rule;
//            the parent (housing) receives the equal and opposite reaction",
//   "units": {"t":"s","torque":"N*m"},
//   "t": [...],                           sample times, s (record_hz of the trajectory)
//   "torque": [...],                      joint-side actuator torque at each sample, N*m
//   "peak": {"abs","signed","t"},         over EVERY integration step, not only samples
//   "source": {"trajectory_sha256","model_sha256","mujoco_version","timestep","integrator","record_hz"}
// }
//
// "Joint-side" means after the gear: qfrc_actuator in MuJoCo = gear x actuator
// force. Only the torque about the joint axis is exported. The bearing's radial
// and axial forces and the bending moments a real housing also carries are NOT
// in this shape.

import { findJoint, column } from './analysis.mjs';

export const JOINT_LOAD_FORMAT = 'kinux.joint_load/1';

/**
 * @param {object} traj  a kinux.mj_trajectory/1 object
 * @param {string} jointName
 * @param {{trajectory_sha256?:string, model_sha256?:string}} [refs]
 */
export function exportJointLoad(traj, jointName, refs = {}) {
  const j = findJoint(traj, jointName);
  if (!j) throw new Error(`no joint named ${jointName}`);
  if (j.type !== 'hinge') throw new Error(`joint ${jointName} is ${j.type}; the load export supports hinge joints only`);
  const actuators = traj.actuators.filter(a => a.joint === j.name).map(a => ({ name: a.name, gear: a.gear }));
  if (!actuators.length) throw new Error(`joint ${jointName} has no actuator, so there is no actuator load to export`);
  const peak = traj.peak_qfrc_actuator[j.dof_adr];
  return {
    format: JOINT_LOAD_FORMAT,
    joint: j.name,
    actuators,
    body: j.body,
    parent_body: j.parent_body,
    axis_local: j.axis_local,
    anchor_local: j.anchor_local,
    sign: 'positive torque turns the child body about +axis by the right-hand rule; the parent body (housing) receives the equal and opposite reaction',
    units: { t: 's', torque: 'N*m' },
    t: traj.t,
    torque: column(traj.qfrc_actuator, j.dof_adr),
    peak: { abs: peak.abs, signed: peak.signed, t: peak.t },
    source: {
      trajectory_sha256: refs.trajectory_sha256 ?? null,
      model_sha256: refs.model_sha256 ?? null,
      mujoco_version: traj.mujoco_version,
      timestep: traj.timestep,
      integrator: traj.integrator,
      record_hz: traj.record_hz,
    },
  };
}

/** Structural check of a joint load. Returns a list of problems; [] means valid. */
export function checkJointLoad(load) {
  const p = [];
  const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!load || load.format !== JOINT_LOAD_FORMAT) p.push(`format must be ${JOINT_LOAD_FORMAT}`);
  if (!load) return p;
  if (typeof load.joint !== 'string' || !load.joint) p.push('joint must be a name');
  if (!vec3(load.axis_local)) p.push('axis_local must be 3 finite numbers');
  if (!vec3(load.anchor_local)) p.push('anchor_local must be 3 finite numbers');
  if (!Array.isArray(load.actuators) || !load.actuators.length) p.push('actuators must be non-empty');
  if (load.units?.t !== 's' || load.units?.torque !== 'N*m') p.push('units must be { t: "s", torque: "N*m" }');
  if (!Array.isArray(load.t) || !Array.isArray(load.torque) || load.t.length !== load.torque.length || !load.t.length) p.push('t and torque must be equal-length non-empty arrays');
  else {
    if (!load.t.every(Number.isFinite) || !load.torque.every(Number.isFinite)) p.push('t and torque must be finite');
    for (let i = 1; i < load.t.length; i++) if (!(load.t[i] > load.t[i - 1])) { p.push('t must increase strictly'); break; }
    const seriesMax = Math.max(...load.torque.map(Math.abs));
    if (!(load.peak?.abs >= seriesMax - 1e-12)) p.push('peak.abs must be at least the largest |torque| sample');
    if (Math.abs(Math.abs(load.peak?.signed) - load.peak?.abs) > 1e-12) p.push('peak.signed must have magnitude peak.abs');
  }
  return p;
}

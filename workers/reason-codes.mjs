// One place that says what each reason code means for a verdict (K19).
//
// A check that could not run is NOT_CHECKED or ERROR, never PASS and never FAIL,
// and it always carries a reason_code. Which of the two depends on the code:
//
//   NOT_CHECKED  we looked and cannot say: the model, mesh, contact or material
//                data is missing or unusable, or the check is out of scope.
//   ERROR        something broke while running: a timeout or a tool failure.
//
// Every worker takes its answer from here, so the same failure gives the same
// verdict whichever worker saw it. The codes themselves come from
// contracts/event.schema.json; a test fails if that list gains a code this file
// does not classify.
//
// `tool_missing` is deliberately NOT classified here. ngspice and FEA say ERROR;
// motion and the PCB worker say NOT_CHECKED. That is an open question (STATUS
// K24), and each worker still states its own answer through `toolMissing`.

export const NOT_CHECKED_CODES = new Set([
  'no_model', 'blackbox', 'netlist_unsupported', 'sim_nonconverge', 'out_of_scope',
  'no_material_data', 'mesh_failed', 'mesh_not_converged', 'unsupported_contact',
]);
export const ERROR_CODES = new Set(['timeout', 'tool_error']);

/**
 * @param {string} code
 * @param {'ERROR'|'NOT_CHECKED'} [toolMissing]  how this worker treats `tool_missing`
 * @returns {'ERROR'|'NOT_CHECKED'}
 */
export function verdictForReason(code, toolMissing = 'ERROR') {
  if (code === 'tool_missing') return toolMissing;
  if (NOT_CHECKED_CODES.has(code)) return 'NOT_CHECKED';
  return 'ERROR'; // an unknown code fails closed: still never a pass, never a kill
}

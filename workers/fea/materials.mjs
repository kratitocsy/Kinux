// Material data for the FEA slices. Units are the consistent mm-N-s-tonne
// system CalculiX expects for these models:
//   E           Young's modulus, MPa (N/mm^2)
//   nu          Poisson's ratio, dimensionless
//   density     tonne/mm^3            (steel: 7.85e-9)
//   expansion   1/K                   (steel: 1.2e-5)
//   conductivity  mW/(mm K), numerically equal to W/(m K)  (steel: ~50)
//
// No defaults are ever filled in. A missing or non-physical property is
// reported as no_material_data, never guessed.

export const STEEL = Object.freeze({
  name: 'structural steel (nominal, isotropic)',
  E: 210000, nu: 0.3, density: 7.85e-9, expansion: 1.2e-5, conductivity: 50,
});

const RULES = {
  E: x => x > 0,
  nu: x => x > -1 && x < 0.5,
  density: x => x > 0,
  expansion: x => x > 0,
  conductivity: x => x > 0,
};

/** @returns {{ok:true} | {ok:false, missing:string[], reason:string}} */
export function checkMaterial(material, needs) {
  const missing = [];
  for (const k of needs) {
    const v = material?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || !RULES[k](v)) missing.push(k);
  }
  if (!missing.length) return { ok: true };
  return { ok: false, missing, reason: `material "${material?.name ?? '(unnamed)'}" lacks usable ${missing.join(', ')}` };
}

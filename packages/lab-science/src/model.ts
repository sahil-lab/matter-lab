export const SCIENCE_METHOD_ID = 'aqueous-acid-base-ideal-v1';
export const SCIENCE_METHOD_VERSION = '1.0.0';

export const DEFAULT_ASSUMPTIONS: readonly string[] = Object.freeze([
  'IDEAL_ACTIVITIES',
  'ADDITIVE_VOLUMES',
  'CLOSED_AQUEOUS_SYSTEM',
]);

export const MODEL_LIMITS = Object.freeze({
  temperatureK: 298.15,
  minimumVolumeL: 1e-9,
  maximumVolumeL: 100,
  maximumComponentConcentrationMolL: 0.1,
  maximumTotalAnalyticalConcentrationMolL: 0.2,
  maximumIonicStrengthMolL: 0.100001,
  activityWarningIonicStrengthMolL: 0.01,
  maximumInventoryEntries: 128,
  maximumJsonBytes: 262_144,
});

export const KW = 1e-14;
export const ACETIC_ACID_KA = 1.8e-5;
export const AMMONIA_KB = 1.8e-5;
export const AMMONIUM_KA = KW / AMMONIA_KB;

export const MODEL_LIMITATIONS: readonly string[] = Object.freeze([
  'Ideal aqueous concentration model: all activity coefficients are one; pH is -log10([H3O+]/(1 mol/L)), not a calibrated electrode prediction.',
  'Only 298.15 K is validated. Kw, Ka and Kb are not extrapolated to other temperatures.',
  'At most one weak monoprotic analytical family (acetate OR ammonia) is supported, with sodium/chloride spectator ions.',
  'No polyprotic acids, mixed weak families, arbitrary reactions, precipitation, complexation, gas exchange, evaporation, heat balance or kinetics.',
  'Water is an implicit solvent/proton reservoir. Hydrogen/oxygen of the solvent are not a conserved solute inventory.',
  'The 0.100 mol/L component ceiling and 0.100001 mol/L ionic-strength ceiling (including water ions) are educational eligibility bounds, not guarantees of experimental accuracy.',
  'No validated physical measurement uncertainty is available. Numerical residuals and root brackets are not experimental uncertainty.',
]);

export function getScienceMethod() {
  return {
    id: SCIENCE_METHOD_ID,
    version: SCIENCE_METHOD_VERSION,
    evidence: 'MODEL_CALCULATED' as const,
    assumptions: [...DEFAULT_ASSUMPTIONS],
    limitations: [...MODEL_LIMITATIONS],
    limits: { ...MODEL_LIMITS },
    constants: {
      convention: 'Concentration-form constants: gamma=1 and standard concentration 1 mol/L. Thermodynamic equilibrium constants are dimensionless.',
      waterIonProduct: { value: KW, unit: '(mol/L)^2', temperatureK: 298.15 },
      aceticAcidKa: { value: ACETIC_ACID_KA, unit: 'mol/L', temperatureK: 298.15 },
      ammoniaKb: { value: AMMONIA_KB, unit: 'mol/L', temperatureK: 298.15 },
      ammoniumKa: { value: AMMONIUM_KA, unit: 'mol/L', temperatureK: 298.15 },
    },
  };
}

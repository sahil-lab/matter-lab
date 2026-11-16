import type { EquilibriumInput, EquilibriumResult, JsonObject } from '@matterlab/contracts';
import { speciateAtPH } from './chemistry.js';
import { evaluateIndicators, validateIndicatorIds } from './indicators.js';
import { KW, MODEL_LIMITS, SCIENCE_METHOD_ID } from './model.js';
import { bisect, CHARGE_RESIDUAL_TOLERANCE_MOL_L, ROOT_PH_TOLERANCE, stableSum } from './numerics.js';
import { failure, provenance } from './provenance.js';
import { exceedsLimit, hasOnlyKeys, isRecord, validateAssumptions, validateContents } from './validation.js';

export function solveEquilibrium(input: EquilibriumInput): EquilibriumResult {
  if (!isRecord(input)) return failure('FAILED', 'INVALID_INPUT', 'Expected an EquilibriumInput object.');
  if (!hasOnlyKeys(input, ['contents', 'methodId', 'assumptions', 'indicatorIds'])) {
    return failure('FAILED', 'INVALID_INPUT', 'Unexpected equilibrium options are not silently ignored.');
  }
  if (typeof input.methodId !== 'string') return failure('FAILED', 'INVALID_INPUT', 'methodId is required.');
  if (input.methodId !== SCIENCE_METHOD_ID) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_MODEL', `Unsupported methodId '${input.methodId}'.`);
  }
  const assumptionsFailure = validateAssumptions(input.assumptions);
  if (assumptionsFailure) return assumptionsFailure;
  const indicatorIds = validateIndicatorIds(input.indicatorIds);
  if ('status' in indicatorIds) return indicatorIds;
  const composition = validateContents(input.contents);
  if ('status' in composition) return composition;

  const root = bisect((pH) => speciateAtPH(pH, composition).chargeResidualMolL, -2, 16, ROOT_PH_TOLERANCE);
  if (!root.converged) {
    return failure('FAILED', 'SOLVER_FAILED', 'Electroneutrality root was not bracketed or did not converge.',
      { algorithm: 'bisection-log-hydronium', iterations: root.iterations, functionEvaluations: root.evaluations });
  }
  const equilibrium = speciateAtPH(root.value, composition);
  const sodium = composition.concentrations['ion:sodium'];
  const chloride = composition.concentrations['ion:chloride'];
  const acetateTotal = composition.concentrations['family:acetate'];
  const ammoniaTotal = composition.concentrations['family:ammonia'];
  const acidMassResidual = stableSum([equilibrium.aceticAcid, equilibrium.acetate, -acetateTotal]);
  const baseMassResidual = stableSum([equilibrium.ammonia, equilibrium.ammonium, -ammoniaTotal]);
  const reconstructedChargeResidual = stableSum([
    equilibrium.hydronium, -equilibrium.hydroxide, sodium, -chloride, -equilibrium.acetate, equilibrium.ammonium,
  ]);
  const maximumMassResidual = Math.max(Math.abs(acidMassResidual), Math.abs(baseMassResidual));
  const diagnostics: JsonObject = {
    algorithm: 'bisection-log-hydronium',
    converged: true,
    iterations: root.iterations,
    functionEvaluations: root.evaluations,
    rootBracketPH: [root.lower, root.upper],
    numericalPHBracketWidth: root.upper - root.lower,
    requestedPHBracketTolerance: ROOT_PH_TOLERANCE,
    chargeResidualToleranceMolL: CHARGE_RESIDUAL_TOLERANCE_MOL_L,
    chargeResidualMolL: equilibrium.chargeResidualMolL,
    reconstructedChargeResidualMolL: reconstructedChargeResidual,
    relativeChargeResidual: Math.abs(equilibrium.chargeResidualMolL) / Math.max(2 * equilibrium.ionicStrengthMolL, 1e-30),
    massBalanceResiduals: [
      { componentId: 'family:acetate', residualMolL: acidMassResidual, totalMolL: acetateTotal },
      { componentId: 'family:ammonia', residualMolL: baseMassResidual, totalMolL: ammoniaTotal },
      { componentId: 'ion:sodium', residualMolL: 0, totalMolL: sodium },
      { componentId: 'ion:chloride', residualMolL: 0, totalMolL: chloride },
    ],
    maximumMassResidualMolL: maximumMassResidual,
    waterProductResidualMol2L2: equilibrium.hydronium * equilibrium.hydroxide - KW,
    ionicStrengthMolL: equilibrium.ionicStrengthMolL,
    activityModel: 'IDEAL_GAMMA_1',
    totalAnalyticalConcentrationMolL: composition.totalAnalyticalConcentrationMolL,
    analyticalConcentrations: Object.entries(composition.concentrations).map(([componentId, concentrationMolL]) => ({
      componentId, concentrationMolL,
    })),
    volumeL: composition.contents.volumeL,
    temperatureK: composition.contents.temperatureK,
    pOH: -Math.log10(equilibrium.hydroxide),
    neutralPH: -0.5 * Math.log10(KW),
    physicalUncertainty: 'Not established; no uncertainty field is invented from numerical convergence.',
  };
  if (Math.abs(equilibrium.chargeResidualMolL) > CHARGE_RESIDUAL_TOLERANCE_MOL_L
    || Math.abs(reconstructedChargeResidual) > CHARGE_RESIDUAL_TOLERANCE_MOL_L
    || maximumMassResidual > 1e-12) {
    return failure('FAILED', 'SOLVER_FAILED', 'Numerical mass or charge residual exceeds the declared tolerance.', {
      algorithm: 'bisection-log-hydronium', converged: false, iterations: root.iterations,
      chargeResidualMolL: equilibrium.chargeResidualMolL,
      reconstructedChargeResidualMolL: reconstructedChargeResidual,
      maximumMassResidualMolL: maximumMassResidual,
    });
  }
  if (exceedsLimit(equilibrium.ionicStrengthMolL, MODEL_LIMITS.maximumIonicStrengthMolL)) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      `Equilibrium ionic strength exceeds ${MODEL_LIMITS.maximumIonicStrengthMolL} mol/L; a nonideal model is required.`, {
        ionicStrengthMolL: equilibrium.ionicStrengthMolL,
        maximumIonicStrengthMolL: MODEL_LIMITS.maximumIonicStrengthMolL,
      });
  }
  const indicatorState = evaluateIndicators(indicatorIds, root.value);
  if ('status' in indicatorState) return indicatorState;
  const warnings: string[] = [];
  if (equilibrium.ionicStrengthMolL > MODEL_LIMITS.activityWarningIonicStrengthMolL) {
    warnings.push('IDEAL_ACTIVITY_LIMIT: Ionic strength exceeds 0.01 mol/L. Neglected activities may materially affect experimental pH; no error bound is claimed.');
  }
  if (indicatorIds.length > 0) {
    warnings.push('TRACE_INDICATOR_MODEL: Indicator fractions use an effective trace equilibrium; sRGB colors are illustrative, not spectroscopic measurements.');
  }
  const sourceIds = ['openstax-chem2e-14-2', ...indicatorState.sourceIds];
  if (acetateTotal > 0 || ammoniaTotal > 0) sourceIds.push('openstax-chem2e-14-3');
  const equilibriumSpecies: { speciesId: string; concentrationMolL: number }[] = [
    { speciesId: 'ion:hydronium', concentrationMolL: equilibrium.hydronium },
    { speciesId: 'ion:hydroxide', concentrationMolL: equilibrium.hydroxide },
  ];
  if (sodium > 0) equilibriumSpecies.push({ speciesId: 'ion:sodium', concentrationMolL: sodium });
  if (chloride > 0) equilibriumSpecies.push({ speciesId: 'ion:chloride', concentrationMolL: chloride });
  if (acetateTotal > 0) {
    equilibriumSpecies.push(
      { speciesId: 'molecule:acetic-acid', concentrationMolL: equilibrium.aceticAcid },
      { speciesId: 'ion:acetate', concentrationMolL: equilibrium.acetate },
    );
  }
  if (ammoniaTotal > 0) {
    equilibriumSpecies.push(
      { speciesId: 'molecule:ammonia', concentrationMolL: equilibrium.ammonia },
      { speciesId: 'ion:ammonium', concentrationMolL: equilibrium.ammonium },
    );
  }
  return {
    ...provenance({ ...diagnostics, indicators: indicatorState.diagnostics }, sourceIds, warnings),
    status: 'SUCCEEDED',
    evidence: 'MODEL_CALCULATED',
    pH: { value: root.value, unit: 'pH' },
    equilibriumSpecies,
    indicators: indicatorState.indicators,
  };
}

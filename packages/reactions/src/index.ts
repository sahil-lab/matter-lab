/**
 * @matterlab/reactions - reaction stoichiometry, reference-data thermodynamics and rate-law kinetics.
 *
 * Three rules hold throughout:
 *  - nothing here predicts that substances react; every function works on an equation or a model that the
 *    caller supplies;
 *  - every reference number was read by script from a saved copy of a cited source (see README.md);
 *  - every result says how it was obtained (`evidence`, `provenance`) and anything outside what a model was
 *    validated for comes back with a status and warnings rather than a silent extrapolation.
 */

// --- formulas and equations ---------------------------------------------------------------------------
export { ChemicalSyntaxError, hillFormula, molarMass, normalizeFormulaText, parseFormula } from './formula';
export type { ParsedFormula } from './formula';
export {
  PHASE_LABELS,
  checkConservation,
  formatCoefficient,
  formatEquation,
  formatTerm,
  parseEquation,
  reverseEquation,
  scaleEquation,
} from './equation';
export type { ConservationReport, Phase, ReactionEquation, SpeciesTerm } from './equation';
export { balanceEquation } from './balance';
export type { BalanceResult } from './balance';

// --- thermodynamic reference data ----------------------------------------------------------------------
export {
  ENTHALPY_UNIT,
  ENTROPY_UNIT,
  THERMO_DATA_SOURCES,
  THERMO_OMITTED_ROWS,
  THERMO_SPECIES,
  findThermoSpecies,
  lookupThermoSpecies,
} from './thermo/species';
export type { ThermoDataSource, ThermoLookup, ThermoSpecies } from './thermo/species';
export { LIQUID_WATER_RANGE_K, THERMO_NO_WARNING_SPAN_K, THERMO_VALIDATED_SPAN_K, reactionThermodynamics } from './thermo/reaction';
export type { ReactionThermo, ReactionThermoTerm } from './thermo/reaction';

// --- kinetics -------------------------------------------------------------------------------------------
export {
  KINETIC_DATA_SOURCES,
  KINETIC_MODELS,
  MOLECULES_PER_CM3_PER_MOL_PER_L,
  findKineticModels,
  kineticEvidence,
  rateConstant,
  toMolarUnits,
} from './kinetics/models';
export type { KineticModel, RateConstantResult } from './kinetics/models';
export { KINETICS_SOLVER_METHOD, powerLawDecay, powerLawHalfLife, secondOrderTwoReactants, simulateKinetics } from './kinetics/simulate';
export type { KineticsHooks, KineticsInput, KineticsResult } from './kinetics/simulate';
export { integrateOde } from './kinetics/ode';
export type { OdeOptions, OdeResult } from './kinetics/ode';

// --- catalogue for the UI --------------------------------------------------------------------------------
export { SUPPORTED_REACTION_CLASSES, UNSUPPORTED_FEATURES, reactionSupport } from './catalogue';
export type { ReactionClassInfo, ReactionSupport, UnsupportedFeature } from './catalogue';

// --- the experiment pipeline of the Reaction Laboratory ---------------------------------------------------
export {
  EXPERIMENT_CONCENTRATION_UNITS,
  EXPERIMENT_ENGINE,
  EXPERIMENT_ENGINE_VERSION,
  EXPERIMENT_ENVIRONMENTS,
  EXPERIMENT_METHODS,
  EXPERIMENT_PRESETS,
  EXPERIMENT_RESULT_SCHEMA,
  EXPERIMENT_RESULT_SCHEMA_VERSION,
  EXPERIMENT_STATUSES,
  EXPERIMENT_STEP_IDS,
  EXPERIMENT_STEP_TITLES,
  EXPLANATION_HEADINGS,
  KINETIC_PRESSURE_MATCH_TOLERANCE,
  LIMITATION_PHRASES,
  REACTION_CATALOGUE,
  SPECIES_ROLES,
  canonicalJson,
  normaliseInput,
  parseExperimentResult,
  runExperiment,
  serializeExperimentResult,
  sha256Hex,
  suggestReactions,
} from './experiment';
export type {
  CataloguedReaction,
  EnergyDiagram,
  EnergyLevel,
  ExperimentConcentrationUnit,
  ExperimentConditions,
  ExperimentDataSource,
  ExperimentEnvironment,
  ExperimentInput,
  ExperimentMethod,
  ExperimentPreset,
  ExperimentResult,
  ExperimentSolverSettings,
  ExperimentSpecies,
  ExperimentStatus,
  ExperimentStep,
  ExperimentStepId,
  ExplanationSection,
  ExplanationTopic,
  RunExperimentOptions,
  SpeciesRole,
} from './experiment';

// --- shapes of the generated data ------------------------------------------------------------------------
export type { KineticSourceId, ThermoSourceId } from './data/records';

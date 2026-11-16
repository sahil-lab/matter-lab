/**
 * The headless "experiment" pipeline of the Reaction Laboratory: one deterministic, serialisable function
 * that takes the species and conditions a user entered and returns everything an interface has to show.
 */
export { runExperiment } from './run';
export { parseExperimentResult, serializeExperimentResult } from './serialize';
export { REACTION_CATALOGUE, suggestReactions } from './suggest';
export { EXPERIMENT_PRESETS } from './presets';
export { EXPLANATION_HEADINGS } from './explain';
export type { ExplanationTopic } from './explain';
export { LIMITATION_PHRASES } from './limitations';
export { KINETIC_PRESSURE_MATCH_TOLERANCE } from './plan';
export { canonicalJson } from './canonical';
export { sha256Hex } from './sha256';
export { normaliseInput } from './input';
export {
  EXPERIMENT_CONCENTRATION_UNITS,
  EXPERIMENT_ENGINE,
  EXPERIMENT_ENGINE_VERSION,
  EXPERIMENT_ENVIRONMENTS,
  EXPERIMENT_METHODS,
  EXPERIMENT_RESULT_SCHEMA,
  EXPERIMENT_RESULT_SCHEMA_VERSION,
  EXPERIMENT_STATUSES,
  EXPERIMENT_STEP_IDS,
  EXPERIMENT_STEP_TITLES,
  SPECIES_ROLES,
} from './types';
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
  RunExperimentOptions,
  SpeciesRole,
} from './types';

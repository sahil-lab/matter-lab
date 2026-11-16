import type { Citation, EvidenceLevel } from '@matterlab/core';
import type { BalanceResult } from '../balance';
import type { Phase, ReactionEquation } from '../equation';
import type { KineticModel, RateConstantResult } from '../kinetics/models';
import type { KineticsResult } from '../kinetics/simulate';
import type { ReactionThermo } from '../thermo/reaction';

// --- input ------------------------------------------------------------------------------------------------

export type SpeciesRole = 'reactant' | 'product' | 'catalyst' | 'solvent';

export interface ExperimentSpecies {
  /** The formula as typed by the user, e.g. "CH4" or "SO4^2-"; without a phase label. */
  readonly formula: string;
  readonly phase?: Phase;
  readonly role: SpeciesRole;
  readonly name?: string;
  /** In `conditions.concentrationUnit`; used by kinetics only. */
  readonly initialConcentration?: number;
  /**
   * Stoichiometric coefficient. Normally left out: the coefficients are then found by conservation of atoms
   * and charge. Give one for every reactant and product to fix the proportions yourself, which is needed
   * when conservation leaves them open, or to write the equation at another scale ("1/2 O2").
   */
  readonly coefficient?: number;
}

export type ExperimentEnvironment = 'gas-phase' | 'aqueous-solution' | 'unspecified';
export type ExperimentMethod = 'auto' | 'stoichiometry' | 'thermodynamics' | 'kinetics';
export type ExperimentConcentrationUnit = 'molecule/cm3' | 'mol/L';

export interface ExperimentConditions {
  readonly temperatureK: number;
  readonly pressureBar: number;
  readonly durationSeconds: number;
  readonly environment: ExperimentEnvironment;
  readonly concentrationUnit: ExperimentConcentrationUnit;
}

/** Optional settings of the kinetics integrator; the defaults are those of `simulateKinetics`. */
export interface ExperimentSolverSettings {
  /** Error tolerance of the integration, 1e-13 to 1e-3 (default 1e-8). */
  readonly tolerance?: number;
  /** Limit on the number of step attempts (default 200 000). */
  readonly maxSteps?: number;
  /** Number of equally spaced output times, including the start and the end (default 201). */
  readonly outputPoints?: number;
}

export interface ExperimentInput {
  readonly title?: string;
  /** The order of the species is the order in which they are written in the equation. */
  readonly species: readonly ExperimentSpecies[];
  readonly conditions: ExperimentConditions;
  /** `auto` does everything the data support. */
  readonly method: ExperimentMethod;
  readonly solver?: ExperimentSolverSettings;
}

// --- output -----------------------------------------------------------------------------------------------

export type ExperimentStepId = 'validate-species' | 'conservation' | 'model-selection' | 'reference-data' | 'engine' | 'calculation' | 'limitations';

export interface ExperimentStep {
  readonly id: ExperimentStepId;
  readonly title: string;
  /**
   * - `passed`: done, nothing to report.
   * - `warning`: done, with something the reader must know.
   * - `failed`: the step could not do what it is for; `summary` says why.
   * - `skipped`: not run, because it was not needed, an earlier step ended the experiment, or the run was cancelled.
   */
  readonly status: 'passed' | 'warning' | 'failed' | 'skipped';
  /** One sentence. */
  readonly summary: string;
  /** Zero or more further sentences. */
  readonly details: readonly string[];
}

/** One block of an explanation; the shape of the explanation panel of the app. */
export interface ExplanationSection {
  readonly heading: string;
  /** May use **double asterisks** for emphasis; no other markup. */
  readonly paragraphs: readonly string[];
  /** Plain-text formula, e.g. "ΔG = ΔH − TΔS". */
  readonly equation?: string;
  readonly evidence?: EvidenceLevel;
}

export interface EnergyLevel {
  readonly kind: 'reactants' | 'barrier' | 'products';
  readonly label: string;
  /** Relative to the reactants, which are at 0. */
  readonly value: number;
  readonly evidence: EvidenceLevel;
  readonly note?: string;
}

export interface EnergyDiagram {
  readonly quantity: 'enthalpy' | 'gibbs';
  readonly unit: 'kJ/mol';
  /** Empty when nothing can honestly be drawn; `notes` then says why. */
  readonly levels: readonly EnergyLevel[];
  readonly notes: readonly string[];
}

export type ExperimentStatus = 'completed' | 'partial' | 'unsupported' | 'invalid' | 'cancelled';

export interface ExperimentDataSource {
  readonly id: string;
  readonly title: string;
  /** ISO date on which the source was retrieved. */
  readonly retrieved?: string;
  /** SHA-256 of the page or document as retrieved. */
  readonly sha256?: string;
}

export interface ExperimentResult {
  readonly schema: 'matterlab.experiment-result';
  readonly schemaVersion: 1;
  /** Normalised copy of what was run. */
  readonly input: ExperimentInput;
  /** SHA-256 (hex) of the canonical JSON of `input` (keys sorted). */
  readonly inputHash: string;
  /**
   * - `completed`: everything that was asked for was calculated.
   * - `partial`: something is shown, but less than was asked for or than the data would in principle allow.
   * - `unsupported`: the experiment is well-formed, but what was asked for cannot be calculated.
   * - `invalid`: the input cannot be run as given; nothing was calculated.
   * - `cancelled`: `shouldCancel` returned true; only the steps finished before that are reported.
   */
  readonly status: ExperimentStatus;
  /** The weakest evidence level among the results shown; `unsupported` when there are none. */
  readonly evidence: EvidenceLevel;
  /** Always all seven steps, in order. */
  readonly steps: readonly ExperimentStep[];
  /** The uniquely balanced equation; `null` when there is none (see `balance`). */
  readonly equation: { readonly text: string; readonly balanced: ReactionEquation; readonly balance: BalanceResult } | null;
  /**
   * Outcome of balancing whenever it was attempted, also when no unique balanced equation exists
   * (`impossible`, `underdetermined`); `null` when balancing was not reached.
   */
  readonly balance: BalanceResult | null;
  readonly thermo: ReactionThermo | null;
  /** The kinetic model that was used, in the concentration unit of the experiment. */
  readonly kineticModel: KineticModel | null;
  readonly rateConstant: RateConstantResult | null;
  readonly kinetics: KineticsResult | null;
  /** Enthalpy and, when available, Gibbs energy. */
  readonly energyDiagrams: readonly EnergyDiagram[];
  readonly explanation: {
    readonly beginner: readonly ExplanationSection[];
    readonly advanced: readonly ExplanationSection[];
    /** Only the sources actually used by this result. */
    readonly references: readonly Citation[];
  };
  readonly warnings: readonly string[];
  readonly limitations: readonly string[];
  readonly reproducibility: {
    readonly engine: '@matterlab/reactions';
    readonly engineVersion: string;
    /** The pages and documents the numbers of this result were read from. */
    readonly dataSources: readonly ExperimentDataSource[];
    readonly solver: { readonly method: string; readonly tolerance: number; readonly steps: number; readonly functionEvaluations?: number } | null;
    readonly deterministic: true;
  };
}

export interface RunExperimentOptions {
  /** Called with a strictly increasing fraction between 0 and 1 and the step that is running. */
  readonly onProgress?: (fraction: number, step: ExperimentStepId) => void;
  /** Asked before every step and after every accepted integration step; return true to stop. */
  readonly shouldCancel?: () => boolean;
}

// --- catalogue and presets --------------------------------------------------------------------------------

export interface CataloguedReaction {
  readonly id: string;
  /** Balanced equation in a form `parseEquation` reads. */
  readonly equation: string;
  readonly title: string;
  /** Identifier of an entry of `SUPPORTED_REACTION_CLASSES`. */
  readonly reactionClass: string;
  /** True when at least the reaction enthalpy can be computed from the reference table. */
  readonly hasThermo: boolean;
  /** True when a sourced rate law for exactly this reaction is shipped. */
  readonly hasKinetics: boolean;
  /** Says that this is a catalogue lookup of a known reaction, not a prediction, and what can be calculated. */
  readonly note: string;
  /** Identifier of the kinetic model, when `hasKinetics` is true. */
  readonly kineticModelId?: string;
}

export interface ExperimentPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Identifier of an entry of `SUPPORTED_REACTION_CLASSES`. */
  readonly reactionClass: string;
  readonly input: ExperimentInput;
  /** The status `runExperiment(input)` returns; checked by the test suite. */
  readonly expectedStatus: ExperimentStatus;
  /** What the preset is meant to show. */
  readonly demonstrates: string;
}

// --- constants --------------------------------------------------------------------------------------------

export const EXPERIMENT_RESULT_SCHEMA = 'matterlab.experiment-result';
export const EXPERIMENT_RESULT_SCHEMA_VERSION = 1;
export const EXPERIMENT_ENGINE = '@matterlab/reactions';
/** Version of this package; the test suite checks it against package.json. */
export const EXPERIMENT_ENGINE_VERSION = '0.1.0';

export const EXPERIMENT_STEP_IDS: readonly ExperimentStepId[] = ['validate-species', 'conservation', 'model-selection', 'reference-data', 'engine', 'calculation', 'limitations'];

export const EXPERIMENT_STEP_TITLES: Readonly<Record<ExperimentStepId, string>> = {
  'validate-species': 'Validate the species and conditions',
  conservation: 'Check conservation of atoms and charge',
  'model-selection': 'Select the models that apply',
  'reference-data': 'Look up the reference data',
  engine: 'Name the calculation engine',
  calculation: 'Run the calculation',
  limitations: 'State the limitations',
};

export const SPECIES_ROLES: readonly SpeciesRole[] = ['reactant', 'product', 'catalyst', 'solvent'];
export const EXPERIMENT_ENVIRONMENTS: readonly ExperimentEnvironment[] = ['gas-phase', 'aqueous-solution', 'unspecified'];
export const EXPERIMENT_METHODS: readonly ExperimentMethod[] = ['auto', 'stoichiometry', 'thermodynamics', 'kinetics'];
export const EXPERIMENT_CONCENTRATION_UNITS: readonly ExperimentConcentrationUnit[] = ['molecule/cm3', 'mol/L'];
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['completed', 'partial', 'unsupported', 'invalid', 'cancelled'];

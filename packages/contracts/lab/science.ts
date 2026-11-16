import type { Evidence, JsonObject, ProblemDetails, Quantity, UUID } from './common.ts';
import type { ContainerContents, MixingState } from './scene.ts';

export interface ScientificProvenance {
  readonly methodId: string;
  readonly methodVersion: string;
  readonly sourceIds: readonly string[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly diagnostics: JsonObject;
}
export interface EquilibriumInput {
  readonly contents: ContainerContents;
  readonly methodId: string;
  readonly assumptions: readonly string[];
  readonly indicatorIds?: readonly string[];
}
export interface EquilibriumSpecies {
  readonly speciesId: string;
  readonly concentrationMolL: number;
}
export interface IndicatorResult {
  readonly indicatorId: string;
  readonly baseFraction: number;
  readonly colorSrgb: readonly [number, number, number];
  readonly colorEvidence: 'ILLUSTRATIVE';
  readonly sourceIds: readonly string[];
}
export type ScientificFailure =
  | { readonly status: 'UNSUPPORTED'; readonly evidence: 'UNSUPPORTED'; readonly error: ProblemDetails }
  | { readonly status: 'FAILED'; readonly evidence: 'UNVERIFIED'; readonly error: ProblemDetails };
export type EquilibriumResult = ScientificProvenance & (
  | {
      readonly status: 'SUCCEEDED';
      readonly evidence: 'MODEL_CALCULATED';
      readonly pH: Quantity<'pH'>;
      readonly equilibriumSpecies: readonly EquilibriumSpecies[];
      readonly indicators: readonly IndicatorResult[];
    }
  | ScientificFailure
);
export type EquilibriumSolver = (input: EquilibriumInput) => EquilibriumResult;
export type AsyncEquilibriumSolver = (input: EquilibriumInput) => Promise<EquilibriumResult>;
export interface PreparationInput {
  readonly reagentId: string;
  readonly volumeL: number;
  readonly concentrationMolL: number;
  readonly temperatureK?: number;
  readonly mixing?: MixingState;
}
export type PreparationResult = ScientificProvenance & (
  | { readonly status: 'SUCCEEDED'; readonly evidence: 'MODEL_CALCULATED'; readonly contents: ContainerContents }
  | ScientificFailure
);

export interface ObservationQuantities {
  readonly PH: Quantity<'pH'>;
  readonly TEMPERATURE: Quantity<'K'>;
  readonly VOLUME: Quantity<'L'>;
  readonly CONCENTRATION: Quantity<'mol/L'>;
  readonly INDICATOR: Quantity<'1'>;
  readonly MASS: Quantity<'kg'>;
}
export type ObservationType = keyof ObservationQuantities;
export interface CumulativeTransfer {
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly deliveredVolumeL: number;
}
export type Observation = {
  [Type in ObservationType]: {
    readonly type: Type;
    readonly apparatusId?: UUID;
    readonly stationId?: UUID;
    readonly timeS: number;
    readonly quantity: ObservationQuantities[Type];
    readonly evidence: Evidence;
    readonly methodId: string;
    readonly methodVersion?: string;
    readonly sourceIds: readonly string[];
    readonly speciesId?: string;
    readonly indicatorId?: string;
    readonly titration?: CumulativeTransfer;
  } & (Type extends 'INDICATOR' ? { readonly indicatorState?: IndicatorResult } : {});
}[ObservationType];
export interface ObservationRecord {
  readonly id: UUID;
  readonly runId: UUID;
  readonly stationId: UUID;
  readonly epoch: number;
  readonly sequence: number;
  readonly observation: Observation;
}
interface RunResultBase {
  readonly runId: UUID;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly inputHash: string;
  readonly observations: readonly Observation[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly limitations?: readonly string[];
  readonly solverDiagnostics?: JsonObject;
}
export type RunResult = RunResultBase & (
  | { readonly status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'CANCELLED' }
  | { readonly status: 'FAILED' | 'UNSUPPORTED'; readonly error: ProblemDetails }
);
export type TerminalRunResult = RunResult & { readonly status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNSUPPORTED' };

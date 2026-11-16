import type { JsonObject, Transform, UUID } from './common.ts';

export const APPARATUS_KINDS = [
  'BENCH', 'STAND', 'CLAMP', 'BURETTE', 'FLASK', 'BEAKER', 'PIPETTE',
  'STIRRER', 'PH_PROBE', 'BALANCE', 'OTHER',
] as const;
export type ApparatusKind = (typeof APPARATUS_KINDS)[number];
export const CAPABILITIES = [
  'CONTAINER', 'FLOW_SOURCE', 'FLOW_RECEIVER', 'MOUNT', 'MOUNTABLE',
  'HEATING', 'STIRRING', 'PH_SENSOR', 'MEASUREMENT',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CONNECTION_KINDS = ['MECHANICAL', 'FLUID', 'SENSOR', 'CONTROL'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface ApparatusInstance {
  readonly id: UUID;
  readonly kind: ApparatusKind;
  readonly definitionId: string;
  readonly transform: Transform;
  readonly revision: number;
  readonly config: JsonObject;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
}
export interface SocketEndpoint {
  readonly instanceId: UUID;
  readonly socketId: string;
}
export interface Connection {
  readonly id: UUID;
  readonly from: SocketEndpoint;
  readonly to: SocketEndpoint;
  readonly kind: ConnectionKind;
  readonly enabled: boolean;
}
export interface SpeciesAmount {
  /** A science-resolved analytical component, not a transient equilibrium concentration. */
  readonly speciesId: string;
  readonly moles: number;
  readonly sourceId?: string;
}
export type MixingState = 'WELL_MIXED' | 'UNMIXED';
export interface ContainerContents {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly mixing: MixingState;
  readonly modelId: string;
}
export interface Station {
  readonly id: UUID;
  readonly name: string;
}
export interface SimulationConfig {
  readonly methodId: string;
  readonly timeStepS: number;
}
export interface ExperimentScene {
  readonly id: UUID;
  /** Durable save revision (API If-Match), NOT the local runtime revision. */
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly stations: readonly Station[];
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  readonly containerStates: Readonly<Record<UUID, ContainerContents>>;
  readonly simulationConfig: SimulationConfig;
  readonly viewport?: JsonObject;
}
export interface ExperimentAssembly {
  readonly id: UUID;
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description: string;
  readonly scene: ExperimentScene;
  readonly sourceIds: readonly string[];
}

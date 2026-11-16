import type { JsonObject, Transform, UUID } from './common.ts';
import type { ApparatusInstance, Connection, ContainerContents } from './scene.ts';

export interface LabActionPayloads {
  readonly PLACE: { readonly instance: ApparatusInstance };
  readonly MOVE: { readonly transform: Transform };
  readonly ATTACH: { readonly connection: Connection };
  readonly DETACH: { readonly connectionId: UUID };
  readonly FILL: {
    readonly contents: ContainerContents;
    readonly preparation: { readonly kind: 'INITIAL' | 'EXTERNAL'; readonly sourceId: string };
  };
  readonly SET_VALVE: { readonly openingFraction: number };
  readonly TRANSFER: {
    readonly sourceInstanceId: UUID;
    readonly targetInstanceId: UUID;
    readonly volumeL: number;
    readonly connectionId: UUID;
  };
  readonly START_STIRRER: { readonly enabled: boolean; readonly frequencyHz: number };
  readonly SET_PROBE: { readonly containerInstanceId: UUID | null };
  readonly RESET: { readonly scope: 'STATION' | 'SCENE' };
  readonly CUSTOM: { readonly pluginId: string; readonly actionType: string; readonly data: JsonObject };
}
export type LabActionType = keyof LabActionPayloads;
export type LabActionOf<Type extends LabActionType> = {
  readonly actionId: UUID;
  readonly atSimulationS: number;
  readonly targetInstanceId: UUID;
  readonly type: Type;
  readonly payload: LabActionPayloads[Type];
  readonly actorId?: UUID;
  /** Local RuntimeSnapshot.revision, never ExperimentScene.revision / HTTP If-Match. */
  readonly expectedRevision?: number;
  readonly expectedEpoch?: number;
};
export type LabAction = {
  [Type in LabActionType]: LabActionOf<Type>;
}[LabActionType];

export type RuntimeControl = {
  readonly controlId: UUID;
  readonly stationId: UUID;
  readonly atSimulationS: number;
  readonly expectedEpoch?: number;
} & (
  | { readonly type: 'PAUSE' | 'RESUME'; readonly payload: Readonly<Record<string, never>> }
  | { readonly type: 'SET_SPEED'; readonly payload: { readonly speed: number } }
);
export type ReplayStep =
  | { readonly kind: 'ACTION'; readonly action: LabAction }
  | { readonly kind: 'ADVANCE'; readonly stationId: UUID; readonly ticks: number }
  | { readonly kind: 'CONTROL'; readonly control: RuntimeControl };

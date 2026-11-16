import type { BoundsM, Evidence, JsonObject, Transform, Vec3M } from './common.ts';
import type { ApparatusKind, Capability, ConnectionKind } from './scene.ts';

export type ConfigField =
  | {
      readonly type: 'number';
      readonly unit: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    }
  | { readonly type: 'boolean'; readonly default?: boolean }
  | {
      readonly type: 'string';
      readonly enum?: readonly string[];
      readonly maxLength?: number;
      readonly default?: string;
    };
export interface ConfigSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ConfigField>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}
export interface SocketCompatibility {
  readonly key: string;
  readonly accepts: readonly string[];
  readonly requiredCapabilities?: readonly Capability[];
  readonly allowedKinds?: readonly ApparatusKind[];
  readonly requiredTags?: readonly string[];
}
export interface SocketDefinition {
  readonly id: string;
  readonly kind: ConnectionKind;
  readonly localTransform: Transform;
  readonly direction: 'IN' | 'OUT' | 'BIDIRECTIONAL';
  readonly gender: 'MALE' | 'FEMALE' | 'NEUTRAL';
  readonly compatibility: SocketCompatibility;
  readonly maxConnections: number;
  readonly highlightAnchorM?: Vec3M;
  readonly alignmentToleranceM?: number;
}
export interface VesselCalibration {
  readonly capacityL: number;
  readonly maxFillHeightM: number;
  readonly interiorProfile: readonly { readonly yM: number; readonly radiusM: number }[];
  /** Explicit visual calibration: authoritative volume in L -> local liquid height in m. */
  readonly volumeHeightCurve: readonly { readonly volumeL: number; readonly heightM: number }[];
  readonly graduations?: {
    readonly minorStepL: number;
    readonly majorStepL: number;
    readonly startHeightM: number;
    readonly endHeightM: number;
    readonly reading: 'CONTAINED' | 'DELIVERED';
    readonly direction: 'UP' | 'DOWN';
  };
  readonly meniscus: { readonly reference: 'BOTTOM' | 'TOP'; readonly offsetM: number };
  readonly evidence: Evidence;
  readonly sourceIds: readonly string[];
  readonly assumptions: readonly string[];
}
export interface ApparatusControl {
  readonly id: string;
  readonly label: string;
  readonly actionType: 'FILL' | 'SET_VALVE' | 'TRANSFER' | 'START_STIRRER' | 'SET_PROBE' | 'CUSTOM';
  readonly fields: Readonly<Record<string, ConfigField>>;
}
export interface FlowModelDefinition {
  readonly methodId: string;
  readonly maxFlowLPerS: number;
  readonly assumptions: readonly string[];
}
export interface ApparatusAsset {
  readonly kind: 'PROCEDURAL' | 'GLTF';
  readonly uri?: string;
  readonly thumbnailUri?: string;
  readonly previewFocusM?: Vec3M;
  readonly license: string;
  readonly attribution: string;
  readonly triangleCount: number;
  readonly textureBytes: number;
  readonly sourceIds: readonly string[];
  readonly status: 'COMPLETE' | 'DEVELOPMENT_PLACEHOLDER';
}
export interface ApparatusDefinition {
  readonly id: string;
  readonly version: string;
  readonly schemaVersion: 1;
  readonly kind: ApparatusKind;
  readonly label: string;
  readonly category: string;
  readonly capabilities: readonly Capability[];
  readonly dimensionsM: Vec3M;
  readonly boundsM: BoundsM;
  readonly permittedTransforms: {
    readonly translation: readonly ('X' | 'Y' | 'Z')[];
    readonly rotation: readonly ('X' | 'Y' | 'Z')[];
  };
  readonly sockets: readonly SocketDefinition[];
  readonly controls: readonly ApparatusControl[];
  readonly configSchema: ConfigSchema;
  readonly defaultConfig: JsonObject;
  readonly tags?: readonly string[];
  readonly capacityL?: number;
  readonly vesselCalibration?: VesselCalibration;
  readonly flowModel?: FlowModelDefinition;
  readonly massKg?: number;
  readonly maxSupportedMassKg?: number;
  readonly visual?: ApparatusAsset;
}

/** Read-only access; Agent 03 owns registration/assets, Agent 07 owns capability execution. */
export interface ApparatusDefinitionReader {
  getDefinition(id: string): ApparatusDefinition | undefined;
  listDefinitions(): readonly ApparatusDefinition[];
}

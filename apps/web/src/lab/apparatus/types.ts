/**
 * Apparatus domain model — Agent 03 (Apparatus Modeling Engineer).
 *
 * This file defines what an "apparatus" is: both a rendered 3D object and a typed scientific
 * capability. Two groups of types live here:
 *
 * 1. A local mirror of the handful of runtime types from `00_SHARED_INTEGRATION_CONTRACT.md`
 *    §3 (`UUID`, `Evidence`, `Quantity`, `Transform`, the base `ApparatusKind`/`Capability`
 *    members, `ApparatusInstance`, `Connection`). `packages/contracts/lab/**` is the long-term
 *    home for these (owned jointly by Agent 07 and Agent 09); it does not exist yet, so this
 *    module defines a compatible copy rather than blocking on it. When that package lands, this
 *    block should be replaced by an import from there — the shapes are deliberately identical.
 * 2. The definition-level types this agent is responsible for designing: `SocketDefinition`,
 *    `ControlDefinition`, `ApparatusDefinition` and their supporting pieces. These do not exist
 *    in the shared contract; Section 1 of `Agent_03_Apparatus_Assets_and_Capability_Definitions.md`
 *    asks for exactly this.
 *
 * Nothing in this module (or anywhere under `lab/apparatus/**`) mutates experiment state. Every
 * function here is pure: given a definition (and, where relevant, an instance snapshot), it
 * returns data or validates data. Agent 07's reducer is the only writer of apparatus/chemical
 * state (shared contract §4).
 */

// ---------------------------------------------------------------------------------------------
// 1. Shared-contract mirror (keep in sync with 00_SHARED_INTEGRATION_CONTRACT.md §3)
// ---------------------------------------------------------------------------------------------

export type UUID = string;

/** Evidence labels from the shared contract. See also `@matterlab/core`'s `EvidenceLevel`, which
 * labels existing v1 scientific results; this is the lab-extension spelling used by Agents 1-10. */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

/** World or local-space pose. Position is in meters; rotation is a normalized quaternion [x,y,z,w]. */
export interface Transform {
  readonly positionM: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

export const IDENTITY_TRANSFORM: Transform = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] };

/** Base apparatus kinds defined by the shared contract. Do not rename or remove these. */
export type SharedApparatusKind =
  | 'BENCH'
  | 'STAND'
  | 'CLAMP'
  | 'BURETTE'
  | 'FLASK'
  | 'BEAKER'
  | 'PIPETTE'
  | 'STIRRER'
  | 'PH_PROBE'
  | 'BALANCE'
  | 'OTHER';

/**
 * P1-library kinds this agent needs that are not in the shared contract's `ApparatusKind` yet.
 * Additive only — flagged in the module README for Agent 07/09/10 reconciliation, per the
 * orchestration rule "stub anything missing additively". Anything typed `OTHER` in the shared
 * union still works; these give the richer palette more specific, filterable identities.
 */
export type ProposedApparatusKind =
  | 'BOTTLE'
  | 'TEST_TUBE'
  | 'VOLUMETRIC_FLASK'
  | 'DROPPER'
  | 'GRADUATED_CYLINDER'
  | 'FUNNEL'
  | 'SUPPORT_RING'
  | 'LAB_JACK'
  | 'THERMOMETER'
  | 'CONDUCTIVITY_METER'
  | 'TEMPERATURE_SENSOR';

export type ApparatusKind = SharedApparatusKind | ProposedApparatusKind;

/** Base capabilities defined by the shared contract. Do not rename or remove these. */
export type SharedCapability =
  | 'CONTAINER'
  | 'FLOW_SOURCE'
  | 'FLOW_RECEIVER'
  | 'MOUNT'
  | 'MOUNTABLE'
  | 'HEATING'
  | 'STIRRING'
  | 'PH_SENSOR'
  | 'MEASUREMENT';

/** Proposed, additive capabilities for P1 instruments. See note on `ProposedApparatusKind`. */
export type ProposedCapability = 'TEMPERATURE_SENSOR' | 'CONDUCTIVITY_SENSOR' | 'SURFACE_SUPPORT' | 'OPTICAL_SENSOR';

export type Capability = SharedCapability | ProposedCapability;

/** Connection kinds from the shared contract (`Connection.kind`). */
export type ConnectionKind = 'MECHANICAL' | 'FLUID' | 'SENSOR' | 'CONTROL';

/** A runtime placement of a definition in a scene. Mirrors shared contract `ApparatusInstance`. */
export interface ApparatusInstance {
  readonly id: UUID;
  readonly kind: ApparatusKind;
  readonly definitionId: string;
  readonly transform: Transform;
  readonly revision: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
}

/** A socket-to-socket attachment edge. Mirrors shared contract `Connection`. */
export interface Connection {
  readonly id: UUID;
  readonly from: { readonly instanceId: UUID; readonly socketId: string };
  readonly to: { readonly instanceId: UUID; readonly socketId: string };
  readonly kind: ConnectionKind;
  readonly enabled: boolean;
}

/** Action types from the shared contract (`LabAction.type`). */
export type LabActionType =
  | 'PLACE'
  | 'MOVE'
  | 'ATTACH'
  | 'DETACH'
  | 'FILL'
  | 'SET_VALVE'
  | 'TRANSFER'
  | 'START_STIRRER'
  | 'SET_PROBE'
  | 'RESET'
  | 'CUSTOM';

/** A single authored event. Mirrors shared contract `LabAction`. Agent 07 is the sole consumer
 * and interpreter of these; this module only ever *builds* them (see `controls.ts`). */
export interface LabAction {
  readonly actionId: UUID;
  readonly atSimulationS: number;
  readonly targetInstanceId: UUID;
  readonly type: LabActionType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actorId?: UUID;
}

// ---------------------------------------------------------------------------------------------
// 2. Apparatus definition model (this agent's design)
// ---------------------------------------------------------------------------------------------

export type ApparatusCategory = 'support' | 'glassware' | 'fluid-control' | 'instrument' | 'storage' | 'surface';

/** How two mated sockets constrain each other's relative pose. */
export type SocketMateKind =
  /** The child socket's frame is made to coincide exactly with the parent's (e.g. clamp jaw <-> burette barrel mount). */
  | 'coincident'
  /** Coincident, but free to slide along the socket's local +Z axis (e.g. a clamp's height on a stand pole). */
  | 'axial'
  /** The child rests on the parent's local XY plane at any point within the parent's footprint, inheriting its +Z as "up" (e.g. anything placed on a bench or support ring). */
  | 'planar'
  /** No rigid attachment is formed; compatibility only requires spatial alignment within a tolerance (e.g. an open burette tip dripping into a flask mouth with nothing clamped together). */
  | 'proximity';

export type SocketGender = 'MALE' | 'FEMALE' | 'NEUTRAL';

/** A simple geometric fit check layered on top of role/kind matching. */
export type SocketGeometryCheck =
  | { readonly kind: 'cylinder-fit'; readonly minDiameterM: number; readonly maxDiameterM: number }
  | { readonly kind: 'footprint-fit'; readonly maxWidthM: number; readonly maxDepthM: number }
  | { readonly kind: 'none' };

export interface SocketDefinition {
  /** Unique within the owning definition, e.g. 'pole-top'. Stable across definition versions. */
  readonly id: string;
  readonly label: string;
  readonly kind: ConnectionKind;
  /** This socket's own role id, e.g. 'stand-pole'. Free-form, but shared across definitions that should interoperate. */
  readonly role: string;
  /** Role ids (or '*' for "any role of the same `kind`") this socket is willing to mate with. */
  readonly accepts: readonly string[];
  readonly gender: SocketGender;
  readonly mate: SocketMateKind;
  /** Local transform (relative to the apparatus origin) when `mate` is not 'planar'; the anchor/reference pose for 'planar'. */
  readonly transform: Transform;
  /** For 'axial' sockets: the allowed signed travel in meters along local +Z from `transform`,
   * used when this socket is the rail side of a pairing (`computeAttachmentPlacement` prefers the
   * parent socket's range). A socket that is normally the grip/child side of an axial mate (e.g. a
   * clamp's boss-head, gripping a stand's rod) can declare `[0, 0]` here — still required so
   * `validateDefinition` can assert every axial socket is internally consistent. */
  readonly axialRangeM?: readonly [number, number];
  /** For 'planar' sockets: the usable area in meters, centered on `transform`. */
  readonly planarAreaM?: { readonly width: number; readonly depth: number };
  readonly geometryCheck: SocketGeometryCheck;
  /** The physical diameter (meters) at this socket, for cylindrical mounts (stand pole, burette
   * barrel, clamp stem). Checked against a mating socket's `geometryCheck` of kind 'cylinder-fit'. */
  readonly nominalDiameterM?: number;
  /** The physical footprint (meters) this item needs when resting on a 'planar' mate, e.g. a
   * stand's base plate or a flask's base ring. Checked against a 'footprint-fit' geometry check. */
  readonly nominalFootprintM?: { readonly width: number; readonly depth: number };
  readonly maxConnections: number;
  /** Radius in meters of the hover/snap highlight affordance shown by Agent 04/01. */
  readonly highlightRadiusM: number;
}

/** A spatial reference point for fluid alignment that is not a rigid mechanical mate (e.g. a
 * burette tip pouring into an open flask mouth with no clamped connection between them). */
export interface FlowPort {
  readonly id: string;
  readonly label: string;
  readonly direction: 'OUTLET' | 'INLET';
  readonly transform: Transform;
  /** Declared maximum volumetric flow this port can pass, used only as a capability hint for
   * Agent 07's flow model — this module never computes or moves actual flow. */
  readonly maxFlowRateLPerS?: number;
}

export type ControlKind =
  | 'VALVE'
  | 'FILL'
  | 'STIRRER_TOGGLE'
  | 'STIRRER_SPEED'
  | 'PROBE_POSITION'
  | 'BALANCE_TARE'
  | 'READOUT'
  | 'CUSTOM';

export interface ControlRange {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit: string;
  readonly default: number;
}

export type ControlValueType = 'number' | 'boolean' | 'string';

export interface ControlDefinition {
  /** Unique within the owning definition, e.g. 'stopcock'. */
  readonly id: string;
  readonly label: string;
  readonly kind: ControlKind;
  /** The shared-contract `LabAction.type` a successful invocation of this control produces. */
  readonly actionType: LabActionType;
  readonly description: string;
  readonly valueType: ControlValueType;
  /** Required and only meaningful when `valueType === 'number'` (valve openness, stirrer speed, probe depth). */
  readonly range?: ControlRange;
  /** Required and only meaningful when `valueType === 'string'` (discrete controls). */
  readonly options?: readonly string[];
  /** Capability this control depends on, checked against the definition at registration time. */
  readonly requiresCapability?: Capability;
}

export interface CollisionBox {
  readonly kind: 'box';
  readonly halfExtentsM: readonly [number, number, number];
  readonly centerM?: readonly [number, number, number];
}
export interface CollisionCylinder {
  readonly kind: 'cylinder';
  readonly radiusM: number;
  readonly heightM: number;
  readonly centerM?: readonly [number, number, number];
}
export interface CollisionCompound {
  readonly kind: 'compound';
  readonly parts: readonly (CollisionBox | CollisionCylinder)[];
}
export type CollisionBounds = CollisionBox | CollisionCylinder | CollisionCompound;

/** A vessel's internal volume calibration: liquid volume (liters) <-> fill geometry (meters).
 * Agent 05 uses this to place the meniscus/fill mesh; Agent 03 never computes the volume itself
 * (that is conserved, authoritative state owned by Agent 07). */
export interface ContainerSpec {
  readonly capacityL: number;
  /** Liquid below this volume is not visually distinguishable from empty (e.g. the barrel below a stopcock bore). Defaults to 0. */
  readonly deadVolumeL?: number;
  /** Returns the liquid surface height above the vessel's local origin, and the surface radius, for a given contained volume. */
  readonly fillLevelForVolume: (volumeL: number) => { readonly heightM: number; readonly surfaceRadiusM: number };
  /** Inverse of `fillLevelForVolume`, for tooling/tests. */
  readonly volumeForFillHeight: (heightM: number) => number;
}

export interface GraduationTick {
  readonly heightM: number;
  readonly valueML: number;
  readonly major: boolean;
  readonly label?: string;
}

/** Printed/etched graduation marks on a piece of volumetric glassware. */
export interface GraduationSpec {
  readonly capacityML: number;
  readonly majorIntervalML: number;
  readonly minorIntervalML: number;
  /** A major tick is labeled every Nth major interval (e.g. 1 labels every mL, 5 every 5 mL). */
  readonly labelEveryNMajor: number;
  /** Declared reading tolerance, e.g. +/-0.05 mL for a Class A 50 mL burette. */
  readonly toleranceML: number;
  /** True when the 0 mark is at the top and values increase downward (all burettes). */
  readonly zeroAtTop: boolean;
  readonly evidence: Evidence;
}

export type ConfigFieldType = 'number' | 'string' | 'boolean' | 'enum' | 'color';

export interface ConfigFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly type: ConfigFieldType;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly default: unknown;
  readonly description?: string;
}

export type AssetSource = 'procedural' | 'gltf';

/**
 * Documents provenance, licensing and budget for one definition's visual asset, per the brief's
 * "documented poly count, texture memory and licensing/provenance" acceptance test.
 */
export interface AssetManifestEntry {
  readonly source: AssetSource;
  /** Key into the geometry builder registry (`geometry/index.ts`) when `source === 'procedural'`. */
  readonly proceduralBuilderId?: string;
  readonly gltfUri?: string;
  /** Triangle count at the default level of detail. Computed from the actual built geometry, not hand-typed — see `geometry/polycount.ts`. */
  readonly polyCount: number;
  readonly materialSlots: readonly string[];
  readonly textureMemoryKB: number;
  readonly license: string;
  readonly attribution?: string;
  /** True = a development stand-in, visibly marked as incomplete, not a shipping asset (brief §Required implementation, point 7). */
  readonly isPlaceholder: boolean;
  readonly notes?: string;
}

export interface ThumbnailSpec {
  /** `lucide-react` icon name used for the palette/browser card (Agent 01 owns the palette UI itself). */
  readonly icon: string;
  readonly previewColor: string;
}

export interface PlacementRules {
  /** Role ids of the socket(s) this definition is normally placed relative to — usually a
   * `'flat-surface'`-style MECHANICAL role, but any socket kind (e.g. a SENSOR `'sensor-access'`
   * role for a probe) is valid here. Informational for Agent 04/01; this module does not enforce it. */
  readonly allowedSurfaceRoles: readonly string[];
  readonly allowRotationAboutUpAxis: boolean;
  readonly snapRotationDeg?: number;
}

export interface DefinitionProvenance {
  readonly dimensions: Evidence;
  readonly notes: string;
  readonly sourceIds?: readonly string[];
}

/**
 * The complete, serializable description of one instrument type. An `ApparatusInstance` always
 * points at one of these by `definitionId`; the instance carries only placement, config and a
 * revision — everything else (sockets, capacities, controls, geometry) is looked up here.
 */
export interface ApparatusDefinition {
  readonly id: string;
  readonly kind: ApparatusKind;
  readonly category: ApparatusCategory;
  readonly label: string;
  readonly shortLabel?: string;
  readonly description: string;
  /** Bumped when sockets, capacities or config schema change in a way that could invalidate saved instances. */
  readonly version: number;
  readonly dimensionsM: { readonly width: number; readonly depth: number; readonly height: number };
  readonly massKg?: number;
  readonly collision: CollisionBounds;
  readonly capabilities: readonly Capability[];
  readonly sockets: readonly SocketDefinition[];
  readonly flowPorts?: readonly FlowPort[];
  readonly controls: readonly ControlDefinition[];
  readonly container?: ContainerSpec;
  readonly graduation?: GraduationSpec;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly configSchema: readonly ConfigFieldSchema[];
  readonly placement: PlacementRules;
  readonly asset: AssetManifestEntry;
  readonly thumbnail: ThumbnailSpec;
  /** Local point (meters) the camera should frame when inspecting this instrument. */
  readonly focusPointM?: readonly [number, number, number];
  /** Local anchor (meters) + radius for Agent 08's guided-mode highlight ring. */
  readonly guidedHighlight?: { readonly anchorM: readonly [number, number, number]; readonly radiusM: number };
  readonly tags?: readonly string[];
  readonly provenance: DefinitionProvenance;
}

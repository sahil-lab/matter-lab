/**
 * Additive contract stub for `lab/fluids` (Agent 05).
 *
 * This file mirrors Section 3 ("Shared domain model") of `00_SHARED_INTEGRATION_CONTRACT.md`, plus
 * the extra shapes this module needs from modules that do not exist yet on this branch:
 *
 *  - `VesselProfile` stands in for the vessel calibration metadata Agent 03 (`lab/apparatus`) will
 *    eventually expose (capacity, revolve profile, graduation range). It is shaped so a real
 *    definition can be substituted without changing any fluid rendering code.
 *  - `FluidOutflow` stands in for the per-tick flow state Agent 07 (`lab/experiments`) will stream
 *    (the authoritative current flow rate between a source and a receiver).
 *
 * Nothing in `lab/fluids` computes chemistry, flow rates or geometry transforms on its own: every
 * value below is meant to be read from upstream state, never invented here. When `packages/contracts`
 * (Agent 07 + 09) and `lab/apparatus` (Agent 03) land, replace the imports of this file with the
 * real ones; the shapes were kept close on purpose to make that a mechanical change.
 */

export type UUID = string;

/** Shared contract Section 3. */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export const EVIDENCE_LABELS: Readonly<Record<Evidence, string>> = {
  REFERENCE_MEASURED: 'Reference measured',
  MODEL_CALCULATED: 'Model calculated',
  ILLUSTRATIVE: 'Illustrative',
  UNVERIFIED: 'Unverified',
  UNSUPPORTED: 'Unsupported',
};

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

/** Scene coordinates are meters; quaternion is [x, y, z, w]. */
export interface Transform {
  readonly positionM: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

export type ApparatusKind = 'BENCH' | 'STAND' | 'CLAMP' | 'BURETTE' | 'FLASK' | 'BEAKER' | 'PIPETTE' | 'STIRRER' | 'PH_PROBE' | 'BALANCE' | 'OTHER';

export type Capability = 'CONTAINER' | 'FLOW_SOURCE' | 'FLOW_RECEIVER' | 'MOUNT' | 'MOUNTABLE' | 'HEATING' | 'STIRRING' | 'PH_SENSOR' | 'MEASUREMENT';

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

export interface SpeciesAmount {
  readonly speciesId: string;
  readonly moles: number;
  readonly sourceId?: string;
}

export interface ContainerContents {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly mixing: 'WELL_MIXED' | 'UNMIXED';
  readonly modelId: string;
}

export interface Observation {
  readonly type: 'PH' | 'TEMPERATURE' | 'VOLUME' | 'CONCENTRATION' | 'INDICATOR' | 'MASS';
  readonly apparatusId?: UUID;
  readonly timeS: number;
  readonly quantity: Quantity;
  readonly evidence: Evidence;
  readonly methodId: string;
  readonly sourceIds: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Proposed additions (not yet in the shared contract) — flagged for the orchestrator to reconcile.
// ---------------------------------------------------------------------------------------------

/**
 * A single control point of a vessel's revolve profile: the inner-wall radius at a height measured
 * from the vessel's own base (meters). Points must be sorted ascending by `heightM` and the first
 * point's `heightM` must be 0. Proposed shape for Agent 03's vessel calibration metadata — a real
 * burette/flask/beaker/bottle definition should be able to supply the same points (or be adapted to
 * them), so fill-level geometry stays exact regardless of where the profile data originates.
 */
export interface VesselProfilePoint {
  readonly heightM: number;
  readonly radiusM: number;
}

export type VesselShapeId = 'burette' | 'erlenmeyer-flask' | 'beaker' | 'reagent-bottle';

export interface VesselGraduation {
  /** Smallest graduated reading, in milliliters (top of a burette's scale is usually 0). */
  readonly minML: number;
  readonly maxML: number;
  readonly majorStepML: number;
  readonly minorStepML: number;
  /** True when the printed scale reads 0 at the liquid surface's resting (full) height, counting
   * down as liquid drains — the burette convention. False counts up from the base (beaker/flask). */
  readonly zeroAtTop: boolean;
  /** Height (meters, from the vessel base) of the top of the graduated zone. */
  readonly topHeightM: number;
  /** Height (meters, from the vessel base) of the bottom of the graduated zone — above any unmarked dead volume (e.g. a burette's tip below the stopcock). */
  readonly bottomHeightM: number;
}

export interface VesselProfile {
  readonly id: string;
  readonly shape: VesselShapeId;
  /** Revolve profile of the *inner* wall, base to rim, in meters. */
  readonly points: readonly VesselProfilePoint[];
  /** Nominal full capacity in liters, used for sanity-checking and default graduation ranges. */
  readonly capacityL: number;
  /** Glass wall thickness in meters, used to build the outer shell for the glass shell mesh. */
  readonly wallThicknessM: number;
  readonly graduation?: VesselGraduation;
}

/**
 * Authoritative current flow between a source vessel's outlet and a receiver, resolved in world
 * space. Proposed stand-in for the per-tick stream Agent 07's experiment runtime will emit;
 * `lab/fluids` never computes `flowRateMlPerS` itself, it only visualizes it. A rate of exactly 0
 * (closed valve, finished transfer, or paused run) must render zero droplets.
 */
export interface FluidOutflow {
  readonly fromPointM: readonly [number, number, number];
  readonly toPointM: readonly [number, number, number];
  readonly flowRateMlPerS: number;
}

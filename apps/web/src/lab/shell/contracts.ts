/**
 * MATTER LAB — Astra lab shell: shared contract types (Agent 01: Creative Direction and UI).
 *
 * This file mirrors `00_SHARED_INTEGRATION_CONTRACT.md` §3 "Shared domain model" and §5 API
 * surface. Authoritative ownership of these types is **Agent 07 (experiment graph/runtime) and
 * Agent 09 (persistence)**, who are expected to publish them from `packages/contracts/lab`. Agent
 * 01 works in an isolated worktree with no access to their branches, so this is a local,
 * additive stub kept field-for-field identical to the contract text, used only so the UI layer
 * compiles and can be demonstrated against realistic shapes.
 *
 * Integration note for Agent 10: when `packages/contracts` lands, delete this file's type
 * declarations (keep `ApparatusSummary`, the Hud/derived view types and the demo-data builders,
 * which are Agent 01's own) and re-point the imports below at the real package.
 */

export type UUID = string;

/** Shared contract §3. Distinct from `@matterlab/core`'s six-level `EvidenceLevel`. */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

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

export interface Connection {
  readonly id: UUID;
  readonly from: { readonly instanceId: UUID; readonly socketId: string };
  readonly to: { readonly instanceId: UUID; readonly socketId: string };
  readonly kind: 'MECHANICAL' | 'FLUID' | 'SENSOR' | 'CONTROL';
  readonly enabled: boolean;
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

export interface ExperimentScene {
  readonly id: UUID;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly stations: ReadonlyArray<{ readonly id: UUID; readonly name: string }>;
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  readonly containerStates: Readonly<Record<UUID, ContainerContents>>;
  readonly simulationConfig: { readonly methodId: string; readonly timeStepS: number };
  readonly viewport?: Readonly<Record<string, unknown>>;
}

export type LabActionType = 'PLACE' | 'MOVE' | 'ATTACH' | 'DETACH' | 'FILL' | 'SET_VALVE' | 'TRANSFER' | 'START_STIRRER' | 'SET_PROBE' | 'RESET' | 'CUSTOM';

export interface LabAction {
  readonly actionId: UUID;
  readonly atSimulationS: number;
  readonly targetInstanceId: UUID;
  readonly type: LabActionType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actorId?: UUID;
}

export type ObservationType = 'PH' | 'TEMPERATURE' | 'VOLUME' | 'CONCENTRATION' | 'INDICATOR' | 'MASS';

export interface Observation {
  readonly type: ObservationType;
  readonly apparatusId?: UUID;
  readonly timeS: number;
  readonly quantity: Quantity;
  readonly evidence: Evidence;
  readonly methodId: string;
  readonly sourceIds: readonly string[];
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNSUPPORTED';

export interface RunResult {
  readonly runId: UUID;
  readonly status: RunStatus;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly inputHash: string;
  readonly observations: readonly Observation[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly solverDiagnostics?: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------------------------------- *
 * The rest of this file is Agent 01's own: UI-facing shapes layered on the contract above, and
 * the read-only selector interface the lab shell consumes. None of it invents a scientific value;
 * selectors only reshape data that a `RunResult`/`Observation` already carries.
 * ------------------------------------------------------------------------------------------- */

/**
 * Catalog-level display data for one apparatus definition, as Agent 03's registry is expected to
 * expose it (brief §"Owned surfaces": "Agent 01 ... obtain apparatus thumbnails and display labels
 * from Agent 03"). `thumbnailGlyph` names a `lucide-react` icon as a placeholder until Agent 03
 * supplies real rendered thumbnails.
 */
export interface ApparatusSummary {
  readonly definitionId: string;
  readonly kind: ApparatusKind;
  readonly label: string;
  readonly category: string;
  readonly shortDescription: string;
  readonly dimensionsM?: { readonly width: number; readonly height: number; readonly depth: number };
  readonly thumbnailGlyph: string;
  /** True for the eight P0 vertical-slice instruments named in the Agent 03 brief. */
  readonly vertical_slice?: boolean;
}

/** Resolved indicator appearance for the HUD legend. Agent 06 computes it; this is the display shape. */
export interface IndicatorState {
  readonly indicatorId: string;
  readonly label: string;
  readonly colorHex: string;
  /** 0 = fully the acid-side color, 1 = fully the base-side color. */
  readonly transitionFraction: number;
  readonly evidence: Evidence;
}

/** What the titration HUD needs, derived from a scene/run/observations by {@link deriveTitrationHudData}. */
export interface TitrationHudData {
  readonly connectionStatus: 'disconnected' | 'unsupported' | 'ready';
  readonly deliveredVolumeL: number | null;
  readonly buretteRemainingL: number | null;
  readonly buretteCapacityL: number | null;
  readonly ph: Quantity | null;
  readonly phEvidence: Evidence | null;
  readonly temperatureK: number | null;
  readonly indicator: IndicatorState | null;
  readonly equivalenceVolumeL: number | null;
  readonly endpointVolumeL: number | null;
  readonly warnings: readonly string[];
  readonly sourceIds: readonly string[];
}

const EMPTY_HUD_DATA: TitrationHudData = {
  connectionStatus: 'disconnected',
  deliveredVolumeL: null,
  buretteRemainingL: null,
  buretteCapacityL: null,
  ph: null,
  phEvidence: null,
  temperatureK: null,
  indicator: null,
  equivalenceVolumeL: null,
  endpointVolumeL: null,
  warnings: [],
  sourceIds: [],
};

/**
 * A read-only selector over a scene/run, in the sense the shared contract requires ("consume
 * read-only ExperimentScene, RunResult and Observation selectors ... never mutate"). It only picks
 * fields that already exist on its inputs; it never computes pH, volumes or equivalence itself.
 * `null` scene/run/observations mean "not connected yet" and produce the honest disconnected state.
 */
export function deriveTitrationHudData(scene: ExperimentScene | null, run: RunResult | null, observations: readonly Observation[] | null): TitrationHudData {
  if (!scene) return EMPTY_HUD_DATA;
  if (run?.status === 'UNSUPPORTED') {
    return { ...EMPTY_HUD_DATA, connectionStatus: 'unsupported', warnings: run.warnings, sourceIds: [] };
  }
  const obs = observations ?? run?.observations ?? [];
  const latest = (type: ObservationType): Observation | null => {
    let best: Observation | null = null;
    for (const o of obs) if (o.type === type && (!best || o.timeS >= best.timeS)) best = o;
    return best;
  };
  const ph = latest('PH');
  const volume = latest('VOLUME');
  const temperature = latest('TEMPERATURE');
  const burette = scene.apparatus.find((a) => a.kind === 'BURETTE');
  const buretteState = burette ? scene.containerStates[burette.id] : undefined;
  return {
    connectionStatus: 'ready',
    deliveredVolumeL: volume?.quantity.value ?? null,
    buretteRemainingL: buretteState?.volumeL ?? null,
    buretteCapacityL: typeof burette?.config.capacityL === 'number' ? burette.config.capacityL : null,
    ph: ph?.quantity ?? null,
    phEvidence: ph?.evidence ?? null,
    temperatureK: temperature?.quantity.value ?? null,
    indicator: null,
    equivalenceVolumeL: typeof run?.solverDiagnostics?.equivalenceVolumeL === 'number' ? run.solverDiagnostics.equivalenceVolumeL : null,
    endpointVolumeL: typeof run?.solverDiagnostics?.endpointVolumeL === 'number' ? run.solverDiagnostics.endpointVolumeL : null,
    warnings: run?.warnings ?? [],
    sourceIds: [...new Set(obs.flatMap((o) => o.sourceIds))],
  };
}

export interface TitrationPoint {
  readonly volumeL: number;
  readonly ph: number;
}

/**
 * Another read-only selector: pairs each `VOLUME` observation with the `PH` observation recorded
 * at the same simulation time into chart-ready points. It reshapes observations that already
 * exist; it does not interpolate, fit or otherwise invent a point no observation reported.
 */
export function pairVolumeAndPh(observations: readonly Observation[]): TitrationPoint[] {
  const volumeByTime = new Map<number, number>();
  const phByTime = new Map<number, number>();
  for (const o of observations) {
    if (o.type === 'VOLUME') volumeByTime.set(o.timeS, o.quantity.value);
    else if (o.type === 'PH') phByTime.set(o.timeS, o.quantity.value);
  }
  const points: TitrationPoint[] = [];
  for (const [timeS, volumeL] of volumeByTime) {
    const ph = phByTime.get(timeS);
    if (ph !== undefined) points.push({ volumeL, ph });
  }
  return points.sort((a, b) => a.volumeL - b.volumeL);
}

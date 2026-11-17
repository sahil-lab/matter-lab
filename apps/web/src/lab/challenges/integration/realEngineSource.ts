/**
 * Real-engine-backed `ExperimentRuntimeSource`, replacing the old labelled `FixtureDemoRuntime`.
 * Wires together, for real:
 *  - Agent 07's actual `ExperimentEngine` (`apps/web/src/lab/experiments`), including his reducer,
 *    event log, observation ledger and simulation clock;
 *  - Agent 07's own vertical-slice apparatus registry and acid-base titration plugin (see
 *    `apps/web/src/lab/experiments/registry/verticalSliceDefinitions.ts` for the one patched
 *    number and the reconciliation note about Agent 03's richer registry);
 *  - Agent 06's real titration solver, reached through `pythonSolverClient.ts` (Node/tests) or
 *    `httpSolverClient.ts` (browser) — never a locally fabricated pH.
 *
 * This is the first genuinely end-to-end path through this surface: goal evaluation, scoring and
 * the notebook all read `getEventLog()`/`getObservations()` off a *real* engine instance instead of
 * a scripted fixture. Nothing here computes a scientific result itself — it only ever builds
 * `LabAction`s with Agent 07's own action builders and dispatches them through the engine.
 *
 * Scope note: this module assembles apparatus through the engine's real `PLACE`/`ATTACH` actions
 * using Agent 07's placeholder registry positions (not Agent 03's real 3D drag-and-drop editor,
 * which is Agent 02/04's surface). Flagged for reconciliation, same as the registry itself.
 */
import {
  DEFAULT_SIMULATION_TIME_STEP_S,
  type ExperimentScene,
  type SolverClient,
  type SpeciesAmount,
  type Transform,
  type UUID,
} from '@matterlab/contracts';
import {
  BURETTE_DEFINITION,
  CLAMP_DEFINITION,
  createAcidBaseTitrationPlugin,
  createDefinitionRegistry,
  ExperimentEngine,
  FLASK_DEFINITION,
  STAND_DEFINITION,
  VERTICAL_SLICE_DEFINITIONS,
} from '../../experiments';
import { generateUUID } from '../../experiments/runtime/ids';
import type { ExperimentRuntimeSource } from '../contracts';
import { HCL_SPECIES_ID, NAOH_SPECIES_ID, TITRATION_BENCHMARK } from '../titrationObjective';

function emptyScene(): ExperimentScene {
  return {
    id: generateUUID(),
    revision: 0,
    schemaVersion: 1,
    stations: [],
    apparatus: [],
    connections: [],
    containerStates: {},
    simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: DEFAULT_SIMULATION_TIME_STEP_S },
  };
}

function transformAt(positionM: readonly [number, number, number]): Transform {
  return { positionM, quaternion: [0, 0, 0, 1] };
}

/** Positions chosen to already satisfy `flaskLocatedBelow` (Y-up, burette tip over the flask mouth) the moment both are placed, matching Agent 07's own test fixture layout. */
const LAYOUT: Readonly<Record<'stand' | 'clamp' | 'burette' | 'flask', readonly [number, number, number]>> = {
  stand: [0, 0, 0],
  clamp: [0, 0.6, 0],
  burette: [0, 0.6, 0],
  flask: [0, 0.08, 0],
};

export interface RealEngineReadout {
  readonly deliveredSinceTrialStartL: number;
  readonly latestPh: number | null;
}

/**
 * Role-keyed convenience wrapper around one real `ExperimentEngine` station, assembling and
 * driving the shared vertical slice (stand -> clamp -> burette -> flask) one real `LabAction` at a
 * time. Each method dispatches through `engine.dispatchOrThrow`, so a call that is not yet valid
 * (e.g. attaching a burette before it is placed) throws instead of silently no-opping.
 */
export class RealEngineRuntimeSource implements ExperimentRuntimeSource {
  readonly connectionStatus = 'connected' as const;
  private readonly engine: ExperimentEngine;
  private readonly stationId: UUID;
  private readonly roleInstanceIds = new Map<string, UUID>();
  private readonly listeners = new Set<() => void>();
  private trialStartSequence = 0;
  private nextActionSimulationS = 0;
  private cachedReadout: RealEngineReadout = { deliveredSinceTrialStartL: 0, latestPh: null };

  constructor(solver: SolverClient, stationName = 'Guided bench') {
    const registry = createDefinitionRegistry(VERTICAL_SLICE_DEFINITIONS);
    this.engine = new ExperimentEngine(emptyScene(), { registry, solver, plugins: [createAcidBaseTitrationPlugin()] });
    this.stationId = this.engine.createStation(stationName);
    this.engine.subscribe(() => {
      this.recomputeReadout();
      this.notify();
    });
  }

  // --- ExperimentRuntimeSource -----------------------------------------------------------------

  getScene(): ExperimentScene {
    return this.engine.getScene();
  }

  getEventLog() {
    return this.engine.getEventLog();
  }

  getObservations(apparatusId?: UUID) {
    return this.engine.getObservations(apparatusId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // --- role/id bookkeeping ----------------------------------------------------------------------

  /** Instance id this source placed for `role` (e.g. `'burette'`), if any. */
  idFor(role: 'stand' | 'clamp' | 'burette' | 'flask'): UUID | undefined {
    return this.roleInstanceIds.get(role);
  }

  private place(role: 'stand' | 'clamp' | 'burette' | 'flask', definitionId: string): UUID {
    const id = generateUUID();
    this.engine.dispatchOrThrow({
      actionId: generateUUID(),
      atSimulationS: this.advanceSimulationS(),
      targetInstanceId: id,
      type: 'PLACE',
      payload: { definitionId, stationId: this.stationId, transform: transformAt(LAYOUT[role]), config: {} },
    });
    this.roleInstanceIds.set(role, id);
    return id;
  }

  /**
   * Every dispatched action needs its own, strictly increasing `atSimulationS` (the goal/scoring/
   * replay code orders and slices by it). The station's own fixed-tick clock (`engine.getClock`)
   * only ever advances via `tick()`/`advance()`, which this manual-dispatch source never calls, so
   * reading it here would give every action the same `atSimulationS: 0` — this keeps its own
   * monotonic counter instead, stepping by the scene's own declared tick size.
   */
  private advanceSimulationS(): number {
    const value = this.nextActionSimulationS;
    this.nextActionSimulationS += this.engine.getScene().simulationConfig.timeStepS;
    return value;
  }

  // --- guided-lab convenience actions -----------------------------------------------------------

  placeStand(): UUID {
    return this.place('stand', STAND_DEFINITION.id);
  }

  placeClamp(): UUID {
    return this.place('clamp', CLAMP_DEFINITION.id);
  }

  attachClampToStand(): void {
    const clampId = this.require('clamp');
    const standId = this.require('stand');
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: clampId, type: 'ATTACH', payload: { socketId: 'grip', toInstanceId: standId, toSocketId: 'pole' } });
  }

  placeBurette(): UUID {
    return this.place('burette', BURETTE_DEFINITION.id);
  }

  attachBuretteToClamp(): void {
    const buretteId = this.require('burette');
    const clampId = this.require('clamp');
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: buretteId, type: 'ATTACH', payload: { socketId: 'barrel', toInstanceId: clampId, toSocketId: 'bore' } });
  }

  placeFlask(): UUID {
    return this.place('flask', FLASK_DEFINITION.id);
  }

  /** The required FLUID connection (burette tip -> flask mouth): without it the engine's auto-flow never fires (`detectSupport`/`fluidConnectionsInStation`). */
  connectBuretteToFlask(): void {
    const buretteId = this.require('burette');
    const flaskId = this.require('flask');
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: buretteId, type: 'ATTACH', payload: { socketId: 'tip', toInstanceId: flaskId, toSocketId: 'mouth' } });
  }

  private fill(role: 'burette' | 'flask', species: readonly SpeciesAmount[], volumeL: number): void {
    const id = this.require(role);
    this.engine.dispatchOrThrow({
      actionId: generateUUID(),
      atSimulationS: this.advanceSimulationS(),
      targetInstanceId: id,
      type: 'FILL',
      payload: { volumeL, species, temperatureK: 298.15, modelId: 'ideal-dilute-v1' },
    });
  }

  fillHcl(volumeL = TITRATION_BENCHMARK.aliquotVolumeL, molarity = TITRATION_BENCHMARK.aliquotMolarity): void {
    this.fill('flask', [{ speciesId: HCL_SPECIES_ID, moles: molarity * volumeL }], volumeL);
  }

  fillNaoh(volumeL = 0.05, molarity = TITRATION_BENCHMARK.titrantMolarity): void {
    this.fill('burette', [{ speciesId: NAOH_SPECIES_ID, moles: molarity * volumeL }], volumeL);
  }

  /** Opens (or closes) the burette's stopcock. With the fluid path connected and the station clock running, the engine then drips titrant on its own simulation ticks; `deliverIncrement` below is the manual alternative this UI actually drives. */
  setStopcock(opening: number): void {
    const buretteId = this.require('burette');
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: buretteId, type: 'SET_VALVE', payload: { valveOpening: opening } });
  }

  /** Dispatches one real, immediate `TRANSFER` of `volumeL` from the burette to the flask — the manual delivery control this surface's UI exposes (not a tick-driven auto-drip, which would need a running animation loop Agent 02/04 own). The transfer itself, its inventory conservation and the resulting pH recompute all go through the real engine and the real solver. */
  deliverIncrement(volumeL: number): void {
    const buretteId = this.require('burette');
    const flaskId = this.require('flask');
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: buretteId, type: 'TRANSFER', payload: { toInstanceId: flaskId, volumeL } });
  }

  /** Marks the endpoint at the flask's total delivered volume since the current trial began. */
  markEndpoint(indicatorColorNote?: string): void {
    const flaskId = this.require('flask');
    const deliveredVolumeL = this.deliveredSinceTrialStart();
    this.engine.dispatchOrThrow({
      actionId: generateUUID(),
      atSimulationS: this.advanceSimulationS(),
      targetInstanceId: flaskId,
      type: 'CUSTOM',
      payload: { kind: 'MARK_ENDPOINT', deliveredVolumeL, ...(indicatorColorNote ? { indicatorColorNote } : {}) },
    });
  }

  /** Starts a fresh Precision-mode repeat trial: only moves the trial boundary (the next `MARK_ENDPOINT`'s delivered-volume baseline), it does not reset apparatus or chemistry — repeat by filling and titrating again from here. */
  startNewTrial(): void {
    this.trialStartSequence = this.engine.getEventLog().length;
    this.notify();
  }

  /** Tears down this station's apparatus/chemistry and creates a fresh one, for "reset bench". */
  resetAll(): void {
    this.engine.dispatchOrThrow({ actionId: generateUUID(), atSimulationS: this.advanceSimulationS(), targetInstanceId: this.stationId, type: 'RESET', payload: { scope: 'STATION', clearConnections: true } });
    this.roleInstanceIds.clear();
    this.trialStartSequence = this.engine.getEventLog().length;
    this.recomputeReadout();
    this.notify();
  }

  private require(role: 'stand' | 'clamp' | 'burette' | 'flask'): UUID {
    const id = this.roleInstanceIds.get(role);
    if (!id) throw new Error(`Cannot operate on "${role}": it has not been placed in this station yet.`);
    return id;
  }

  // --- UI readout (delivered volume this trial + latest pH) ------------------------------------

  private deliveredSinceTrialStart(): number {
    const buretteId = this.roleInstanceIds.get('burette');
    const flaskId = this.roleInstanceIds.get('flask');
    if (!buretteId || !flaskId) return 0;
    let total = 0;
    const events = this.engine.getEventLog();
    for (let i = this.trialStartSequence; i < events.length; i += 1) {
      const record = events[i]!;
      if (record.outcome !== 'APPLIED' || record.action.type !== 'TRANSFER' || record.action.targetInstanceId !== buretteId) continue;
      const payload = record.action.payload as { toInstanceId?: UUID; volumeL?: number };
      if (payload.toInstanceId !== flaskId) continue;
      if (typeof payload.volumeL === 'number' && Number.isFinite(payload.volumeL)) total += payload.volumeL;
    }
    return total;
  }

  private recomputeReadout(): void {
    const flaskId = this.roleInstanceIds.get('flask');
    const latestObservation = flaskId ? this.engine.getLatestObservation(flaskId, 'PH') : undefined;
    this.cachedReadout = { deliveredSinceTrialStartL: this.deliveredSinceTrialStart(), latestPh: latestObservation?.quantity.value ?? null };
  }

  /** Cached (referentially stable until the next real change) readout for `useSyncExternalStore`. */
  readout(): RealEngineReadout {
    return this.cachedReadout;
  }

  /** Resolves once every solver request triggered so far (e.g. by a `FILL` or `TRANSFER`) has returned a real observation or failed honestly. Tests await this instead of polling; production UI reacts to `subscribe` instead. */
  async settle(): Promise<void> {
    await this.engine.settle();
  }
}

export function createRealEngineSource(solver: SolverClient): RealEngineRuntimeSource {
  return new RealEngineRuntimeSource(solver);
}

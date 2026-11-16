/**
 * `ExperimentEngine`: the single authoritative owner of experiment/apparatus state (brief role
 * statement; 00_SHARED_INTEGRATION_CONTRACT.md Section 4). Everything else — Agent 04's editor,
 * Agent 05's fluid renderer, Agent 08's challenges, Agent 09's persistence — reads from this
 * engine or dispatches a `LabAction` into it; nothing else may mutate `ExperimentScene` or call the
 * chemistry solver directly.
 *
 * Responsibilities, each delegated to a focused module so this file stays an orchestrator:
 *  - `reducer.ts` applies one `LabAction` to the scene (pure).
 *  - `eventLog.ts` / idempotency: a repeated `actionId` is recorded as `DUPLICATE`, never re-applied.
 *  - `observationLedger.ts` keeps solver results and rejects stale (out-of-order) responses.
 *  - `clock.ts` is the per-station fixed-tick simulation clock (pause/resume/speed/reset).
 *  - `snapshot.ts` is the save/reopen/replay shape.
 */
import {
  isLabActionType,
  type ApparatusDefinitionLookup,
  type ExperimentPlugin,
  type ExperimentScene,
  type LabAction,
  type LabEventRecord,
  type Observation,
  type PluginSupport,
  type SolverClient,
  type SolverRequest,
  type UUID,
} from '@matterlab/contracts';
import {
  buildAttachAction,
  buildCreateStationAction,
  buildFillAction,
  buildPlaceAction,
} from './actions';
import {
  createStationClock,
  pauseClock,
  resetClock,
  setClockSpeed,
  startClock,
  stepOnce,
  ticksForElapsed,
  type StationClockState,
} from './clock';
import { volumeOverTick } from './flow';
import { appendDuplicateEvent, appendEvent, findEventByActionId } from './eventLog';
import { clampTransferVolume, VOLUME_CONSERVATION_TOLERANCE_L } from './inventory';
import { generateUUID, solverRequestId, tickTransferActionId } from './ids';
import {
  beginRecompute,
  EMPTY_OBSERVATION_LEDGER,
  latestObservation,
  observationsFor,
  recordObservations,
  type ObservationLedgerState,
} from './observationLedger';
import { applyLabAction, type ReducerContext } from './reducer';
import { buildEngineSnapshot, type EngineSnapshot } from './snapshot';
import { findStation, fluidConnectionsInStation } from './validation';

export interface ExperimentEngineDeps {
  readonly registry: ApparatusDefinitionLookup;
  readonly solver: SolverClient;
  readonly plugins: readonly ExperimentPlugin[];
  /** Spiral-of-death guard for `advance()`; default 200. */
  readonly maxTicksPerAdvance?: number;
  /** Injection point for deterministic tests; defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

export type EngineEvent =
  | { readonly kind: 'ACTION_RECORDED'; readonly record: LabEventRecord }
  | { readonly kind: 'OBSERVATION_RECORDED'; readonly apparatusId: UUID; readonly observations: readonly Observation[] }
  | { readonly kind: 'SOLVER_REQUEST_FAILED'; readonly apparatusId: UUID; readonly reason: string };

export type EngineEventListener = (event: EngineEvent) => void;

const DEFAULT_MAX_TICKS_PER_ADVANCE = 200;

export class ExperimentEngine {
  private readonly baseScene: ExperimentScene;
  private scene: ExperimentScene;
  private events: readonly LabEventRecord[] = [];
  private observationLedger: ObservationLedgerState = EMPTY_OBSERVATION_LEDGER;
  private readonly clocksByStation = new Map<UUID, StationClockState>();
  private readonly listeners = new Set<EngineEventListener>();
  private readonly pendingSolverWork = new Set<Promise<void>>();
  private readonly deps: ExperimentEngineDeps & { maxTicksPerAdvance: number; now: () => string };

  constructor(initialScene: ExperimentScene, deps: ExperimentEngineDeps) {
    this.baseScene = initialScene;
    this.scene = initialScene;
    this.deps = {
      ...deps,
      maxTicksPerAdvance: deps.maxTicksPerAdvance ?? DEFAULT_MAX_TICKS_PER_ADVANCE,
      now: deps.now ?? (() => new Date().toISOString()),
    };
    this.syncClocksWithStations();
  }

  // --- read-only state ---------------------------------------------------------------------------

  getScene(): ExperimentScene {
    return this.scene;
  }

  getEventLog(): readonly LabEventRecord[] {
    return this.events;
  }

  getObservations(apparatusId?: UUID): readonly Observation[] {
    return apparatusId ? observationsFor(this.observationLedger, apparatusId) : this.observationLedger.observations;
  }

  getLatestObservation(apparatusId: UUID, type?: Observation['type']): Observation | undefined {
    return latestObservation(this.observationLedger, apparatusId, type);
  }

  getClock(stationId: UUID): StationClockState | undefined {
    return this.clocksByStation.get(stationId);
  }

  getStationSupport(stationId: UUID): PluginSupport {
    for (const plugin of this.deps.plugins) {
      const support = plugin.detectSupport(this.scene, stationId, this.deps.registry);
      if (support.supported) return support;
    }
    return { supported: false, reason: 'No experiment plugin recognises this apparatus arrangement yet.' };
  }

  // --- dispatch ------------------------------------------------------------------------------------

  /** Never throws: every outcome, including a rejection or a duplicate, is a normal `LabEventRecord`. */
  dispatch(action: LabAction): LabEventRecord {
    const alreadySeen = findEventByActionId(this.events, action.actionId);
    if (alreadySeen) {
      const { events, record } = appendDuplicateEvent(this.events, action, this.scene.revision);
      this.events = events;
      this.emit({ kind: 'ACTION_RECORDED', record });
      return record;
    }

    const before = this.scene.revision;
    if (!isLabActionType(action.type)) {
      const { events, record } = appendEvent(this.events, {
        action,
        sceneRevisionBefore: before,
        sceneRevisionAfter: before,
        outcome: 'REJECTED',
        rejectionReason: `Unknown LabAction type "${String(action.type)}".`,
        receivedAt: this.deps.now(),
      });
      this.events = events;
      this.emit({ kind: 'ACTION_RECORDED', record });
      return record;
    }

    const context: ReducerContext = { registry: this.deps.registry };
    const outcome = applyLabAction(this.scene, action, context);
    if (!outcome.ok) {
      const { events, record } = appendEvent(this.events, {
        action,
        sceneRevisionBefore: before,
        sceneRevisionAfter: before,
        outcome: 'REJECTED',
        rejectionReason: outcome.reason,
        receivedAt: this.deps.now(),
      });
      this.events = events;
      this.emit({ kind: 'ACTION_RECORDED', record });
      return record;
    }

    this.scene = outcome.scene;
    this.syncClocksWithStations();
    const pendingObservationRequestIds = this.recomputeAffected(outcome.affectedContainerIds, action.atSimulationS);
    if (action.type === 'RESET') this.resetClocksFor(action.payload);
    const { events, record } = appendEvent(this.events, {
      action,
      sceneRevisionBefore: before,
      sceneRevisionAfter: this.scene.revision,
      outcome: 'APPLIED',
      warnings: outcome.warnings,
      pendingObservationRequestIds,
      receivedAt: this.deps.now(),
    });
    this.events = events;
    this.emit({ kind: 'ACTION_RECORDED', record });
    return record;
  }

  /** A successful `RESET` also zeroes and pauses the clock(s) it affects — scope `STATION` resets just that station's clock, `SCENE` resets every known station's clock — so "reset" reads as one user-facing operation even though the reducer (scene/chemistry) and the clock (simulation time) are tracked separately. */
  private resetClocksFor(payload: Readonly<Record<string, unknown>>): void {
    if (payload.scope === 'SCENE') {
      for (const stationId of this.clocksByStation.keys()) this.resetStationClock(stationId);
    } else if (payload.scope === 'STATION' && typeof payload.stationId === 'string') {
      this.resetStationClock(payload.stationId);
    }
  }

  /** Throws with the rejection reason instead of returning a record; for trusted call sites (tests, engine-internal helpers) that want to fail loudly. `dispatch` is the safe primitive for untrusted input. */
  dispatchOrThrow(action: LabAction): LabEventRecord {
    const record = this.dispatch(action);
    if (record.outcome === 'REJECTED') throw new Error(record.rejectionReason ?? 'Action rejected.');
    return record;
  }

  // --- simulation clock ----------------------------------------------------------------------------

  pauseStation(stationId: UUID): void {
    const clock = this.clocksByStation.get(stationId);
    if (clock) this.clocksByStation.set(stationId, pauseClock(clock));
  }

  resumeStation(stationId: UUID): void {
    const clock = this.clocksByStation.get(stationId);
    if (clock) this.clocksByStation.set(stationId, startClock(clock));
  }

  setStationSpeed(stationId: UUID, speed: number): void {
    const clock = this.clocksByStation.get(stationId);
    if (clock) this.clocksByStation.set(stationId, setClockSpeed(clock, speed));
  }

  /** Resets simulation time for one station back to zero, paused, without touching scene contents. Called automatically by a successful `RESET` `LabAction` for the station(s) it scopes; exposed directly too, for a caller that wants to rewind only the clock (e.g. scrubbing playback back to the start without clearing chemistry). */
  resetStationClock(stationId: UUID): void {
    const clock = this.clocksByStation.get(stationId);
    if (clock) this.clocksByStation.set(stationId, resetClock(clock));
  }

  /**
   * Runs exactly one fixed simulation tick for `stationId`: every open, connected `FLOW_SOURCE`
   * delivers `flowRate * timeStepS` as a synthetic, deterministically-identified `TRANSFER`
   * (brief item 5). No-op (returns `[]`) while the station's clock is not `RUNNING` — this is what
   * makes pausing suspend transfer.
   */
  tick(stationId: UUID): readonly LabEventRecord[] {
    const clock = this.clocksByStation.get(stationId);
    if (!clock || clock.status !== 'RUNNING') return [];

    const records: LabEventRecord[] = [];
    for (const connection of fluidConnectionsInStation(this.scene, stationId)) {
      const source = this.scene.apparatus.find((a) => a.id === connection.from.instanceId);
      const receiver = this.scene.apparatus.find((a) => a.id === connection.to.instanceId);
      if (!source || !receiver) continue;
      const sourceDefinition = this.deps.registry.get(source.definitionId);
      if (!sourceDefinition) continue;
      const valveOpening = Number(source.config['valveOpening'] ?? 0);
      const requestedVolumeL = volumeOverTick(sourceDefinition, valveOpening, clock.timeStepS);
      if (requestedVolumeL <= 0) continue;

      const sourceContents = this.scene.containerStates[source.id];
      const receiverContents = this.scene.containerStates[receiver.id];
      if (!sourceContents || !receiverContents) continue;
      const receiverCapacityL = this.deps.registry.get(receiver.definitionId)?.capacityL;
      const preview = clampTransferVolume(sourceContents, receiverContents, requestedVolumeL, receiverCapacityL);
      if (preview.appliedVolumeL <= VOLUME_CONSERVATION_TOLERANCE_L) continue; // e.g. burette ran dry: a silent no-op, not a rejection

      const action: LabAction = {
        actionId: tickTransferActionId(stationId, connection.id, clock.tickIndex),
        atSimulationS: clock.simulationS + clock.timeStepS,
        targetInstanceId: source.id,
        type: 'TRANSFER',
        payload: { toInstanceId: receiver.id, volumeL: requestedVolumeL },
      };
      records.push(this.dispatch(action));
    }
    this.clocksByStation.set(stationId, stepOnce(clock));
    return records;
  }

  /** Runs as many fixed ticks as `elapsedRealS` of wall-clock time implies at the station's current speed. */
  advance(stationId: UUID, elapsedRealS: number): readonly LabEventRecord[] {
    const clock = this.clocksByStation.get(stationId);
    if (!clock) return [];
    const ticks = ticksForElapsed(clock, elapsedRealS, this.deps.maxTicksPerAdvance);
    const records: LabEventRecord[] = [];
    for (let i = 0; i < ticks; i += 1) records.push(...this.tick(stationId));
    return records;
  }

  // --- stations --------------------------------------------------------------------------------

  createStation(name: string, stationId: UUID = generateUUID()): UUID {
    this.dispatchOrThrow(buildCreateStationAction(stationId, name));
    return stationId;
  }

  /**
   * Copies a station's apparatus graph (and, by default, its current contents) into a brand new,
   * independently-clocked station (brief item 7: "duplicating a setup"). Every new instance gets a
   * fresh id; nothing is shared or cross-linked with the source (acceptance test: "Duplicate scene
   * produces new IDs without cross-linking or mutating original" — stated for whole scenes in
   * Agent 09's brief, and equally required here at station scope).
   */
  duplicateStation(sourceStationId: UUID, options?: { readonly name?: string; readonly copyContents?: boolean }): UUID {
    const source = findStation(this.scene, sourceStationId);
    if (!source.ok) throw new Error(source.reason);
    const copyContents = options?.copyContents ?? true;

    const newStationId = this.createStation(options?.name ?? `${source.value.name} (copy)`);
    const idMap = new Map<UUID, UUID>();
    const sourceInstances = this.scene.apparatus.filter((a) => a.stationId === sourceStationId);
    for (const instance of sourceInstances) {
      const newId = generateUUID();
      idMap.set(instance.id, newId);
      this.dispatchOrThrow(buildPlaceAction(newId, instance.definitionId, newStationId, instance.transform, { ...instance.config }));
    }
    const sourceInstanceIds = new Set(sourceInstances.map((a) => a.id));
    for (const connection of this.scene.connections) {
      if (!sourceInstanceIds.has(connection.from.instanceId) || !sourceInstanceIds.has(connection.to.instanceId)) continue;
      const fromId = idMap.get(connection.from.instanceId)!;
      const toId = idMap.get(connection.to.instanceId)!;
      this.dispatchOrThrow(buildAttachAction(fromId, connection.from.socketId, toId, connection.to.socketId));
    }
    if (copyContents) {
      for (const instance of sourceInstances) {
        const contents = this.scene.containerStates[instance.id];
        if (!contents || (contents.volumeL <= 0 && contents.species.length === 0)) continue;
        const newId = idMap.get(instance.id)!;
        this.dispatchOrThrow(
          buildFillAction(newId, {
            volumeL: contents.volumeL,
            species: contents.species,
            temperatureK: contents.temperatureK,
            modelId: contents.modelId,
          }),
        );
      }
    }
    return newStationId;
  }

  // --- events --------------------------------------------------------------------------------------

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Resolves once every solver request in flight at call time (and any they chain-trigger) has settled. Test/integration convenience — production UI should react to `OBSERVATION_RECORDED` events instead of polling this. */
  async settle(): Promise<void> {
    while (this.pendingSolverWork.size > 0) {
      await Promise.all([...this.pendingSolverWork]);
    }
  }

  // --- snapshot / replay -----------------------------------------------------------------------------

  createSnapshot(): EngineSnapshot {
    return buildEngineSnapshot(this.baseScene, this.scene, this.events, this.observationLedger.observations, this.deps.now());
  }

  /** Rebuilds a fresh engine from `snapshot.baseScene` and replays every logged action through `dispatch`, in order, reproducing the same scene, event log and (given a deterministic solver) the same observations. */
  static async replay(snapshot: EngineSnapshot, deps: ExperimentEngineDeps): Promise<ExperimentEngine> {
    const engine = new ExperimentEngine(snapshot.baseScene, deps);
    for (const record of snapshot.events) {
      engine.dispatch(record.action);
    }
    await engine.settle();
    return engine;
  }

  // --- internal --------------------------------------------------------------------------------------

  private syncClocksWithStations(): void {
    for (const station of this.scene.stations) {
      if (!this.clocksByStation.has(station.id)) {
        this.clocksByStation.set(station.id, createStationClock(station.id, this.scene.simulationConfig.timeStepS));
      }
    }
  }

  private recomputeAffected(containerIds: readonly UUID[], atSimulationS: number): readonly string[] {
    const requestIds: string[] = [];
    for (const containerId of new Set(containerIds)) {
      const instance = this.scene.apparatus.find((a) => a.id === containerId);
      if (!instance) continue;
      const plugin = this.deps.plugins.find((p) => {
        const support = p.detectSupport(this.scene, instance.stationId, this.deps.registry);
        return support.supported && p.selectObservationTargets(this.scene, instance.stationId).includes(containerId);
      });
      if (!plugin) continue;
      const contents = this.scene.containerStates[containerId];
      if (!contents) continue;
      const built = plugin.buildSolverRequest(contents, { temperatureK: contents.temperatureK }, { registry: this.deps.registry, atSimulationS });
      if (!built) continue;

      const { state, generation } = beginRecompute(this.observationLedger, containerId);
      this.observationLedger = state;
      const requestId = solverRequestId(containerId, generation);
      requestIds.push(requestId);
      const request: SolverRequest = { ...built, requestId, stationId: instance.stationId, apparatusId: containerId, atSimulationS };
      const work = this.runSolverRequest(request, containerId, generation);
      this.pendingSolverWork.add(work);
      void work.finally(() => this.pendingSolverWork.delete(work));
    }
    return requestIds;
  }

  private async runSolverRequest(request: SolverRequest, apparatusId: UUID, generation: number): Promise<void> {
    try {
      const response = await this.deps.solver.evaluate(request);
      const outcome = recordObservations(this.observationLedger, apparatusId, generation, response.observations);
      this.observationLedger = outcome.state;
      if (outcome.accepted && response.observations.length > 0) {
        this.emit({ kind: 'OBSERVATION_RECORDED', apparatusId, observations: response.observations });
      }
    } catch (error) {
      this.emit({ kind: 'SOLVER_REQUEST_FAILED', apparatusId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

export type { EngineSnapshot };

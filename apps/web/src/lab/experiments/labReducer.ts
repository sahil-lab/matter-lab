/**
 * PROVISIONAL STUB — owned by Agent 07 ("Experiment Graph Engineer") per
 * `Agent_07_Experiment_Graph_State_and_Simulation_Runtime.md`. That agent's branch did not exist
 * yet when this one was written, so Agent 04 (interaction/editor) wrote the smallest authoritative
 * reducer that satisfies `00_SHARED_INTEGRATION_CONTRACT.md` Section 4 ("Agent 7 authoritative
 * apparatus reducer... No other agent may independently invent a pH value or change species
 * inventory") well enough to exercise the editor's dispatch path end to end — placement, snapping,
 * fill, valve, metered transfer, live pH, pause/resume/reset, save/reopen. It deliberately does
 * **not** attempt Agent 07's full scope (plugin-based capability registry, append-only persisted
 * event log, arbitrary experiment templates); replace this whole file with Agent 07's real reducer
 * when that branch is integrated — `actionSink.ts` is the seam, so nothing elsewhere should need to
 * change. Every chemistry number this reducer produces is labelled `UNVERIFIED`
 * (`strongAcidBaseModel.ts`'s own caveat applies here too), never `MODEL_CALCULATED`.
 */
import { getApparatusDefinition } from '../apparatus/catalog';
import type { AttachPayload, DetachPayload, FillPayload, MovePayload, PlacePayload, ResetPayload, SetProbePayload, SetValvePayload, StartStirrerPayload, TransferPayload } from '../editor/actionPayloads';
import type { ActionRejection, LabActionDispatchResult, LabActionSink } from '../editor/actionSink';
import type { ApparatusInstance, Connection, ContainerContents, ExperimentScene, LabAction, Observation, SpeciesAmount, UUID } from '../editor/contracts';
import { newUUID } from '../editor/contracts';
import { computeStrongAcidBasePh, isKnownStrongElectrolyte, SUPPORTED_TEMPERATURE_K } from './strongAcidBaseModel';

const VOLUME_EPSILON_L = 1e-9;
const STRONG_ACID_BASE_METHOD_ID = 'strong-acid-base-charge-balance-stub-v1';

function reject(code: string, message: string): LabActionDispatchResult {
  return { accepted: false, rejection: { code, message } };
}

function accept(observations?: readonly Observation[], warnings?: readonly string[]): LabActionDispatchResult {
  return { accepted: true, observations, warnings };
}

function emptyContents(temperatureK = SUPPORTED_TEMPERATURE_K): ContainerContents {
  return { volumeL: 0, species: [], temperatureK, mixing: 'WELL_MIXED', modelId: 'empty' };
}

function mergeSpecies(a: readonly SpeciesAmount[], b: readonly SpeciesAmount[]): SpeciesAmount[] {
  const moles = new Map<string, number>();
  for (const s of a) moles.set(s.speciesId, (moles.get(s.speciesId) ?? 0) + s.moles);
  for (const s of b) moles.set(s.speciesId, (moles.get(s.speciesId) ?? 0) + s.moles);
  return [...moles.entries()].map(([speciesId, m]) => ({ speciesId, moles: m }));
}

function weightedAverageTemperature(volA: number, tempA: number, volB: number, tempB: number): number {
  const total = volA + volB;
  if (total <= 0) return tempB;
  return (volA * tempA + volB * tempB) / total;
}

/** A capability every target instance of a given `LabActionType` must declare (checked before the type-specific logic runs). */
const REQUIRED_CAPABILITY: Partial<Record<LabAction['type'], string>> = {
  FILL: 'CONTAINER',
  SET_VALVE: 'FLOW_SOURCE',
  START_STIRRER: 'STIRRING',
  SET_PROBE: 'PH_SENSOR',
};

export interface LabReducerOptions {
  /** Litres/second at `valveOpenFraction === 1`, keyed by apparatus `definitionId`. */
  readonly maxFlowRateLpsByDefinition?: Readonly<Record<string, number>>;
}

const DEFAULT_MAX_FLOW_LPS = 50 / 1000 / 25; // a 50 mL burette, fully open, empties in about 25 s.

/**
 * The authoritative (for this stand-in) single writer of apparatus placement, the connection
 * graph and every container's chemical inventory. Implements `LabActionSink` so it can be
 * installed via `installLabActionSink` exactly as Agent 07's real reducer eventually will be.
 */
export class LabReducer implements LabActionSink {
  private apparatus = new Map<UUID, ApparatusInstance>();
  private connections = new Map<UUID, Connection>();
  private containerStates = new Map<UUID, ContainerContents>();
  private revision = 0;
  private simulationS = 0;
  private running = true;
  private readonly processed = new Map<UUID, LabActionDispatchResult>();
  private readonly log: LabAction[] = [];
  private readonly observations: Observation[] = [];

  constructor(private readonly options: LabReducerOptions = {}) {}

  // ---------- LabActionSink ----------

  dispatch(action: LabAction): LabActionDispatchResult {
    const cached = this.processed.get(action.actionId);
    if (cached) return cached; // idempotent: a replayed/duplicate actionId never double-applies
    const result = this.apply(action);
    this.processed.set(action.actionId, result);
    if (result.accepted) this.log.push(action);
    return result;
  }

  getContainerStates(): Readonly<Record<UUID, ContainerContents>> {
    return Object.fromEntries(this.containerStates);
  }

  getObservations(apparatusId?: UUID): readonly Observation[] {
    return apparatusId ? this.observations.filter((o) => o.apparatusId === apparatusId) : this.observations;
  }

  /** The `LabActionSink` contract's reset: equivalent to a global `RESET` action. */
  reset(): void {
    this.applyReset({ scope: 'all' });
  }

  // ---------- extra surface used by the demo harness (not part of the formal sink contract) ----------

  getApparatus(): readonly ApparatusInstance[] {
    return [...this.apparatus.values()];
  }

  getConnections(): readonly Connection[] {
    return [...this.connections.values()];
  }

  getRevision(): number {
    return this.revision;
  }

  getSimulationS(): number {
    return this.simulationS;
  }

  isRunning(): boolean {
    return this.running;
  }

  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  getEventLog(): readonly LabAction[] {
    return this.log;
  }

  /**
   * Advances the simulation clock and auto-generates metered `TRANSFER`s for every enabled FLUID
   * connection whose source has an open valve — "run precisely metered transfers at variable
   * flow" (Section 6). Every litre moved still goes through `dispatch`/`applyTransfer`, so
   * conservation, capacity and idempotency are enforced on exactly the same path as a manual
   * transfer; nothing here is allowed to touch `containerStates` directly.
   */
  advanceSimulation(dtS: number): void {
    if (!this.running || !(dtS > 0)) return;
    this.simulationS += dtS;
    for (const connection of this.connections.values()) {
      if (connection.kind !== 'FLUID' || !connection.enabled) continue;
      const source = this.apparatus.get(connection.from.instanceId);
      if (!source) continue;
      const openFraction = Number(source.config['valveOpenFraction'] ?? 0);
      if (!(openFraction > 0)) continue;
      const maxFlowLps = this.options.maxFlowRateLpsByDefinition?.[source.definitionId] ?? DEFAULT_MAX_FLOW_LPS;
      const requested = maxFlowLps * Math.min(Math.max(openFraction, 0), 1) * dtS;
      const available = this.containerStates.get(source.id)?.volumeL ?? 0;
      const volumeL = Math.min(requested, available);
      if (volumeL <= VOLUME_EPSILON_L) continue;
      const payload: TransferPayload = { fromInstanceId: connection.from.instanceId, toInstanceId: connection.to.instanceId, volumeL };
      this.dispatch({ actionId: newUUID(), atSimulationS: this.simulationS, targetInstanceId: source.id, type: 'TRANSFER', payload: payload as unknown as Record<string, unknown>, actorId: 'simulation-clock' });
    }
  }

  exportScene(): ExperimentScene {
    const stationIds = new Set(this.getApparatus().map((a) => a.stationId));
    return {
      id: 'stub-scene',
      revision: this.revision,
      schemaVersion: 1,
      stations: [...stationIds].map((id) => ({ id, name: id })),
      apparatus: this.getApparatus(),
      connections: this.getConnections(),
      containerStates: this.getContainerStates(),
      simulationConfig: { methodId: STRONG_ACID_BASE_METHOD_ID, timeStepS: 0.05 },
    };
  }

  loadScene(scene: ExperimentScene): void {
    this.apparatus = new Map(scene.apparatus.map((a) => [a.id, a]));
    this.connections = new Map(scene.connections.map((c) => [c.id, c]));
    this.containerStates = new Map(Object.entries(scene.containerStates));
    this.revision = scene.revision;
    this.simulationS = 0;
    this.running = true;
    this.processed.clear();
    this.log.length = 0;
    this.observations.length = 0;
  }

  // ---------- dispatch ----------

  private apply(action: LabAction): LabActionDispatchResult {
    const requiredCapability = REQUIRED_CAPABILITY[action.type];
    if (requiredCapability && action.type !== 'RESET' && action.type !== 'PLACE') {
      const target = this.apparatus.get(action.targetInstanceId);
      if (!target) return reject('UNKNOWN_INSTANCE', `No apparatus with id ${action.targetInstanceId}.`);
      if (!target.capabilities.includes(requiredCapability as ApparatusInstance['capabilities'][number])) {
        return reject('MISSING_CAPABILITY', `${action.targetInstanceId} does not have the ${requiredCapability} capability required for ${action.type}.`);
      }
    }
    switch (action.type) {
      case 'PLACE':
        return this.applyPlace(action.targetInstanceId, action.payload as unknown as PlacePayload);
      case 'MOVE':
        return this.applyMove(action.targetInstanceId, action.payload as unknown as MovePayload);
      case 'ATTACH':
        return this.applyAttach(action.payload as unknown as AttachPayload);
      case 'DETACH':
        return this.applyDetach(action.payload as unknown as DetachPayload);
      case 'FILL':
        return this.applyFill(action.targetInstanceId, action.payload as unknown as FillPayload);
      case 'SET_VALVE':
        return this.applySetValve(action.targetInstanceId, action.payload as unknown as SetValvePayload);
      case 'TRANSFER':
        return this.applyTransfer(action.payload as unknown as TransferPayload);
      case 'START_STIRRER':
        return this.applyStartStirrer(action.targetInstanceId, action.payload as unknown as StartStirrerPayload);
      case 'SET_PROBE':
        return this.applySetProbe(action.targetInstanceId, action.payload as unknown as SetProbePayload);
      case 'RESET':
        return this.applyReset(action.payload as unknown as ResetPayload);
      case 'CUSTOM':
        return this.applyCustom(action.targetInstanceId, action.payload as { op?: string });
      default:
        return reject('UNKNOWN_ACTION_TYPE', `Unknown LabAction type: ${String((action as LabAction).type)}.`);
    }
  }

  private bump(): void {
    this.revision += 1;
  }

  private applyPlace(targetInstanceId: UUID, payload: PlacePayload): LabActionDispatchResult {
    if (this.apparatus.has(targetInstanceId)) return reject('DUPLICATE_INSTANCE', `${targetInstanceId} is already placed.`);
    const instance: ApparatusInstance = {
      id: targetInstanceId,
      kind: payload.kind,
      definitionId: payload.definitionId,
      transform: payload.transform,
      revision: 1,
      config: payload.config,
      capabilities: payload.capabilities,
      stationId: payload.stationId,
    };
    this.apparatus.set(targetInstanceId, instance);
    if (instance.capabilities.includes('CONTAINER')) this.containerStates.set(targetInstanceId, emptyContents());
    this.bump();
    return accept();
  }

  private applyMove(targetInstanceId: UUID, payload: MovePayload): LabActionDispatchResult {
    const instance = this.apparatus.get(targetInstanceId);
    if (!instance) return reject('UNKNOWN_INSTANCE', `No apparatus with id ${targetInstanceId}.`);
    this.apparatus.set(targetInstanceId, { ...instance, transform: payload.transform, revision: instance.revision + 1 });
    this.bump();
    return accept();
  }

  private socketOccupied(instanceId: UUID, socketId: string, multiple: boolean): boolean {
    if (multiple) return false;
    for (const connection of this.connections.values()) {
      if ((connection.from.instanceId === instanceId && connection.from.socketId === socketId) || (connection.to.instanceId === instanceId && connection.to.socketId === socketId)) return true;
    }
    return false;
  }

  private applyAttach(payload: AttachPayload): LabActionDispatchResult {
    const fromInstance = this.apparatus.get(payload.from.instanceId);
    const toInstance = this.apparatus.get(payload.to.instanceId);
    if (!fromInstance || !toInstance) return reject('UNKNOWN_INSTANCE', 'Both ends of a connection must already be placed.');
    if (fromInstance.id === toInstance.id) return reject('SELF_CONNECTION', 'An instrument cannot connect to itself.');
    if (this.connections.has(payload.connectionId)) return reject('DUPLICATE_CONNECTION', `${payload.connectionId} already exists.`);
    const fromSocket = getApparatusDefinition(fromInstance.definitionId)?.sockets.find((s) => s.id === payload.from.socketId);
    const toSocket = getApparatusDefinition(toInstance.definitionId)?.sockets.find((s) => s.id === payload.to.socketId);
    if (!fromSocket || !toSocket) return reject('UNKNOWN_SOCKET', 'One of the named sockets does not exist on its apparatus definition.');
    if (fromSocket.kind !== toSocket.kind || fromSocket.kind !== payload.kind) {
      return reject('INCOMPATIBLE_KIND', `${payload.from.socketId} (${fromSocket.kind}) cannot pair with ${payload.to.socketId} (${toSocket.kind}).`);
    }
    const fromAccepts = fromSocket.accepts.includes(toInstance.kind) || fromSocket.accepts.includes('ANY');
    const toAccepts = toSocket.accepts.includes(fromInstance.kind) || toSocket.accepts.includes('ANY');
    if (!fromAccepts || !toAccepts) return reject('INCOMPATIBLE_KIND', `${fromInstance.kind} and ${toInstance.kind} do not accept each other at these sockets.`);
    if (this.socketOccupied(fromInstance.id, fromSocket.id, fromSocket.multiple ?? false)) return reject('SOCKET_OCCUPIED', `${payload.from.socketId} is already connected.`);
    if (this.socketOccupied(toInstance.id, toSocket.id, toSocket.multiple ?? false)) return reject('SOCKET_OCCUPIED', `${payload.to.socketId} is already connected.`);
    this.connections.set(payload.connectionId, { id: payload.connectionId, from: payload.from, to: payload.to, kind: payload.kind, enabled: true });
    this.bump();
    return accept();
  }

  private applyDetach(payload: DetachPayload): LabActionDispatchResult {
    if (!this.connections.has(payload.connectionId)) return reject('UNKNOWN_CONNECTION', `No connection with id ${payload.connectionId}.`);
    this.connections.delete(payload.connectionId);
    this.bump();
    return accept();
  }

  private applyFill(targetInstanceId: UUID, payload: FillPayload): LabActionDispatchResult {
    if (payload.volumeL <= 0) return reject('NEGATIVE_VOLUME', 'Fill volume must be positive.');
    const target = this.apparatus.get(targetInstanceId)!;
    const existing = this.containerStates.get(targetInstanceId) ?? emptyContents(payload.temperatureK);
    const addedMoles = payload.concentrationMolPerL * payload.volumeL;
    const newVolume = existing.volumeL + payload.volumeL;
    const capacityL = getApparatusDefinition(target.definitionId)?.capacityL;
    if (capacityL != null && newVolume > capacityL + VOLUME_EPSILON_L) {
      return reject('CAPACITY_EXCEEDED', `Filling with ${(payload.volumeL * 1000).toFixed(2)} mL would exceed the ${(capacityL * 1000).toFixed(0)} mL capacity.`);
    }
    const merged = mergeSpecies(existing.species, addedMoles > 0 ? [{ speciesId: payload.speciesId, moles: addedMoles }] : []);
    const next: ContainerContents = {
      volumeL: newVolume,
      species: merged,
      temperatureK: weightedAverageTemperature(existing.volumeL, existing.temperatureK, payload.volumeL, payload.temperatureK),
      mixing: 'WELL_MIXED',
      modelId: STRONG_ACID_BASE_METHOD_ID,
    };
    this.containerStates.set(targetInstanceId, next);
    this.bump();
    return accept(this.recomputeObservations(targetInstanceId));
  }

  private applySetValve(targetInstanceId: UUID, payload: SetValvePayload): LabActionDispatchResult {
    const instance = this.apparatus.get(targetInstanceId)!;
    const openFraction = Math.min(Math.max(payload.openFraction, 0), 1);
    this.apparatus.set(targetInstanceId, { ...instance, config: { ...instance.config, valveOpenFraction: openFraction }, revision: instance.revision + 1 });
    this.bump();
    return accept();
  }

  private applyTransfer(payload: TransferPayload): LabActionDispatchResult {
    if (payload.volumeL <= 0) return reject('NEGATIVE_VOLUME', 'Transfer volume must be positive.');
    if (!this.apparatus.has(payload.fromInstanceId) || !this.apparatus.has(payload.toInstanceId)) return reject('UNKNOWN_INSTANCE', 'Both the source and the receiver must be placed.');
    const source = this.containerStates.get(payload.fromInstanceId);
    if (!source || source.volumeL + VOLUME_EPSILON_L < payload.volumeL) {
      return reject('INSUFFICIENT_VOLUME', `${payload.fromInstanceId} does not hold ${(payload.volumeL * 1000).toFixed(3)} mL.`);
    }
    const receiverInstance = this.apparatus.get(payload.toInstanceId)!;
    const receiver = this.containerStates.get(payload.toInstanceId) ?? emptyContents(source.temperatureK);
    const capacityL = getApparatusDefinition(receiverInstance.definitionId)?.capacityL;
    const newReceiverVolume = receiver.volumeL + payload.volumeL;
    if (capacityL != null && newReceiverVolume > capacityL + VOLUME_EPSILON_L) {
      return reject('CAPACITY_EXCEEDED', `${payload.toInstanceId} cannot hold another ${(payload.volumeL * 1000).toFixed(3)} mL.`);
    }

    const fraction = payload.volumeL / source.volumeL;
    const movedSpecies = source.species.map((s) => ({ speciesId: s.speciesId, moles: s.moles * fraction }));
    const remainingSpecies = source.species.map((s) => ({ speciesId: s.speciesId, moles: s.moles * (1 - fraction) }));

    const newSource: ContainerContents = { ...source, volumeL: source.volumeL - payload.volumeL, species: remainingSpecies };
    const newReceiver: ContainerContents = {
      volumeL: newReceiverVolume,
      species: mergeSpecies(receiver.species, movedSpecies),
      temperatureK: weightedAverageTemperature(receiver.volumeL, receiver.temperatureK, payload.volumeL, source.temperatureK),
      mixing: 'WELL_MIXED',
      modelId: STRONG_ACID_BASE_METHOD_ID,
    };
    this.containerStates.set(payload.fromInstanceId, newSource);
    this.containerStates.set(payload.toInstanceId, newReceiver);
    this.bump();
    const observations = [...this.recomputeObservations(payload.fromInstanceId), ...this.recomputeObservations(payload.toInstanceId)];
    return accept(observations);
  }

  private applyStartStirrer(targetInstanceId: UUID, payload: StartStirrerPayload): LabActionDispatchResult {
    const instance = this.apparatus.get(targetInstanceId)!;
    const speed = Math.min(Math.max(payload.speed, 0), 1);
    this.apparatus.set(targetInstanceId, { ...instance, config: { ...instance.config, speed }, revision: instance.revision + 1 });
    this.bump();
    return accept();
  }

  private applySetProbe(targetInstanceId: UUID, payload: SetProbePayload): LabActionDispatchResult {
    const instance = this.apparatus.get(targetInstanceId)!;
    this.apparatus.set(targetInstanceId, {
      ...instance,
      config: { ...instance.config, immersionDepthM: payload.immersionDepthM, intoInstanceId: payload.intoInstanceId },
      revision: instance.revision + 1,
    });
    this.bump();
    const observations = payload.intoInstanceId && payload.immersionDepthM > 0 ? this.recomputeObservations(payload.intoInstanceId, targetInstanceId) : [];
    return accept(observations);
  }

  private applyReset(payload: ResetPayload): LabActionDispatchResult {
    const inScope = (instance: ApparatusInstance) => payload.scope === 'all' || instance.stationId === payload.stationId;
    for (const instance of this.apparatus.values()) {
      if (!inScope(instance)) continue;
      if (instance.capabilities.includes('CONTAINER')) this.containerStates.set(instance.id, emptyContents());
      const definition = getApparatusDefinition(instance.definitionId);
      if (definition) this.apparatus.set(instance.id, { ...instance, config: definition.defaultConfig, revision: instance.revision + 1 });
    }
    const keep = (o: Observation) => {
      const owner = o.apparatusId ? this.apparatus.get(o.apparatusId) : undefined;
      return !owner || !inScope(owner);
    };
    const survivors = this.observations.filter(keep);
    this.observations.length = 0;
    this.observations.push(...survivors);
    if (payload.scope === 'all') this.simulationS = 0;
    this.bump();
    return accept();
  }

  private applyCustom(targetInstanceId: UUID, payload: { op?: string }): LabActionDispatchResult {
    if (payload.op !== 'REMOVE') return reject('UNSUPPORTED_CUSTOM_OP', `Unknown CUSTOM op: ${String(payload.op)}.`);
    if (!this.apparatus.has(targetInstanceId)) return reject('UNKNOWN_INSTANCE', `No apparatus with id ${targetInstanceId}.`);
    this.apparatus.delete(targetInstanceId);
    this.containerStates.delete(targetInstanceId);
    for (const connection of [...this.connections.values()]) {
      if (connection.from.instanceId === targetInstanceId || connection.to.instanceId === targetInstanceId) this.connections.delete(connection.id);
    }
    this.bump();
    return accept();
  }

  /** Recomputes VOLUME/CONCENTRATION/PH observations for a container whose contents just changed. `probeId` tags the reading with the sensing instrument rather than the vessel, when a probe triggered it. */
  private recomputeObservations(containerId: UUID, probeId?: UUID): Observation[] {
    const contents = this.containerStates.get(containerId);
    if (!contents) return [];
    const apparatusId = probeId ?? containerId;
    const produced: Observation[] = [
      { type: 'VOLUME', apparatusId, timeS: this.simulationS, quantity: { value: contents.volumeL * 1000, unit: 'mL' }, evidence: 'MODEL_CALCULATED', methodId: 'conservation-ledger-stub-v1', sourceIds: [] },
    ];
    const totalMoles = contents.species.reduce((sum, s) => sum + s.moles, 0);
    if (contents.volumeL > 0 && totalMoles > 0) {
      produced.push({ type: 'CONCENTRATION', apparatusId, timeS: this.simulationS, quantity: { value: totalMoles / contents.volumeL, unit: 'mol/L' }, evidence: 'MODEL_CALCULATED', methodId: 'conservation-ledger-stub-v1', sourceIds: [] });
    }
    if (contents.species.length > 0 && contents.species.every((s) => isKnownStrongElectrolyte(s.speciesId))) {
      const ph = computeStrongAcidBasePh(contents.species, contents.volumeL, contents.temperatureK);
      if (ph.supported) {
        produced.push({ type: 'PH', apparatusId, timeS: this.simulationS, quantity: { value: ph.pH, unit: 'pH' }, evidence: 'UNVERIFIED', methodId: STRONG_ACID_BASE_METHOD_ID, sourceIds: [] });
      }
    }
    this.observations.push(...produced);
    return produced;
  }
}

export function createLabReducer(options?: LabReducerOptions): LabReducer {
  return new LabReducer(options);
}

export type { ActionRejection };

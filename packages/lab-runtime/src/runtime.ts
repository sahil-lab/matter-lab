import {
  LAB_CONTRACT_VERSION, LAB_LIMITS, hashNodeRunInput, parseApparatusDefinition, parseExperimentScene,
  parseLabAction, parseLabContract, serializeLabContract,
} from '@matterlab/contracts';
import type {
  ActionReceipt, ApparatusCapabilityPlugin, ApparatusDefinitionReader, ApparatusInstance, ApparatusRuntimeState,
  ContainerContents, ControlReceipt, EquilibriumResult, ExperimentPlugin, ExperimentScene, JsonObject,
  LabAction, LabActionAdapter, LabActionOf, LabRuntimeEvent, LabRuntimeReader, ModelSupport, NodeRunRequest,
  Observation, ObservationRecord, ProblemDetails, ReplayStep, RunLimits, RuntimeCheckpoint,
  RuntimeControl, RuntimeSnapshot, StationRuntimeState, TerminalRunResult, UUID,
} from '@matterlab/contracts';
import { asProblem, fail, LabRuntimeError, problem } from './errors.ts';
import { definitionFor, isProbeImmersed, stationGraphProblems, validateConnection, validateInstance, validateMove } from './graph.ts';
import { deterministicId, freeze } from './immutable.ts';
import { MOLE_TOLERANCE, transferInventory, VOLUME_TOLERANCE_L } from './inventory.ts';
import { builtInCapabilities, CONFIGURATION_PLUGIN_ID, createAqueousExperimentPlugin, EDITOR_PLUGIN_ID, METERED_FLOW_METHOD_ID, resolveSolverRequests } from './plugins.ts';
import type { LabRuntime, LabRuntimeOptions, RuntimeDependencies } from './types.ts';

export const LAB_RUNTIME_VERSION = '1.0.0';
export const DEFAULT_RUN_LIMITS: RunLimits = freeze({
  maxTicks: 100_000, maxActions: 50_000, maxObservations: LAB_LIMITS.maxObservations, maxSimulationTimeS: 3600,
});
const TIME_TOLERANCE_S = 1e-9;
type EventData<Event = LabRuntimeEvent> = Event extends LabRuntimeEvent
  ? Omit<Event, 'runId' | 'sequence' | 'stationId' | 'epoch'> : never;
type Listener = Parameters<LabRuntimeReader['subscribe']>[0];
interface Transition { readonly snapshot: RuntimeSnapshot; readonly dirty: readonly UUID[] }

function initialControls(instance: ApparatusInstance): ApparatusRuntimeState {
  return {
    ...(instance.capabilities.includes('FLOW_SOURCE') ? { valveOpeningFraction: 0, deliveredVolumeL: 0 } : {}),
    ...(instance.capabilities.includes('STIRRING') ? { stirring: { enabled: false, frequencyHz: 0 } } : {}),
    ...(instance.capabilities.includes('PH_SENSOR') ? { probe: { containerInstanceId: null } } : {}),
  };
}
function stationState(old: StationRuntimeState, status: StationRuntimeState['status'], error?: ProblemDetails): StationRuntimeState {
  return {
    stationId: old.stationId, epoch: old.epoch, status, simulationTimeS: old.simulationTimeS,
    tick: old.tick, speed: old.speed, ...(error ? { error } : {}),
  };
}
function replaceStation(snapshot: RuntimeSnapshot, station: StationRuntimeState): RuntimeSnapshot {
  return { ...snapshot, stationStates: { ...snapshot.stationStates, [station.stationId]: station } };
}
function replaceInstances(scene: ExperimentScene, changed: readonly UUID[], update?: (instance: ApparatusInstance) => ApparatusInstance): ExperimentScene {
  const ids = new Set(changed);
  return { ...scene, apparatus: scene.apparatus.map((instance) => ids.has(instance.id)
    ? { ...(update ? update(instance) : instance), revision: instance.revision + 1 } : instance) };
}

export class RuntimeEngine implements LabRuntime {
  readonly reader: LabRuntimeReader;
  readonly actions: LabActionAdapter;
  private snapshot: RuntimeSnapshot;
  private publishedSnapshot: RuntimeSnapshot;
  private readonly initialScene: ExperimentScene;
  private readonly definitions: ApparatusDefinitionReader;
  private readonly options: LabRuntimeOptions;
  private readonly limits: RunLimits;
  private readonly experiments: readonly ExperimentPlugin[];
  private readonly capabilities: readonly ApparatusCapabilityPlugin[];
  private readonly listeners = new Set<Listener>();
  private readonly events: LabRuntimeEvent[] = [];
  private readonly steps: ReplayStep[] = [];
  private readonly actionIndex = new Map<UUID, { readonly input: string; readonly receipt: ActionReceipt }>();
  private readonly controlIndex = new Map<UUID, { readonly input: string; readonly receipt: ControlReceipt }>();
  private readonly startedEpochs = new Set<string>();
  private readonly latestResults = new Map<UUID, EquilibriumResult>();
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private totalTicks = 0;
  private batching = false;
  private editorBatching = false;
  private batchEvents: LabRuntimeEvent[] = [];

  constructor(options: LabRuntimeOptions) {
    this.options = {
      ...options,
      science: Object.freeze({ ...options.science, assumptions: Object.freeze([...options.science.assumptions]) }),
      ...(options.limits ? { limits: Object.freeze({ ...options.limits }) } : {}),
    };
    this.initialScene = parseExperimentScene(options.initialScene);
    this.limits = parseLabContract('NodeRunRequest', {
      schemaVersion: 1, runId: options.runId, contractVersion: LAB_CONTRACT_VERSION,
      runtimeVersion: LAB_RUNTIME_VERSION, methodVersion: options.science.methodVersion,
      initialScene: this.initialScene, steps: [], limits: options.limits ?? DEFAULT_RUN_LIMITS,
    }).limits!;
    const rawDefinitions = options.definitions.listDefinitions();
    if (!Array.isArray(rawDefinitions) || rawDefinitions.length > LAB_LIMITS.maxApparatus) fail('LIMIT_EXCEEDED', 'Definition provider exceeds its size cap.');
    const definitions = rawDefinitions.map((value) => parseApparatusDefinition(value));
    if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) {
      fail('INVALID_INPUT', 'Definition provider must be bounded and contain unique IDs.');
    }
    const table = new Map(definitions.map((definition) => [definition.id, definition]));
    this.definitions = Object.freeze({ getDefinition: (id: string) => table.get(id), listDefinitions: () => Object.freeze(definitions) });
    this.experiments = Object.freeze([...(options.experiments ?? [createAqueousExperimentPlugin(this.options.science)])]);
    this.capabilities = Object.freeze([...builtInCapabilities(), ...(options.capabilities ?? [])]);
    for (const plugins of [this.experiments, this.capabilities]) {
      if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) fail('INVALID_INPUT', 'Plugin IDs must be unique.');
    }
    this.snapshot = parseLabContract('RuntimeSnapshot', {
      schemaVersion: 1, runId: options.runId, revision: 0, scene: this.initialScene,
      stationStates: Object.fromEntries(this.initialScene.stations.map((station) => [station.id, {
        stationId: station.id, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1,
      }])),
      apparatusStates: Object.fromEntries(this.initialScene.apparatus.map((instance) => [instance.id, initialControls(instance)])),
      observations: [], transferTotals: [], lastSequence: 0,
    });
    this.publishedSnapshot = this.snapshot;
    this.reader = Object.freeze({
      getSnapshot: () => this.publishedSnapshot,
      subscribe: (listener: Listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
      },
    });
    this.actions = Object.freeze({
      dispatch: (action: LabAction) => this.enqueue(async () => {
        const parsed = parseLabAction(action);
        const duplicate = this.actionIndex.has(parsed.actionId);
        if (!duplicate && this.steps.length >= LAB_LIMITS.maxReplaySteps) fail('LIMIT_EXCEEDED', 'Replay step limit reached.');
        const receipt = await this.processAction(parsed);
        if (!duplicate) this.steps.push(freeze({ kind: 'ACTION', action: parsed }));
        return receipt;
      }),
      control: (command: RuntimeControl) => this.enqueue(async () => {
        const parsed = parseLabContract('RuntimeControl', command);
        const duplicate = this.controlIndex.has(parsed.controlId);
        if (!duplicate && this.steps.length >= LAB_LIMITS.maxReplaySteps) fail('LIMIT_EXCEEDED', 'Replay step limit reached.');
        const receipt = await this.processControl(parsed);
        if (!duplicate) this.steps.push(freeze({ kind: 'CONTROL', control: parsed }));
        return receipt;
      }),
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.disposed) fail('CANCELLED', 'This runtime has been disposed.');
      return task();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  async initialize(): Promise<void> {
    const pending: LabRuntimeEvent[] = [];
    const results = new Map<UUID, EquilibriumResult>();
    const next = await this.observe(this.snapshot, Object.keys(this.snapshot.scene.containerStates), pending, results);
    this.commit(next, pending, results);
  }
  private station(id: UUID, snapshot = this.snapshot): StationRuntimeState {
    const station = snapshot.stationStates[id];
    if (!station) fail('MISSING_REFERENCE', 'Station does not exist.');
    return station;
  }
  private target(action: LabAction, snapshot = this.snapshot): ApparatusInstance {
    const target = action.type === 'PLACE' ? action.payload.instance : snapshot.scene.apparatus.find((instance) => instance.id === action.targetInstanceId);
    if (!target) fail('MISSING_REFERENCE', 'Action target does not exist; no arbitrary station attribution is invented.');
    this.station(target.stationId, snapshot);
    return target;
  }
  private hasStarted(station: StationRuntimeState): boolean {
    return this.startedEpochs.has(`${station.stationId}:${station.epoch}`);
  }
  private assertTime(timeS: number, station: StationRuntimeState, epoch?: number): void {
    if ((epoch !== undefined && epoch !== station.epoch) || Math.abs(timeS - station.simulationTimeS) > TIME_TOLERANCE_S) {
      fail('STALE_ACTION', 'Command time/epoch does not match the current station clock.');
    }
  }
  private append(snapshot: RuntimeSnapshot, pending: LabRuntimeEvent[], stationId: UUID, data: EventData, epoch?: number): RuntimeSnapshot {
    const sequence = this.events.length + pending.length + 1;
    const event = parseLabContract('LabRuntimeEvent', {
      ...data, runId: snapshot.runId, sequence, stationId, epoch: epoch ?? this.station(stationId, snapshot).epoch,
    });
    pending.push(event);
    return { ...snapshot, lastSequence: sequence };
  }
  private commit(snapshot: RuntimeSnapshot, pending: readonly LabRuntimeEvent[], results = new Map<UUID, EquilibriumResult>()): void {
    if (this.disposed) fail('CANCELLED', 'Disposed runtime cannot commit pending work.');
    const commands = pending.filter((event) => event.type === 'ACTION' || event.type === 'CONTROL').length;
    if (this.events.length + pending.length > LAB_LIMITS.maxEvents ||
        this.actionIndex.size + this.controlIndex.size + commands > this.limits.maxActions ||
        snapshot.observations.length > this.limits.maxObservations) {
      fail('LIMIT_EXCEEDED', 'Event, command or observation cap reached; pending state changes were not committed.');
    }
    this.snapshot = freeze(snapshot);
    for (const event of pending) {
      this.events.push(event);
      if (event.type === 'ACTION') this.actionIndex.set(event.action.actionId, { input: serializeLabContract('LabAction', event.action), receipt: event.receipt });
      if (event.type === 'CONTROL') this.controlIndex.set(event.control.controlId, { input: serializeLabContract('RuntimeControl', event.control), receipt: event.receipt });
    }
    results.forEach((result, id) => this.latestResults.set(id, result));
    if (this.batching) {
      this.batchEvents.push(...pending);
      return;
    }
    this.publish(pending);
  }
  private publish(pending: readonly LabRuntimeEvent[]): void {
    const cleared = Object.entries(this.snapshot.apparatusStates).filter(([id, state]) =>
      state.probe?.containerInstanceId && !isProbeImmersed(this.snapshot, id, state.probe.containerInstanceId, this.definitions));
    if (cleared.length > 0) {
      this.snapshot = freeze({
        ...this.snapshot,
        apparatusStates: { ...this.snapshot.apparatusStates, ...Object.fromEntries(cleared.map(([id, state]) =>
          [id, { ...state, probe: { containerInstanceId: null } }])) },
      });
    }
    this.publishedSnapshot = this.snapshot;
    for (const event of pending) {
      for (const listener of this.listeners) {
        try { listener(this.snapshot, event); } catch { /* Observers cannot roll back committed inventory or block other consumers. */ }
      }
    }
  }
  getModelSupport(stationId: UUID): ModelSupport {
    this.station(stationId);
    const graphErrors = stationGraphProblems(this.snapshot.scene, stationId, this.definitions);
    if (graphErrors.length) return freeze({ status: 'UNSUPPORTED', methodId: this.snapshot.scene.simulationConfig.methodId, reasons: graphErrors.map((error) => error.detail) });
    const plugin = this.experiments.find((candidate) => candidate.methodId === this.snapshot.scene.simulationConfig.methodId);
    if (!plugin) return freeze({ status: 'UNSUPPORTED', methodId: this.snapshot.scene.simulationConfig.methodId, reasons: ['No registered experiment plugin supports this method.'] });
    return freeze(plugin.getSupport(this.snapshot.scene, stationId, this.definitions));
  }

  private transition(action: LabAction): Transition {
    const original = this.snapshot;
    const target = this.target(action);
    const station = this.station(target.stationId);
    this.assertTime(action.atSimulationS, station, action.expectedEpoch);
    if (action.expectedRevision !== undefined && action.expectedRevision !== original.revision) fail('REVISION_CONFLICT', 'Local runtime revision changed.');
    const definition = this.definitions.getDefinition(target.definitionId);
    if (action.type !== 'RESET') {
      const error = validateInstance(target, this.definitions);
      const editableUnknown = ['PLACE', 'MOVE'].includes(action.type) ||
        (action.type === 'CUSTOM' && action.payload.pluginId === EDITOR_PLUGIN_ID && action.payload.actionType === 'REMOVE_EMPTY_APPARATUS');
      if (error && !(editableUnknown && error.code === 'UNSUPPORTED_MODEL')) throw new LabRuntimeError(error);
    }
    for (const capability of this.capabilities.filter((plugin) => plugin.actionTypes.includes(action.type))) {
      const error = capability.validateAction(original, action);
      if (error) throw new LabRuntimeError(error);
    }
    let scene = original.scene;
    let apparatusStates = original.apparatusStates;
    let transferTotals = original.transferTotals;
    let stationStates = original.stationStates;
    let dirty: readonly UUID[] = [];
    const editable = station.status !== 'RUNNING';
    switch (action.type) {
      case 'PLACE':
        if (!editable) fail('INVALID_PHASE', 'Pause before editing apparatus.');
        if (scene.apparatus.some((instance) => instance.id === target.id) ||
            scene.stations.some((item) => item.id === target.id) || scene.connections.some((item) => item.id === target.id) || scene.id === target.id) {
          fail('DUPLICATE_ID', 'PLACE cannot reuse an existing entity ID.');
        }
        if (scene.apparatus.length >= LAB_LIMITS.maxApparatus) fail('LIMIT_EXCEEDED', 'Apparatus limit reached.');
        scene = { ...scene, apparatus: [...scene.apparatus, target] };
        apparatusStates = { ...apparatusStates, [target.id]: initialControls(target) };
        break;
      case 'MOVE': {
        if (!editable) fail('INVALID_PHASE', 'Pause before moving apparatus.');
        const error = definition ? validateMove(target, action.payload.transform, definition) : null;
        if (error) throw new LabRuntimeError(error);
        scene = replaceInstances(scene, [target.id], (instance) => ({ ...instance, transform: action.payload.transform }));
        for (const edge of scene.connections.filter((edge) => edge.from.instanceId === target.id || edge.to.instanceId === target.id)) {
          const invalid = validateConnection(scene, edge, this.definitions, !this.editorBatching);
          if (invalid) throw new LabRuntimeError(invalid);
        }
        break;
      }
      case 'ATTACH': {
        if (!editable) fail('INVALID_PHASE', 'Pause before editing connections.');
        if (scene.connections.some((edge) => edge.id === action.payload.connection.id)) fail('DUPLICATE_ID', 'Connection ID already exists.');
        const error = validateConnection(scene, action.payload.connection, this.definitions, !this.editorBatching);
        if (error) throw new LabRuntimeError(error);
        if (scene.connections.length >= LAB_LIMITS.maxConnections) fail('LIMIT_EXCEEDED', 'Connection limit reached.');
        scene = { ...scene, connections: [...scene.connections, action.payload.connection] };
        break;
      }
      case 'DETACH': {
        if (!editable) fail('INVALID_PHASE', 'Pause before detaching connections.');
        const edge = scene.connections.find((connection) => connection.id === action.payload.connectionId);
        if (!edge || (edge.from.instanceId !== target.id && edge.to.instanceId !== target.id)) fail('MISSING_REFERENCE', 'DETACH target is not an endpoint of that connection.');
        scene = { ...scene, connections: scene.connections.filter((connection) => connection.id !== edge.id) };
        apparatusStates = Object.fromEntries(Object.entries(apparatusStates).map(([id, state]) =>
          edge.kind === 'SENSOR' && (id === edge.from.instanceId || id === edge.to.instanceId) && state.probe
            ? [id, { ...state, probe: { containerInstanceId: null } }] : [id, state]));
        break;
      }
      case 'FILL':
        if (this.hasStarted(station) || station.status === 'RUNNING' || station.status === 'PAUSED') fail('INVALID_PHASE', 'FILL is explicit initial/external preparation, never a mass source during an experiment. RESET first.');
        if (!target.capabilities.includes('CONTAINER') || definition?.capacityL === undefined) fail('INVALID_ACTION', 'FILL requires a defined container capacity.');
        if (action.payload.contents.volumeL > definition.capacityL + VOLUME_TOLERANCE_L) fail('CAPACITY_EXCEEDED', 'Preparation exceeds the vessel capacity.');
        scene = { ...replaceInstances(scene, [target.id]), containerStates: { ...scene.containerStates, [target.id]: action.payload.contents } };
        stationStates = { ...stationStates, [station.stationId]: stationState(station, 'PREPARING') };
        dirty = [target.id];
        break;
      case 'SET_VALVE':
        if (action.payload.openingFraction > 0 && definition?.flowModel?.methodId !== METERED_FLOW_METHOD_ID) fail('UNSUPPORTED_MODEL', 'Opening a valve requires the declared linear metering model.');
        apparatusStates = { ...apparatusStates, [target.id]: { ...apparatusStates[target.id], valveOpeningFraction: action.payload.openingFraction } };
        scene = replaceInstances(scene, [target.id]);
        break;
      case 'TRANSFER': {
        if (station.status !== 'RUNNING') fail('INVALID_PHASE', 'Transfers only occur in RUNNING stations; pause suspends all movement.');
        const receiver = scene.apparatus.find((instance) => instance.id === action.payload.targetInstanceId);
        if (!receiver || receiver.stationId !== target.stationId) fail('CROSS_STATION_CONNECTION', 'Transfer receiver must belong to the same station.');
        const edge = scene.connections.find((connection) => connection.id === action.payload.connectionId);
        if (!edge || !edge.enabled || edge.kind !== 'FLUID' || edge.from.instanceId !== target.id || edge.to.instanceId !== receiver.id) {
          fail('INCOMPATIBLE_SOCKET', 'TRANSFER requires an enabled directed fluid connection between its exact source and receiver.');
        }
        const error = validateConnection(scene, edge, this.definitions);
        if (error) throw new LabRuntimeError(error);
        const source = scene.containerStates[target.id];
        const priorReceiver = scene.containerStates[receiver.id];
        if (!source) fail('INSUFFICIENT_VOLUME', 'Source has not been prepared.');
        const receiverCapacity = definitionFor(receiver, this.definitions).capacityL;
        if (receiverCapacity === undefined) fail('INVALID_ACTION', 'Receiver has no capacity.');
        const emptyReceiver: ContainerContents = { volumeL: 0, species: [], temperatureK: source.temperatureK, mixing: 'WELL_MIXED', modelId: source.modelId };
        const update = transferInventory(source, priorReceiver ?? emptyReceiver, action.payload.volumeL, receiverCapacity);
        scene = { ...replaceInstances(scene, [target.id, receiver.id]), containerStates: {
          ...scene.containerStates, [target.id]: update.source, [receiver.id]: update.receiver,
        } };
        const oldTotal = transferTotals.find((total) => total.sourceInstanceId === target.id && total.receiverInstanceId === receiver.id);
        transferTotals = [...transferTotals.filter((total) => total !== oldTotal), {
          sourceInstanceId: target.id, receiverInstanceId: receiver.id, deliveredVolumeL: (oldTotal?.deliveredVolumeL ?? 0) + update.transferredVolumeL,
        }].sort((a, b) => `${a.sourceInstanceId}:${a.receiverInstanceId}` < `${b.sourceInstanceId}:${b.receiverInstanceId}` ? -1 : 1);
        apparatusStates = { ...apparatusStates, [target.id]: {
          ...apparatusStates[target.id], deliveredVolumeL: (apparatusStates[target.id]?.deliveredVolumeL ?? 0) + update.transferredVolumeL,
        } };
        dirty = [target.id, receiver.id];
        break;
      }
      case 'START_STIRRER': {
        apparatusStates = { ...apparatusStates, [target.id]: { ...apparatusStates[target.id], stirring: action.payload } };
        const receivers = [...new Set(scene.connections.filter((edge) => edge.enabled && edge.from.instanceId === target.id && ['CONTROL', 'MECHANICAL'].includes(edge.kind))
          .map((edge) => edge.to.instanceId).filter((id) => scene.containerStates[id] !== undefined))];
        if (action.payload.enabled) {
          const contents = { ...scene.containerStates };
          for (const id of receivers) contents[id] = { ...contents[id]!, mixing: 'WELL_MIXED' };
          scene = { ...replaceInstances(scene, [target.id, ...receivers]), containerStates: contents };
          dirty = receivers;
        } else scene = replaceInstances(scene, [target.id]);
        break;
      }
      case 'SET_PROBE': {
        const id = action.payload.containerInstanceId;
        if (id !== null) {
          const container = scene.apparatus.find((instance) => instance.id === id);
          const edge = scene.connections.find((edge) => edge.enabled && edge.kind === 'SENSOR' && edge.from.instanceId === target.id && edge.to.instanceId === id);
          if (!container?.capabilities.includes('CONTAINER') || container.stationId !== target.stationId || !edge) fail('INCOMPATIBLE_SOCKET', 'Probe requires an enabled sensor connection to a same-station container.');
          const error = validateConnection(scene, edge, this.definitions);
          if (error) throw new LabRuntimeError(error);
          if (!isProbeImmersed(original, target.id, id, this.definitions)) fail('UNSUPPORTED_CONDITIONS', 'The probe tip must be inside the calibrated liquid volume; no ambient pH is invented.');
          dirty = [id];
        }
        apparatusStates = { ...apparatusStates, [target.id]: { ...apparatusStates[target.id], probe: action.payload } };
        scene = replaceInstances(scene, [target.id]);
        break;
      }
      case 'CUSTOM': {
        if (action.payload.pluginId === EDITOR_PLUGIN_ID && action.payload.actionType === 'REMOVE_EMPTY_APPARATUS') {
          if (Object.keys(action.payload.data).length !== 0) fail('INVALID_ACTION', 'Empty-apparatus removal takes no arbitrary payload.');
          if (this.hasStarted(station) || station.status === 'RUNNING' || station.status === 'PAUSED') {
            fail('INVALID_PHASE', 'Editor removal is preparation-only and cannot reverse a running experiment.');
          }
          const contents = scene.containerStates[target.id];
          if (contents && (contents.volumeL > 0 || contents.species.some((species) => species.moles > 0))) {
            fail('INVALID_PHASE', 'Nonempty apparatus cannot be removed through editor undo; inventory may only move by explicit transfer/reset.');
          }
          scene = {
            ...scene, apparatus: scene.apparatus.filter((instance) => instance.id !== target.id),
            connections: scene.connections.filter((edge) => edge.from.instanceId !== target.id && edge.to.instanceId !== target.id),
            containerStates: Object.fromEntries(Object.entries(scene.containerStates).filter(([id]) => id !== target.id)),
          };
          apparatusStates = Object.fromEntries(Object.entries(apparatusStates).filter(([id]) => id !== target.id).map(([id, state]) =>
            state.probe?.containerInstanceId === target.id ? [id, { ...state, probe: { containerInstanceId: null } }] : [id, state]));
          break;
        }
        if (action.payload.pluginId !== CONFIGURATION_PLUGIN_ID || action.payload.actionType !== 'SET_CONFIG' || !target.capabilities.includes('CONTAINER')) {
          fail('UNSUPPORTED_MODEL', 'No validated runtime handler exists for this custom action.');
        }
        if (station.status === 'RUNNING') fail('INVALID_PHASE', 'Pause before changing apparatus configuration.');
        const updated = { ...target, config: { ...target.config, ...action.payload.data } };
        const error = validateInstance(updated, this.definitions);
        if (error) throw new LabRuntimeError(error);
        scene = replaceInstances(scene, [target.id], () => updated);
        dirty = [target.id];
        break;
      }
      case 'RESET': {
        const affected = new Set(action.payload.scope === 'SCENE' ? scene.stations.map((station) => station.id) : [target.stationId]);
        const removeIds = new Set(scene.apparatus.filter((instance) => affected.has(instance.stationId)).map((instance) => instance.id));
        const restore = this.initialScene.apparatus.filter((instance) => affected.has(instance.stationId)).map((instance) => ({
          ...instance, revision: (scene.apparatus.find((current) => current.id === instance.id)?.revision ?? instance.revision) + 1,
        }));
        const restored = new Map(restore.map((instance) => [instance.id, instance]));
        const restoreIds = new Set(restore.map((instance) => instance.id));
        const contents = Object.fromEntries(Object.entries(scene.containerStates).filter(([id]) => !removeIds.has(id)));
        for (const [id, initial] of Object.entries(this.initialScene.containerStates)) if (restoreIds.has(id)) contents[id] = initial;
        scene = {
          ...scene,
          apparatus: [...scene.apparatus.flatMap((instance) => removeIds.has(instance.id)
            ? restored.has(instance.id) ? [restored.get(instance.id)!] : [] : [instance]),
          ...restore.filter((instance) => !scene.apparatus.some((current) => current.id === instance.id))],
          connections: [...scene.connections.filter((edge) => !removeIds.has(edge.from.instanceId) && !removeIds.has(edge.to.instanceId)),
            ...this.initialScene.connections.filter((edge) => restoreIds.has(edge.from.instanceId) && restoreIds.has(edge.to.instanceId))],
          containerStates: contents,
        };
        apparatusStates = { ...Object.fromEntries(Object.entries(apparatusStates).filter(([id]) => !removeIds.has(id))),
          ...Object.fromEntries(restore.map((instance) => [instance.id, initialControls(instance)])) };
        transferTotals = transferTotals.filter((total) => !removeIds.has(total.sourceInstanceId) && !removeIds.has(total.receiverInstanceId));
        stationStates = { ...stationStates };
        for (const id of affected) {
          const old = this.station(id);
          stationStates = { ...stationStates, [id]: { stationId: id, epoch: old.epoch + 1, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1 } };
        }
        dirty = restore.filter((instance) => contents[instance.id]).map((instance) => instance.id);
        break;
      }
    }
    return { snapshot: { ...original, revision: original.revision + 1, scene, apparatusStates, transferTotals, stationStates }, dirty };
  }

  private async observe(
    snapshot: RuntimeSnapshot, dirty: readonly UUID[], pending: LabRuntimeEvent[], results: Map<UUID, EquilibriumResult>,
  ): Promise<RuntimeSnapshot> {
    let current = snapshot;
    const stationIds = new Set(dirty.map((id) => current.scene.apparatus.find((instance) => instance.id === id)?.stationId).filter((id): id is UUID => id !== undefined));
    for (const stationId of stationIds) {
      const station = this.station(stationId, current);
      for (const id of dirty.filter((id) => current.scene.apparatus.some((instance) => instance.id === id && instance.stationId === stationId))) {
        const contents = current.scene.containerStates[id];
        if (!contents) continue;
        const base = {
          apparatusId: id, stationId, timeS: station.simulationTimeS, methodVersion: LAB_RUNTIME_VERSION,
          sourceIds: [...new Set(contents.species.flatMap((species) => species.sourceId ? [species.sourceId] : []))],
        };
        const observations: Observation[] = [
          { ...base, type: 'VOLUME', quantity: { value: contents.volumeL, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'inventory-ledger-v1' },
        ];
        const previousTemperature = current.observations.findLast((record) => record.stationId === stationId &&
          record.epoch === station.epoch && record.observation.apparatusId === id && record.observation.type === 'TEMPERATURE');
        if (!previousTemperature || previousTemperature.observation.quantity.value !== contents.temperatureK) observations.push({
          ...base, type: 'TEMPERATURE', quantity: { value: contents.temperatureK, unit: 'K' },
          evidence: 'UNVERIFIED', methodId: 'specified-isothermal-condition-v1',
        });
        current = await this.appendObservations(current, pending, stationId, observations);
      }
      const plugin = this.experiments.find((candidate) => candidate.methodId === current.scene.simulationConfig.methodId);
      let requests;
      try {
        if (!plugin) fail('UNSUPPORTED_MODEL', 'No experiment plugin supplies this calculation method.');
        requests = resolveSolverRequests(plugin, current, stationId, this.definitions).filter((request) => dirty.includes(request.apparatusId));
      } catch (error) {
        const detail = asProblem(error);
        current = replaceStation(current, stationState(this.station(stationId, current), 'UNSUPPORTED', detail));
        current = this.append(current, pending, stationId, { type: 'STATUS', status: 'UNSUPPORTED', error: detail });
        continue;
      }
      for (const request of requests) {
        const station = this.station(stationId, current);
        let result: EquilibriumResult;
        try {
          const raw = await this.options.science.solve(request.input);
          result = parseLabContract('EquilibriumResult', raw);
          if (result.methodId !== this.options.science.methodId || result.methodVersion !== this.options.science.methodVersion) {
            fail('METHOD_VERSION_MISMATCH', 'Scientific solver returned different method/version than the pinned adapter.');
          }
        } catch (error) {
          result = {
            status: 'FAILED', evidence: 'UNVERIFIED', methodId: this.options.science.methodId,
            methodVersion: this.options.science.methodVersion, sourceIds: [], warnings: [],
            assumptions: request.input.assumptions, limitations: ['No scientific numeric output is available.'], diagnostics: {},
            error: problem('SOLVER_FAILED', asProblem(error).detail, 500),
          };
        }
        results.set(request.apparatusId, freeze(result));
        const totals = current.transferTotals.filter((total) => total.receiverInstanceId === request.apparatusId);
        const candidateSources = current.scene.connections.filter((edge) => edge.enabled && edge.kind === 'FLUID' && edge.to.instanceId === request.apparatusId);
        const titration = totals.length === 1 && candidateSources.every((edge) => edge.from.instanceId === totals[0]!.sourceInstanceId)
          ? totals[0]
          : totals.length === 0 && candidateSources.length === 1 ? {
            sourceInstanceId: candidateSources[0]!.from.instanceId, receiverInstanceId: request.apparatusId, deliveredVolumeL: 0,
          } : undefined;
        const base = {
          apparatusId: request.apparatusId, stationId, timeS: station.simulationTimeS,
          methodId: result.methodId, methodVersion: result.methodVersion, sourceIds: result.sourceIds,
          ...(titration ? { titration } : {}),
        };
        const observations: Observation[] = [];
        if (result.status === 'SUCCEEDED') {
          observations.push({ ...base, type: 'PH', quantity: result.pH, evidence: result.evidence });
          for (const species of result.equilibriumSpecies) observations.push({
            ...base, type: 'CONCENTRATION', speciesId: species.speciesId,
            quantity: { value: species.concentrationMolL, unit: 'mol/L' }, evidence: result.evidence,
          });
          for (const indicator of result.indicators) observations.push({
            ...base, type: 'INDICATOR', indicatorId: indicator.indicatorId,
            quantity: { value: indicator.baseFraction, unit: '1' }, evidence: result.evidence,
            sourceIds: indicator.sourceIds, indicatorState: indicator,
          });
        }
        if (observations.length > 0) current = await this.appendObservations(current, pending, stationId, observations);
        if (result.status !== 'SUCCEEDED') {
          current = replaceStation(current, stationState(this.station(stationId, current), result.status === 'FAILED' ? 'FAILED' : 'UNSUPPORTED', result.error));
          current = this.append(current, pending, stationId, { type: 'STATUS', status: result.status, error: result.error });
        }
      }
    }
    return current;
  }
  private async appendObservations(
    snapshot: RuntimeSnapshot, pending: LabRuntimeEvent[], stationId: UUID, observations: readonly Observation[],
  ): Promise<RuntimeSnapshot> {
    const sequence = this.events.length + pending.length + 1;
    const records: ObservationRecord[] = [];
    for (const [index, observation] of observations.entries()) records.push(parseLabContract('ObservationRecord', {
      id: await deterministicId(snapshot.runId, `observation:${sequence}:${index}`), runId: snapshot.runId,
      stationId, epoch: this.station(stationId, snapshot).epoch, sequence, observation,
    }));
    return this.append({ ...snapshot, observations: [...snapshot.observations, ...records] }, pending, stationId,
      { type: 'OBSERVATIONS', observations: records });
  }

  private async processAction(action: LabAction): Promise<ActionReceipt> {
    const input = serializeLabContract('LabAction', action);
    const previous = this.actionIndex.get(action.actionId);
    if (previous) {
      if (previous.input !== input) fail('ACTION_ID_CONFLICT', 'Action ID already belongs to a different immutable command.');
      return previous.receipt;
    }
    if (this.controlIndex.has(action.actionId)) fail('ACTION_ID_CONFLICT', 'Command UUID is already used by a control.');
    if (action.type === 'CUSTOM' && action.payload.pluginId === EDITOR_PLUGIN_ID && action.payload.actionType === 'BATCH') {
      return this.processEditorBatch(action);
    }
    const target = this.target(action);
    const station = this.station(target.stationId);
    const pending: LabRuntimeEvent[] = [];
    const header = { actionId: action.actionId, sequence: this.events.length + 1, stationId: station.stationId, epoch: station.epoch };
    let transition: Transition;
    try { transition = this.transition(action); }
    catch (error) {
      const receipt = parseLabContract('ActionReceipt', { ...header, runtimeRevision: this.snapshot.revision, status: 'REJECTED', error: asProblem(error) });
      const current = this.append(this.snapshot, pending, station.stationId, { type: 'ACTION', action, receipt });
      this.commit(current, pending);
      return this.actionIndex.get(action.actionId)!.receipt;
    }
    const receipt = parseLabContract('ActionReceipt', { ...header, runtimeRevision: transition.snapshot.revision, status: 'APPLIED' });
    let current = this.append(transition.snapshot, pending, station.stationId, { type: 'ACTION', action, receipt }, station.epoch);
    const results = new Map<UUID, EquilibriumResult>();
    current = await this.observe(current, transition.dirty, pending, results);
    this.commit(current, pending, results);
    return this.actionIndex.get(action.actionId)!.receipt;
  }

  private async processControl(control: RuntimeControl): Promise<ControlReceipt> {
    const input = serializeLabContract('RuntimeControl', control);
    const previous = this.controlIndex.get(control.controlId);
    if (previous) {
      if (previous.input !== input) fail('ACTION_ID_CONFLICT', 'Control ID already belongs to another command.');
      return previous.receipt;
    }
    if (this.actionIndex.has(control.controlId)) fail('ACTION_ID_CONFLICT', 'Command UUID is already used by an action.');
    const station = this.station(control.stationId);
    const header = { controlId: control.controlId, sequence: this.events.length + 1, stationId: station.stationId, epoch: station.epoch };
    const pending: LabRuntimeEvent[] = [];
    let current = this.snapshot;
    let nextStation: StationRuntimeState;
    try {
      this.assertTime(control.atSimulationS, station, control.expectedEpoch);
      if (control.type === 'SET_SPEED') nextStation = { ...station, speed: control.payload.speed };
      else if (control.type === 'PAUSE') {
        if (!['RUNNING', 'PAUSED'].includes(station.status)) fail('INVALID_PHASE', 'Only a running experiment can be paused.');
        nextStation = stationState(station, 'PAUSED');
      } else {
        const support = this.getModelSupport(station.stationId);
        if (support.status !== 'SUPPORTED') fail('UNSUPPORTED_MODEL', support.reasons.join(' '));
        if (!['PREPARING', 'PAUSED', 'RUNNING'].includes(station.status)) fail('INVALID_PHASE', 'Resolve failed/unsupported calculations by resetting before resuming.');
        nextStation = stationState(station, 'RUNNING');
      }
      current = { ...replaceStation(current, nextStation), revision: current.revision + 1 };
    } catch (error) {
      const receipt = parseLabContract('ControlReceipt', { ...header, runtimeRevision: current.revision, status: 'REJECTED', error: asProblem(error) });
      current = this.append(this.snapshot, pending, station.stationId, { type: 'CONTROL', control, receipt });
      this.commit(current, pending);
      return this.controlIndex.get(control.controlId)!.receipt;
    }
    const receipt = parseLabContract('ControlReceipt', { ...header, runtimeRevision: current.revision, status: 'APPLIED' });
    current = this.append(current, pending, station.stationId, { type: 'CONTROL', control, receipt });
    const results = new Map<UUID, EquilibriumResult>();
    if (control.type === 'RESUME') {
      current = await this.observe(current, current.scene.apparatus.filter((instance) => instance.stationId === station.stationId).map((instance) => instance.id), pending, results);
    }
    this.commit(current, pending, results);
    if (control.type === 'RESUME') this.startedEpochs.add(`${station.stationId}:${station.epoch}`);
    return this.controlIndex.get(control.controlId)!.receipt;
  }

  advanceStation(stationId: UUID, ticks: number): Promise<RuntimeSnapshot> {
    return this.enqueue(async () => {
      const step = parseLabContract('ReplayStep', { kind: 'ADVANCE', stationId, ticks });
      this.station(stationId);
      if (this.steps.length >= LAB_LIMITS.maxReplaySteps) fail('LIMIT_EXCEEDED', 'Replay step limit reached.');
      const before = this.snapshot;
      const eventCount = this.events.length;
      const ticksBefore = this.totalTicks;
      const actionsBefore = new Map(this.actionIndex);
      const resultsBefore = new Map(this.latestResults);
      this.batching = true;
      this.batchEvents = [];
      try {
      for (let count = 0; count < ticks; count++) {
        const station = this.station(stationId);
        if (station.status !== 'RUNNING') break;
        if (this.totalTicks >= this.limits.maxTicks) fail('LIMIT_EXCEEDED', 'Fixed tick budget exhausted.');
        const timeS = (station.tick + 1) * this.snapshot.scene.simulationConfig.timeStepS;
        if (timeS > this.limits.maxSimulationTimeS) fail('LIMIT_EXCEEDED', 'Station simulation-time budget exhausted.');
        const pending: LabRuntimeEvent[] = [];
        let next = { ...replaceStation(this.snapshot, { ...station, tick: station.tick + 1, simulationTimeS: timeS }), revision: this.snapshot.revision + 1 };
        next = this.append(next, pending, stationId, { type: 'ADVANCE', fromSimulationS: station.simulationTimeS, toSimulationS: timeS, ticks: 1 });
        this.commit(next, pending);
        this.totalTicks++;
        await this.flowTick(stationId);
        for (const plugin of this.capabilities) {
          const proposals = plugin.proposeActions(this.snapshot, stationId, this.station(stationId).tick);
          if (proposals.length > 128) fail('LIMIT_EXCEEDED', 'Capability plugin proposed too many actions in a tick.');
          for (const proposal of proposals) {
            const action = parseLabAction(proposal);
            if (!plugin.actionTypes.includes(action.type) || this.target(action).stationId !== stationId) fail('UNSUPPORTED_MODEL', 'Capability plugin proposed an unregistered action or cross-station write.');
            await this.processAction(action);
          }
        }
      }
      this.steps.push(step);
      } catch (error) {
        this.snapshot = before;
        this.events.length = eventCount;
        this.totalTicks = ticksBefore;
        this.actionIndex.clear();
        actionsBefore.forEach((value, id) => this.actionIndex.set(id, value));
        this.latestResults.clear();
        resultsBefore.forEach((value, id) => this.latestResults.set(id, value));
        this.batchEvents = [];
        throw error;
      } finally {
        this.batching = false;
      }
      this.publish(this.batchEvents);
      this.batchEvents = [];
      return this.snapshot;
    });
  }
  private async flowTick(stationId: UUID): Promise<void> {
    const edges = this.snapshot.scene.connections.filter((edge) => edge.enabled && edge.kind === 'FLUID' &&
      this.snapshot.scene.apparatus.some((instance) => instance.id === edge.from.instanceId && instance.stationId === stationId))
      .sort((a, b) => a.id < b.id ? -1 : 1);
    for (const edge of edges) {
      const station = this.station(stationId);
      if (station.status !== 'RUNNING') return;
      const source = this.snapshot.scene.apparatus.find((instance) => instance.id === edge.from.instanceId)!;
      const opening = this.snapshot.apparatusStates[source.id]?.valveOpeningFraction ?? 0;
      if (opening <= 0) continue;
      const definition = definitionFor(source, this.definitions);
      const flow = definition.flowModel;
      if (!flow || flow.methodId !== METERED_FLOW_METHOD_ID ||
          edges.filter((candidate) => candidate.from.instanceId === source.id).length !== 1) {
        const error = problem('UNSUPPORTED_MODEL', 'Flow requires the declared flow:linear-valve-v1 model and one unambiguous receiver.');
        const pending: LabRuntimeEvent[] = [];
        let next = replaceStation(this.snapshot, stationState(station, 'UNSUPPORTED', error));
        next = this.append(next, pending, stationId, { type: 'STATUS', status: 'UNSUPPORTED', error });
        this.commit(next, pending);
        return;
      }

      const receiver = this.snapshot.scene.apparatus.find((instance) => instance.id === edge.to.instanceId)!;
      const capacity = definitionFor(receiver, this.definitions).capacityL;
      if (capacity === undefined) fail('UNSUPPORTED_MODEL', 'Flow receiver lacks a declared capacity.');
      const sourceVolume = this.snapshot.scene.containerStates[source.id]?.volumeL ?? 0;
      const receiverVolume = this.snapshot.scene.containerStates[receiver.id]?.volumeL ?? 0;
      const space = Math.max(0, capacity - receiverVolume);
      let volumeL = Math.min(opening * flow.maxFlowLPerS * this.snapshot.scene.simulationConfig.timeStepS, sourceVolume, space);
      if (sourceVolume - volumeL <= VOLUME_TOLERANCE_L && space >= sourceVolume) volumeL = sourceVolume;
      if (volumeL > 0) {
        await this.processAction(parseLabAction({
          actionId: await deterministicId(this.snapshot.runId, `flow:${stationId}:${station.epoch}:${station.tick}:${edge.id}`),
          atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch, targetInstanceId: source.id, type: 'TRANSFER',
          payload: { sourceInstanceId: source.id, targetInstanceId: receiver.id, volumeL, connectionId: edge.id },
        }));
      }
      const nowSource = this.snapshot.scene.containerStates[source.id]?.volumeL ?? 0;
      const nowReceiver = this.snapshot.scene.containerStates[receiver.id]?.volumeL ?? 0;
      if (volumeL <= 0 || nowSource <= VOLUME_TOLERANCE_L || capacity - nowReceiver <= VOLUME_TOLERANCE_L) {
        await this.processAction(parseLabAction({
          actionId: await deterministicId(this.snapshot.runId, `close:${stationId}:${station.epoch}:${station.tick}:${edge.id}`),
          atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch, targetInstanceId: source.id, type: 'SET_VALVE', payload: { openingFraction: 0 },
        }));
      }
    }
  }

  private async processEditorBatch(parent: LabActionOf<'CUSTOM'>): Promise<ActionReceipt> {
    const raw = parent.payload.data.actions;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64 ||
        Object.keys(parent.payload.data).some((key) => key !== 'actions')) {
      fail('INVALID_ACTION', 'Editor BATCH requires exactly one actions array with 1–64 validated graph commands.');
    }
    const actions = raw.map((action) => parseLabAction(action));
    if (actions.some((action) => !['PLACE', 'MOVE', 'ATTACH', 'DETACH'].includes(action.type) &&
        !(action.type === 'CUSTOM' && action.payload.pluginId === EDITOR_PLUGIN_ID && action.payload.actionType === 'REMOVE_EMPTY_APPARATUS'))) {
      fail('INVALID_ACTION', 'Editor BATCH cannot change preparation or inventory, run controls, reset time, or nest batches.');
    }
    if (actions.some((action) => action.actionId === parent.actionId)) fail('ACTION_ID_CONFLICT', 'Batch ID cannot equal a child action ID.');
    const station = this.station(this.target(actions[0]!).stationId);
    if (parent.targetInstanceId !== actions[0]!.targetInstanceId) fail('INVALID_ACTION', 'Batch anchor must match its first graph action.');
    const before = this.snapshot;
    const eventCount = this.events.length;
    const priorActions = new Map(this.actionIndex);
    const touched = new Set<UUID>();
    this.batching = true;
    this.editorBatching = true;
    this.batchEvents = [];
    let rejected: ProblemDetails | undefined;
    try {
      this.assertTime(parent.atSimulationS, station, parent.expectedEpoch);
      if (parent.expectedRevision !== undefined && parent.expectedRevision !== this.snapshot.revision) fail('REVISION_CONFLICT', 'Batch runtime revision changed.');
      for (const action of actions) {
        touched.add(action.targetInstanceId);
        const receipt = await this.processAction(action);
        if (receipt.status === 'REJECTED') throw new LabRuntimeError(receipt.error);
      }
      for (const edge of this.snapshot.scene.connections.filter((edge) => touched.has(edge.from.instanceId) || touched.has(edge.to.instanceId))) {
        const invalid = validateConnection(this.snapshot.scene, edge, this.definitions);
        if (invalid) throw new LabRuntimeError(invalid);
      }
      const receipt = parseLabContract('ActionReceipt', {
        actionId: parent.actionId, sequence: this.events.length + 1, stationId: station.stationId,
        epoch: station.epoch, runtimeRevision: this.snapshot.revision, status: 'APPLIED',
      });
      const pending: LabRuntimeEvent[] = [];
      const next = this.append(this.snapshot, pending, station.stationId, { type: 'ACTION', action: parent, receipt });
      this.commit(next, pending);
    } catch (error) {
      this.snapshot = before;
      this.events.length = eventCount;
      this.actionIndex.clear();
      priorActions.forEach((value, id) => this.actionIndex.set(id, value));
      this.batchEvents = [];
      rejected = asProblem(error);
    } finally {
      this.batching = false;
      this.editorBatching = false;
    }
    if (rejected) {
      const receipt = parseLabContract('ActionReceipt', {
        actionId: parent.actionId, sequence: this.events.length + 1, stationId: station.stationId,
        epoch: station.epoch, runtimeRevision: this.snapshot.revision, status: 'REJECTED', error: rejected,
      });
      const pending: LabRuntimeEvent[] = [];
      const next = this.append(this.snapshot, pending, station.stationId, { type: 'ACTION', action: parent, receipt });
      this.commit(next, pending);
    } else this.publish(this.batchEvents);
    this.batchEvents = [];
    return this.actionIndex.get(parent.actionId)!.receipt;
  }

  dispatchBatch(actions: readonly LabAction[]): Promise<readonly ActionReceipt[]> {
    return this.enqueue(async () => {
      if (actions.length === 0 || actions.length > 64) fail('LIMIT_EXCEEDED', 'Editor batches require 1–64 actions.');
      const parsed = actions.map((action) => parseLabAction(action));
      const first = parsed[0]!;
      const actionId = await deterministicId(this.snapshot.runId, `editor-batch:${parsed.map((action) => serializeLabContract('LabAction', action)).join('\n')}`);
      const parent = parseLabAction({
        actionId, atSimulationS: first.atSimulationS, targetInstanceId: first.targetInstanceId,
        type: 'CUSTOM', payload: { pluginId: EDITOR_PLUGIN_ID, actionType: 'BATCH', data: { actions: parsed } },
        ...(first.expectedRevision !== undefined ? { expectedRevision: first.expectedRevision } : {}),
        ...(first.expectedEpoch !== undefined ? { expectedEpoch: first.expectedEpoch } : {}),
        ...(first.actorId ? { actorId: first.actorId } : {}),
      });
      const duplicate = this.actionIndex.has(actionId);
      if (!duplicate && this.steps.length >= LAB_LIMITS.maxReplaySteps) fail('LIMIT_EXCEEDED', 'Replay step limit reached.');
      const receipt = await this.processAction(parent);
      if (!duplicate) this.steps.push(freeze({ kind: 'ACTION', action: parent }));
      if (receipt.status === 'REJECTED') throw new LabRuntimeError(receipt.error);
      return Object.freeze(parsed.map((action) => this.actionIndex.get(action.actionId)!.receipt));
    });
  }

  getCheckpoint(): Promise<RuntimeCheckpoint> {
    return this.enqueue(async () => {
      const request: NodeRunRequest = {
        schemaVersion: 1, runId: this.snapshot.runId, contractVersion: LAB_CONTRACT_VERSION,
        runtimeVersion: LAB_RUNTIME_VERSION, methodVersion: this.options.science.methodVersion,
        initialScene: this.initialScene, steps: [...this.steps], ...(this.options.limits ? { limits: this.options.limits } : {}),
      };
      return parseLabContract('RuntimeCheckpoint', {
        schemaVersion: 1, contractVersion: LAB_CONTRACT_VERSION, runtimeVersion: LAB_RUNTIME_VERSION,
        methodVersion: this.options.science.methodVersion, inputHash: await hashNodeRunInput(request),
        initialScene: this.initialScene, snapshot: this.snapshot, steps: request.steps, completedStepCount: this.steps.length,
        ...(this.options.limits ? { limits: this.options.limits } : {}), events: [...this.events],
      });
    });
  }
  getDiagnostics(): JsonObject {
    return freeze({
      contractVersion: LAB_CONTRACT_VERSION, runtimeVersion: LAB_RUNTIME_VERSION, totalTicks: this.totalTicks,
      volumeToleranceL: VOLUME_TOLERANCE_L, moleTolerance: MOLE_TOLERANCE,
      definitionVersions: Object.fromEntries(this.definitions.listDefinitions().map((definition) => [definition.id, definition.version])),
      solverByApparatus: Object.fromEntries([...this.latestResults].map(([id, result]) => [id, result.diagnostics])),
    });
  }
  makeResult(inputHash: string, error?: ProblemDetails): TerminalRunResult {
    const failures = Object.values(this.snapshot.stationStates).filter((station) => station.status === 'FAILED' || station.status === 'UNSUPPORTED');
    const rejection = [...this.events].reverse().find((event) =>
      (event.type === 'ACTION' || event.type === 'CONTROL') && event.receipt.status === 'REJECTED');
    const rejectedProblem = rejection && (rejection.type === 'ACTION' || rejection.type === 'CONTROL') && rejection.receipt.status === 'REJECTED'
      ? rejection.receipt.error : undefined;
    const failure = error ?? failures[0]?.error ?? rejectedProblem;
    const status = failure ? failure.code.startsWith('UNSUPPORTED') ? 'UNSUPPORTED' : failure.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED' : 'SUCCEEDED';
    const common = {
      runId: this.snapshot.runId, methodId: this.initialScene.simulationConfig.methodId,
      methodVersion: this.options.science.methodVersion, inputHash,
      observations: this.snapshot.observations.map((record) => record.observation),
      assumptions: [...new Set([...this.options.science.assumptions, 'Explicit initial/external preparation; additive metered volumes; no detailed fluid hydrodynamics.',
        ...[...this.latestResults.values()].flatMap((result) => result.assumptions)])],
      warnings: [...new Set([...this.latestResults.values()].flatMap((result) => result.warnings))],
      limitations: [...new Set(['Specified isothermal conditions; no thermal mixing, evaporation or spills.',
        ...[...this.latestResults.values()].flatMap((result) => result.limitations)])],
      solverDiagnostics: this.getDiagnostics(),
    };
    return parseLabContract('TerminalRunResult', {
      ...common, status, ...((status === 'FAILED' || status === 'UNSUPPORTED') && failure ? { error: failure } : {}),
    });
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}

export async function createLabRuntime(options: LabRuntimeOptions): Promise<LabRuntime> {
  const runtime = new RuntimeEngine(options);
  await runtime.initialize();
  return runtime;
}

export async function restoreLabRuntime(input: RuntimeCheckpoint, dependencies: RuntimeDependencies): Promise<LabRuntime> {
  const checkpoint = parseLabContract('RuntimeCheckpoint', input);
  if (checkpoint.contractVersion !== LAB_CONTRACT_VERSION || checkpoint.runtimeVersion !== LAB_RUNTIME_VERSION ||
      checkpoint.methodVersion !== dependencies.science.methodVersion) {
    fail('METHOD_VERSION_MISMATCH', 'Checkpoint contract/runtime/science versions differ; no silent checkpoint upgrade is performed.');
  }
  const request: NodeRunRequest = {
    schemaVersion: 1, runId: checkpoint.snapshot.runId, contractVersion: checkpoint.contractVersion,
    runtimeVersion: checkpoint.runtimeVersion, methodVersion: checkpoint.methodVersion,
    initialScene: checkpoint.initialScene, steps: checkpoint.steps, ...(checkpoint.limits ? { limits: checkpoint.limits } : {}),
  };
  if (await hashNodeRunInput(request) !== checkpoint.inputHash) fail('INPUT_HASH_MISMATCH', 'Checkpoint frozen input hash does not match its initial state and ordered steps.');
  const runtime = new RuntimeEngine({
    ...dependencies, initialScene: checkpoint.initialScene, runId: checkpoint.snapshot.runId,
    ...(checkpoint.limits ? { limits: checkpoint.limits } : {}),
  });
  await runtime.initialize();
  for (const step of checkpoint.steps.slice(0, checkpoint.completedStepCount)) await applyReplayStep(runtime, step);
  const replayed = await runtime.getCheckpoint();
  if (serializeLabContract('RuntimeSnapshot', replayed.snapshot) !== serializeLabContract('RuntimeSnapshot', checkpoint.snapshot) ||
      replayed.events.length !== checkpoint.events.length ||
      replayed.events.some((event, index) => serializeLabContract('LabRuntimeEvent', event) !== serializeLabContract('LabRuntimeEvent', checkpoint.events[index]!))) {
    runtime.dispose();
    fail('INPUT_HASH_MISMATCH', 'Checkpoint inventory/observations/events do not reproduce from its immutable input. Untrusted results were not restored.');
  }
  return runtime;
}
export async function applyReplayStep(runtime: LabRuntime, step: ReplayStep): Promise<void> {
  if (step.kind === 'ACTION') await runtime.actions.dispatch(step.action);
  else if (step.kind === 'CONTROL') await runtime.actions.control(step.control);
  else await runtime.advanceStation(step.stationId, step.ticks);
}

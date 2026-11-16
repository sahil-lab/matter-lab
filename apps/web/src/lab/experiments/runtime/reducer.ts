/**
 * The authoritative apparatus/inventory reducer (brief item 3). `applyLabAction` is a pure
 * function: `(scene, action, context) -> outcome`. It never calls the solver and never generates
 * an id, timestamp or random number itself — every value it needs is already in the action, so
 * replaying the same ordered action list against the same starting scene always produces the same
 * resulting scene (acceptance test: "replay produces identical observations").
 *
 * Idempotency (duplicate `actionId`) and the append-only log live one layer up, in `eventLog.ts` /
 * `engine.ts`: this module only ever sees an action once per call and does not know or care
 * whether it has "already" been applied.
 */
import {
  isLabActionType,
  type ApparatusDefinitionLookup,
  type ApparatusInstance,
  type ContainerContents,
  type ExperimentScene,
  type LabAction,
  type UUID,
} from '@matterlab/contracts';
import {
  parseAttachPayload,
  parseCreateStationPayload,
  parseDetachPayload,
  parseFillPayload,
  parseMovePayload,
  parsePlacePayload,
  parseResetPayload,
  parseSetProbePayload,
  parseSetValvePayload,
  parseStartStirrerPayload,
  parseTransferPayload,
} from './actionPayloads';
import { clampValveOpening } from './flow';
import { buildFilledContents, applyTransfer } from './inventory';
import {
  findConnection,
  findInstance,
  findStation,
  requireCapability,
  validateAttach,
} from './validation';

export interface ReducerContext {
  readonly registry: ApparatusDefinitionLookup;
}

export interface ReducerSuccess {
  readonly ok: true;
  readonly scene: ExperimentScene;
  /** Containers whose contents may have changed; candidates the engine should ask the solver about. */
  readonly affectedContainerIds: readonly UUID[];
  readonly warnings: readonly string[];
}

export interface ReducerFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ReducerOutcome = ReducerSuccess | ReducerFailure;

function success(scene: ExperimentScene, affectedContainerIds: readonly UUID[] = [], warnings: readonly string[] = []): ReducerSuccess {
  return { ok: true, scene, affectedContainerIds, warnings };
}

function failure(reason: string): ReducerFailure {
  return { ok: false, reason };
}

const EMPTY_CONTAINER_MODEL_ID = 'matterlab.lab.empty-container-v1';

function emptyContainerContents(temperatureK = 298.15): ContainerContents {
  return { volumeL: 0, species: [], temperatureK, mixing: 'WELL_MIXED', modelId: EMPTY_CONTAINER_MODEL_ID };
}

function replaceInstance(scene: ExperimentScene, updated: ApparatusInstance): ExperimentScene {
  return { ...scene, apparatus: scene.apparatus.map((a) => (a.id === updated.id ? updated : a)) };
}

// --- individual handlers ------------------------------------------------------------------------

function handlePlace(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parsePlacePayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const { definitionId, stationId, transform, config } = parsed.value;

  if (scene.apparatus.some((a) => a.id === action.targetInstanceId)) {
    return failure(`An apparatus instance with id "${action.targetInstanceId}" already exists.`);
  }
  const station = findStation(scene, stationId);
  if (!station.ok) return failure(station.reason);
  const definition = context.registry.get(definitionId);
  if (!definition) return failure(`No apparatus definition is registered with id "${definitionId}".`);

  const instance: ApparatusInstance = {
    id: action.targetInstanceId,
    kind: definition.kind,
    definitionId: definition.id,
    transform,
    revision: 0,
    config: { ...definition.defaultConfig, ...(config ?? {}) },
    capabilities: definition.capabilities,
    stationId,
  };
  let nextScene: ExperimentScene = { ...scene, apparatus: [...scene.apparatus, instance] };
  if (definition.capabilities.includes('CONTAINER')) {
    nextScene = {
      ...nextScene,
      containerStates: { ...nextScene.containerStates, [instance.id]: emptyContainerContents() },
    };
  }
  return success(nextScene);
}

function handleMove(scene: ExperimentScene, action: LabAction): ReducerOutcome {
  const parsed = parseMovePayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const instance = findInstance(scene, action.targetInstanceId);
  if (!instance.ok) return failure(instance.reason);
  const updated: ApparatusInstance = { ...instance.value, transform: parsed.value.transform, revision: instance.value.revision + 1 };
  return success(replaceInstance(scene, updated));
}

function handleAttach(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parseAttachPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const from = { instanceId: action.targetInstanceId, socketId: parsed.value.socketId };
  const to = { instanceId: parsed.value.toInstanceId, socketId: parsed.value.toSocketId };
  const validation = validateAttach(scene, context.registry, from, to);
  if (!validation.ok) return failure(validation.reason);

  const connection = { id: `conn:${action.actionId}`, from, to, kind: validation.value.kind, enabled: true };
  return success({ ...scene, connections: [...scene.connections, connection] });
}

function handleDetach(scene: ExperimentScene, action: LabAction): ReducerOutcome {
  const parsed = parseDetachPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const connection = findConnection(scene, parsed.value.connectionId);
  if (!connection.ok) return failure(connection.reason);
  if (connection.value.from.instanceId !== action.targetInstanceId && connection.value.to.instanceId !== action.targetInstanceId) {
    return failure(`targetInstanceId "${action.targetInstanceId}" is not an endpoint of connection "${parsed.value.connectionId}".`);
  }
  return success({ ...scene, connections: scene.connections.filter((c) => c.id !== parsed.value.connectionId) });
}

function handleFill(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parseFillPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const instance = findInstance(scene, action.targetInstanceId);
  if (!instance.ok) return failure(instance.reason);
  const capability = requireCapability(instance.value, 'CONTAINER');
  if (!capability.ok) return failure(capability.reason);
  const definition = context.registry.get(instance.value.definitionId);
  const built = buildFilledContents(parsed.value, definition?.capacityL);
  if (!built.ok) return failure(built.reason);

  const nextScene: ExperimentScene = {
    ...scene,
    containerStates: { ...scene.containerStates, [instance.value.id]: built.value },
  };
  return success(nextScene, [instance.value.id]);
}

function handleSetValve(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parseSetValvePayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const instance = findInstance(scene, action.targetInstanceId);
  if (!instance.ok) return failure(instance.reason);
  const capability = requireCapability(instance.value, 'FLOW_SOURCE');
  if (!capability.ok) return failure(capability.reason);
  const definition = context.registry.get(instance.value.definitionId);
  if (!definition?.flowModel) return failure(`${instance.value.kind} "${instance.value.id}" has no declared flow model to open a valve on.`);

  const updated: ApparatusInstance = {
    ...instance.value,
    config: { ...instance.value.config, valveOpening: clampValveOpening(parsed.value.valveOpening) },
    revision: instance.value.revision + 1,
  };
  return success(replaceInstance(scene, updated));
}

function findEnabledFluidConnection(scene: ExperimentScene, aId: UUID, bId: UUID) {
  return scene.connections.find(
    (c) =>
      c.enabled &&
      c.kind === 'FLUID' &&
      ((c.from.instanceId === aId && c.to.instanceId === bId) || (c.from.instanceId === bId && c.to.instanceId === aId)),
  );
}

/**
 * `targetInstanceId` is the transfer's source; `payload.toInstanceId` the receiver. Looks up the
 * receiver's declared `capacityL` from the registry so an overflowing transfer clamps instead of
 * silently exceeding the vessel's physical size.
 */
function handleTransfer(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parseTransferPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const receiverDefinitionId = scene.apparatus.find((a) => a.id === parsed.value.toInstanceId)?.definitionId;
  const receiverCapacityL = receiverDefinitionId ? context.registry.get(receiverDefinitionId)?.capacityL : undefined;

  const sourceId = action.targetInstanceId;
  const receiverId = parsed.value.toInstanceId;
  const source = findInstance(scene, sourceId);
  if (!source.ok) return failure(source.reason);
  const receiver = findInstance(scene, receiverId);
  if (!receiver.ok) return failure(receiver.reason);
  const sourceCapability = requireCapability(source.value, 'CONTAINER');
  if (!sourceCapability.ok) return failure(sourceCapability.reason);
  const receiverCapability = requireCapability(receiver.value, 'CONTAINER');
  if (!receiverCapability.ok) return failure(receiverCapability.reason);
  if (!findEnabledFluidConnection(scene, sourceId, receiverId)) {
    return failure(`No enabled FLUID connection exists between "${sourceId}" and "${receiverId}"; attach them first.`);
  }
  const sourceContents = scene.containerStates[sourceId];
  const receiverContents = scene.containerStates[receiverId];
  if (!sourceContents) return failure(`Source "${sourceId}" has no recorded contents; FILL it first.`);
  if (!receiverContents) return failure(`Receiver "${receiverId}" has no recorded contents; FILL it first.`);

  const outcome = applyTransfer(sourceContents, receiverContents, parsed.value.volumeL, receiverCapacityL);
  if (!outcome.ok) return failure(outcome.reason);

  const nextScene: ExperimentScene = {
    ...scene,
    containerStates: {
      ...scene.containerStates,
      [sourceId]: outcome.value.source,
      [receiverId]: outcome.value.receiver,
    },
  };
  return success(nextScene, [sourceId, receiverId], outcome.value.warnings);
}

function handleStartStirrer(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  const parsed = parseStartStirrerPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const instance = findInstance(scene, action.targetInstanceId);
  if (!instance.ok) return failure(instance.reason);
  const capability = requireCapability(instance.value, 'STIRRING');
  if (!capability.ok) return failure(capability.reason);
  const definition = context.registry.get(instance.value.definitionId);
  const maxRpm = definition?.controls.find((c) => c.id === 'stirrerRpm')?.max ?? Infinity;
  const clampedRpm = Math.min(Math.max(0, parsed.value.rpm), maxRpm);

  const updated: ApparatusInstance = {
    ...instance.value,
    config: { ...instance.value.config, running: parsed.value.running, stirrerRpm: parsed.value.running ? clampedRpm : 0 },
    revision: instance.value.revision + 1,
  };
  return success(replaceInstance(scene, updated));
}

function handleSetProbe(scene: ExperimentScene, action: LabAction): ReducerOutcome {
  const parsed = parseSetProbePayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);
  const instance = findInstance(scene, action.targetInstanceId);
  if (!instance.ok) return failure(instance.reason);
  const capability = requireCapability(instance.value, 'PH_SENSOR');
  if (!capability.ok) return failure(capability.reason);
  const target = findInstance(scene, parsed.value.targetApparatusId);
  if (!target.ok) return failure(target.reason);
  const targetCapability = requireCapability(target.value, 'CONTAINER');
  if (!targetCapability.ok) return failure(targetCapability.reason);
  if (target.value.stationId !== instance.value.stationId) {
    return failure('A pH probe can only be pointed at a container in its own station.');
  }

  const updated: ApparatusInstance = {
    ...instance.value,
    config: { ...instance.value.config, targetApparatusId: parsed.value.targetApparatusId, depthM: parsed.value.depthM ?? instance.value.config.depthM },
    revision: instance.value.revision + 1,
  };
  return success(replaceInstance(scene, updated), [parsed.value.targetApparatusId]);
}

function handleReset(scene: ExperimentScene, action: LabAction): ReducerOutcome {
  const parsed = parseResetPayload(action.payload);
  if (!parsed.ok) return failure(parsed.reason);

  if (parsed.value.scope === 'SCENE') {
    return success({ ...scene, apparatus: [], connections: [], containerStates: {} });
  }

  const stationId = parsed.value.stationId!;
  const station = findStation(scene, stationId);
  if (!station.ok) return failure(station.reason);
  const stationInstanceIds = new Set(scene.apparatus.filter((a) => a.stationId === stationId).map((a) => a.id));

  const containerStates = { ...scene.containerStates };
  for (const id of stationInstanceIds) {
    if (containerStates[id]) containerStates[id] = emptyContainerContents();
  }
  const apparatus = scene.apparatus.map((a) => {
    if (!stationInstanceIds.has(a.id)) return a;
    const resetValve = a.capabilities.includes('FLOW_SOURCE') ? { valveOpening: 0 } : {};
    const resetStirrer = a.capabilities.includes('STIRRING') ? { running: false, stirrerRpm: 0 } : {};
    return { ...a, config: { ...a.config, ...resetValve, ...resetStirrer }, revision: a.revision + 1 };
  });
  const connections = parsed.value.clearConnections
    ? scene.connections.filter((c) => !stationInstanceIds.has(c.from.instanceId) && !stationInstanceIds.has(c.to.instanceId))
    : scene.connections;

  return success({ ...scene, apparatus, connections, containerStates }, [...stationInstanceIds]);
}

function handleCustom(scene: ExperimentScene, action: LabAction): ReducerOutcome {
  const createStation = parseCreateStationPayload(action.payload);
  if (createStation.ok) {
    if (scene.stations.some((s) => s.id === action.targetInstanceId)) {
      return failure(`A station with id "${action.targetInstanceId}" already exists.`);
    }
    return success({ ...scene, stations: [...scene.stations, { id: action.targetInstanceId, name: createStation.value.name }] });
  }
  // Unrecognised CUSTOM payloads are logged (by the engine) but do not mutate scene state: a
  // forward-compatible extension point for future ExperimentPlugins, not silently ignored data loss.
  return success(scene);
}

/** Routes one `LabAction` to its handler. Unknown action types are rejected, never silently ignored. */
export function applyLabAction(scene: ExperimentScene, action: LabAction, context: ReducerContext): ReducerOutcome {
  if (!isLabActionType(action.type)) return failure(`Unknown LabAction type "${String(action.type)}".`);

  const outcome = ((): ReducerOutcome => {
    switch (action.type) {
      case 'PLACE':
        return handlePlace(scene, action, context);
      case 'MOVE':
        return handleMove(scene, action);
      case 'ATTACH':
        return handleAttach(scene, action, context);
      case 'DETACH':
        return handleDetach(scene, action);
      case 'FILL':
        return handleFill(scene, action, context);
      case 'SET_VALVE':
        return handleSetValve(scene, action, context);
      case 'TRANSFER':
        return handleTransfer(scene, action, context);
      case 'START_STIRRER':
        return handleStartStirrer(scene, action, context);
      case 'SET_PROBE':
        return handleSetProbe(scene, action);
      case 'RESET':
        return handleReset(scene, action);
      case 'CUSTOM':
        return handleCustom(scene, action);
    }
  })();

  if (!outcome.ok) return outcome;
  return success({ ...outcome.scene, revision: scene.revision + 1 }, outcome.affectedContainerIds, outcome.warnings);
}

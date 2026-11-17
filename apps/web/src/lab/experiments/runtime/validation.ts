/**
 * Read-only checks the reducer runs before committing any scene mutation: does the instance exist,
 * does it declare the right capability, are the two sockets of an `ATTACH` actually compatible and
 * unoccupied. Every function here returns a `Result` instead of throwing, so a caller can always
 * reject a `LabAction` transparently (acceptance test: invalid attachments "fail transparently
 * without corrupting scene state").
 */
import {
  canSocketsConnect,
  type ApparatusInstance,
  type Capability,
  type Connection,
  type ConnectionKind,
  type ExperimentScene,
  type SocketDefinition,
  type SocketRef,
  type UUID,
} from '@matterlab/contracts';
import type { ApparatusDefinitionLookup } from '@matterlab/contracts';
import { fail, ok, type Result } from './result';

export function findInstance(scene: ExperimentScene, instanceId: UUID): Result<ApparatusInstance> {
  const instance = scene.apparatus.find((a) => a.id === instanceId);
  return instance ? ok(instance) : fail(`No apparatus instance with id "${instanceId}" exists in this scene.`);
}

export function findStation(scene: ExperimentScene, stationId: UUID): Result<{ id: UUID; name: string }> {
  const station = scene.stations.find((s) => s.id === stationId);
  return station ? ok(station) : fail(`No station with id "${stationId}" exists in this scene.`);
}

export function requireCapability(instance: ApparatusInstance, capability: Capability): Result<ApparatusInstance> {
  return instance.capabilities.includes(capability)
    ? ok(instance)
    : fail(`${instance.kind} "${instance.id}" does not declare the ${capability} capability.`);
}

export interface ResolvedSocket {
  readonly instance: ApparatusInstance;
  readonly socket: SocketDefinition;
}

export function resolveSocket(
  scene: ExperimentScene,
  registry: ApparatusDefinitionLookup,
  ref: SocketRef,
): Result<ResolvedSocket> {
  const instanceResult = findInstance(scene, ref.instanceId);
  if (!instanceResult.ok) return fail(instanceResult.reason);
  const definition = registry.get(instanceResult.value.definitionId);
  if (!definition) {
    return fail(`Apparatus instance "${ref.instanceId}" references unknown definition "${instanceResult.value.definitionId}".`);
  }
  const socket = definition.sockets.find((s) => s.id === ref.socketId);
  if (!socket) {
    return fail(`${definition.label} has no socket named "${ref.socketId}".`);
  }
  return ok({ instance: instanceResult.value, socket });
}

/** Enabled connections currently occupying one specific socket (either end). */
export function connectionsAtSocket(scene: ExperimentScene, ref: SocketRef): readonly Connection[] {
  return scene.connections.filter(
    (c) =>
      c.enabled &&
      ((c.from.instanceId === ref.instanceId && c.from.socketId === ref.socketId) ||
        (c.to.instanceId === ref.instanceId && c.to.socketId === ref.socketId)),
  );
}

export interface AttachValidation {
  readonly kind: ConnectionKind;
}

/**
 * Authoritative compatibility check for an `ATTACH` (also used by Agent 04's drag-preview, so the
 * "shows valid" and "actually accepts" paths cannot drift apart — see `canSocketsConnect`'s doc
 * comment in `@matterlab/contracts`).
 */
export function validateAttach(
  scene: ExperimentScene,
  registry: ApparatusDefinitionLookup,
  from: SocketRef,
  to: SocketRef,
): Result<AttachValidation> {
  if (from.instanceId === to.instanceId) {
    return fail('An apparatus instance cannot be connected to itself.');
  }
  const fromLookup = resolveSocket(scene, registry, from);
  if (!fromLookup.ok) return fail(fromLookup.reason);
  const toLookup = resolveSocket(scene, registry, to);
  if (!toLookup.ok) return fail(toLookup.reason);

  if (fromLookup.value.instance.stationId !== toLookup.value.instance.stationId) {
    return fail('Apparatus in different stations cannot be connected to each other.');
  }

  const fromDefinition = registry.get(fromLookup.value.instance.definitionId)!;
  const toDefinition = registry.get(toLookup.value.instance.definitionId)!;
  const compatibility = canSocketsConnect(
    { definition: fromDefinition, socket: fromLookup.value.socket },
    { definition: toDefinition, socket: toLookup.value.socket },
  );
  if (!compatibility.ok) return fail(compatibility.reason ?? 'Sockets are not compatible.');

  const fromOccupancy = connectionsAtSocket(scene, from).length;
  if (fromOccupancy >= fromLookup.value.socket.maxConnections) {
    return fail(`${fromDefinition.label}'s ${from.socketId} socket already has its maximum of ${fromLookup.value.socket.maxConnections} connection(s).`);
  }
  const toOccupancy = connectionsAtSocket(scene, to).length;
  if (toOccupancy >= toLookup.value.socket.maxConnections) {
    return fail(`${toDefinition.label}'s ${to.socketId} socket already has its maximum of ${toLookup.value.socket.maxConnections} connection(s).`);
  }

  return ok({ kind: fromLookup.value.socket.kind });
}

export function findConnection(scene: ExperimentScene, connectionId: UUID): Result<Connection> {
  const connection = scene.connections.find((c) => c.id === connectionId);
  return connection ? ok(connection) : fail(`No connection with id "${connectionId}" exists in this scene.`);
}

/** All enabled `FLUID` connections whose `from` end is `instanceId` (i.e. it is the flow source). */
export function outgoingFluidConnections(scene: ExperimentScene, instanceId: UUID): readonly Connection[] {
  return scene.connections.filter((c) => c.enabled && c.kind === 'FLUID' && c.from.instanceId === instanceId);
}

/** Every enabled `FLUID` connection whose source apparatus belongs to `stationId`; drives one simulation tick. */
export function fluidConnectionsInStation(scene: ExperimentScene, stationId: UUID): readonly Connection[] {
  const sourceIdsInStation = new Set(scene.apparatus.filter((a) => a.stationId === stationId).map((a) => a.id));
  return scene.connections.filter((c) => c.enabled && c.kind === 'FLUID' && sourceIdsInStation.has(c.from.instanceId));
}

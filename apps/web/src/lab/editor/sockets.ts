import { Vector3 } from 'three';
import type {
  ApparatusDefinition, ApparatusDefinitionReader, ApparatusInstance, Connection, ExperimentScene,
  SocketDefinition, SocketEndpoint, Transform,
} from '@matterlab/contracts/lab';
import { matrixOf, transformOf } from './geometry';
import type { SocketCandidate } from './types';

export interface ResolvedSocket {
  readonly instance: ApparatusInstance;
  readonly definition: ApparatusDefinition;
  readonly socket: SocketDefinition;
  readonly worldTransform: Transform;
}
export function resolveSocket(
  scene: ExperimentScene, definitions: ApparatusDefinitionReader, endpoint: SocketEndpoint,
): ResolvedSocket | null {
  const instance = scene.apparatus.find((item) => item.id === endpoint.instanceId);
  const definition = instance && definitions.getDefinition(instance.definitionId);
  const socket = definition?.sockets.find((item) => item.id === endpoint.socketId);
  return instance && definition && socket ? {
    instance, definition, socket,
    worldTransform: transformOf(matrixOf(instance.transform).multiply(matrixOf(socket.localTransform))),
  } : null;
}
export function mechanicalDescendants(scene: ExperimentScene, ids: readonly string[]): string[] {
  const children = new Map<string, string[]>();
  for (const edge of scene.connections) if (edge.enabled && edge.kind === 'MECHANICAL') {
    const list = children.get(edge.from.instanceId) ?? [];
    list.push(edge.to.instanceId);
    children.set(edge.from.instanceId, list);
  }
  const found = new Set(ids);
  const queue = [...ids];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) if (!found.has(child)) {
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}
export function mechanicallyRelated(scene: ExperimentScene, a: string, b: string): boolean {
  return mechanicalDescendants(scene, [a]).includes(b) || mechanicalDescendants(scene, [b]).includes(a);
}
function requirements(own: ResolvedSocket, other: ResolvedSocket): string[] {
  const reasons: string[] = [];
  const compatibility = own.socket.compatibility;
  if (!compatibility.accepts.includes(other.socket.compatibility.key)) reasons.push(`${own.socket.id} does not accept ${other.socket.compatibility.key}.`);
  if (compatibility.requiredCapabilities?.some((capability) => !other.instance.capabilities.includes(capability))) {
    reasons.push(`${own.socket.id} requires capabilities not provided by ${other.definition.label}.`);
  }
  if (compatibility.allowedKinds && !compatibility.allowedKinds.includes(other.instance.kind)) {
    reasons.push(`${own.definition.label} cannot connect to apparatus kind ${other.instance.kind}.`);
  }
  if (compatibility.requiredTags?.some((tag) => !other.definition.tags?.includes(tag))) {
    reasons.push(`${other.definition.label} lacks the tags required by ${own.socket.id}.`);
  }
  return reasons;
}
export function validateSocketConnection(
  scene: ExperimentScene, definitions: ApparatusDefinitionReader, connection: Connection,
  options: { readonly ignoreConnectionId?: string; readonly checkAlignment?: boolean } = {},
): readonly string[] {
  const from = resolveSocket(scene, definitions, connection.from);
  const to = resolveSocket(scene, definitions, connection.to);
  if (!from || !to) return ['The selected apparatus or socket no longer exists.'];
  const reasons: string[] = [];
  if (from.instance.id === to.instance.id) reasons.push('An apparatus cannot attach to itself.');
  if (from.instance.stationId !== to.instance.stationId) reasons.push('Connections cannot cross workstations.');
  if (from.socket.kind !== connection.kind || to.socket.kind !== connection.kind) reasons.push('Socket connection kinds do not match.');
  if (from.socket.direction === 'IN' || to.socket.direction === 'OUT') reasons.push('Connect an output socket to an input socket.');
  if (from.socket.gender !== 'NEUTRAL' && from.socket.gender === to.socket.gender) reasons.push('Socket genders are incompatible.');
  reasons.push(...requirements(from, to), ...requirements(to, from));
  const existing = scene.connections.filter((edge) => edge.id !== options.ignoreConnectionId);
  for (const endpoint of [from, to]) {
    const occupied = existing.filter((edge) => edge.enabled &&
      [edge.from, edge.to].some((item) => item.instanceId === endpoint.instance.id && item.socketId === endpoint.socket.id)).length;
    if (occupied >= endpoint.socket.maxConnections) reasons.push(`${endpoint.definition.label} / ${endpoint.socket.id} is at connection capacity.`);
  }
  if (existing.some((edge) => edge.kind === connection.kind && (
    (edge.from.instanceId === connection.from.instanceId && edge.from.socketId === connection.from.socketId &&
     edge.to.instanceId === connection.to.instanceId && edge.to.socketId === connection.to.socketId) ||
    (edge.from.instanceId === connection.to.instanceId && edge.from.socketId === connection.to.socketId &&
     edge.to.instanceId === connection.from.instanceId && edge.to.socketId === connection.from.socketId)
  ))) reasons.push('These sockets are already connected.');
  if (connection.kind === 'MECHANICAL') {
    if (existing.some((edge) => edge.enabled && edge.kind === 'MECHANICAL' && edge.to.instanceId === to.instance.id)) {
      reasons.push('Detach the existing mechanical parent before reparenting.');
    }
    if (mechanicalDescendants({ ...scene, connections: existing }, [to.instance.id]).includes(from.instance.id)) {
      reasons.push('Mechanical attachment would create a cycle.');
    }
  }
  if (options.checkAlignment !== false) {
    const tolerance = Math.min(from.socket.alignmentToleranceM ?? Infinity, to.socket.alignmentToleranceM ?? Infinity);
    const separation = new Vector3(...from.worldTransform.positionM).distanceTo(new Vector3(...to.worldTransform.positionM));
    if (separation > tolerance + 1e-7) reasons.push(`Sockets are ${separation.toFixed(3)} m apart; align them within ${tolerance.toFixed(3)} m.`);
  }
  return [...new Set(reasons)];
}
export function socketCandidate(
  scene: ExperimentScene, definitions: ApparatusDefinitionReader,
  source: SocketEndpoint, target: SocketEndpoint, id: string,
): SocketCandidate {
  const a = resolveSocket(scene, definitions, source);
  const b = resolveSocket(scene, definitions, target);
  const reverse = a?.socket.direction === 'IN' || b?.socket.direction === 'OUT';
  const connection: Connection = {
    id, from: reverse ? target : source, to: reverse ? source : target,
    kind: a?.socket.kind ?? 'MECHANICAL', enabled: true,
  };
  const parent = reverse ? b : a;
  const child = reverse ? a : b;
  const distanceM = a && b ? new Vector3(...a.worldTransform.positionM).distanceTo(new Vector3(...b.worldTransform.positionM)) : Infinity;
  const reasons = validateSocketConnection(scene, definitions, connection, { checkAlignment: false });
  const snappedTransform = parent && child && connection.kind === 'MECHANICAL'
    ? transformOf(matrixOf(parent.worldTransform).multiply(matrixOf(child.socket.localTransform).invert())) : undefined;
  return { source, target, connection, valid: reasons.length === 0, reasons, distanceM, snappedTransform };
}

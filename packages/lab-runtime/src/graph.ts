import { validateApparatusDefinition } from '@matterlab/contracts';
import type {
  ApparatusDefinition, ApparatusDefinitionReader, ApparatusInstance, Connection, ExperimentScene,
  ProblemDetails, Quaternion, RuntimeSnapshot, SocketDefinition, Transform, UUID, Vec3M,
} from '@matterlab/contracts';
import { fail, problem } from './errors.ts';

const configValidation = new WeakMap<ApparatusDefinition, WeakMap<object, ProblemDetails | null>>();

export function definitionFor(instance: ApparatusInstance, definitions: ApparatusDefinitionReader): ApparatusDefinition {
  const definition = definitions.getDefinition(instance.definitionId);
  if (!definition) fail('UNSUPPORTED_MODEL', `Apparatus definition ${instance.definitionId} is unavailable; no equipment behavior is synthesized.`);
  return definition;
}
export function validateInstance(instance: ApparatusInstance, definitions: ApparatusDefinitionReader): ProblemDetails | null {
  const definition = definitions.getDefinition(instance.definitionId);
  if (!definition) return problem('UNSUPPORTED_MODEL', `Unknown equipment definition ${instance.definitionId}.`);
  if (instance.kind !== definition.kind || instance.capabilities.length !== definition.capabilities.length ||
      instance.capabilities.some((capability) => !definition.capabilities.includes(capability))) {
    return problem('INVALID_INPUT', `Instance ${instance.id} cannot claim capabilities/kind different from its authoritative definition.`);
  }
  const cacheable = Object.isFrozen(definition) && Object.isFrozen(definition.configSchema) &&
    Object.isFrozen(definition.configSchema.properties) && Object.isFrozen(definition.configSchema.required) &&
    Object.values(definition.configSchema.properties).every((field) => Object.isFrozen(field) &&
      (field.type !== 'string' || !field.enum || Object.isFrozen(field.enum))) && Object.isFrozen(instance.config);
  const cached = configValidation.get(definition);
  if (cacheable && cached?.has(instance.config)) return cached.get(instance.config)!;
  const checked = validateApparatusDefinition({ ...definition, defaultConfig: instance.config });
  const error = checked.ok ? null : problem('INVALID_INPUT', `Invalid apparatus config: ${checked.errors[0]?.message ?? 'schema mismatch'}`);
  if (cacheable) {
    const entries = cached ?? new WeakMap<object, ProblemDetails | null>();
    entries.set(instance.config, error);
    configValidation.set(definition, entries);
  }
  return error;
}
export function socketWorldPosition(instance: ApparatusInstance, socket: SocketDefinition): Vec3M {
  const [x, y, z] = socket.localTransform.positionM;
  const [qx, qy, qz, qw] = instance.transform.quaternion;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    instance.transform.positionM[0] + x + qw * tx + qy * tz - qz * ty,
    instance.transform.positionM[1] + y + qw * ty + qz * tx - qx * tz,
    instance.transform.positionM[2] + z + qw * tz + qx * ty - qy * tx,
  ];
}
function accepts(socket: SocketDefinition, other: SocketDefinition, instance: ApparatusInstance, definition: ApparatusDefinition): boolean {
  return socket.compatibility.accepts.includes(other.compatibility.key) &&
    (socket.compatibility.requiredCapabilities ?? []).every((capability) => instance.capabilities.includes(capability)) &&
    (!socket.compatibility.allowedKinds || socket.compatibility.allowedKinds.includes(instance.kind)) &&
    (socket.compatibility.requiredTags ?? []).every((tag) => definition.tags?.includes(tag));
}
function hasCycle(edges: readonly Connection[], added: Connection): boolean {
  const outgoing = new Map<UUID, UUID[]>();
  for (const edge of [...edges.filter((edge) => edge.id !== added.id && edge.kind === 'MECHANICAL'), added]) {
    outgoing.set(edge.from.instanceId, [...(outgoing.get(edge.from.instanceId) ?? []), edge.to.instanceId]);
  }
  const active = new Set<UUID>();
  const visited = new Set<UUID>();
  function visit(id: UUID): boolean {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    active.add(id);
    for (const child of outgoing.get(id) ?? []) if (visit(child)) return true;
    active.delete(id);
    visited.add(id);
    return false;
  }
  return [...outgoing.keys()].some(visit);
}
export function validateConnection(
  scene: ExperimentScene, edge: Connection, definitions: ApparatusDefinitionReader, checkAlignment = true,
): ProblemDetails | null {
  const from = scene.apparatus.find((instance) => instance.id === edge.from.instanceId);
  const to = scene.apparatus.find((instance) => instance.id === edge.to.instanceId);
  if (!from || !to) return problem('MISSING_REFERENCE', 'Both connection endpoints must exist.');
  if (from.id === to.id) return problem('INCOMPATIBLE_SOCKET', 'Self connections are forbidden.');
  if (from.stationId !== to.stationId) return problem('CROSS_STATION_CONNECTION', 'Station inventories/connections are independent.');
  for (const instance of [from, to]) {
    const error = validateInstance(instance, definitions);
    if (error) return error;
  }
  const fromDefinition = definitions.getDefinition(from.definitionId)!;
  const toDefinition = definitions.getDefinition(to.definitionId)!;
  const fromSocket = fromDefinition.sockets.find((socket) => socket.id === edge.from.socketId);
  const toSocket = toDefinition.sockets.find((socket) => socket.id === edge.to.socketId);
  if (!fromSocket || !toSocket) return problem('MISSING_REFERENCE', 'Connection socket is not in the authoritative definition.');
  if (fromSocket.kind !== edge.kind || toSocket.kind !== edge.kind ||
      fromSocket.direction === 'IN' || toSocket.direction === 'OUT' ||
      (fromSocket.gender !== 'NEUTRAL' && toSocket.gender !== 'NEUTRAL' && fromSocket.gender === toSocket.gender) ||
      !accepts(fromSocket, toSocket, to, toDefinition) || !accepts(toSocket, fromSocket, from, fromDefinition)) {
    return problem('INCOMPATIBLE_SOCKET', 'Socket kind, direction, gender or compatibility rules do not match.');
  }
  const required = edge.kind === 'MECHANICAL' ? ['MOUNT', 'MOUNTABLE'] :
    edge.kind === 'FLUID' ? ['FLOW_SOURCE', 'FLOW_RECEIVER'] :
      edge.kind === 'SENSOR' ? ['PH_SENSOR', 'CONTAINER'] : ['STIRRING', 'CONTAINER'];
  if (!from.capabilities.some((capability) => capability === required[0]) ||
      !to.capabilities.some((capability) => capability === required[1])) {
    return problem('INCOMPATIBLE_SOCKET', 'Connection endpoints lack the required functional capabilities.');
  }
  const existing = scene.connections.filter((connection) => connection.id !== edge.id);
  for (const [endpoint, socket] of [[edge.from, fromSocket], [edge.to, toSocket]] as const) {
    const count = existing.filter((connection) =>
      (connection.from.instanceId === endpoint.instanceId && connection.from.socketId === endpoint.socketId) ||
      (connection.to.instanceId === endpoint.instanceId && connection.to.socketId === endpoint.socketId)).length;
    if (count >= socket.maxConnections) return problem('INCOMPATIBLE_SOCKET', 'Socket connection capacity would be exceeded.');
  }
  if (edge.kind === 'MECHANICAL') {
    if (existing.some((connection) => connection.kind === 'MECHANICAL' && connection.to.instanceId === to.id)) {
      return problem('INCOMPATIBLE_SOCKET', 'A mounted apparatus cannot have two mechanical parents.');
    }
    if (hasCycle(existing, edge)) return problem('INCOMPATIBLE_SOCKET', 'Mechanical attachment cycles are forbidden.');
  }
  const tolerances = [fromSocket.alignmentToleranceM, toSocket.alignmentToleranceM].filter((value): value is number => value !== undefined);
  if (checkAlignment && tolerances.length > 0) {
    const fromPosition = socketWorldPosition(from, fromSocket);
    const toPosition = socketWorldPosition(to, toSocket);
    const distance = Math.hypot(...fromPosition.map((value, index) => value - toPosition[index]!));
    if (distance > Math.min(...tolerances) + 1e-12) return problem('INCOMPATIBLE_SOCKET', 'Socket positions exceed declared alignment tolerance in meters.');
  }
  return null;
}
export function stationGraphProblems(scene: ExperimentScene, stationId: UUID, definitions: ApparatusDefinitionReader): readonly ProblemDetails[] {
  const errors: ProblemDetails[] = [];
  const instances = scene.apparatus.filter((instance) => instance.stationId === stationId);
  const ids = new Set(instances.map((instance) => instance.id));
  for (const instance of instances) {
    const error = validateInstance(instance, definitions);
    if (error) errors.push(error);
    const contents = scene.containerStates[instance.id];
    const capacity = definitions.getDefinition(instance.definitionId)?.capacityL;
    if (contents && capacity !== undefined && contents.volumeL > capacity + 1e-12) {
      errors.push(problem('CAPACITY_EXCEEDED', `Container ${instance.id} exceeds its calibrated capacity.`));
    }
    const definition = definitions.getDefinition(instance.definitionId);
    if (definition?.tags?.includes('requires-mount') &&
        !scene.connections.some((edge) => edge.enabled && edge.kind === 'MECHANICAL' && edge.to.instanceId === instance.id)) {
      errors.push(problem('UNSUPPORTED_MODEL', `${instance.definitionId} requires a mechanical mount before operation.`));
    }
  }
  for (const edge of scene.connections.filter((edge) => ids.has(edge.from.instanceId) || ids.has(edge.to.instanceId))) {
    const error = validateConnection(scene, edge, definitions);
    if (error) errors.push(error);
  }
  return Object.freeze(errors);
}

export function validateMove(instance: ApparatusInstance, transform: Transform, definition: ApparatusDefinition): ProblemDetails | null {
  const axes = ['X', 'Y', 'Z'] as const;
  for (let i = 0; i < 3; i++) {
    if (!definition.permittedTransforms.translation.includes(axes[i]!) &&
        Math.abs(transform.positionM[i]! - instance.transform.positionM[i]!) > 1e-12) {
      return problem('INVALID_ACTION', `Translation on ${axes[i]} is not permitted for ${definition.id}.`);
    }
  }
  const [x, y, z, w] = instance.transform.quaternion;
  const [a, b, c, d] = transform.quaternion;
  const relative: Quaternion = [
    w * a - x * d - y * c + z * b,
    w * b + x * c - y * d - z * a,
    w * c - x * b + y * a - z * d,
    w * d + x * a + y * b + z * c,
  ];
  for (let i = 0; i < 3; i++) {
    if (!definition.permittedTransforms.rotation.includes(axes[i]!) && Math.abs(relative[i]!) > 1e-6) {
      return problem('INVALID_ACTION', `Rotation on ${axes[i]} is not permitted for ${definition.id}.`);
    }
  }
  return null;
}

export function isProbeImmersed(
  snapshot: RuntimeSnapshot, probeId: UUID, receiverId: UUID, definitions: ApparatusDefinitionReader,
): boolean {
  const probe = snapshot.scene.apparatus.find((instance) => instance.id === probeId);
  const receiver = snapshot.scene.apparatus.find((instance) => instance.id === receiverId);
  const contents = snapshot.scene.containerStates[receiverId];
  if (!probe || !receiver || probe.stationId !== receiver.stationId || !contents || contents.volumeL <= 1e-12) return false;
  const edge = snapshot.scene.connections.find((edge) => edge.enabled && edge.kind === 'SENSOR' &&
    edge.from.instanceId === probeId && edge.to.instanceId === receiverId);
  const socket = edge && definitions.getDefinition(probe.definitionId)?.sockets.find((socket) => socket.id === edge.from.socketId);
  const calibration = definitions.getDefinition(receiver.definitionId)?.vesselCalibration;
  if (!socket || !calibration) return false;
  const tip = socketWorldPosition(probe, socket);
  const q = receiver.transform.quaternion;
  const local = socketWorldPosition({
    ...receiver, transform: { positionM: [0, 0, 0], quaternion: [-q[0], -q[1], -q[2], q[3]] },
  }, { ...socket, localTransform: {
    positionM: [tip[0] - receiver.transform.positionM[0], tip[1] - receiver.transform.positionM[1], tip[2] - receiver.transform.positionM[2]],
    quaternion: [0, 0, 0, 1],
  } });
  const curve = calibration.volumeHeightCurve;
  let height = curve[curve.length - 1]!.heightM;
  for (let i = 1; i < curve.length; i++) {
    if (contents.volumeL <= curve[i]!.volumeL) {
      const a = curve[i - 1]!;
      const b = curve[i]!;
      height = a.heightM + (b.heightM - a.heightM) * (contents.volumeL - a.volumeL) / (b.volumeL - a.volumeL);
      break;
    }
  }
  const profile = calibration.interiorProfile;
  if (local[1] < profile[0]!.yM || local[1] > height) return false;
  for (let i = 1; i < profile.length; i++) {
    if (local[1] <= profile[i]!.yM) {
      const a = profile[i - 1]!;
      const b = profile[i]!;
      const radius = a.radiusM + (b.radiusM - a.radiusM) * (local[1] - a.yM) / (b.yM - a.yM);
      return Math.hypot(local[0], local[2]) <= radius;
    }
  }
  return false;
}

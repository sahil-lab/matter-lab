import type { ApparatusDefinition, ApparatusDefinitionReader, ApparatusInstance, Connection, SocketDefinition, Transform, Vec3M } from '@matterlab/contracts';
import { sameNumber } from './json.ts';
import type { ApparatusSelector, ChallengeDefinition, RoleBindings, RuntimeEvidenceFrame, TrialEvidence } from './types.ts';

export function definitionReader(definitions: readonly ApparatusDefinition[]): ApparatusDefinitionReader {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return { getDefinition: (id) => byId.get(id), listDefinitions: () => definitions };
}

export function matchesSelector(instance: ApparatusInstance, selector: ApparatusSelector, definitions: ApparatusDefinitionReader): boolean {
  const definition = definitions.getDefinition(instance.definitionId);
  return Boolean(definition && definition.kind === instance.kind &&
    instance.capabilities.length === definition.capabilities.length &&
    instance.capabilities.every((capability) => definition.capabilities.includes(capability)) &&
    (!selector.kind || instance.kind === selector.kind) &&
    (!selector.definitionId || instance.definitionId === selector.definitionId) &&
    selector.capabilities.every((capability) => definition.capabilities.includes(capability)));
}

export function resolveRoleBindings(
  frame: RuntimeEvidenceFrame, stationId: string, definition: ChallengeDefinition,
  definitions: ApparatusDefinitionReader, requested: RoleBindings,
): RoleBindings {
  const bindings: Record<string, string> = {};
  const used = new Set<string>();
  for (const [role, selector] of Object.entries(definition.roles)) {
    const explicit = requested[role];
    const matches = frame.scene.apparatus.filter((instance) =>
      instance.stationId === stationId && (!explicit || explicit === instance.id) &&
      matchesSelector(instance, selector, definitions));
    // Ambiguous apparatus must be explicitly bound; catalog order never chooses a scoring receiver.
    if (matches.length === 1 && !used.has(matches[0]!.id)) {
      bindings[role] = matches[0]!.id;
      used.add(matches[0]!.id);
    }
  }
  return bindings;
}

export function rotatePoint(point: Vec3M, transform: Transform): Vec3M {
  const [x, y, z, w] = transform.quaternion;
  const [px, py, pz] = point;
  const tx = 2 * (y * pz - z * py);
  const ty = 2 * (z * px - x * pz);
  const tz = 2 * (x * py - y * px);
  return [px + w * tx + y * tz - z * ty, py + w * ty + z * tx - x * tz, pz + w * tz + x * ty - y * tx];
}

export function worldSocket(instance: ApparatusInstance, socket: SocketDefinition): Vec3M {
  const rotated = rotatePoint(socket.localTransform.positionM, instance.transform);
  return [rotated[0] + instance.transform.positionM[0], rotated[1] + instance.transform.positionM[1], rotated[2] + instance.transform.positionM[2]];
}

export interface ConnectionAssessment {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Read-only evidence check. The runtime still decides whether to accept any connection/action. */
export function assessConnection(
  frame: RuntimeEvidenceFrame, edge: Connection, definitions: ApparatusDefinitionReader, stationId: string,
): ConnectionAssessment {
  const reasons: string[] = [];
  const from = frame.scene.apparatus.find((instance) => instance.id === edge.from.instanceId);
  const to = frame.scene.apparatus.find((instance) => instance.id === edge.to.instanceId);
  if (!edge.enabled) return { valid: false, reasons: ['The connection is disabled.'] };
  if (!from || !to || from.id === to.id || from.stationId !== stationId || to.stationId !== stationId) {
    return { valid: false, reasons: ['Connection endpoints must be distinct apparatus in the active station.'] };
  }
  const fromDefinition = definitions.getDefinition(from.definitionId);
  const toDefinition = definitions.getDefinition(to.definitionId);
  const source = fromDefinition?.sockets.find((socket) => socket.id === edge.from.socketId);
  const receiver = toDefinition?.sockets.find((socket) => socket.id === edge.to.socketId);
  if (!source || !receiver || !fromDefinition || !toDefinition) return { valid: false, reasons: ['Registered endpoint sockets are missing.'] };
  if (source.kind !== edge.kind || receiver.kind !== edge.kind || source.direction === 'IN' || receiver.direction === 'OUT') reasons.push('Socket kinds or directions are incompatible.');
  if (source.gender !== 'NEUTRAL' && source.gender === receiver.gender) reasons.push('Socket genders are incompatible.');
  const accepts = (own: SocketDefinition, other: SocketDefinition, otherDefinition: ApparatusDefinition) =>
    own.compatibility.accepts.includes(other.compatibility.key) &&
    (own.compatibility.requiredCapabilities ?? []).every((capability) => otherDefinition.capabilities.includes(capability)) &&
    (!own.compatibility.allowedKinds || own.compatibility.allowedKinds.includes(otherDefinition.kind)) &&
    (own.compatibility.requiredTags ?? []).every((tag) => otherDefinition.tags?.includes(tag));
  if (!accepts(source, receiver, toDefinition) || !accepts(receiver, source, fromDefinition)) reasons.push('Socket capabilities or compatibility keys do not match.');
  for (const [instance, socket] of [[from, source], [to, receiver]] as const) {
    const count = frame.scene.connections.filter((connection) => connection.enabled &&
      ((connection.from.instanceId === instance.id && connection.from.socketId === socket.id) ||
       (connection.to.instanceId === instance.id && connection.to.socketId === socket.id))).length;
    if (count > socket.maxConnections) reasons.push('A socket exceeds its declared connection limit.');
  }
  const a = worldSocket(from, source);
  const b = worldSocket(to, receiver);
  const tolerance = Math.min(source.alignmentToleranceM ?? 0.02, receiver.alignmentToleranceM ?? 0.02);
  const separation = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (!Number.isFinite(separation) || separation > tolerance + 1e-9) reasons.push('Socket positions exceed their declared alignment tolerance.');
  if (edge.kind === 'FLUID' && a[1] < b[1] - 1e-9) reasons.push('The receiver inlet is above the gravity-fed outlet.');
  return { valid: reasons.length === 0, reasons };
}

export function trialGraphIssues(trial: TrialEvidence): readonly string[] {
  const { frame, scope } = trial;
  const definitions = definitionReader(trial.definitions);
  const issues: string[] = [];
  const local = frame.scene.apparatus.filter((instance) => instance.stationId === scope.stationId);
  for (const instance of local) {
    if (!matchesSelector(instance, { capabilities: [], label: instance.kind }, definitions)) issues.push(`Apparatus ${instance.id} disagrees with its registered definition.`);
    const definition = definitions.getDefinition(instance.definitionId);
    const contents = frame.scene.containerStates[instance.id];
    if (contents && (definition?.capacityL === undefined || contents.volumeL > definition.capacityL + 1e-12)) issues.push(`Container ${instance.id} is outside its declared capacity.`);
  }
  const connections = frame.scene.connections.filter((edge) => edge.enabled &&
    local.some((instance) => instance.id === edge.from.instanceId || instance.id === edge.to.instanceId));
  connections.forEach((edge) => issues.push(...assessConnection(frame, edge, definitions, scope.stationId).reasons));
  const parents = new Map<string, string>();
  for (const edge of connections.filter((connection) => connection.kind === 'MECHANICAL')) {
    if (parents.has(edge.to.instanceId)) issues.push('An apparatus has more than one mechanical parent.');
    parents.set(edge.to.instanceId, edge.from.instanceId);
  }
  for (const child of parents.keys()) {
    const visited = new Set<string>([child]);
    let parent = parents.get(child);
    while (parent) {
      if (visited.has(parent)) { issues.push('The mounting graph contains a cycle.'); break; }
      visited.add(parent);
      parent = parents.get(parent);
    }
  }
  return [...new Set(issues)];
}

export function roleInstance(trial: TrialEvidence, role: string): ApparatusInstance | undefined {
  return trial.frame.scene.apparatus.find((instance) => instance.id === trial.bindings[role] && instance.stationId === trial.scope.stationId);
}

export function hasRoleConnection(trial: TrialEvidence, from: string, to: string, kind: Connection['kind']): boolean {
  const definitions = definitionReader(trial.definitions);
  return trial.frame.scene.connections.some((edge) =>
    edge.kind === kind && edge.from.instanceId === trial.bindings[from] && edge.to.instanceId === trial.bindings[to] &&
    assessConnection(trial.frame, edge, definitions, trial.scope.stationId).valid);
}

export function isUpright(instance: ApparatusInstance): boolean {
  return sameNumber(rotatePoint([0, 1, 0], instance.transform)[1], 1, 1e-6);
}

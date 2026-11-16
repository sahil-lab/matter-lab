/**
 * Socket compatibility ("can A attach to B, and why not if not") and attachment placement math.
 *
 * This is the piece the acceptance test "invalid socket pair rejects attachment with clear
 * reason" is about. It is deliberately data-driven (role/kind/gender/geometry), not a hardcoded
 * switch over apparatus kinds, so new definitions (including future plugins — brief point 6)
 * interoperate automatically as long as their sockets declare compatible roles.
 *
 * Agent 07 is the authority that actually records a `Connection`; this module only answers
 * "would this be valid" and "where would the child end up", for Agent 04's live preview and
 * Agent 07's validation to both call.
 */
import type { ApparatusDefinition, SocketDefinition, SocketMateKind, Transform } from './types';
import { composeTransforms, solveCoincidentOrigin } from './transforms';

export type SocketCompatibilityReasonCode =
  | 'OK'
  | 'KIND_MISMATCH'
  | 'ROLE_NOT_ACCEPTED'
  | 'GENDER_MISMATCH'
  | 'SOCKET_FULL'
  | 'DIAMETER_TOO_SMALL'
  | 'DIAMETER_TOO_LARGE'
  | 'DIAMETER_UNKNOWN'
  | 'FOOTPRINT_TOO_LARGE'
  | 'FOOTPRINT_UNKNOWN';

export interface SocketCompatibilityResult {
  readonly compatible: boolean;
  readonly reasonCode: SocketCompatibilityReasonCode;
  /** A short, user-presentable explanation (shared contract: "clear reason"). */
  readonly reason: string;
}

export interface SocketRef {
  readonly definition: ApparatusDefinition;
  readonly socket: SocketDefinition;
  /** Connections already present at this socket on the specific instance being tested. Defaults to 0. */
  readonly currentConnections?: number;
}

function acceptsRole(socket: SocketDefinition, otherRole: string): boolean {
  return socket.accepts.includes('*') || socket.accepts.includes(otherRole);
}

function ok(): SocketCompatibilityResult {
  return { compatible: true, reasonCode: 'OK', reason: 'Sockets are compatible.' };
}
function fail(reasonCode: SocketCompatibilityReasonCode, reason: string): SocketCompatibilityResult {
  return { compatible: false, reasonCode, reason };
}

/**
 * Checks whether `a.socket` on `a.definition` can mate with `b.socket` on `b.definition`. Order of
 * the two sides does not matter; every check is evaluated symmetrically.
 */
export function evaluateSocketCompatibility(a: SocketRef, b: SocketRef): SocketCompatibilityResult {
  if (a.socket.kind !== b.socket.kind) {
    return fail(
      'KIND_MISMATCH',
      `"${a.socket.label}" is a ${a.socket.kind.toLowerCase()} socket and cannot connect to "${b.socket.label}", a ${b.socket.kind.toLowerCase()} socket.`,
    );
  }

  if (!acceptsRole(a.socket, b.socket.role) || !acceptsRole(b.socket, a.socket.role)) {
    return fail(
      'ROLE_NOT_ACCEPTED',
      `"${a.definition.label}" (${a.socket.label}) and "${b.definition.label}" (${b.socket.label}) do not declare each other as compatible attachment roles.`,
    );
  }

  const genders = [a.socket.gender, b.socket.gender];
  if (genders[0] !== 'NEUTRAL' && genders[1] !== 'NEUTRAL' && genders[0] === genders[1]) {
    return fail(
      'GENDER_MISMATCH',
      `Both "${a.socket.label}" and "${b.socket.label}" are ${genders[0].toLowerCase()} connectors; one side must be the complementary fitting.`,
    );
  }

  if ((a.currentConnections ?? 0) >= a.socket.maxConnections) {
    return fail('SOCKET_FULL', `"${a.definition.label}"'s "${a.socket.label}" socket already has the maximum number of connections.`);
  }
  if ((b.currentConnections ?? 0) >= b.socket.maxConnections) {
    return fail('SOCKET_FULL', `"${b.definition.label}"'s "${b.socket.label}" socket already has the maximum number of connections.`);
  }

  const geometryResult = checkGeometryFit(a.socket, b.socket) ?? checkGeometryFit(b.socket, a.socket);
  if (geometryResult) return geometryResult;

  return ok();
}

/** If `requirer` declares a geometry check, verifies `offered`'s nominal size satisfies it. Returns `null` if `requirer` has no check to apply. */
function checkGeometryFit(requirer: SocketDefinition, offered: SocketDefinition): SocketCompatibilityResult | null {
  const check = requirer.geometryCheck;
  if (check.kind === 'none') return null;

  if (check.kind === 'cylinder-fit') {
    if (offered.nominalDiameterM === undefined) {
      return fail('DIAMETER_UNKNOWN', `"${offered.label}" does not declare the diameter "${requirer.label}" needs to check the fit.`);
    }
    if (offered.nominalDiameterM < check.minDiameterM) {
      return fail(
        'DIAMETER_TOO_SMALL',
        `"${offered.label}" (${(offered.nominalDiameterM * 1000).toFixed(1)} mm) is too thin for "${requirer.label}" (min ${(check.minDiameterM * 1000).toFixed(1)} mm).`,
      );
    }
    if (offered.nominalDiameterM > check.maxDiameterM) {
      return fail(
        'DIAMETER_TOO_LARGE',
        `"${offered.label}" (${(offered.nominalDiameterM * 1000).toFixed(1)} mm) is too thick for "${requirer.label}" (max ${(check.maxDiameterM * 1000).toFixed(1)} mm).`,
      );
    }
    return null;
  }

  // check.kind === 'footprint-fit'
  if (!offered.nominalFootprintM) {
    return fail('FOOTPRINT_UNKNOWN', `"${offered.label}" does not declare the footprint "${requirer.label}" needs to check the fit.`);
  }
  if (offered.nominalFootprintM.width > check.maxWidthM || offered.nominalFootprintM.depth > check.maxDepthM) {
    return fail('FOOTPRINT_TOO_LARGE', `"${offered.label}"'s footprint is too large to rest on "${requirer.label}".`);
  }
  return null;
}

/**
 * The mate kind that actually governs placement for a pair of sockets. 'planar' (free placement
 * on a surface) takes precedence over 'axial' (free travel along one axis), which takes
 * precedence over the default rigid 'coincident' mate; 'proximity' (no rigid attachment) is used
 * only when neither side asks for anything stricter.
 */
export function effectiveMateKind(a: SocketDefinition, b: SocketDefinition): SocketMateKind {
  const kinds = [a.mate, b.mate];
  if (kinds.includes('planar')) return 'planar';
  if (kinds.includes('axial')) return 'axial';
  if (kinds.includes('proximity') && !kinds.includes('coincident')) return 'proximity';
  return 'coincident';
}

export interface AttachmentOptions {
  /** Signed travel in meters along the parent socket's local +Z, for 'axial' mates. Clamped to the declared range. */
  readonly axialOffsetM?: number;
  /** Offset in meters within the parent socket's local XY plane, for 'planar' mates. Clamped to the declared area. */
  readonly planarOffsetM?: readonly [number, number];
  /** Extra rotation about the parent socket's local Z axis, in degrees (e.g. the user spinning a flask on a bench). */
  readonly yawOffsetDeg?: number;
}

export interface AttachmentPlacement {
  /** World transform the child apparatus's origin should be set to. */
  readonly childOrigin: Transform;
  readonly mate: SocketMateKind;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes where a child apparatus's origin must be placed in world space so that `childSocket`
 * mates with `parentSocket`, given the parent apparatus's current world transform. Used by
 * Agent 04 for live snap previews and available to Agent 07 for authoritative placement on
 * `ATTACH`. Never mutates anything — purely computes a candidate transform.
 */
export function computeAttachmentPlacement(
  parentWorldTransform: Transform,
  parentSocket: SocketDefinition,
  childSocket: SocketDefinition,
  options: AttachmentOptions = {},
): AttachmentPlacement {
  const parentSocketWorld = composeTransforms(parentWorldTransform, parentSocket.transform);
  const mate = effectiveMateKind(parentSocket, childSocket);

  const yawDeg = options.yawOffsetDeg ?? 0;
  const yawRad = (yawDeg * Math.PI) / 180;
  const yawQuaternion: readonly [number, number, number, number] = [0, 0, Math.sin(yawRad / 2), Math.cos(yawRad / 2)];

  let virtualParentFrame = parentSocketWorld;

  if (mate === 'axial') {
    // The parent (the already-placed object providing the rail — a stand's rod, a clamp's jaw
    // opening) governs the valid travel domain for this specific pairing; the child's own
    // `axialRangeM` is only a fallback default for when IT is acting as the rail (e.g. if the same
    // socket were ever mated the other way around). See the socket-authoring notes in `definitions/**`.
    const range = parentSocket.axialRangeM ?? childSocket.axialRangeM ?? [0, 0];
    const offset = clamp(options.axialOffsetM ?? 0, range[0], range[1]);
    virtualParentFrame = composeTransforms(parentSocketWorld, { positionM: [0, 0, offset], quaternion: yawQuaternion });
  } else if (mate === 'planar') {
    const area = parentSocket.planarAreaM ?? { width: 0, depth: 0 };
    const requested = options.planarOffsetM ?? [0, 0];
    const offset: [number, number] = [clamp(requested[0], -area.width / 2, area.width / 2), clamp(requested[1], -area.depth / 2, area.depth / 2)];
    virtualParentFrame = composeTransforms(parentSocketWorld, { positionM: [offset[0], offset[1], 0], quaternion: yawQuaternion });
  } else if (yawDeg !== 0) {
    virtualParentFrame = composeTransforms(parentSocketWorld, { positionM: [0, 0, 0], quaternion: yawQuaternion });
  }

  const childOrigin = solveCoincidentOrigin(virtualParentFrame, childSocket.transform);
  return { childOrigin, mate };
}

export interface RoleCompatibilityEntry {
  readonly roleA: string;
  readonly roleB: string;
  readonly kind: string;
  readonly result: SocketCompatibilityResult;
  readonly exampleA: string;
  readonly exampleB: string;
}

/**
 * Builds a deduplicated role x role compatibility matrix across every socket in the given
 * definitions — the "socket compatibility matrix" deliverable. One representative socket is used
 * per distinct (kind, role); geometry results reflect that representative's nominal size, so the
 * matrix should be read as "can this role generally attach", not as an exhaustive per-instance check.
 */
export function buildRoleCompatibilityMatrix(definitions: readonly ApparatusDefinition[]): RoleCompatibilityEntry[] {
  const representatives = new Map<string, SocketRef>();
  for (const definition of definitions) {
    for (const socket of definition.sockets) {
      const key = `${socket.kind}::${socket.role}`;
      if (!representatives.has(key)) representatives.set(key, { definition, socket });
    }
  }

  const entries: RoleCompatibilityEntry[] = [];
  const keys = [...representatives.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i; j < keys.length; j++) {
      const a = representatives.get(keys[i])!;
      const b = representatives.get(keys[j])!;
      entries.push({
        roleA: a.socket.role,
        roleB: b.socket.role,
        kind: a.socket.kind,
        result: evaluateSocketCompatibility(a, b),
        exampleA: a.definition.label,
        exampleB: b.definition.label,
      });
    }
  }
  return entries;
}

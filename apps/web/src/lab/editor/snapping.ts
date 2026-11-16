/**
 * Socket snapping: the brief's item 3 ("robust snap/attach flow based solely on Agent 03 socket
 * metadata and Agent 07 connection validation. Show valid sockets while hovering and explicit
 * rejection reasons."). This module only *proposes* a snap from Agent 03's socket metadata and the
 * current (optimistic) editor scene graph; the proposal still has to be confirmed by Agent 07's
 * reducer through an `ATTACH` action (`commands.ts`) before it is real.
 */
import type { ApparatusDefinition, SocketDefinition } from '../apparatus/catalog';
import type { ApparatusInstance, Connection, Transform, UUID } from './contracts';
import { composeTransform, conjugateQuat, distanceVec3, multiplyQuat, projectPointOntoPlane, rotateVec3, subVec3, worldAabbFor } from './footprint';
import type { ResolvedSocket, SnapRejectReason, SnapResult, Vec3 } from './types';
import { footprintFor } from '../apparatus/catalog';

/** Default distance within which a socket is considered "aimed at"; roughly a thumb's width. */
export const DEFAULT_SNAP_DISTANCE_M = 0.06;
/** How far above a planar socket's surface a dragged socket may still be considered touching it. */
const PLANAR_HEIGHT_TOLERANCE_M = 0.35;

function socketOccupied(instanceId: UUID, socketId: string, connections: Iterable<Connection>, multiple: boolean): boolean {
  if (multiple) return false;
  for (const connection of connections) {
    if ((connection.from.instanceId === instanceId && connection.from.socketId === socketId) || (connection.to.instanceId === instanceId && connection.to.socketId === socketId)) {
      return true;
    }
  }
  return false;
}

/** Every socket of `instance`, resolved to world space and tagged with whether it is already in use. */
export function resolveSockets(instance: ApparatusInstance, definition: ApparatusDefinition, connections: Iterable<Connection>): ResolvedSocket[] {
  return definition.sockets.map((socket) => ({
    instanceId: instance.id,
    socketId: socket.id,
    kind: socket.kind,
    accepts: socket.accepts,
    worldTransform: composeTransform(instance.transform, socket.localTransform),
    occupied: socketOccupied(instance.id, socket.id, connections, socket.multiple ?? false),
    surface: socket.surface,
    multiple: socket.multiple ?? false,
  }));
}

function accepts(list: readonly string[], kind: string): boolean {
  return list.includes(kind) || list.includes('ANY');
}

export interface SnapCandidate {
  readonly instance: ApparatusInstance;
  readonly definition: ApparatusDefinition;
}

export interface FindSnapParams {
  readonly draggedKind: ApparatusDefinition['kind'];
  readonly draggedDefinition: ApparatusDefinition;
  /** Where the dragged item would land absent any snapping (e.g. the pointer's plane intersection). */
  readonly candidateTransform: Transform;
  /** Other instances close enough to be worth considering (pre-filtered, e.g. via `SpatialIndex.queryNear`). */
  readonly nearby: readonly SnapCandidate[];
  readonly connections: Iterable<Connection>;
  readonly snapDistanceM?: number;
  /** The instance being moved, excluded from snapping to itself. Omit when placing a brand-new instance. */
  readonly excludeInstanceId?: UUID;
}

interface PairCandidate {
  readonly ds: SocketDefinition;
  readonly ns: ResolvedSocket;
  readonly nsInstance: ApparatusInstance;
  readonly nsDefinition: ApparatusDefinition;
  readonly distanceM: number;
  /** The dragged socket's current world point, kept so a planar match can re-project it onto the surface later. */
  readonly point: Vec3;
}

/** The world point a dragged socket would currently occupy under `candidateTransform`, before any snapping. */
function draggedSocketWorldPoint(ds: SocketDefinition, candidateTransform: Transform): Vec3 {
  return composeTransform(candidateTransform, ds.localTransform).positionM;
}

function planarDistance(ns: ResolvedSocket, nsInstance: ApparatusInstance, nsDefinition: ApparatusDefinition, point: Vec3): number | null {
  const aabb = worldAabbFor(footprintFor(nsDefinition), nsInstance.transform);
  if (point[0] < aabb.min[0] || point[0] > aabb.max[0] || point[2] < aabb.min[2] || point[2] > aabb.max[2]) return null;
  const height = point[1] - ns.worldTransform.positionM[1];
  if (height < -0.02 || height > PLANAR_HEIGHT_TOLERANCE_M) return null;
  return Math.abs(height);
}

/**
 * Proposes the best snap for the dragged apparatus at its current candidate position: `'none'`
 * when nothing compatible is nearby, `'invalid'` with a reason when the nearest socket rejects it,
 * or `'valid'` with the instance transform that would align the dragged socket exactly onto it.
 */
export function findSnapTarget(params: FindSnapParams): SnapResult {
  const snapDistanceM = params.snapDistanceM ?? DEFAULT_SNAP_DISTANCE_M;
  const pairs: PairCandidate[] = [];

  for (const candidate of params.nearby) {
    if (candidate.instance.id === params.excludeInstanceId) continue;
    const resolved = resolveSockets(candidate.instance, candidate.definition, params.connections);
    for (const ns of resolved) {
      for (const ds of params.draggedDefinition.sockets) {
        if (ds.kind !== ns.kind) continue; // different connection domains (mechanical/fluid/sensor/control) never pair
        const point = draggedSocketWorldPoint(ds, params.candidateTransform);
        const distanceM = ns.surface === 'planar' ? planarDistance(ns, candidate.instance, candidate.definition, point) : distanceVec3(point, ns.worldTransform.positionM);
        if (distanceM === null || distanceM > snapDistanceM) continue;
        pairs.push({ ds, ns, nsInstance: candidate.instance, nsDefinition: candidate.definition, distanceM, point });
      }
    }
  }

  if (pairs.length === 0) return { status: 'none' };
  pairs.sort((a, b) => a.distanceM - b.distanceM);
  const best = pairs[0]!;
  const { ds, ns, nsInstance } = best;

  const mutualAccept = accepts(ns.accepts, params.draggedKind) && accepts(ds.accepts, nsInstance.kind);
  if (!mutualAccept) {
    return { status: 'invalid', reason: 'INCOMPATIBLE_KIND', message: `${ns.socketId} on this ${nsInstance.kind.toLowerCase()} does not accept a ${params.draggedKind.toLowerCase()}.`, socket: ns };
  }
  if (ns.occupied) {
    return { status: 'invalid', reason: 'SOCKET_OCCUPIED', message: `${ns.socketId} is already connected.`, socket: ns };
  }
  if (nsInstance.id === params.excludeInstanceId) {
    return { status: 'invalid', reason: 'SELF_CONNECTION', message: 'An instrument cannot connect to itself.', socket: ns };
  }

  const worldTransform = alignToSocket(ds.localTransform, planarTargetWorld(ns, best.point));
  return { status: 'valid', socket: ns, draggedSocketId: ds.id, worldTransform };
}

/** For a planar socket, the alignment target is the drag point re-projected onto the surface (keeping its horizontal position); for a point socket it is simply the socket's own anchor. */
function planarTargetWorld(ns: ResolvedSocket, draggedPoint: Vec3): Transform {
  if (ns.surface !== 'planar') return ns.worldTransform;
  const normal = rotateVec3([0, 1, 0], ns.worldTransform.quaternion);
  return { positionM: projectPointOntoPlane(draggedPoint, ns.worldTransform.positionM, normal), quaternion: ns.worldTransform.quaternion };
}

/** The instance transform that would place `draggedSocketLocal` exactly at `targetWorld`. */
export function alignToSocket(draggedSocketLocal: Transform, targetWorld: Transform): Transform {
  const quaternion = multiplyQuat(targetWorld.quaternion, conjugateQuat(draggedSocketLocal.quaternion));
  const positionM = subVec3(targetWorld.positionM, rotateVec3(draggedSocketLocal.positionM, quaternion));
  return { positionM, quaternion };
}

export type { SnapRejectReason, SnapResult };


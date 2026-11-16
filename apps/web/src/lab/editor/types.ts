/**
 * Editor-local types for `apps/web/src/lab/editor/**` (Agent 04's owned surface). Nothing here is
 * part of the shared domain model (see `contracts.ts`): this file describes *how the editor thinks*
 * about the scene while the user is placing, selecting and transforming apparatus, independent of
 * how Agent 07's authoritative reducer represents the same instances.
 */
import type { ApparatusInstance, Capability, Connection, Transform, UUID } from './contracts';

export type Axis = 'x' | 'y' | 'z';
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

/** A named collection of instance ids the user can select, move and lock together ("workstation grouping"). */
export interface Group {
  readonly id: UUID;
  readonly name: string;
  readonly memberIds: readonly UUID[];
}

/**
 * Everything the editor's undo stack governs: apparatus placement/transform, the connection graph,
 * groups and the lock flag. Deliberately excludes `ContainerContents` / species inventory, which
 * only the action sink (Agent 07's reducer, or its stand-in) may hold or change.
 */
export interface EditorSceneState {
  readonly apparatus: ReadonlyMap<UUID, ApparatusInstance>;
  readonly connections: ReadonlyMap<UUID, Connection>;
  readonly groups: ReadonlyMap<UUID, Group>;
  readonly locked: ReadonlySet<UUID>;
  readonly nextRevision: number;
}

export function emptyEditorScene(): EditorSceneState {
  return { apparatus: new Map(), connections: new Map(), groups: new Map(), locked: new Set(), nextRevision: 1 };
}

/** One socket resolved to world space, for snapping and highlight purposes. */
export interface ResolvedSocket {
  readonly instanceId: UUID;
  readonly socketId: string;
  readonly kind: Connection['kind'];
  /** Apparatus kinds (or `'ANY'`) this socket accepts on the other end. */
  readonly accepts: readonly string[];
  readonly worldTransform: Transform;
  readonly occupied: boolean;
  /** A `'planar'` socket (a benchtop) snaps anywhere on its surface; a `'point'` socket snaps at one fixed anchor. */
  readonly surface: 'point' | 'planar';
  /** Whether more than one connection may use this socket at once. */
  readonly multiple: boolean;
}

export type SnapRejectReason =
  | 'INCOMPATIBLE_KIND'
  | 'SOCKET_OCCUPIED'
  | 'OUT_OF_RANGE'
  | 'SELF_CONNECTION'
  | 'COLLISION'
  | 'CAPACITY_EXCEEDED';

export type SnapResult =
  | { readonly status: 'valid'; readonly socket: ResolvedSocket; readonly worldTransform: Transform }
  | { readonly status: 'none' }
  | { readonly status: 'invalid'; readonly reason: SnapRejectReason; readonly message: string; readonly socket?: ResolvedSocket };

export interface CollisionWarning {
  readonly withInstanceId: UUID;
  readonly message: string;
}

/** What is shown while an apparatus is being dragged from the palette or moved, before the user commits it. */
export interface PlacementPreview {
  readonly definitionId: string;
  readonly transform: Transform;
  readonly snap: SnapResult;
  readonly collisions: readonly CollisionWarning[];
  /** False when the equipment floats unsupported (no bench/mount beneath it) and the definition requires one. */
  readonly supported: boolean;
}

/**
 * Pointer/keyboard gesture ownership. Exactly one mode is active at a time, and only `'camera'` (or
 * `'idle'`) permits the orbit camera to receive pointer input — see `cameraGate.ts`.
 */
export type GestureMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'camera' }
  | { readonly kind: 'placing'; readonly definitionId: string }
  | { readonly kind: 'dragging'; readonly instanceIds: readonly UUID[] }
  | { readonly kind: 'gizmo'; readonly mode: 'translate' | 'rotate'; readonly axis: Axis | null }
  | { readonly kind: 'marquee' }
  | { readonly kind: 'connecting'; readonly fromInstanceId: UUID; readonly fromSocketId: string }
  | { readonly kind: 'operating'; readonly instanceId: UUID; readonly control: string };

export const IDLE_GESTURE: GestureMode = { kind: 'idle' };
export const CAMERA_GESTURE: GestureMode = { kind: 'camera' };

/** True for every mode except the two that leave the camera free to orbit. */
export function gestureOwnsPointer(mode: GestureMode): boolean {
  return mode.kind !== 'idle' && mode.kind !== 'camera';
}

export interface BoundsBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Minimal per-kind facts the editor needs for picking/snapping/collision, independent of Agent 03's render assets. */
export interface ApparatusFootprint {
  readonly halfExtents: Vec3;
  /** Local-space offset of the footprint's centre from the instance origin. */
  readonly center: Vec3;
}

export interface CapabilityRequirement {
  readonly capability: Capability;
  readonly message: string;
}

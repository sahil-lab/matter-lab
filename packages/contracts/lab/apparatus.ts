/**
 * Apparatus definition / socket contract (00_SHARED_INTEGRATION_CONTRACT.md Section 4; Agent 03's
 * brief, "Required implementation" items 1-2). Agent 03 owns authoring the real instrument library
 * (meshes, physically scaled dimensions, premium materials); Agent 07 owns validating connection
 * topology and capabilities against whatever satisfies this shape, and is the only agent allowed to
 * actually apply an `ATTACH`/`DETACH` to authoritative scene state.
 *
 * STUB STATUS: Agent 03 is a sibling branch and had not landed a definitions registry at the time
 * this was written. The shape below is Agent 07's best-effort reconstruction of Agent 03's brief so
 * the reducer has something concrete to validate against and test. Reconcile field-for-field with
 * Agent 03's actual delivered `ApparatusDefinition`s before shipping; do not assume this is final.
 */

import type { ApparatusKind, Capability, ConnectionKind, Transform } from './types';

/** Local-space transform plus the connection rules that make a socket a socket and not just a point. */
export interface SocketDefinition {
  readonly id: string;
  readonly kind: ConnectionKind;
  /** Where the socket sits relative to the apparatus's own origin. */
  readonly localTransform: Transform;
  /**
   * `PLUG` mates only with `SOCKET` (and vice versa); `NEUTRAL` mates with any gender. Mirrors the
   * physical reality that a burette's barrel (plug) fits a clamp's bore (socket), while two fluid
   * ports on a manifold might both be neutral.
   */
  readonly gender: 'PLUG' | 'SOCKET' | 'NEUTRAL';
  /** When set, only these apparatus kinds may occupy the other end, in addition to capability checks. */
  readonly acceptsKinds?: readonly ApparatusKind[];
  /** Capability the apparatus at the *other* end of the connection must declare. */
  readonly requiresCapability?: Capability;
  /** How many simultaneous connections this socket tolerates (almost always 1). */
  readonly maxConnections: number;
}

export interface OperationControlDefinition {
  /** e.g. `'valveOpening'`, `'stirrerRpm'`, `'probeDepthM'`. Read and written through `config`. */
  readonly id: string;
  readonly label: string;
  readonly kind: 'range' | 'toggle' | 'select';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: readonly string[];
  /** Which `LabAction` type carries changes to this control (e.g. `SET_VALVE`, `START_STIRRER`). */
  readonly appliesVia: string;
}

/** A flow model is named and declared, never silently assumed (Section 4: "explicit supported model"). */
export interface LinearValveFlowModel {
  readonly id: 'linear-valve-v1';
  /** Flow at `valveOpening === 1`, in liters per second. */
  readonly maxFlowRateLPerS: number;
}

export interface ApparatusDefinition {
  /** Stable type id, e.g. `'burette.class-a.50ml'`. Never reused for a different design. */
  readonly id: string;
  readonly kind: ApparatusKind;
  readonly label: string;
  readonly category: string;
  readonly capabilities: readonly Capability[];
  readonly dimensionsM: { readonly width: number; readonly height: number; readonly depth: number };
  readonly massKg?: number;
  /** Present when `capabilities` includes `CONTAINER` or `FLOW_SOURCE`. */
  readonly capacityL?: number;
  readonly flowModel?: LinearValveFlowModel;
  readonly sockets: readonly SocketDefinition[];
  readonly collisionRadiusM?: number;
  readonly permittedTransforms: {
    readonly translate: boolean;
    readonly rotateAxes: readonly ('x' | 'y' | 'z')[];
  };
  readonly controls: readonly OperationControlDefinition[];
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly assetRef?: { readonly uri: string; readonly polyCount?: number; readonly license?: string; readonly provenance?: string };
  /** Visibly marks a development placeholder, per Agent 03 brief item 7 — never a shipping feature. */
  readonly isPlaceholder?: boolean;
}

export interface SocketLookup {
  readonly definition: ApparatusDefinition;
  readonly socket: SocketDefinition;
}

export interface SocketCompatibility {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Pure predicate used both by Agent 04 (hover/preview feedback while dragging) and Agent 07
 * (authoritative check before committing an `ATTACH`). Keeping it here, rather than duplicated in
 * each agent's own module, is what keeps "shows valid" and "actually accepts" from drifting apart.
 */
export function canSocketsConnect(a: SocketLookup, b: SocketLookup): SocketCompatibility {
  if (a.socket.kind !== b.socket.kind) {
    return { ok: false, reason: `Socket kinds do not match (${a.socket.kind} vs ${b.socket.kind}).` };
  }
  if (a.socket.gender !== 'NEUTRAL' && b.socket.gender !== 'NEUTRAL' && a.socket.gender === b.socket.gender) {
    return { ok: false, reason: `Sockets of the same gender (${a.socket.gender}) cannot mate.` };
  }
  if (a.socket.acceptsKinds && !a.socket.acceptsKinds.includes(b.definition.kind)) {
    return { ok: false, reason: `${a.definition.label}'s ${a.socket.id} socket does not accept ${b.definition.kind}.` };
  }
  if (b.socket.acceptsKinds && !b.socket.acceptsKinds.includes(a.definition.kind)) {
    return { ok: false, reason: `${b.definition.label}'s ${b.socket.id} socket does not accept ${a.definition.kind}.` };
  }
  if (a.socket.requiresCapability && !b.definition.capabilities.includes(a.socket.requiresCapability)) {
    return { ok: false, reason: `${b.definition.label} lacks the ${a.socket.requiresCapability} capability required by ${a.definition.label}'s ${a.socket.id} socket.` };
  }
  if (b.socket.requiresCapability && !a.definition.capabilities.includes(b.socket.requiresCapability)) {
    return { ok: false, reason: `${a.definition.label} lacks the ${b.socket.requiresCapability} capability required by ${b.definition.label}'s ${b.socket.id} socket.` };
  }
  return { ok: true };
}

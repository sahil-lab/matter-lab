/**
 * Combines snapping, collision and support checks into one `PlacementPreview` — what the brief's
 * item 1 calls "placement previews, surface snapping and collision/capacity warnings before
 * commit". Nothing here mutates any state; `commands.ts` reads the result to decide what a commit
 * is allowed to do and what warning text to surface.
 */
import type { ApparatusDefinition } from '../apparatus/catalog';
import { footprintFor } from '../apparatus/catalog';
import type { Connection, Transform, UUID } from './contracts';
import { worldAabbFor } from './footprint';
import type { CollisionCandidate } from './collision';
import { findCollisions } from './collision';
import type { SnapCandidate } from './snapping';
import { findSnapTarget } from './snapping';
import type { PlacementPreview } from './types';

export interface PlacementContext {
  readonly definition: ApparatusDefinition;
  readonly candidateTransform: Transform;
  /** Instances close enough to be worth snap-testing against. */
  readonly snapNearby: readonly SnapCandidate[];
  /** Instances close enough to be worth collision-testing against (usually a superset of `snapNearby`). */
  readonly collisionNearby: readonly CollisionCandidate[];
  readonly connections: Iterable<Connection>;
  readonly excludeInstanceId?: UUID;
  readonly snapDistanceM?: number;
}

export function computePlacementPreview(ctx: PlacementContext): PlacementPreview {
  const snap = findSnapTarget({
    draggedKind: ctx.definition.kind,
    draggedDefinition: ctx.definition,
    candidateTransform: ctx.candidateTransform,
    nearby: ctx.snapNearby,
    connections: ctx.connections,
    snapDistanceM: ctx.snapDistanceM,
    excludeInstanceId: ctx.excludeInstanceId,
  });

  const transform = snap.status === 'valid' ? snap.worldTransform : ctx.candidateTransform;
  const candidateBox = worldAabbFor(footprintFor(ctx.definition), transform);

  const excludeIds = new Set<UUID>();
  if (ctx.excludeInstanceId) excludeIds.add(ctx.excludeInstanceId);
  if (snap.status === 'valid') excludeIds.add(snap.socket.instanceId);

  const collisions = findCollisions(candidateBox, ctx.collisionNearby, { excludeIds });

  const mountedOnSupport = snap.status === 'valid' && ctx.snapNearby.some((c) => c.instance.id === snap.socket.instanceId && c.definition.capabilities.includes('MOUNT'));
  const supported = !ctx.definition.requiresSupport || mountedOnSupport;

  return { definitionId: ctx.definition.id, transform, snap, collisions, supported };
}

/**
 * Overlap warnings for the placement preview (brief item 1: "collision/capacity warnings before
 * commit"). This is a visual, advisory check only — it never blocks a placement by itself; Agent
 * 07's reducer is still the one source of truth for whether a `PLACE`/`MOVE` is actually accepted.
 */
import type { UUID } from './contracts';
import { aabbsOverlap } from './footprint';
import type { BoundsBox, CollisionWarning } from './types';

export interface CollisionCandidate {
  readonly instanceId: UUID;
  readonly label: string;
  readonly box: BoundsBox;
}

export interface FindCollisionsOptions {
  /** Instances to never flag — typically the instance being moved itself, and whatever it just snapped onto. */
  readonly excludeIds?: ReadonlySet<UUID>;
  /** Boxes are allowed to interpenetrate by up to this many metres before being reported (avoids flagging flush contact as a collision). */
  readonly toleranceM?: number;
}

const DEFAULT_TOLERANCE_M = 0.01;

export function findCollisions(candidateBox: BoundsBox, nearby: readonly CollisionCandidate[], options: FindCollisionsOptions = {}): CollisionWarning[] {
  const tolerance = options.toleranceM ?? DEFAULT_TOLERANCE_M;
  const warnings: CollisionWarning[] = [];
  for (const candidate of nearby) {
    if (options.excludeIds?.has(candidate.instanceId)) continue;
    if (aabbsOverlap(candidateBox, candidate.box, tolerance)) {
      warnings.push({ withInstanceId: candidate.instanceId, message: `Overlaps ${candidate.label}.` });
    }
  }
  return warnings;
}

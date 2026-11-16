import { describe, expect, it } from 'vitest';
import { findCollisions } from './collision';
import type { CollisionCandidate } from './collision';

describe('findCollisions', () => {
  const nearby: CollisionCandidate[] = [
    { instanceId: 'a', label: 'a flask', box: { min: [0, 0, 0], max: [1, 1, 1] } },
    { instanceId: 'b', label: 'a beaker', box: { min: [5, 0, 0], max: [6, 1, 1] } },
  ];

  it('flags an overlapping candidate and not a distant one', () => {
    const warnings = findCollisions({ min: [0.5, 0, 0], max: [1.5, 1, 1] }, nearby);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.withInstanceId).toBe('a');
    expect(warnings[0]!.message).toContain('a flask');
  });

  it('excludes ids the caller names, such as the instance being moved or its snap target', () => {
    const warnings = findCollisions({ min: [0.5, 0, 0], max: [1.5, 1, 1] }, nearby, { excludeIds: new Set(['a']) });
    expect(warnings).toHaveLength(0);
  });

  it('allows flush or slightly interpenetrating contact within tolerance', () => {
    const warnings = findCollisions({ min: [1, 0, 0], max: [2, 1, 1] }, nearby, { toleranceM: 0.02 });
    expect(warnings).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { FixtureDemoRuntime } from './fixtureRuntime';

describe('FixtureDemoRuntime.snapshot', () => {
  it('returns the identical reference across repeated calls until something actually changes (useSyncExternalStore contract)', () => {
    const runtime = new FixtureDemoRuntime();
    const first = runtime.snapshot();
    const second = runtime.snapshot();
    expect(second).toBe(first); // reference equality, not just deep equality

    runtime.placeApparatus('stand');
    const third = runtime.snapshot();
    expect(third).not.toBe(first);
    expect(runtime.snapshot()).toBe(third);
  });
});

describe('FixtureDemoRuntime.deliverIncrement', () => {
  it('accumulates correctly even when called repeatedly without reading an intervening snapshot (guards against stale-closure UI bugs)', () => {
    const runtime = new FixtureDemoRuntime();
    for (let i = 0; i < 50; i++) runtime.deliverIncrement(0.0005); // 50 x 0.5 mL
    expect(runtime.snapshot().deliveredSinceTrialStartL).toBeCloseTo(0.025, 6);
  });
});


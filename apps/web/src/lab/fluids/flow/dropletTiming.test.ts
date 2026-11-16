import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DROP_VOLUME_ML,
  INITIAL_DROPLET_SPAWN_STATE,
  advanceDropletSpawn,
  dropletFallDurationS,
  dropletPositionAt,
} from './dropletTiming';

describe('advanceDropletSpawn', () => {
  it('spawns nothing and resets accumulation at zero flow (no ghost droplets after a pause)', () => {
    const primed = { accumulatedMl: 0.04 };
    const result = advanceDropletSpawn(primed, 0, 1 / 60);
    expect(result.dropsSpawned).toBe(0);
    expect(result.state).toEqual(INITIAL_DROPLET_SPAWN_STATE);
  });

  it('spawns nothing for a zero or negative time step', () => {
    expect(advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 1, 0).dropsSpawned).toBe(0);
    expect(advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 1, -1 / 60).dropsSpawned).toBe(0);
  });

  it('spawns exactly one drop once the accumulated volume reaches one drop volume', () => {
    // 1 mL/s for exactly one drop volume worth of time.
    const dtS = DEFAULT_DROP_VOLUME_ML / 1;
    const result = advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 1, dtS);
    expect(result.dropsSpawned).toBe(1);
    expect(result.state.accumulatedMl).toBeCloseTo(0, 9);
  });

  it('carries a fractional remainder forward between frames', () => {
    const dtS = (DEFAULT_DROP_VOLUME_ML * 0.4) / 1; // 1 mL/s, 40% of one drop
    const first = advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 1, dtS);
    expect(first.dropsSpawned).toBe(0);
    expect(first.state.accumulatedMl).toBeCloseTo(DEFAULT_DROP_VOLUME_ML * 0.4, 9);
    const second = advanceDropletSpawn(first.state, 1, dtS);
    expect(second.dropsSpawned).toBe(0);
    const third = advanceDropletSpawn(second.state, 1, dtS);
    expect(third.dropsSpawned).toBe(1);
  });

  it('spawns more than one drop in a single large step (e.g. a backgrounded tab)', () => {
    const result = advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 5, 1); // 5 mL delivered in one step
    expect(result.dropsSpawned).toBe(Math.floor(5 / DEFAULT_DROP_VOLUME_ML));
  });

  it('a higher flow rate spawns more drops over the same wall-clock time', () => {
    const slow = advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 0.5, 2);
    const fast = advanceDropletSpawn(INITIAL_DROPLET_SPAWN_STATE, 4, 2);
    expect(fast.dropsSpawned).toBeGreaterThan(slow.dropsSpawned);
  });
});

describe('dropletFallDurationS', () => {
  it('matches h = 1/2 g t^2 for a vertical drop', () => {
    const from: [number, number, number] = [0, 0.3, 0];
    const to: [number, number, number] = [0, 0, 0];
    const duration = dropletFallDurationS(from, to);
    const h = 0.5 * 9.81 * duration * duration;
    expect(h).toBeCloseTo(0.3, 6);
  });

  it('falls back to a small fixed duration when there is no height drop', () => {
    const duration = dropletFallDurationS([0, 0.1, 0], [0.05, 0.1, 0]);
    expect(duration).toBeGreaterThan(0);
  });

  it('a longer drop takes longer to fall', () => {
    const short = dropletFallDurationS([0, 0.1, 0], [0, 0, 0]);
    const long = dropletFallDurationS([0, 0.4, 0], [0, 0, 0]);
    expect(long).toBeGreaterThan(short);
  });
});

describe('dropletPositionAt', () => {
  const from: [number, number, number] = [0, 0.2, 0];
  const to: [number, number, number] = [0.02, 0, 0.01];
  const duration = dropletFallDurationS(from, to);

  it('starts exactly at the source point', () => {
    const p = dropletPositionAt(from, to, 0, duration);
    expect(p).toEqual(from);
  });

  it('lands exactly at the target point', () => {
    const p = dropletPositionAt(from, to, duration, duration);
    expect(p[0]).toBeCloseTo(to[0], 9);
    expect(p[1]).toBeCloseTo(to[1], 9);
    expect(p[2]).toBeCloseTo(to[2], 9);
  });

  it('clamps past landing instead of overshooting', () => {
    const p = dropletPositionAt(from, to, duration * 5, duration);
    expect(p[1]).toBeCloseTo(to[1], 9);
  });

  it('descends monotonically (constant downward acceleration, no bouncing mid-fall)', () => {
    let previousY = from[1];
    for (let i = 1; i <= 10; i++) {
      const p = dropletPositionAt(from, to, (duration * i) / 10, duration);
      expect(p[1]).toBeLessThanOrEqual(previousY + 1e-9);
      previousY = p[1];
    }
  });
});

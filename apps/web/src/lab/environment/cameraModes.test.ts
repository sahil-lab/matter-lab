import { describe, expect, it } from 'vitest';
import {
  addBookmark,
  CAMERA_MODE_CONFIG,
  cinematicDuration,
  clampDistance,
  clampPolar,
  createBookmark,
  dampTowards,
  dampTowardsVec3,
  effectiveAnimate,
  encompassingSphere,
  findBookmark,
  fitDistanceForSphere,
  orthoZoomForHeight,
  removeBookmark,
  renameBookmark,
  sampleCinematicPath,
  visibleHeightForZoom,
} from './cameraModes';
import type { CinematicWaypoint, FocusTarget } from './cameraModes';
import type { CameraBookmark, CameraPoseData } from './types';

describe('clampDistance / clampPolar', () => {
  it('leaves in-range values unchanged', () => {
    expect(clampDistance('orbit', 2)).toBe(2);
  });
  it('clamps to the mode-specific range', () => {
    expect(clampDistance('inspect', 5)).toBe(CAMERA_MODE_CONFIG.inspect.maxDistanceM);
    expect(clampDistance('orbit', 0)).toBe(CAMERA_MODE_CONFIG.orbit.minDistanceM);
    expect(clampPolar('top-down', 1)).toBeCloseTo(CAMERA_MODE_CONFIG['top-down'].maxPolarRad, 10);
  });
  it('inspect has a tighter range than orbit, since it is a close-range mode', () => {
    expect(CAMERA_MODE_CONFIG.inspect.maxDistanceM).toBeLessThan(CAMERA_MODE_CONFIG.orbit.maxDistanceM);
  });
});

describe('fitDistanceForSphere', () => {
  it('matches the trigonometric identity for a 90-degree field of view', () => {
    const d = fitDistanceForSphere(2, Math.PI / 2, 1);
    expect(d).toBeCloseTo(2 / Math.sin(Math.PI / 4), 10);
  });
  it('grows with the sphere radius', () => {
    expect(fitDistanceForSphere(4, 1, 1)).toBeGreaterThan(fitDistanceForSphere(2, 1, 1));
  });
  it('shrinks as the field of view widens', () => {
    expect(fitDistanceForSphere(2, 1.6, 1)).toBeLessThan(fitDistanceForSphere(2, 0.4, 1));
  });
  it('padding multiplies the result', () => {
    expect(fitDistanceForSphere(2, 1, 1.5)).toBeCloseTo(1.5 * fitDistanceForSphere(2, 1, 1), 10);
  });
});

describe('orthoZoomForHeight / visibleHeightForZoom', () => {
  it('are inverse functions', () => {
    const zoom = orthoZoomForHeight(3.2, 2);
    expect(visibleHeightForZoom(zoom, 2)).toBeCloseTo(3.2, 10);
  });
  it('a smaller desired height requires a larger zoom', () => {
    expect(orthoZoomForHeight(1, 2)).toBeGreaterThan(orthoZoomForHeight(4, 2));
  });
});

describe('effectiveAnimate', () => {
  it('only animates when requested and motion is not reduced', () => {
    expect(effectiveAnimate(true, false)).toBe(true);
    expect(effectiveAnimate(true, true)).toBe(false);
    expect(effectiveAnimate(false, false)).toBe(false);
    expect(effectiveAnimate(false, true)).toBe(false);
  });
});

describe('dampTowards', () => {
  it('returns the target exactly after an effectively infinite time', () => {
    expect(dampTowards(0, 10, 5, 1000)).toBeCloseTo(10, 6);
  });
  it('leaves the value unchanged at dt = 0', () => {
    expect(dampTowards(3, 10, 5, 0)).toBeCloseTo(3, 10);
  });
  it('does not move when lambda is zero or negative', () => {
    expect(dampTowards(3, 10, 0, 1)).toBe(3);
    expect(dampTowards(3, 10, -2, 1)).toBe(3);
  });
  it('compounds: two short steps land at the same place as one long step', () => {
    const viaTwoSteps = dampTowards(dampTowards(0, 10, 3, 0.1), 10, 3, 0.2);
    const viaOneStep = dampTowards(0, 10, 3, 0.3);
    expect(viaTwoSteps).toBeCloseTo(viaOneStep, 10);
  });
  it('moves monotonically towards the target without overshoot', () => {
    let value = 0;
    for (let i = 0; i < 20; i++) {
      const next = dampTowards(value, 10, 4, 0.05);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(10);
      value = next;
    }
    expect(value).toBeGreaterThan(8);
  });
});

describe('dampTowardsVec3', () => {
  it('damps each component independently', () => {
    const result = dampTowardsVec3([0, 0, 0], [10, -10, 5], 5, 1000);
    expect(result[0]).toBeCloseTo(10, 6);
    expect(result[1]).toBeCloseTo(-10, 6);
    expect(result[2]).toBeCloseTo(5, 6);
  });
});

const POSE_A: CameraPoseData = { position: [0, 1.6, 4], target: [0, 1, 0], zoom: 1, projection: 'perspective' };
const POSE_B: CameraPoseData = { position: [2, 2, 2], target: [0, 0.9, 0], zoom: 1.4, projection: 'perspective' };

describe('bookmarks', () => {
  it('adds a bookmark and finds it by id', () => {
    const bookmark = createBookmark('Equivalence point', 'inspect', POSE_A, 'bm-1');
    const list = addBookmark([], bookmark);
    expect(findBookmark(list, 'bm-1')?.name).toBe('Equivalence point');
  });

  it('adding a bookmark with an existing id replaces it (upsert)', () => {
    const first = createBookmark('Old name', 'orbit', POSE_A, 'bm-1');
    const second = createBookmark('New name', 'inspect', POSE_B, 'bm-1');
    const list = addBookmark(addBookmark([], first), second);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('New name');
  });

  it('removes a bookmark by id', () => {
    const list: CameraBookmark[] = [createBookmark('A', 'orbit', POSE_A, 'a'), createBookmark('B', 'orbit', POSE_B, 'b')];
    const after = removeBookmark(list, 'a');
    expect(after.map((b) => b.id)).toEqual(['b']);
  });

  it('renames a bookmark without touching its pose', () => {
    const list = addBookmark([], createBookmark('Old', 'orbit', POSE_A, 'a'));
    const renamed = renameBookmark(list, 'a', 'New');
    expect(renamed[0]?.name).toBe('New');
    expect(renamed[0]?.position).toEqual(POSE_A.position);
  });

  it('findBookmark returns undefined for an unknown id', () => {
    expect(findBookmark([], 'missing')).toBeUndefined();
  });
});

describe('sampleCinematicPath', () => {
  const path: CinematicWaypoint[] = [
    { pose: POSE_A, travelSeconds: 0 },
    { pose: POSE_B, travelSeconds: 2 },
  ];

  it('starts exactly at the first waypoint', () => {
    const sample = sampleCinematicPath(path, 0);
    expect(sample.pose.position).toEqual(POSE_A.position);
    expect(sample.finished).toBe(false);
  });

  it('ends exactly at the last waypoint and reports finished', () => {
    const sample = sampleCinematicPath(path, 2);
    expect(sample.pose.position[0]).toBeCloseTo(POSE_B.position[0], 10);
    expect(sample.pose.position[1]).toBeCloseTo(POSE_B.position[1], 10);
    expect(sample.pose.position[2]).toBeCloseTo(POSE_B.position[2], 10);
    expect(sample.finished).toBe(true);
  });

  it('clamps to the final pose past the end of the path', () => {
    const sample = sampleCinematicPath(path, 500);
    expect(sample.finished).toBe(true);
    expect(sample.pose.position[0]).toBeCloseTo(POSE_B.position[0], 10);
  });

  it('is partway between the two poses at the midpoint', () => {
    const sample = sampleCinematicPath(path, 1);
    expect(sample.pose.position[0]).toBeGreaterThan(POSE_A.position[0]);
    expect(sample.pose.position[0]).toBeLessThan(POSE_B.position[0]);
    expect(sample.finished).toBe(false);
  });

  it('a single-waypoint path is immediately finished', () => {
    const sample = sampleCinematicPath([{ pose: POSE_A, travelSeconds: 0 }], 0);
    expect(sample.finished).toBe(true);
    expect(sample.pose).toEqual(POSE_A);
  });

  it('an empty path returns a safe fallback pose', () => {
    const sample = sampleCinematicPath([], 0);
    expect(sample.finished).toBe(true);
    expect(sample.pose.projection).toBe('perspective');
  });
});

describe('encompassingSphere', () => {
  it('gives a safe default for no targets', () => {
    const sphere = encompassingSphere([]);
    expect(sphere.radiusM).toBeGreaterThan(0);
  });

  it('returns the single target unchanged', () => {
    const target: FocusTarget = { center: [1, 2, 3], radiusM: 0.5 };
    expect(encompassingSphere([target])).toEqual(target);
  });

  it('contains every target sphere', () => {
    const targets: FocusTarget[] = [
      { center: [-3, 0, 0], radiusM: 0.4 },
      { center: [3, 0, 0], radiusM: 0.4 },
      { center: [0, 0, 2], radiusM: 0.2 },
    ];
    const sphere = encompassingSphere(targets);
    for (const t of targets) {
      const d = Math.hypot(t.center[0] - sphere.center[0], t.center[1] - sphere.center[1], t.center[2] - sphere.center[2]);
      expect(d + t.radiusM).toBeLessThanOrEqual(sphere.radiusM + 1e-9);
    }
  });

  it('is centred between two equal, opposite targets', () => {
    const sphere = encompassingSphere([
      { center: [-2, 0, 0], radiusM: 0.3 },
      { center: [2, 0, 0], radiusM: 0.3 },
    ]);
    expect(sphere.center[0]).toBeCloseTo(0, 10);
  });
});

describe('cinematicDuration', () => {
  it('sums the travel time of every waypoint after the first', () => {
    const path: CinematicWaypoint[] = [
      { pose: POSE_A, travelSeconds: 0 },
      { pose: POSE_B, travelSeconds: 2 },
      { pose: POSE_A, travelSeconds: 3 },
    ];
    expect(cinematicDuration(path)).toBe(5);
  });
  it('is zero for an empty or single-waypoint path', () => {
    expect(cinematicDuration([])).toBe(0);
    expect(cinematicDuration([{ pose: POSE_A, travelSeconds: 0 }])).toBe(0);
  });
});

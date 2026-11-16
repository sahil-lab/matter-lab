import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  createWorkbenchSurface, IDENTITY_LAB_TRANSFORM, intersectPlacementSurface, projectWorldPoint,
  rayFromViewport, surfaceLocalToWorld, surfaceWorldToLocal, transformBounds, WORKBENCH_METRICS,
} from './coordinates';
import { measureWorkbenchModel } from './workbenchGeometry';
import type { LabTransform, WorldPointM } from './types';

function close(actual: readonly number[], expected: readonly number[], precision = 6) {
  actual.forEach((number, index) => expect(number).toBeCloseTo(expected[index], precision));
}

describe('calibrated workbench geometry', () => {
  it.each(['low', 'balanced', 'high'] as const)('%s geometry keeps floor pivot, exact bounds and the agreed socket plane', (quality) => {
    const measured = measureWorkbenchModel(quality);
    close(measured.boundsM.minM, [-1.2, 0, -0.525]);
    close(measured.boundsM.maxM, [1.2, 0.9, 0.525]);
    const surface = createWorkbenchSurface({ id: 'bench', transform: IDENTITY_LAB_TRANSFORM });
    expect(measured.tabletopHeightM).toBeCloseTo(surface.transform.positionM[1], 6);
    expect(measured.triangles).toBeLessThan(4000);
  });

  it('measures actual geometry budgets for the integration report', () => {
    const measurements = (['low', 'balanced', 'high'] as const).map((quality) => ({ quality, ...measureWorkbenchModel(quality) }));
    expect(measurements[0].triangles).toBeLessThan(measurements[1].triangles);
    expect(measurements[1].triangles).toBeLessThan(measurements[2].triangles);
    console.info('Workbench CPU geometry measurements:', JSON.stringify(measurements));
  });
});

describe('meter placement surfaces', () => {
  const transform: LabTransform = {
    positionM: [3, 0, -2],
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).toArray(),
  };
  const surface = createWorkbenchSurface({ id: 'bench-2', stationId: 'station-2', transform });

  it('intersects translated and rotated finite tables, not their axis-aligned bounding rectangle', () => {
    const hit = intersectPlacementSurface({ originM: [3, 4, -3], direction: [0, -5, 0] }, surface);
    expect(hit?.surfaceId).toBe('bench-2:work-surface');
    close(hit!.pointM, [3, 0.9, -3]);
    expect(hit?.distanceM).toBeCloseTo(3.1);
    expect(intersectPlacementSurface({ originM: [3.6, 4, -2], direction: [0, -1, 0] }, surface)).toBeNull();
    expect(intersectPlacementSurface({ originM: [3, 0, -2], direction: [0, -1, 0] }, surface)).toBeNull();
    expect(intersectPlacementSurface({ originM: [3, 4, -2], direction: [1, 0, 0] }, surface)).toBeNull();
  });

  it('snaps in the surface local frame and rejects an inset footprint or a snapped point over an edge', () => {
    const flat = createWorkbenchSurface({ id: 'bench', transform: IDENTITY_LAB_TRANSFORM });
    const hit = intersectPlacementSurface({ originM: [0.126, 2, 0.074], direction: [0, -1, 0] }, flat, { snapM: 0.05 });
    close(hit!.localPointM, [0.15, 0, 0.05]);
    expect(intersectPlacementSurface({ originM: [1.199, 2, 0], direction: [0, -1, 0] }, flat)).toBeNull();
    expect(intersectPlacementSurface({ originM: [1.15, 2, 0], direction: [0, -1, 0] }, flat, { insetM: 0.1 })).toBeNull();
    expect(intersectPlacementSurface({ originM: [1.19, 2, 0], direction: [0, -1, 0] }, flat, { snapM: 0.25 })).toBeNull();
  });

  it('preserves tilted surface normals and round-trips local/world points without changing source transforms', () => {
    const tilted: LabTransform = {
      positionM: [-2, 0.1, 1],
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6).toArray(),
    };
    const original = JSON.stringify(tilted);
    const tiltedSurface = createWorkbenchSurface({ id: 'tilted', transform: tilted });
    const point: WorldPointM = [0.21, 0, -0.15];
    const world = surfaceLocalToWorld(tiltedSurface, point);
    close(surfaceWorldToLocal(tiltedSurface, world), point);
    const normal = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...tilted.quaternion));
    const ray = {
      originM: new Vector3(...world).addScaledVector(normal, 2).toArray(),
      direction: normal.clone().negate().toArray(),
    };
    const hit = intersectPlacementSurface(ray, tiltedSurface);
    close(hit!.normal, normal.toArray());
    close(hit!.pointM, world);
    expect(JSON.stringify(tilted)).toBe(original);
  });

  it('transforms all eight bounds corners and rejects invalid meter transforms', () => {
    const bounds = transformBounds(WORKBENCH_METRICS.boundsM, transform);
    close(bounds.minM, [2.475, 0, -3.2]);
    close(bounds.maxM, [3.525, 0.9, -0.8]);
    expect(() => createWorkbenchSurface({ id: 'invalid', transform: { positionM: [NaN, 0, 0], quaternion: [0, 0, 0, 1] } })).toThrow();
    expect(() => createWorkbenchSurface({ id: 'scaled', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 2] } })).toThrow();
  });
});

describe('viewport coordinate conversion', () => {
  it.each(['perspective', 'orthographic'] as const)('unprojects and reprojects %s coordinates with a nonzero DOM offset', (mode) => {
    const rect = { left: 170, top: 90, width: 960, height: 540 };
    const camera = mode === 'perspective'
      ? new PerspectiveCamera(42, rect.width / rect.height, 0.005, 150)
      : new OrthographicCamera(-2, 2, 1.125, -1.125, 0.005, 150);
    camera.position.set(0, 4, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0.9, 0);
    camera.updateProjectionMatrix();
    const x = rect.left + rect.width * 0.57;
    const y = rect.top + rect.height * 0.46;
    const ray = rayFromViewport(camera, x, y, rect)!;
    const hit = intersectPlacementSurface(ray, createWorkbenchSurface({ id: 'bench', transform: IDENTITY_LAB_TRANSFORM }))!;
    const projected = projectWorldPoint(camera, hit.pointM, rect);
    expect(projected.clientX).toBeCloseTo(x, 6);
    expect(projected.clientY).toBeCloseTo(y, 6);
    expect(projected.visible).toBe(true);
    expect(rayFromViewport(camera, x, y, { ...rect, width: 0 })).toBeNull();
  });
});

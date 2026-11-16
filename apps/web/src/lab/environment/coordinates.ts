import { Matrix4, Quaternion, Ray, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import type {
  LabBoundsM, LabTransform, PlacementHit, PlacementSurface, ProjectedPoint,
  ViewportRect, WorldPointM, WorldRayM,
} from './types';

export const LAB_UNITS = 'm' as const;
export const IDENTITY_LAB_TRANSFORM: LabTransform = Object.freeze({
  positionM: [0, 0, 0] as const,
  quaternion: [0, 0, 0, 1] as const,
});
export const WORKBENCH_METRICS = Object.freeze({
  widthM: 2.4,
  depthM: 1.05,
  tabletopHeightM: 0.9,
  slabThicknessM: 0.055,
  edgeInsetM: 0.01,
  basePivotM: [0, 0, 0] as WorldPointM,
  boundsM: {
    minM: [-1.2, 0, -0.525] as WorldPointM,
    maxM: [1.2, 0.9, 0.525] as WorldPointM,
  },
  socketId: 'work-surface',
});

export function assertPointM(value: readonly number[], name = 'point'): asserts value is WorldPointM {
  if (value.length !== 3 || value.some((n) => !Number.isFinite(n) || Math.abs(n) > 10_000)) {
    throw new RangeError(`${name} must contain three finite meter values within the lab coordinate limit.`);
  }
}

export function assertBoundsM(bounds: LabBoundsM): void {
  assertPointM(bounds.minM, 'bounds.minM');
  assertPointM(bounds.maxM, 'bounds.maxM');
  if (bounds.minM.some((n, axis) => n > bounds.maxM[axis])) {
    throw new RangeError('Bounds minima cannot exceed maxima.');
  }
}

export function transformMatrix(transform: LabTransform): Matrix4 {
  assertPointM(transform.positionM);
  const q = transform.quaternion;
  if (q.length !== 4 || q.some((n) => !Number.isFinite(n)) ||
      Math.abs(q.reduce((sum, n) => sum + n * n, 0) - 1) > 1e-4) {
    throw new RangeError('Lab transforms require a normalized quaternion and no scale.');
  }
  return new Matrix4().compose(
    new Vector3(...transform.positionM),
    new Quaternion(...q).normalize(),
    new Vector3(1, 1, 1),
  );
}

export function boundsCenter(bounds: LabBoundsM): WorldPointM {
  assertBoundsM(bounds);
  return [
    (bounds.minM[0] + bounds.maxM[0]) / 2,
    (bounds.minM[1] + bounds.maxM[1]) / 2,
    (bounds.minM[2] + bounds.maxM[2]) / 2,
  ];
}

export function transformBounds(bounds: LabBoundsM, transform: LabTransform): LabBoundsM {
  assertBoundsM(bounds);
  const matrix = transformMatrix(transform);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const corner = new Vector3();
  for (const x of [bounds.minM[0], bounds.maxM[0]]) {
    for (const y of [bounds.minM[1], bounds.maxM[1]]) {
      for (const z of [bounds.minM[2], bounds.maxM[2]]) {
        corner.set(x, y, z).applyMatrix4(matrix);
        min.min(corner);
        max.max(corner);
      }
    }
  }
  return { minM: min.toArray(), maxM: max.toArray() };
}

export function createWorkbenchSurface(options: {
  id: string;
  stationId?: string;
  transform: LabTransform;
}): PlacementSurface {
  const matrix = transformMatrix(options.transform);
  const position = new Vector3(0, WORKBENCH_METRICS.tabletopHeightM, 0).applyMatrix4(matrix);
  return {
    id: `${options.id}:${WORKBENCH_METRICS.socketId}`,
    instanceId: options.id,
    stationId: options.stationId,
    kind: 'tabletop',
    transform: { positionM: position.toArray(), quaternion: [...options.transform.quaternion] },
    sizeM: [WORKBENCH_METRICS.widthM, WORKBENCH_METRICS.depthM],
    edgeInsetM: WORKBENCH_METRICS.edgeInsetM,
  };
}

export function createFloorSurface(widthM: number, depthM: number): PlacementSurface {
  if (![widthM, depthM].every((n) => Number.isFinite(n) && n > 0 && n <= 1000)) {
    throw new RangeError('Floor dimensions must be positive finite meters, at most 1000 m.');
  }
  return { id: 'lab-floor', kind: 'floor', transform: IDENTITY_LAB_TRANSFORM, sizeM: [widthM, depthM] };
}

export function surfaceLocalToWorld(surface: PlacementSurface, pointM: WorldPointM): WorldPointM {
  assertPointM(pointM);
  return new Vector3(...pointM).applyMatrix4(transformMatrix(surface.transform)).toArray();
}

export function surfaceWorldToLocal(surface: PlacementSurface, pointM: WorldPointM): WorldPointM {
  assertPointM(pointM);
  return new Vector3(...pointM).applyMatrix4(transformMatrix(surface.transform).invert()).toArray();
}

/** Returns null outside the finite tabletop, behind the ray, or parallel to its plane. */
export function intersectPlacementSurface(
  ray: WorldRayM,
  surface: PlacementSurface,
  options: { snapM?: number; insetM?: number; doubleSided?: boolean } = {},
): PlacementHit | null {
  assertPointM(ray.originM);
  assertPointM(ray.direction, 'ray direction');
  const { snapM = 0, insetM = 0, doubleSided = false } = options;
  const edgeInsetM = surface.edgeInsetM ?? 0;
  if (![snapM, insetM, edgeInsetM].every((n) => Number.isFinite(n) && n >= 0) ||
      !surface.sizeM.every((n) => Number.isFinite(n) && n > 0)) {
    throw new RangeError('Surface size, snap and inset must be finite nonnegative meters.');
  }
  const matrix = transformMatrix(surface.transform);
  const worldDirection = new Vector3(...ray.direction);
  if (worldDirection.lengthSq() < 1e-12) return null;
  const localRay = new Ray(new Vector3(...ray.originM), worldDirection.normalize())
    .applyMatrix4(matrix.clone().invert());
  if (Math.abs(localRay.direction.y) < 1e-8 || (!doubleSided && localRay.direction.y >= 0)) return null;
  const distance = -localRay.origin.y / localRay.direction.y;
  if (distance < 0) return null;
  const point = localRay.at(distance, new Vector3());
  const halfX = surface.sizeM[0] / 2 - insetM - edgeInsetM;
  const halfZ = surface.sizeM[1] / 2 - insetM - edgeInsetM;
  if (halfX < 0 || halfZ < 0 || Math.abs(point.x) > halfX + 1e-8 || Math.abs(point.z) > halfZ + 1e-8) return null;
  if (snapM > 0) {
    point.x = Math.round(point.x / snapM) * snapM;
    point.z = Math.round(point.z / snapM) * snapM;
  }
  if (Math.abs(point.x) > halfX + 1e-8 || Math.abs(point.z) > halfZ + 1e-8) return null;
  point.y = 0;
  const localPointM = point.toArray();
  const worldPoint = point.applyMatrix4(matrix);
  return {
    surfaceId: surface.id,
    localPointM,
    pointM: worldPoint.toArray(),
    normal: new Vector3(0, 1, 0).transformDirection(matrix).toArray(),
    distanceM: distance,
  };
}

export function rayFromViewport(
  camera: Camera, clientX: number, clientY: number, rect: ViewportRect,
): WorldRayM | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0) return null;
  const pointer = new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  camera.updateMatrixWorld();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(pointer, camera);
  return { originM: raycaster.ray.origin.toArray(), direction: raycaster.ray.direction.toArray() };
}

export function projectWorldPoint(
  camera: Camera, pointM: WorldPointM, rect: ViewportRect,
): ProjectedPoint {
  assertPointM(pointM);
  camera.updateMatrixWorld();
  const point = new Vector3(...pointM).project(camera);
  return {
    clientX: rect.left + ((point.x + 1) * rect.width) / 2,
    clientY: rect.top + ((1 - point.y) * rect.height) / 2,
    visible: Number.isFinite(point.x) && Number.isFinite(point.y) &&
      Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1,
  };
}

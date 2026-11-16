import {
  Box3, BufferAttribute, BufferGeometry, DynamicDrawUsage, Sphere, Vector3,
} from 'three';
import type { VesselCalibration } from '@matterlab/contracts';
import { checkVesselCalibration, profileRadiusM } from './calibration';
import type { CalibratedFill } from './calibration';
import type { FluidScope, ResolvedFluidSettings, StirringState } from './types';

export const LIQUID_WALL_INSET_M = 0.000005;

export interface SurfaceMotion {
  readonly amplitudeM: number;
  readonly phaseRad: number;
}

export function boundedSurfaceMotion(
  fill: CalibratedFill, maxFillHeightM: number, scope: FluidScope, stirring: StirringState,
  settings: ResolvedFluidSettings, visualTimeS = scope.simulationTimeS,
): SurfaceMotion {
  if (fill.status !== 'READY' || scope.status !== 'RUNNING' || !stirring?.enabled ||
      !Number.isFinite(stirring.frequencyHz) || stirring.frequencyHz <= 0 ||
      !Number.isFinite(visualTimeS) || settings.motionUpdatesPerS === 0) {
    return { amplitudeM: 0, phaseRad: 0 };
  }
  return {
    amplitudeM: Math.max(0, Math.min(
      settings.maxSurfaceAmplitudeM,
      (fill.referenceHeightM - fill.bottomHeightM) * 0.04,
      (maxFillHeightM - Math.max(fill.edgeHeightM, fill.referenceHeightM)) * 0.2,
      fill.radiusM * 0.03,
    )),
    phaseRad: (visualTimeS * Math.min(1.5, stirring.frequencyHz) * Math.PI * 2) % (Math.PI * 2),
  };
}

/** Zero at the reading point/contact line and zero angular mean on every concentric ring. */
export function surfaceWaveM(radiusFraction: number, theta: number, motion: SurfaceMotion): number {
  const u = radiusFraction;
  return motion.amplitudeM * 16 * u * u * (1 - u) * (1 - u) * Math.sin(2 * theta - motion.phaseRad);
}

export interface LiquidGeometryResource {
  readonly geometry: BufferGeometry;
  readonly vertexCount: number;
  readonly triangleCount: number;
  update(fill: CalibratedFill, motion?: SurfaceMotion): void;
  dispose(): void;
}

/** A single closed, indexed body/surface mesh, without an invisible full-vessel liquid shell. */
export function createLiquidGeometry(
  calibration: VesselCalibration, settings: ResolvedFluidSettings,
): LiquidGeometryResource {
  const checked = checkVesselCalibration(calibration);
  if (!checked.supported) throw new RangeError(checked.reason);
  const segments = settings.angularSegments;
  const rings = settings.surfaceRings;
  const bottomM = calibration.volumeHeightCurve[0]!.heightM;
  const topM = calibration.maxFillHeightM;
  const sideHeights = [
    bottomM,
    ...calibration.interiorProfile.filter((point) => point.yM > bottomM && point.yM < topM).map((point) => point.yM),
    topM,
  ];
  const sideVertices = sideHeights.length * segments;
  const bottomCenter = sideVertices;
  const bottomRing = bottomCenter + 1;
  const surfaceCenter = bottomRing + segments;
  const surfaceStart = surfaceCenter + 1;
  const vertexCount = surfaceStart + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  for (let ring = 0; ring < sideHeights.length - 1; ring++) {
    for (let j = 0; j < segments; j++) {
      const next = (j + 1) % segments;
      const a = ring * segments + j;
      const b = a + segments;
      const c = ring * segments + next;
      const d = c + segments;
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let j = 0; j < segments; j++) {
    const next = (j + 1) % segments;
    indices.push(bottomCenter, bottomRing + j, bottomRing + next);
    indices.push(surfaceCenter, surfaceStart + next, surfaceStart + j);
  }
  for (let ring = 0; ring < rings - 1; ring++) {
    for (let j = 0; j < segments; j++) {
      const next = (j + 1) % segments;
      const a = surfaceStart + ring * segments + j;
      const b = surfaceStart + (ring + 1) * segments + j;
      const c = surfaceStart + ring * segments + next;
      const d = surfaceStart + (ring + 1) * segments + next;
      indices.push(a, d, b, a, c, d);
    }
  }
  const geometry = new BufferGeometry();
  const position = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setIndex(indices);
  const radiusM = Math.max(...calibration.interiorProfile.map((point) => point.radiusM));
  geometry.boundingBox = new Box3(new Vector3(-radiusM, bottomM, -radiusM), new Vector3(radiusM, topM, radiusM));
  geometry.boundingSphere = new Sphere(new Vector3(0, (bottomM + topM) / 2, 0), Math.hypot(radiusM, (topM - bottomM) / 2));
  geometry.userData = { units: 'm', evidence: 'ILLUSTRATIVE', wallInsetM: LIQUID_WALL_INSET_M, vertexCount };
  const cos = Array.from({ length: segments }, (_, j) => Math.cos(j / segments * Math.PI * 2));
  const sin = Array.from({ length: segments }, (_, j) => Math.sin(j / segments * Math.PI * 2));
  const insetRadius = (heightM: number) => {
    const radius = profileRadiusM(calibration.interiorProfile, heightM);
    return radius - Math.min(LIQUID_WALL_INSET_M, radius * 0.002);
  };
  const setVertex = (index: number, radius: number, heightM: number, angleIndex: number) => {
    position.setXYZ(index, radius * cos[angleIndex]!, heightM, radius * sin[angleIndex]!);
  };
  let disposed = false;
  return {
    geometry, vertexCount, triangleCount: indices.length / 3,
    update(fill, motion = { amplitudeM: 0, phaseRad: 0 }) {
      if (disposed) return;
      if (fill.status === 'UNSUPPORTED') throw new RangeError('Unsupported fills must be hidden, not drawn.');
      for (let ring = 0; ring < sideHeights.length; ring++) {
        const heightM = Math.min(sideHeights[ring]!, fill.edgeHeightM);
        const radius = insetRadius(heightM);
        for (let j = 0; j < segments; j++) setVertex(ring * segments + j, radius, heightM, j);
      }
      position.setXYZ(bottomCenter, 0, bottomM, 0);
      for (let j = 0; j < segments; j++) setVertex(bottomRing + j, insetRadius(bottomM), bottomM, j);
      position.setXYZ(surfaceCenter, 0, fill.referenceHeightM, 0);
      const edgeRadius = insetRadius(fill.edgeHeightM);
      for (let ring = 1; ring <= rings; ring++) {
        const u = ring / rings;
        for (let j = 0; j < segments; j++) {
          const theta = j / segments * Math.PI * 2;
          const heightM = fill.referenceHeightM + (fill.edgeHeightM - fill.referenceHeightM) * u ** 4 +
            surfaceWaveM(u, theta, motion);
          const radius = Math.min(u * edgeRadius, insetRadius(heightM));
          setVertex(surfaceStart + (ring - 1) * segments + j, radius, heightM, j);
        }
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
    },
  };
}

import { Vector3 } from 'three';
import type {
  ApparatusDefinition, ApparatusDefinitionReader, ApparatusInstance, ExperimentScene, Transform, Vec3M,
} from '@matterlab/contracts/lab';
import type { PlacementSurface, WorldRayM } from '../environment/types';
import { intersectPlacementSurface, surfaceWorldToLocal } from '../environment/coordinates';
import { boundsCorners, matrixOf, orientedBounds, transformOf, worldBounds } from './geometry';
import type { ApparatusSpatialIndex } from './geometry';
import { mechanicallyRelated, validateSocketConnection } from './sockets';
import type { ConnectionValidator, PlacementCheck } from './types';

function eligibleSurface(definition: ApparatusDefinition, instance: ApparatusInstance, surface: PlacementSurface): boolean {
  const floorStanding = definition.kind === 'BENCH' || definition.tags?.includes('floor-standing');
  return surface.instanceId !== instance.id &&
    (surface.stationId === undefined || surface.stationId === instance.stationId) &&
    (floorStanding ? surface.kind === 'floor' : surface.kind === 'tabletop');
}
export function isSupportedBySurface(
  definition: ApparatusDefinition, instance: ApparatusInstance, surface: PlacementSurface,
): boolean {
  if (!eligibleSurface(definition, instance, surface)) return false;
  const local = boundsCorners(definition.boundsM, instance.transform).map((point) => surfaceWorldToLocal(surface, point));
  const inset = surface.edgeInsetM ?? 0;
  return Math.abs(Math.min(...local.map((point) => point[1]))) <= 0.002 &&
    local.every((point) => Math.abs(point[0]) <= surface.sizeM[0] / 2 - inset + 1e-7 &&
      Math.abs(point[2]) <= surface.sizeM[1] / 2 - inset + 1e-7);
}
export function transformOnSurface(
  definition: ApparatusDefinition, surface: PlacementSurface, pointM: Vec3M,
  quaternion: Transform['quaternion'] = surface.transform.quaternion,
): Transform {
  const rotation: Transform = { positionM: [0, 0, 0], quaternion };
  const normal = new Vector3(0, 1, 0).transformDirection(matrixOf(surface.transform));
  const minimum = Math.min(...boundsCorners(definition.boundsM, rotation).map((corner) => new Vector3(...corner).dot(normal)));
  return { positionM: new Vector3(...pointM).addScaledVector(normal, -minimum).toArray(), quaternion };
}
export function placementFromRay(
  definition: ApparatusDefinition, instance: ApparatusInstance, ray: WorldRayM,
  surfaces: readonly PlacementSurface[], snapM: number,
): { transform: Transform; surface: PlacementSurface } | null {
  const hits = surfaces.filter((surface) => eligibleSurface(definition, instance, surface)).flatMap((surface) => {
    const hit = intersectPlacementSurface(ray, surface, { snapM });
    return hit ? [{ hit, surface }] : [];
  }).sort((a, b) => a.hit.distanceM - b.hit.distanceM);
  const nearest = hits[0];
  return nearest ? { surface: nearest.surface, transform: transformOnSurface(definition, nearest.surface, nearest.hit.pointM) } : null;
}
export function checkPlacement(options: {
  readonly scene: ExperimentScene;
  readonly definitions: ApparatusDefinitionReader;
  readonly instance: ApparatusInstance;
  readonly surfaces: readonly PlacementSurface[];
  readonly index?: ApparatusSpatialIndex;
  readonly ignoreIds?: readonly string[];
  readonly connectionValidator?: ConnectionValidator;
}): PlacementCheck {
  const { scene, definitions, instance, surfaces, index, ignoreIds = [] } = options;
  const definition = definitions.getDefinition(instance.definitionId);
  if (!definition) return { valid: false, reasons: ['Unknown apparatus definition.'], warnings: [], collidingIds: [] };
  const reasons: string[] = [];
  const warnings: string[] = [];
  let surfaceId: string | undefined;
  const parent = scene.connections.find((edge) => edge.enabled && edge.kind === 'MECHANICAL' && edge.to.instanceId === instance.id);
  if (parent) {
    reasons.push(...validateSocketConnection(scene, definitions, parent, { ignoreConnectionId: parent.id, validator: options.connectionValidator }));
  } else if (definition.tags?.includes('requires-mount')) {
    reasons.push(`${definition.label} requires a compatible mechanical mount; choose a highlighted socket.`);
  } else {
    for (const surface of surfaces.filter((item) => eligibleSurface(definition, instance, item))) {
      if (!isSupportedBySurface(definition, instance, surface)) continue;
      surfaceId = surface.id;
      if (surface.instanceId) {
        const support = scene.apparatus.find((item) => item.id === surface.instanceId);
        const supportDefinition = support && definitions.getDefinition(support.definitionId);
        if (support && supportDefinition?.maxSupportedMassKg !== undefined) {
          const supported = scene.apparatus.filter((item) => item.id !== instance.id && item.id !== support.id &&
            item.stationId === instance.stationId && !!definitions.getDefinition(item.definitionId) &&
            Math.abs(worldBounds(definitions.getDefinition(item.definitionId)!, item.transform).minM[1] - surface.transform.positionM[1]) < 0.003);
          const loadKg = (definition.massKg ?? 0) + supported.reduce((sum, item) => sum + (definitions.getDefinition(item.definitionId)?.massKg ?? 0), 0);
          if (loadKg > supportDefinition.maxSupportedMassKg) reasons.push('The supporting surface exceeds its declared apparatus mass capacity.');
        }
      }
      break;
    }
    if (!surfaceId) reasons.push('Place the complete footprint on a supported surface, inside its safe edges. Floating placement is not supported.');
  }
  if (definition.capacityL !== undefined) {
    const volumeL = scene.containerStates[instance.id]?.volumeL ?? 0;
    if (volumeL > definition.capacityL + 1e-12) reasons.push('Container contents exceed the declared capacity.');
    if (volumeL > 0.9 * definition.capacityL) warnings.push('This vessel is above 90% of its declared liquid capacity.');
  }
  const bounds = worldBounds(definition, instance.transform);
  const candidates = index ? new Set(index.query(bounds)) : null;
  const collidingIds: string[] = [];
  for (const other of scene.apparatus) {
    if (other.id === instance.id || ignoreIds.includes(other.id) ||
        (candidates && !candidates.has(other.id)) || mechanicallyRelated(scene, instance.id, other.id)) continue;
    const otherDefinition = definitions.getDefinition(other.definitionId);
    if (otherDefinition && orientedBounds(definition, instance.transform).intersectsOBB(orientedBounds(otherDefinition, other.transform), 1e-8)) {
      collidingIds.push(other.id);
      reasons.push(`Placement overlaps ${otherDefinition.label}.`);
    }
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], warnings, surfaceId, collidingIds };
}
export function transformSubtree(
  instances: readonly ApparatusInstance[], previousRoot: Transform, nextRoot: Transform,
): readonly ApparatusInstance[] {
  const delta = matrixOf(nextRoot).multiply(matrixOf(previousRoot).invert());
  return instances.map((instance) => ({
    ...instance, transform: transformOf(delta.clone().multiply(matrixOf(instance.transform))),
  }));
}

import { Raycaster, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { WorldRayM } from '../environment/types';
import type { ApparatusSpatialIndex } from './geometry';
import type { ApparatusPick } from './pointerControls';

export function createApparatusPicker(
  index: ApparatusSpatialIndex, objects: () => ReadonlyMap<string, Object3D>,
): (ray: WorldRayM, excludedId?: string) => ApparatusPick | null {
  const raycaster = new Raycaster();
  // Three's default 1-world-unit line tolerance is one meter here, not a pixel.
  raycaster.params.Line.threshold = 0.0015;
  raycaster.params.Points.threshold = 0.003;
  return (ray, excludedId) => {
    raycaster.ray.set(new Vector3(...ray.originM), new Vector3(...ray.direction).normalize());
    const candidates = index.raycast(ray).flatMap(({ id }) => {
      const object = objects().get(id);
      if (!object || id === excludedId) return [];
      object.updateWorldMatrix(true, true);
      return [object];
    });
    for (const hit of raycaster.intersectObjects(candidates, true)) {
      let object: Object3D | null = hit.object;
      let controlId: string | undefined;
      while (object) {
        if (typeof object.userData.labControlId === 'string') controlId = object.userData.labControlId;
        if (typeof object.userData.labEditorInstanceId === 'string') {
          return { instanceId: object.userData.labEditorInstanceId, ...(controlId ? { controlId } : {}) };
        }
        object = object.parent;
      }
    }
    return null;
  };
}

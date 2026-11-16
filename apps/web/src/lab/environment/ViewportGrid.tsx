import { useEffect, useMemo } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { useSceneQuality } from './SceneQuality';

export function createGridGeometry(widthM: number, depthM: number, stepM: number): BufferGeometry {
  if (![widthM, depthM, stepM].every((n) => Number.isFinite(n) && n > 0) ||
      widthM / stepM + depthM / stepM > 1000) throw new RangeError('Grid exceeds its bounded geometry budget.');
  const vertices: number[] = [];
  const xSteps = Math.floor(widthM / (2 * stepM));
  const zSteps = Math.floor(depthM / (2 * stepM));
  for (let x = -xSteps; x <= xSteps; x += 1) {
    vertices.push(x * stepM, 0, -depthM / 2, x * stepM, 0, depthM / 2);
  }
  for (let z = -zSteps; z <= zSteps; z += 1) {
    vertices.push(-widthM / 2, 0, z * stepM, widthM / 2, 0, z * stepM);
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(vertices, 3));
}
const noRaycast = () => undefined;

export function ViewportGrid({ widthM = 12, depthM = 10 }: { widthM?: number; depthM?: number }) {
  const quality = useSceneQuality();
  const major = useMemo(() => createGridGeometry(widthM, depthM, 1), [widthM, depthM]);
  const minor = useMemo(() => createGridGeometry(widthM, depthM, 0.1), [widthM, depthM]);
  useEffect(() => () => { major.dispose(); minor.dispose(); }, [major, minor]);
  return (
    <group name="meter-grid" position={[0, 0.003, 0]}>
      <lineSegments geometry={major} raycast={noRaycast}>
        <lineBasicMaterial color="#78a69e" transparent opacity={0.3} depthWrite={false} />
      </lineSegments>
      {quality.preset !== 'low' && (
        <lineSegments geometry={minor} raycast={noRaycast}>
          <lineBasicMaterial color="#78a69e" transparent opacity={0.065} depthWrite={false} />
        </lineSegments>
      )}
    </group>
  );
}

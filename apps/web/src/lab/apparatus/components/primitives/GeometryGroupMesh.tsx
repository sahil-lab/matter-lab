/**
 * Renders one procedural `GeometryGroup` as a mesh with its resolved provisional material. The
 * geometry is owned by the caller (`ApparatusMesh` builds and disposes it); this component only
 * turns it, plus its declared local `transform`, into JSX.
 */
import { useMemo } from 'react';
import type { BufferGeometry } from 'three';
import type { GeometryGroup } from '../../geometry';
import { materialSpecForSlot } from './materials';

export interface GeometryGroupMeshProps {
  readonly group: GeometryGroup;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  /** Extra rotation (radians) about the group's own local Y axis, layered on top of its base
   * transform — how `ApparatusMesh`'s `partSpin` drives a stopcock key or a stirrer knob. */
  readonly extraSpinRad?: number;
}

function toArray3(v: readonly [number, number, number] | undefined): [number, number, number] {
  return v ? [v[0], v[1], v[2]] : [0, 0, 0];
}
function toArray4(v: readonly [number, number, number, number] | undefined): [number, number, number, number] {
  return v ? [v[0], v[1], v[2], v[3]] : [0, 0, 0, 1];
}

export function GeometryGroupMesh({ group, castShadow = true, receiveShadow = true, extraSpinRad = 0 }: GeometryGroupMeshProps) {
  // A glTF-sourced group carries its own authored material (see `geometry/gltfLoader.ts`), which
  // always takes precedence over the provisional, slot-based palette procedural groups resolve.
  const spec = useMemo(() => (group.material ? null : materialSpecForSlot(group.materialSlot)), [group.material, group.materialSlot]);
  const position = toArray3(group.transform?.positionM);
  const quaternion = toArray4(group.transform?.quaternion);

  return (
    <group position={position} quaternion={quaternion}>
      {/* A separate inner group for the extra spin: three.js keeps one Object3D's `rotation` and
       * `quaternion` in sync with each other, so applying both the base orientation (above) and an
       * additional spin to the *same* object would have the second simply overwrite the first. */}
      <group rotation-y={extraSpinRad}>
        <mesh geometry={group.geometry as BufferGeometry} material={group.material} castShadow={castShadow} receiveShadow={receiveShadow}>
          {!group.material && (spec!.kind === 'physical' ? <meshPhysicalMaterial {...spec!.props} /> : <meshStandardMaterial {...spec!.props} />)}
        </mesh>
      </group>
    </group>
  );
}

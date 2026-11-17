/**
 * The translucent preview shown while placing from the palette or dragging an existing instance —
 * brief item 1 ("placement previews, surface snapping and collision/capacity warnings before
 * commit"). Colour alone carries the state (green = will snap and attach, amber = floating/
 * unsupported, red = collides or was rejected); Agent 01's real HUD is expected to add text and
 * icons alongside this.
 */
import { useMemo } from 'react';
import { getApparatusDefinition } from '../../apparatus/catalog';
import { useLabEditor } from '../editorStore';

function previewColor(supported: boolean, collides: boolean, snapInvalid: boolean): string {
  if (collides || snapInvalid) return '#e2555a';
  if (!supported) return '#ffb66b';
  return '#55e2d1';
}

export function PlacementGhost(): React.JSX.Element | null {
  const preview = useLabEditor((s) => s.placementPreview);
  const definition = useMemo(() => (preview ? getApparatusDefinition(preview.definitionId) : undefined), [preview]);

  if (!preview || !definition) return null;
  const [w, h, d] = definition.dimensionsM;
  const [cx, cy, cz] = definition.footprintCenter;
  const color = previewColor(preview.supported, preview.collisions.length > 0, preview.snap.status === 'invalid');

  return (
    <group position={preview.transform.positionM as unknown as [number, number, number]} quaternion={preview.transform.quaternion as unknown as [number, number, number, number]}>
      <mesh position={[cx, cy, cz]}>
        {definition.placeholderGeometry === 'cylinder' ? <cylinderGeometry args={[w / 2, w / 2, h, 20]} /> : <boxGeometry args={[w, h, d]} />}
        <meshStandardMaterial color={color} transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </group>
  );
}

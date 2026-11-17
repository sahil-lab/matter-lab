/**
 * Renders one placed apparatus instance as Agent 03's procedural placeholder geometry
 * (`placeholderGeometry: 'box' | 'cylinder'`), coloured by selection/hover/lock state, and
 * registers a small control hotspot for `FLOW_SOURCE` apparatus (the burette stopcock) so
 * `GestureController` can tell "operate the valve" apart from "move the instrument". This is
 * explicitly a stand-in renderer — Agent 03 owns the real glTF assets and Agent 05 owns fluid/glass
 * material; nothing here is meant to ship as the final look.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { Mesh } from 'three';
import { getApparatusDefinition } from '../../apparatus/catalog';
import type { ApparatusInstance } from '../contracts';
import { labEditor, liveTransformFor, setHovered, useLabEditor } from '../editorStore';
import type { GestureController } from '../GestureController';

const SELECTED_COLOR = '#55e2d1';
const HOVER_COLOR = '#9fb3c8';
const LOCKED_COLOR = '#c98a3a';
const DEFAULT_COLOR = '#6b7c93';

export interface ApparatusMeshProps {
  readonly instance: ApparatusInstance;
  readonly gestures: GestureController;
}

export function ApparatusMesh({ instance, gestures }: ApparatusMeshProps): React.JSX.Element | null {
  const transform = useLabEditor((s) => liveTransformFor(s, instance.id)) ?? instance.transform;
  const selected = useLabEditor((s) => s.selection.has(instance.id));
  const hovered = useLabEditor((s) => s.hoveredInstanceId === instance.id);
  const locked = useLabEditor((s) => s.scene.locked.has(instance.id));
  const valveRef = useRef<Mesh>(null);

  const definition = useMemo(() => getApparatusDefinition(instance.definitionId), [instance.definitionId]);
  const hasValve = definition?.controls.some((c) => c.actionType === 'SET_VALVE') ?? false;

  useEffect(() => {
    const mesh = valveRef.current;
    if (!mesh || !hasValve) return;
    return gestures.registerControlHotspot(mesh, { instanceId: instance.id, controlId: 'valve', pixelsForFullRange: 120 });
  }, [gestures, hasValve, instance.id]);

  if (!definition) return null;
  const [w, h, d] = definition.dimensionsM;
  const [cx, cy, cz] = definition.footprintCenter;
  const color = locked ? LOCKED_COLOR : selected ? SELECTED_COLOR : hovered ? HOVER_COLOR : DEFAULT_COLOR;

  return (
    <group
      position={transform.positionM as unknown as [number, number, number]}
      quaternion={transform.quaternion as unknown as [number, number, number, number]}
      userData={{ instanceId: instance.id }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(instance.id);
      }}
      onPointerOut={() => {
        if (labEditor.get().hoveredInstanceId === instance.id) setHovered(null);
      }}
    >
      <mesh position={[cx, cy, cz]} castShadow receiveShadow>
        {definition.placeholderGeometry === 'cylinder' ? <cylinderGeometry args={[w / 2, w / 2, h, 20]} /> : <boxGeometry args={[w, h, d]} />}
        <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} transparent opacity={definition.capabilities.includes('CONTAINER') ? 0.55 : 1} />
      </mesh>
      {hasValve && (
        <mesh ref={valveRef} position={[0, cy - h / 2 + 0.01, w / 2 + 0.02]}>
          <sphereGeometry args={[0.018, 12, 12]} />
          <meshStandardMaterial color="#ffb66b" emissive="#ffb66b" emissiveIntensity={0.3} />
        </mesh>
      )}
    </group>
  );
}

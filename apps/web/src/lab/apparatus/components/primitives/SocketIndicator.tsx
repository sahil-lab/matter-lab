/**
 * A ring highlight at one socket's local transform — the hover/valid/invalid affordance the brief
 * asks for ("valid/invalid socket feedback"). This module only draws it; Agent 04 owns deciding
 * *which* status applies during an actual drag gesture.
 */
import { useMemo } from 'react';
import { DoubleSide, RingGeometry } from 'three';
import type { SocketDefinition } from '../../types';

export type SocketIndicatorStatus = 'idle' | 'hover' | 'valid' | 'invalid';

const STATUS_COLOR: Readonly<Record<SocketIndicatorStatus, string>> = {
  idle: '#8fa3c8',
  hover: '#ffd966',
  valid: '#4ade80',
  invalid: '#f87171',
};

const STATUS_OPACITY: Readonly<Record<SocketIndicatorStatus, number>> = {
  idle: 0.28,
  hover: 0.65,
  valid: 0.85,
  invalid: 0.85,
};

export interface SocketIndicatorProps {
  readonly socket: SocketDefinition;
  readonly status?: SocketIndicatorStatus;
}

function toArray3(v: readonly [number, number, number]): [number, number, number] {
  return [v[0], v[1], v[2]];
}
function toArray4(v: readonly [number, number, number, number]): [number, number, number, number] {
  return [v[0], v[1], v[2], v[3]];
}

export function SocketIndicator({ socket, status = 'idle' }: SocketIndicatorProps) {
  const radius = socket.highlightRadiusM;
  // A flat ring: its own local +Z (the mating axis, see `uprightSocketTransform`) is the ring's
  // normal, so it lies flat on a surface socket and stands as a collar on an axial/coincident one.
  const geometry = useMemo(() => new RingGeometry(radius * 0.72, radius, 32), [radius]);

  return (
    <group position={toArray3(socket.transform.positionM)} quaternion={toArray4(socket.transform.quaternion)}>
      <mesh geometry={geometry} renderOrder={10}>
        <meshBasicMaterial color={STATUS_COLOR[status]} transparent opacity={STATUS_OPACITY[status]} side={DoubleSide} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

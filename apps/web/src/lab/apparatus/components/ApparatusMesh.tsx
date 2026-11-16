/**
 * The generic, data-driven renderer for any registered `ApparatusDefinition`: given a definition,
 * it resolves the matching procedural geometry builder, renders each group through
 * `GeometryGroupMesh`, and optionally overlays socket highlight rings. No per-apparatus-kind
 * switch statement lives here — a new plugin definition with its own `proceduralBuilderId` (or,
 * in the future, a `gltfUri`) renders through this same component without editor changes (brief
 * point 6).
 */
import { useEffect, useMemo } from 'react';
import type { BufferGeometry } from 'three';
import { BoxGeometry, EdgesGeometry } from 'three';
import { resolveProceduralBuilder } from '../geometry';
import type { ApparatusDefinition, Transform } from '../types';
import { GeometryGroupMesh } from './primitives/GeometryGroupMesh';
import type { SocketIndicatorStatus } from './primitives/SocketIndicator';
import { SocketIndicator } from './primitives/SocketIndicator';

export interface ApparatusMeshProps {
  readonly definition: ApparatusDefinition;
  /** World (or parent-relative) pose for the whole apparatus. Defaults to the origin. */
  readonly transform?: Transform;
  /** Extra spin (radians, about each named group's own local Y) keyed by `materialSlot` — how a
   * caller visualizes a control's current value (e.g. `{ 'stopcock-key': valveAngleRad }`) without
   * this module ever reading or writing that value itself. */
  readonly partSpin?: Readonly<Record<string, number>>;
  readonly showSockets?: boolean;
  /** Per-socket-id status for the optional highlight rings; defaults every socket to 'idle'. */
  readonly socketStatus?: (socketId: string) => SocketIndicatorStatus;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

function toArray3(v: readonly [number, number, number]): [number, number, number] {
  return [v[0], v[1], v[2]];
}
function toArray4(v: readonly [number, number, number, number]): [number, number, number, number] {
  return [v[0], v[1], v[2], v[3]];
}

const IDENTITY: Transform = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] };

/** A bright, unmissable wireframe box stand-in for a definition this version of the renderer
 * cannot build yet (an unregistered `proceduralBuilderId`, or a future `gltfUri` asset — no glTF
 * loader is wired up in this revision). Brief point 7: visibly marked as incomplete, not shipped. */
function MissingAssetPlaceholder({ dimensionsM }: { dimensionsM: ApparatusDefinition['dimensionsM'] }) {
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(dimensionsM.width, dimensionsM.height, dimensionsM.depth)), [dimensionsM.width, dimensionsM.height, dimensionsM.depth]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group position={[0, dimensionsM.height / 2, 0]}>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#ff2fd0" toneMapped={false} />
      </lineSegments>
    </group>
  );
}

export function ApparatusMesh({ definition, transform = IDENTITY, partSpin = {}, showSockets = false, socketStatus, castShadow, receiveShadow }: ApparatusMeshProps) {
  const builder = definition.asset.source === 'procedural' && definition.asset.proceduralBuilderId ? resolveProceduralBuilder(definition.asset.proceduralBuilderId) : undefined;

  // Rebuilt only when the resolved builder function identity changes (i.e. when the definition
  // itself changes) — every geometry here is otherwise static per apparatus type.
  const build = useMemo(() => builder?.(), [builder]);

  useEffect(() => {
    return () => {
      for (const group of build?.groups ?? []) (group.geometry as BufferGeometry).dispose();
    };
  }, [build]);

  return (
    <group position={toArray3(transform.positionM)} quaternion={toArray4(transform.quaternion)}>
      {build ? (
        build.groups.map((group, index) => <GeometryGroupMesh key={index} group={group} extraSpinRad={partSpin[group.materialSlot] ?? 0} castShadow={castShadow} receiveShadow={receiveShadow} />)
      ) : (
        <MissingAssetPlaceholder dimensionsM={definition.dimensionsM} />
      )}
      {showSockets && definition.sockets.map((socket) => <SocketIndicator key={socket.id} socket={socket} status={socketStatus?.(socket.id) ?? 'idle'} />)}
    </group>
  );
}

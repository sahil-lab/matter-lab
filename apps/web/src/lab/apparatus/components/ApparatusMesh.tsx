/**
 * The generic, data-driven renderer for any registered `ApparatusDefinition`: given a definition,
 * it resolves the matching procedural geometry builder (sharing one built copy across every
 * instance of the same definition via `geometryCache`) or loads a glTF asset, renders each group
 * through `GeometryGroupMesh`, and optionally overlays socket highlight rings. No per-apparatus-kind
 * switch statement lives here — a new plugin definition with its own `proceduralBuilderId` or a
 * `gltfUri` renders through this same component without editor changes (brief point 6).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BoxGeometry, EdgesGeometry } from 'three';
import { resolveProceduralBuilder } from '../definitions/builderRegistry';
import { loadGltfBuildResult, type GeometryBuildResult } from '../geometry';
import type { ApparatusDefinition, Transform } from '../types';
import { acquireGeometryBuild, releaseGeometryBuild } from './geometryCache';
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

interface GroupsProps {
  readonly partSpin: Readonly<Record<string, number>>;
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
}

/** A bright, unmissable wireframe box stand-in for a definition this renderer cannot build (an
 * unregistered `proceduralBuilderId`, a glTF asset that is still loading, or one that failed to
 * load). Brief point 7: visibly marked as incomplete, not shipped. */
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

function BuildResultGroups({ build, partSpin, castShadow, receiveShadow }: GroupsProps & { build: GeometryBuildResult }) {
  return (
    <>
      {build.groups.map((group, index) => (
        <GeometryGroupMesh key={index} group={group} extraSpinRad={partSpin[group.materialSlot] ?? 0} castShadow={castShadow} receiveShadow={receiveShadow} />
      ))}
    </>
  );
}

/** The `source: 'procedural'` path: builds (or reuses, via `geometryCache`) the definition's
 * geometry once per distinct `proceduralBuilderId`, releasing its reference on unmount. */
function ProceduralApparatus({ definition, partSpin, castShadow, receiveShadow }: GroupsProps & { definition: ApparatusDefinition }) {
  const id = definition.asset.proceduralBuilderId;
  const builder = id ? resolveProceduralBuilder(id) : undefined;

  const build = useMemo(() => (id && builder ? acquireGeometryBuild(id, builder) : undefined), [id, builder]);

  useEffect(() => {
    if (!id || !builder) return undefined;
    return () => releaseGeometryBuild(id);
  }, [id, builder]);

  if (!build) return <MissingAssetPlaceholder dimensionsM={definition.dimensionsM} />;
  return <BuildResultGroups build={build} partSpin={partSpin} castShadow={castShadow} receiveShadow={receiveShadow} />;
}

/** The `source: 'gltf'` path: fetches and parses `asset.gltfUri` (see `geometry/gltfLoader.ts`),
 * showing the placeholder while loading and on failure (logged, never thrown past this component).
 * No current definition uses this path — see the module README. */
function GltfApparatus({ definition, partSpin, castShadow, receiveShadow }: GroupsProps & { definition: ApparatusDefinition }) {
  const uri = definition.asset.gltfUri;
  const [build, setBuild] = useState<GeometryBuildResult | undefined>(undefined);
  // A ref (not state) for cleanup: a successful load's own groups need disposing, but we must not
  // re-run the loading effect just because `build` changed as a result of that same effect.
  const buildRef = useRef<GeometryBuildResult | undefined>(undefined);

  useEffect(() => {
    if (!uri) return undefined;
    let cancelled = false;
    setBuild(undefined);
    loadGltfBuildResult(uri)
      .then((result) => {
        if (cancelled) {
          for (const group of result.groups) group.geometry.dispose();
          return;
        }
        buildRef.current = result;
        setBuild(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn(`ApparatusMesh: failed to load glTF asset "${uri}" for "${definition.id}":`, error);
      });
    return () => {
      cancelled = true;
      // Dispose directly (not through geometryCache): each glTF load here is this component's own
      // copy, not deduplicated across instances in this revision — see the module README.
      for (const group of buildRef.current?.groups ?? []) group.geometry.dispose();
      buildRef.current = undefined;
    };
  }, [uri, definition.id]);

  if (!build) return <MissingAssetPlaceholder dimensionsM={definition.dimensionsM} />;
  return <BuildResultGroups build={build} partSpin={partSpin} castShadow={castShadow} receiveShadow={receiveShadow} />;
}

export function ApparatusMesh({ definition, transform = IDENTITY, partSpin = {}, showSockets = false, socketStatus, castShadow, receiveShadow }: ApparatusMeshProps) {
  return (
    <group position={toArray3(transform.positionM)} quaternion={toArray4(transform.quaternion)}>
      {definition.asset.source === 'gltf' && definition.asset.gltfUri ? (
        <GltfApparatus definition={definition} partSpin={partSpin} castShadow={castShadow} receiveShadow={receiveShadow} />
      ) : (
        <ProceduralApparatus definition={definition} partSpin={partSpin} castShadow={castShadow} receiveShadow={receiveShadow} />
      )}
      {showSockets && definition.sockets.map((socket) => <SocketIndicator key={socket.id} socket={socket} status={socketStatus?.(socket.id) ?? 'idle'} />)}
    </group>
  );
}

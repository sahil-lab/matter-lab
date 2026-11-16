import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Matrix4, Mesh,
  MeshBasicMaterial, Raycaster, Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { ApparatusDefinition, ApparatusInstance, SocketEndpoint } from '@matterlab/contracts/lab';
import { matrixOf, sameTransform } from './geometry';
import { useLabEditorState, useLabRuntimeSelector } from './hooks';
import type { LabEditorController } from './LabEditorController';
import { installEditorPointerControls } from './pointerControls';
import { createApparatusPicker } from './picking';
import { resolveSocket, socketCandidate } from './sockets';
import type { EditorAxis, EditorPreview } from './types';

export interface LabEditorSceneProps {
  readonly editor: LabEditorController;
  /** This renderer owns instance.transform exactly once. Children/fluids stay local. */
  readonly renderApparatus: (instance: ApparatusInstance) => ReactNode;
  readonly stationId?: string;
}
const noRaycast = () => {};
function sameLayout(a: readonly ApparatusInstance[], b: readonly ApparatusInstance[]): boolean {
  return a === b || a.length === b.length && a.every((instance, index) =>
    instance.id === b[index].id && instance.definitionId === b[index].definitionId &&
    instance.revision === b[index].revision && sameTransform(instance.transform, b[index].transform));
}
function BoundsOutline({ instance, definition, color }: {
  readonly instance: ApparatusInstance; readonly definition: ApparatusDefinition; readonly color: string;
}) {
  const center = new Vector3(...definition.boundsM.min).add(new Vector3(...definition.boundsM.max)).multiplyScalar(0.5);
  const size = new Vector3(...definition.boundsM.max).sub(new Vector3(...definition.boundsM.min)).addScalar(0.005);
  return (
    <group position={[...instance.transform.positionM]} quaternion={[...instance.transform.quaternion]}>
      <mesh position={center} raycast={noRaycast} renderOrder={90}>
        <boxGeometry args={[size.x, size.y, size.z]} />
        <meshBasicMaterial wireframe color={color} transparent opacity={0.7} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  );
}
function TransformGizmo({ instance, mode, axes, groupRef }: {
  readonly instance: ApparatusInstance; readonly mode: 'translate' | 'rotate';
  readonly axes: readonly EditorAxis[]; readonly groupRef: { current: Group | null };
}) {
  const colors = { X: '#ff997b', Y: '#b9e080', Z: '#8acbff' };
  return (
    <group ref={groupRef} position={[...instance.transform.positionM]} renderOrder={100}>
      {axes.map((axis) => {
        const position: [number, number, number] = [axis === 'X' ? 0.14 : 0, axis === 'Y' ? 0.14 : 0, axis === 'Z' ? 0.14 : 0];
        const rotation: [number, number, number] = axis === 'X' ? [0, 0, -Math.PI / 2] : axis === 'Z' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
        return mode === 'rotate' ? (
          <mesh key={axis} rotation={axis === 'X' ? [0, Math.PI / 2, 0] : axis === 'Y' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
            userData={{ labEditorAxis: axis }} renderOrder={100}>
            <torusGeometry args={[0.14, 0.008, 6, 48]} />
            <meshBasicMaterial color={colors[axis]} depthTest={false} depthWrite={false} transparent opacity={0.85} />
          </mesh>
        ) : (
          <group key={axis} position={position} rotation={rotation} userData={{ labEditorAxis: axis }}>
            <mesh renderOrder={100}>
              <cylinderGeometry args={[0.005, 0.005, 0.22, 6]} />
              <meshBasicMaterial color={colors[axis]} depthTest={false} depthWrite={false} />
            </mesh>
            <mesh position={[0, 0.13, 0]} renderOrder={100}>
              <coneGeometry args={[0.016, 0.04, 8]} />
              <meshBasicMaterial color={colors[axis]} depthTest={false} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
export function LabEditorScene({ editor, renderApparatus, stationId }: LabEditorSceneProps) {
  const state = useLabEditorState(editor);
  const apparatus = useLabRuntimeSelector(editor, (snapshot) => snapshot.scene.apparatus
    .filter((instance) => !stationId || instance.stationId === stationId), sameLayout);
  const canvas = useThree((three) => three.gl.domElement);
  const invalidate = useThree((three) => three.invalidate);
  const objects = useRef(new Map<string, Group>());
  const gizmo = useRef<Group | null>(null);
  const ghost = useRef<Mesh | null>(null);
  const lastPreview = useRef<EditorPreview | null | undefined>(undefined);
  const transformedIds = useRef(new Set<string>());
  const line = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    const result = new Line(geometry, new LineBasicMaterial({ color: '#8ee6bd', depthTest: false, transparent: true, opacity: 0.85 }));
    result.raycast = noRaycast;
    result.renderOrder = 100;
    result.visible = false;
    return result;
  }, []);
  useEffect(() => () => { line.geometry.dispose(); line.material.dispose(); }, [line]);
  useEffect(() => editor.subscribePreview(invalidate), [editor, invalidate]);
  useEffect(() => {
    const raycaster = new Raycaster();
    const pick = createApparatusPicker(editor.spatialIndex, () => objects.current);
    const pickSocket = (clientX: number, clientY: number): SocketEndpoint | null => {
      const scene = editor.getRuntimeSnapshot().scene;
      const source = editor.getSnapshot().connectionSource;
      const sourceKind = source ? resolveSocket(scene, editor.definitions, source)?.socket.kind : undefined;
      let nearest: { endpoint: SocketEndpoint; distance: number } | null = null;
      for (const instance of scene.apparatus) {
        if (instance.stationId !== editor.getSnapshot().activeStationId || !objects.current.has(instance.id)) continue;
        for (const socket of editor.definitions.getDefinition(instance.definitionId)?.sockets ?? []) {
          if (sourceKind && socket.kind !== sourceKind) continue;
          const endpoint = { instanceId: instance.id, socketId: socket.id };
          const resolved = resolveSocket(scene, editor.definitions, endpoint)!;
          const point = editor.camera.projectPoint(resolved.worldTransform.positionM);
          if (!point?.visible) continue;
          const distance = Math.hypot(point.clientX - clientX, point.clientY - clientY);
          if (distance <= 22 && (!nearest || distance < nearest.distance)) nearest = { endpoint, distance };
        }
      }
      return nearest?.endpoint ?? null;
    };
    return installEditorPointerControls(editor, canvas, {
      pick, pickSocket, invalidate,
      pickAxis: (ray) => {
        if (!gizmo.current) return null;
        gizmo.current.updateWorldMatrix(true, true);
        raycaster.ray.set(new Vector3(...ray.originM), new Vector3(...ray.direction).normalize());
        const hit = raycaster.intersectObject(gizmo.current, true)[0];
        let object: Object3D | null = hit?.object ?? null;
        while (object) {
          const axis = object.userData.labEditorAxis;
          if (axis === 'X' || axis === 'Y' || axis === 'Z') return axis;
          object = object.parent;
        }
        return null;
      },
    });
  }, [editor, canvas, invalidate, stationId]);
  useFrame(() => {
    const preview = editor.getPreview();
    if (preview === lastPreview.current) return;
    lastPreview.current = preview;
    const pending = new Map(preview?.kind === 'transform' ? preview.instances.map((instance) => [instance.id, instance]) : []);
    for (const id of new Set([...transformedIds.current, ...pending.keys()])) {
      const group = objects.current.get(id);
      const next = pending.get(id);
      const original = editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === id);
      if (!group) continue;
      group.matrixAutoUpdate = false;
      group.matrix.copy(next && original ? matrixOf(next.transform).multiply(matrixOf(original.transform).invert()) : new Matrix4());
      group.matrixWorldNeedsUpdate = true;
    }
    transformedIds.current = new Set(pending.keys());
    const selectedId = editor.getSnapshot().selectedIds[0];
    const selectedInstance = pending.get(selectedId) ?? editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === selectedId);
    if (gizmo.current && selectedInstance) gizmo.current.position.set(...selectedInstance.transform.positionM);
    if (ghost.current) {
      const instance = preview?.kind === 'placement' ? preview.instances[0] : undefined;
      const definition = instance && editor.definitions.getDefinition(instance.definitionId);
      ghost.current.visible = !!instance && !!definition;
      if (instance && definition) {
        const center = new Vector3(...definition.boundsM.min).add(new Vector3(...definition.boundsM.max)).multiplyScalar(0.5);
        const size = new Vector3(...definition.boundsM.max).sub(new Vector3(...definition.boundsM.min));
        ghost.current.matrixAutoUpdate = false;
        ghost.current.matrix.copy(matrixOf(instance.transform).multiply(new Matrix4().makeTranslation(center.x, center.y, center.z))
          .multiply(new Matrix4().makeScale(size.x, size.y, size.z)));
        ghost.current.matrixWorldNeedsUpdate = true;
        (ghost.current.material as MeshBasicMaterial).color.set(preview?.valid ? '#8ee6bd' : '#ff8a78');
      }
    }
    const candidate = preview?.socketCandidate;
    const from = candidate && resolveSocket(editor.getRuntimeSnapshot().scene, editor.definitions, candidate.connection.from);
    const to = candidate && resolveSocket(editor.getRuntimeSnapshot().scene, editor.definitions, candidate.connection.to);
    line.visible = !!from && !!to;
    if (from && to) {
      const positions = line.geometry.getAttribute('position');
      positions.setXYZ(0, ...from.worldTransform.positionM);
      positions.setXYZ(1, ...to.worldTransform.positionM);
      positions.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      line.material.color.set(preview?.valid ? '#8ee6bd' : '#ff8a78');
    }
  });
  const selected = apparatus.find((instance) => instance.id === state.selectedIds[0]);
  const selectedDefinition = selected && editor.definitions.getDefinition(selected.definitionId);
  const showSockets = state.mode === 'connect' || state.mode === 'place';
  const scene = editor.getRuntimeSnapshot().scene;
  return (
    <>
      {apparatus.map((instance) => {
        const definition = editor.definitions.getDefinition(instance.definitionId);
        return (
          <group key={instance.id} ref={(object) => {
            if (object) objects.current.set(instance.id, object); else objects.current.delete(instance.id);
          }} userData={{ labEditorInstanceId: instance.id }}>
            {renderApparatus(instance)}
            {definition && (state.selectedIds.includes(instance.id) || state.tutorialIds.includes(instance.id)) && (
              <BoundsOutline instance={instance} definition={definition}
                color={state.lockedIds.includes(instance.id) ? '#d4ac79' : state.selectedIds.includes(instance.id) ? '#a1e8cc' : '#b7a1ee'} />
            )}
          </group>
        );
      })}
      {selected && selectedDefinition && ['translate', 'rotate'].includes(state.mode) && !state.lockedIds.includes(selected.id) && (
        <TransformGizmo instance={selected} mode={state.mode as 'translate' | 'rotate'} groupRef={gizmo}
          axes={state.mode === 'rotate' ? selectedDefinition.permittedTransforms.rotation : selectedDefinition.permittedTransforms.translation} />
      )}
      {showSockets && apparatus.filter((instance) => instance.stationId === state.activeStationId).flatMap((instance) =>
        editor.definitions.getDefinition(instance.definitionId)?.sockets.map((socket) => {
          const endpoint = { instanceId: instance.id, socketId: socket.id };
          const resolved = resolveSocket(scene, editor.definitions, endpoint)!;
          const candidate = state.connectionSource ? socketCandidate(scene, editor.definitions, state.connectionSource, endpoint,
            '00000000-0000-4000-8000-000000000000', editor.connectionValidator) : null;
          return (
            <mesh key={`${instance.id}:${socket.id}`} position={[...resolved.worldTransform.positionM]}
              raycast={noRaycast} renderOrder={95}>
              <sphereGeometry args={[0.009, 8, 6]} />
              <meshBasicMaterial color={candidate ? candidate.valid ? '#8ee6bd' : '#ff8a78' : '#8dc8ed'}
                depthTest={false} depthWrite={false} transparent opacity={0.8} />
            </mesh>
          );
        }) ?? [])}
      <mesh ref={ghost} visible={false} raycast={noRaycast} renderOrder={80}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#8ee6bd" wireframe transparent opacity={0.75} depthWrite={false} depthTest={false} />
      </mesh>
      <primitive object={line} />
    </>
  );
}

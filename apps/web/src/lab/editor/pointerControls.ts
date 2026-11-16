import { Plane, Ray, Vector3 } from 'three';
import type { SocketEndpoint, Vec3M } from '@matterlab/contracts/lab';
import type { WorldRayM } from '../environment/types';
import type { LabEditorController } from './LabEditorController';
import { handleEditorShortcut } from './shortcuts';
import type { EditorAxis } from './types';

export interface ApparatusPick { readonly instanceId: string; readonly controlId?: string }
export interface EditorPointerOptions {
  readonly pick: (ray: WorldRayM, excludedId?: string) => ApparatusPick | null;
  readonly pickAxis?: (ray: WorldRayM) => EditorAxis | null;
  readonly pickSocket: (clientX: number, clientY: number) => SocketEndpoint | null;
  readonly invalidate?: () => void;
}
interface Gesture {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly kind: 'placement' | 'transform' | 'rotate' | 'valve' | 'transfer' | 'connection';
  readonly instanceId?: string;
  readonly plane?: Plane;
  readonly startM?: Vector3;
  readonly axis?: EditorAxis;
  readonly initialOpening?: number;
  readonly transferVolumeL?: number;
  moved: boolean;
}
const asRay = (ray: WorldRayM) => new Ray(new Vector3(...ray.originM), new Vector3(...ray.direction).normalize());

/** Capture-phase listeners run before camera/R3F handlers, with one pointer owner. */
export function installEditorPointerControls(
  editor: LabEditorController, canvas: HTMLCanvasElement, options: EditorPointerOptions,
): () => void {
  let gesture: Gesture | null = null;
  let latest: PointerEvent | null = null;
  let frame: number | null = null;
  const ownerWindow = canvas.ownerDocument.defaultView;
  const originalCursor = canvas.style.cursor;
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const rayAt = (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => editor.camera.getWorldRay(event.clientX, event.clientY);
  function cancel(): void {
    gesture = null;
    latest = null;
    if (frame !== null) ownerWindow?.cancelAnimationFrame(frame);
    frame = null;
    editor.cancel();
    options.invalidate?.();
  }
  function down(event: PointerEvent): void {
    if (gesture || event.isPrimary === false || editor.capturedPointerId !== null) {
      if (editor.capturedPointerId !== null) stop(event);
      return;
    }
    if (event.button !== 0 || editor.getSnapshot().busy) return;
    const ray = rayAt(event);
    if (!ray) return;
    const state = editor.getSnapshot();
    const picked = options.pick(ray);
    const axis = state.selectedIds.length ? options.pickAxis?.(ray) : null;
    let next: Gesture | null = null;
    if (state.mode === 'place') {
      next = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: 'placement', moved: false };
    } else if (state.mode === 'connect') {
      const socket = options.pickSocket(event.clientX, event.clientY);
      if (!socket) return;
      if (!state.connectionSource) editor.beginConnection(socket);
      next = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: 'connection', moved: false };
    } else if (picked || axis) {
      if (picked && !axis && (!state.selectedIds.includes(picked.instanceId) || event.shiftKey || event.ctrlKey || event.metaKey)) {
        editor.select([picked.instanceId], { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey });
      }
      if (picked && !axis && (event.ctrlKey || event.metaKey) && !editor.getSnapshot().selectedIds.includes(picked.instanceId)) {
        stop(event);
        return;
      }
      const id = axis ? editor.getSnapshot().selectedIds[0] : picked!.instanceId;
      const snapshot = editor.getRuntimeSnapshot();
      const instance = snapshot.scene.apparatus.find((item) => item.id === id);
      if (!instance || editor.getSnapshot().lockedIds.includes(id)) { stop(event); return; }
      const definition = editor.definitions.getDefinition(instance.definitionId);
      if (state.mode === 'operate' || picked?.controlId) {
        if (definition?.controls.some((control) => control.actionType === 'SET_VALVE') &&
            (state.mode === 'operate' || picked?.controlId === 'stopcock')) {
          next = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: 'valve',
            instanceId: id, initialOpening: snapshot.apparatusStates[id]?.valveOpeningFraction ?? 0, moved: false };
        } else if (definition?.controls.some((control) => control.actionType === 'START_STIRRER')) {
          if (editor.beginCapture(canvas, event.pointerId, `stirrer:${id}`)) {
            stop(event);
            editor.finishCapture();
            const stirring = snapshot.apparatusStates[id]?.stirring;
            const frequency = definition.controls.find((control) => control.actionType === 'START_STIRRER')?.fields.frequencyHz;
            void editor.startStirrer(id, !stirring?.enabled, stirring?.frequencyHz ||
              (frequency?.type === 'number' ? frequency.default ?? 0 : 0));
          }
          return;
        } else if (definition?.controls.some((control) => control.actionType === 'TRANSFER')) {
          const field = definition.controls.find((control) => control.actionType === 'TRANSFER')?.fields.volumeL;
          if (field?.type !== 'number' || field.default === undefined) {
            editor.announce('Choose an exact metered volume in the inspector; this apparatus has no declared drag-transfer preset.');
            stop(event);
            return;
          }
          next = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, kind: 'transfer', instanceId: id,
            transferVolumeL: field.default, moved: false };
        } else {
          editor.announce('Use the selected apparatus’s accessible operation controls. Only declared runtime actions are supported.');
          stop(event);
          return;
        }
      } else {
        if (!editor.beginTransformGesture()) { stop(event); return; }
        const normal = axis === 'Y'
          ? new Vector3(...ray.direction).setY(0).normalize() : new Vector3(0, 1, 0);
        if (normal.lengthSq() < 0.5) normal.set(0, 0, 1);
        const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...instance.transform.positionM));
        const startM = asRay(ray).intersectPlane(plane, new Vector3());
        if (!startM) return;
        next = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          kind: state.mode === 'rotate' ? 'rotate' : 'transform', instanceId: id,
          plane, startM, ...(axis ? { axis } : {}), moved: false };
      }
    } else {
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) editor.select([]);
      return;
    }
    if (next && editor.beginCapture(canvas, event.pointerId, `${next.kind}:${next.instanceId ?? 'new'}`)) {
      gesture = next;
      canvas.focus({ preventScroll: true });
      stop(event);
      if (next.kind === 'placement') editor.hoverPlacement(ray, event.shiftKey);
      if (next.kind === 'valve') editor.previewValve(next.instanceId!, next.initialOpening!);
      if (next.kind === 'transfer') editor.previewTransfer(next.instanceId!, null, next.transferVolumeL!);
      if (next.kind === 'connection') {
        const socket = options.pickSocket(event.clientX, event.clientY);
        if (socket && (socket.instanceId !== editor.getSnapshot().connectionSource?.instanceId ||
            socket.socketId !== editor.getSnapshot().connectionSource?.socketId)) editor.previewConnection(socket);
      }
      options.invalidate?.();
    }
  }
  function applyMove(event: PointerEvent): void {
    const ray = rayAt(event);
    if (!ray) { editor.invalidatePreview('The camera is not ready. Cancel and try again after the viewport initializes.'); return; }
    if (!gesture) {
      if (editor.getSnapshot().mode === 'place') editor.hoverPlacement(ray, event.shiftKey);
      else if (editor.getSnapshot().mode === 'connect') {
        const socket = options.pickSocket(event.clientX, event.clientY);
        editor.previewConnection(socket);
      }
      options.invalidate?.();
      return;
    }
    const current = gesture;
    if (event.pointerId !== current.pointerId) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 3) current.moved = true;
    if (current.kind === 'placement') editor.hoverPlacement(ray, event.shiftKey);
    else if (current.kind === 'connection') {
      const socket = options.pickSocket(event.clientX, event.clientY);
      editor.previewConnection(socket);
    } else if (current.kind === 'valve') {
      editor.previewValve(current.instanceId!, current.initialOpening! +
        (event.clientX - current.x - (event.clientY - current.y)) / (event.shiftKey ? 1000 : 180));
    } else if (current.kind === 'transfer') {
      editor.previewTransfer(current.instanceId!, options.pick(ray, current.instanceId)?.instanceId ?? null, current.transferVolumeL!);
    } else if (current.moved && current.kind === 'rotate') {
      const step = event.shiftKey ? 1 : editor.getSnapshot().angleStepDeg;
      editor.previewRotation(current.axis ?? 'Y', Math.round((event.clientX - current.x) * 0.5 / step) * step);
    } else if (current.moved && current.plane && current.startM) {
      const hit = asRay(ray).intersectPlane(current.plane, new Vector3());
      if (hit) {
        const delta = hit.sub(current.startM);
        if (current.axis) {
          if (current.axis !== 'X') delta.x = 0;
          if (current.axis !== 'Y') delta.y = 0;
          if (current.axis !== 'Z') delta.z = 0;
        }
        const step = event.shiftKey ? 0.001 : editor.getSnapshot().snapM;
        const values = delta.toArray().map((value) => step > 0 ? Math.round(value / step) * step : value);
        editor.previewTranslation(values as unknown as Vec3M);
      }
    }
    options.invalidate?.();
  }
  function move(event: PointerEvent): void {
    if (!gesture && !['place', 'connect'].includes(editor.getSnapshot().mode)) return;
    if (gesture) stop(event);
    latest = event;
    if (frame === null && ownerWindow) frame = ownerWindow.requestAnimationFrame(() => {
      frame = null;
      const pending = latest;
      latest = null;
      if (pending) applyMove(pending);
    });
  }
  function up(event: PointerEvent): void {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    stop(event);
    if (frame !== null) ownerWindow?.cancelAnimationFrame(frame);
    frame = null;
    latest = null;
    applyMove(event);
    const finished = gesture;
    gesture = null;
    editor.finishCapture();
    if (finished.kind === 'valve' && !finished.moved) {
      editor.previewValve(finished.instanceId!, finished.initialOpening! > 0 ? 0 : 1);
    }
    if (editor.getPreview()) void editor.commitPreview();
    options.invalidate?.();
  }
  function cancelled(event: PointerEvent): void {
    if (gesture?.pointerId === event.pointerId) { stop(event); cancel(); }
  }
  function lost(event: PointerEvent): void { if (gesture?.pointerId === event.pointerId) cancel(); }
  function key(event: KeyboardEvent): void {
    if (handleEditorShortcut(event, editor)) {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') cancel();
      options.invalidate?.();
    }
  }
  function context(event: MouseEvent): void {
    stop(event);
    cancel();
    const ray = rayAt(event);
    const picked = ray && options.pick(ray);
    if (picked && !editor.getSnapshot().selectedIds.includes(picked.instanceId)) editor.select([picked.instanceId]);
    editor.contextMenu(event.clientX, event.clientY);
  }
  function wheel(event: WheelEvent): void { if (editor.getSnapshot().pointerCaptured) stop(event); }
  const unsubscribe = editor.subscribe(() => {
    const state = editor.getSnapshot();
    canvas.style.cursor = state.pointerCaptured ? 'grabbing' : state.mode === 'place' || state.mode === 'connect' ? 'crosshair'
      : state.mode === 'operate' ? 'pointer' : 'default';
    if (!state.pointerCaptured && gesture) gesture = null;
  });
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', cancelled, true);
  canvas.addEventListener('lostpointercapture', lost, true);
  canvas.addEventListener('keydown', key, true);
  canvas.addEventListener('contextmenu', context, true);
  canvas.addEventListener('wheel', wheel, { capture: true, passive: false });
  ownerWindow?.addEventListener('blur', cancel);
  return () => {
    unsubscribe();
    canvas.removeEventListener('pointerdown', down, true);
    canvas.removeEventListener('pointermove', move, true);
    canvas.removeEventListener('pointerup', up, true);
    canvas.removeEventListener('pointercancel', cancelled, true);
    canvas.removeEventListener('lostpointercapture', lost, true);
    canvas.removeEventListener('keydown', key, true);
    canvas.removeEventListener('contextmenu', context, true);
    canvas.removeEventListener('wheel', wheel, true);
    ownerWindow?.removeEventListener('blur', cancel);
    cancel();
    canvas.style.cursor = originalCursor;
  };
}

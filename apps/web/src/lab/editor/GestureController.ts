/**
 * Routes pointer and keyboard input in the lab editor's 3D view (brief items 1, 3, 4, 6, 8).
 * Mirrors `apps/web/src/interaction/InteractionController.ts`'s shape closely on purpose: at
 * pointer-down it decides who owns the gesture, and if the editor does, the event is stopped
 * (`stopPropagation`/`preventDefault`/`setPointerCapture`) in the capture phase, before any camera
 * control the host (Agent 02's `CameraDirector`, or this branch's stand-in) ever sees it — so an
 * edit can never also rotate the camera, and the camera can never steal an edit gesture either.
 *
 * This class touches no React and no GPU resource; it only reads/writes `editorStore.ts` state and
 * calls into `commands.ts`/`operationalActions.ts`. A thin R3F host (`components/LabEditorScene.tsx`)
 * supplies the camera and DOM element and renders whatever the store now holds.
 */
import type { Camera, Object3D } from 'three';
import { Raycaster, Vector2, Vector3 } from 'three';
import { getApparatusDefinition, requireApparatusDefinition } from '../apparatus/catalog';
import type { ApparatusDefinition } from '../apparatus/catalog';
import { attachConnection, moveInstances, placeApparatus } from './commands';
import type { Transform, UUID } from './contracts';
import {
  clearSelection,
  endGesture,
  labEditor,
  pickIndex,
  setGesture,
  setHovered,
  setPlacementPreview,
  setSelection,
  setTransientTransforms,
  toggleSelection,
} from './editorStore';
import { addVec3, rayIntersectsPlane, subVec3 } from './footprint';
import type { Ray } from './footprint';
import { setValve } from './operationalActions';
import { pickApparatus, pickApparatusInBox } from './picking';
import { computePlacementPreview } from './placement';
import type { CollisionCandidate } from './collision';
import type { SnapCandidate } from './snapping';
import type { PlacementPreview, Vec3 } from './types';

const DRAG_THRESHOLD_PX = 4;
const NEARBY_RADIUS_M = 0.4;
const GROUND_POINT: Vec3 = [0, 0, 0];
const GROUND_NORMAL: Vec3 = [0, 1, 0];

export interface ControlHotspot {
  readonly instanceId: UUID;
  readonly controlId: string;
  /** How far (in CSS pixels, vertical) a full 0→1 sweep of the control should take. */
  readonly pixelsForFullRange: number;
}

export interface GestureControllerDeps {
  /** The element that receives pointer input and defines the viewport rectangle for raycasting. */
  readonly element: HTMLElement;
  /** A DOM rectangle this controller shows/hides/positions during a marquee drag. */
  readonly marquee: HTMLElement;
  readonly getCamera: () => Camera;
  /** Requests a re-render; called after anything that should be visible immediately (R3F's `invalidate`). */
  readonly invalidate: () => void;
}

type Session =
  | { readonly kind: 'click'; readonly pointerId: number; readonly x: number; readonly y: number; moved: boolean; readonly hitId: UUID | null; readonly shift: boolean }
  | {
      readonly kind: 'drag';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      moved: boolean;
      readonly primaryId: UUID;
      readonly ids: readonly UUID[];
      readonly origins: ReadonlyMap<UUID, Transform>;
      readonly planePoint: Vec3;
      readonly planeNormal: Vec3;
      readonly grabOffset: Vec3;
    }
  | { readonly kind: 'marquee'; readonly pointerId: number; readonly x: number; readonly y: number; moved: boolean; readonly additive: boolean }
  | { readonly kind: 'operate'; readonly pointerId: number; readonly x: number; readonly y: number; moved: boolean; readonly instanceId: UUID; readonly controlId: string; readonly startY: number; readonly startValue: number; readonly pixelsForFullRange: number };

function toVec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

export class GestureController {
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly vector3 = new Vector3();
  private readonly controlHotspots = new Map<Object3D, ControlHotspot>();
  private session: Session | null = null;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(private readonly deps: GestureControllerDeps) {}

  connect(): () => void {
    const { element } = this.deps;
    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const cancel = () => this.abortSession();
    const key = (e: KeyboardEvent) => this.onKeyDown(e);
    const menu = (e: Event) => e.preventDefault();

    element.addEventListener('pointerdown', down, { capture: true });
    element.addEventListener('contextmenu', menu);
    window.addEventListener('pointermove', move, { capture: true });
    window.addEventListener('pointerup', up, { capture: true });
    window.addEventListener('pointercancel', cancel, { capture: true });
    window.addEventListener('keydown', key);

    return () => {
      element.removeEventListener('pointerdown', down, { capture: true });
      element.removeEventListener('contextmenu', menu);
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      window.removeEventListener('pointercancel', cancel, { capture: true });
      window.removeEventListener('keydown', key);
    };
  }

  /** Registers a small interactive control (a stopcock lever, a stirrer dial) so a pointer-down on it begins `'operating'` instead of a plain drag. Returns an unregister function. */
  registerControlHotspot(object: Object3D, hotspot: ControlHotspot): () => void {
    this.controlHotspots.set(object, hotspot);
    return () => this.controlHotspots.delete(object);
  }

  /** Arms placement from the palette (or a keyboard-selected definition); the next click in the viewport commits it, Escape cancels. Shared by a keyboard-only flow and by a drag-and-drop palette. */
  armPlacement(definitionId: string): void {
    this.session = null;
    setPlacementPreview(null);
    setGesture({ kind: 'placing', definitionId });
  }

  /** Updates the placement preview for an externally-driven pointer position (native HTML5 drag-and-drop `dragover`, which does not dispatch `pointermove`). */
  updatePlacementPreviewAt(clientX: number, clientY: number): void {
    const gesture = labEditor.get().gesture;
    if (gesture.kind === 'placing') this.previewPlacement(gesture.definitionId, clientX, clientY);
  }

  /** Commits the armed placement at an externally-driven position (a palette `drop`). */
  commitPlacementAt(clientX: number, clientY: number): boolean {
    const gesture = labEditor.get().gesture;
    if (gesture.kind !== 'placing') return false;
    this.previewPlacement(gesture.definitionId, clientX, clientY);
    return this.commitArmedPlacement();
  }

  cancelPlacement(): void {
    if (labEditor.get().gesture.kind === 'placing') endGesture();
  }

  // ---------- raycasting ----------

  private rayAt(clientX: number, clientY: number): Ray {
    const rect = this.deps.element.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.deps.getCamera());
    return { origin: toVec3(this.raycaster.ray.origin), direction: toVec3(this.raycaster.ray.direction) };
  }

  private hotspotAt(clientX: number, clientY: number): { object: Object3D; hotspot: ControlHotspot } | null {
    if (this.controlHotspots.size === 0) return null;
    const rect = this.deps.element.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.deps.getCamera());
    const hits = this.raycaster.intersectObjects([...this.controlHotspots.keys()], true);
    for (const hit of hits) {
      let node: Object3D | null = hit.object;
      while (node) {
        const hotspot = this.controlHotspots.get(node);
        if (hotspot) return { object: node, hotspot };
        node = node.parent;
      }
    }
    return null;
  }

  /** Screen-space (CSS pixel) position of a world point, or `null` if it is behind the camera — used for marquee hit-testing. */
  private project(point: Vec3): [number, number] | null {
    this.vector3.set(point[0], point[1], point[2]).project(this.deps.getCamera());
    if (this.vector3.z > 1 || this.vector3.z < -1) return null;
    const rect = this.deps.element.getBoundingClientRect();
    return [rect.left + (this.vector3.x * 0.5 + 0.5) * rect.width, rect.top + (-this.vector3.y * 0.5 + 0.5) * rect.height];
  }

  private cameraForward(): Vec3 {
    this.deps.getCamera().getWorldDirection(this.vector3);
    return toVec3(this.vector3);
  }

  private nearby(point: Vec3, radiusM: number, excludeId?: UUID): { snapNearby: SnapCandidate[]; collisionNearby: CollisionCandidate[] } {
    const scene = labEditor.get().scene;
    const snapNearby: SnapCandidate[] = [];
    const collisionNearby: CollisionCandidate[] = [];
    for (const id of pickIndex.queryNear(point, radiusM)) {
      if (id === excludeId) continue;
      const instance = scene.apparatus.get(id);
      if (!instance) continue;
      const definition = getApparatusDefinition(instance.definitionId);
      if (!definition) continue;
      snapNearby.push({ instance, definition });
      const box = pickIndex.boxFor(id);
      if (box) collisionNearby.push({ instanceId: id, label: definition.label, box });
    }
    return { snapNearby, collisionNearby };
  }

  // ---------- placement ----------

  private previewPlacement(definitionId: string, clientX: number, clientY: number): void {
    const ray = this.rayAt(clientX, clientY);
    const groundPoint = rayIntersectsPlane(ray, GROUND_POINT, GROUND_NORMAL);
    if (!groundPoint) {
      setPlacementPreview(null);
      return;
    }
    const definition = requireApparatusDefinition(definitionId);
    const candidateTransform: Transform = { positionM: groundPoint, quaternion: [0, 0, 0, 1] };
    const { snapNearby, collisionNearby } = this.nearby(groundPoint, NEARBY_RADIUS_M);
    const preview = computePlacementPreview({ definition, candidateTransform, snapNearby, collisionNearby, connections: labEditor.get().scene.connections.values() });
    setPlacementPreview(preview);
    this.deps.invalidate();
  }

  private commitArmedPlacement(): boolean {
    const gesture = labEditor.get().gesture;
    if (gesture.kind !== 'placing') return false;
    const preview = labEditor.get().placementPreview;
    endGesture();
    if (!preview) return false;
    const definition = requireApparatusDefinition(gesture.definitionId);
    const stationId = labEditor.get().activeStationId;
    const { instanceId, result } = placeApparatus({ definitionId: definition.id, kind: definition.kind, transform: preview.transform, capabilities: definition.capabilities, stationId, config: definition.defaultConfig });
    if (result.accepted) {
      setSelection([instanceId]);
      if (preview.snap.status === 'valid') this.autoAttach(instanceId, preview, definition);
    }
    this.deps.invalidate();
    return result.accepted;
  }

  private autoAttach(instanceId: UUID, preview: PlacementPreview, _definition: ApparatusDefinition): void {
    if (preview.snap.status !== 'valid') return;
    attachConnection({ instanceId, socketId: preview.snap.draggedSocketId }, { instanceId: preview.snap.socket.instanceId, socketId: preview.snap.socket.socketId }, preview.snap.socket.kind);
  }

  // ---------- pointer ----------

  private own(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    try {
      this.deps.element.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
  }

  private inViewport(target: EventTarget | null): boolean {
    return target instanceof Node && this.deps.element.contains(target);
  }

  private onPointerDown(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.deps.invalidate();
    if (e.button !== 0 || !e.isPrimary) return;
    if (this.session) this.abortSession();

    const gesture = labEditor.get().gesture;
    if (gesture.kind === 'placing') {
      this.own(e);
      this.commitArmedPlacement();
      return;
    }

    const base = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };

    const hotspot = this.hotspotAt(e.clientX, e.clientY);
    if (hotspot) {
      this.own(e);
      setGesture({ kind: 'operating', instanceId: hotspot.hotspot.instanceId, control: hotspot.hotspot.controlId });
      this.session = {
        kind: 'operate',
        ...base,
        instanceId: hotspot.hotspot.instanceId,
        controlId: hotspot.hotspot.controlId,
        startY: e.clientY,
        startValue: this.currentControlValue(hotspot.hotspot.instanceId, hotspot.hotspot.controlId),
        pixelsForFullRange: hotspot.hotspot.pixelsForFullRange,
      };
      return;
    }

    const ray = this.rayAt(e.clientX, e.clientY);
    const hit = pickApparatus(pickIndex, ray);
    const locked = labEditor.get().scene.locked;

    if (hit && !locked.has(hit.instanceId)) {
      const selection = labEditor.get().selection;
      if (!selection.has(hit.instanceId)) {
        if (e.shiftKey) toggleSelection(hit.instanceId);
        else setSelection([hit.instanceId]);
      }
      const ids = labEditor.get().selection.has(hit.instanceId) ? [...labEditor.get().selection] : [hit.instanceId];
      const scene = labEditor.get().scene;
      const origins = new Map<UUID, Transform>();
      for (const id of ids) {
        const instance = scene.apparatus.get(id);
        if (instance) origins.set(id, instance.transform);
      }
      const primary = scene.apparatus.get(hit.instanceId)!;
      const planeNormal = this.cameraForward();
      const anchor = rayIntersectsPlane(ray, primary.transform.positionM, planeNormal) ?? primary.transform.positionM;
      this.session = {
        kind: 'drag',
        ...base,
        primaryId: hit.instanceId,
        ids,
        origins,
        planePoint: primary.transform.positionM,
        planeNormal,
        grabOffset: subVec3(primary.transform.positionM, anchor),
      };
      this.own(e);
      return;
    }

    if (!hit && e.shiftKey) {
      this.session = { kind: 'marquee', ...base, additive: true };
      this.own(e);
      this.deps.marquee.style.display = 'block';
      return;
    }

    this.session = { kind: 'click', ...base, hitId: hit?.instanceId ?? null, shift: e.shiftKey };
  }

  private onPointerMove(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };

    const session = this.session;
    if (!session) {
      const gesture = labEditor.get().gesture;
      if (gesture.kind === 'placing') this.previewPlacement(gesture.definitionId, e.clientX, e.clientY);
      else if (this.inViewport(e.target)) this.updateHover(e.clientX, e.clientY);
      return;
    }
    if (e.pointerId !== session.pointerId) return;
    if (!session.moved && Math.hypot(e.clientX - session.x, e.clientY - session.y) < DRAG_THRESHOLD_PX) return;
    session.moved = true;

    if (session.kind === 'drag') return this.updateDrag(session, e);
    if (session.kind === 'marquee') return this.updateMarquee(session, e);
    if (session.kind === 'operate') return this.updateOperate(session, e);
  }

  private onPointerUp(e: PointerEvent): void {
    const session = this.session;
    if (!session || e.pointerId !== session.pointerId) return;
    this.session = null;

    if (session.kind === 'drag') this.finishDrag(session);
    else if (session.kind === 'marquee') this.finishMarquee(session);
    else if (session.kind === 'operate') endGesture();
    else if (session.kind === 'click' && !session.moved) this.finishClick(session);

    this.deps.invalidate();
  }

  private abortSession(): void {
    if (this.session?.kind === 'drag') setTransientTransforms(null);
    if (this.session?.kind === 'marquee') this.deps.marquee.style.display = 'none';
    this.session = null;
    endGesture();
  }

  // ---------- drag (move selected instances) ----------

  private updateDrag(session: Extract<Session, { kind: 'drag' }>, e: PointerEvent): void {
    setGesture({ kind: 'dragging', instanceIds: session.ids });
    const ray = this.rayAt(e.clientX, e.clientY);
    const point = rayIntersectsPlane(ray, session.planePoint, session.planeNormal);
    if (!point) return;
    const target = addVec3(point, session.grabOffset);
    const primaryOrigin = session.origins.get(session.primaryId)!;

    const definition = requireApparatusDefinition(labEditor.get().scene.apparatus.get(session.primaryId)!.definitionId);
    const { snapNearby, collisionNearby } = this.nearby(target, NEARBY_RADIUS_M, session.primaryId);
    const candidateTransform: Transform = { positionM: target, quaternion: primaryOrigin.quaternion };
    const preview = computePlacementPreview({ definition, candidateTransform, snapNearby, collisionNearby, connections: labEditor.get().scene.connections.values(), excludeInstanceId: session.primaryId });
    setPlacementPreview(preview);

    const resolvedPrimary = preview.snap.status === 'valid' ? preview.transform : candidateTransform;
    const resolvedDelta = subVec3(resolvedPrimary.positionM, primaryOrigin.positionM);
    const transforms = new Map<UUID, Transform>();
    for (const [id, origin] of session.origins) {
      transforms.set(id, id === session.primaryId ? resolvedPrimary : { positionM: addVec3(origin.positionM, resolvedDelta), quaternion: origin.quaternion });
    }
    setTransientTransforms(transforms);
    this.deps.invalidate();
  }

  private finishDrag(session: Extract<Session, { kind: 'drag' }>): void {
    const transforms = labEditor.get().transientTransforms;
    setTransientTransforms(null);
    endGesture();
    if (!session.moved || !transforms) return;
    const moves = [...transforms].map(([id, transform]) => ({ id, transform }));
    moveInstances(moves, moves.length > 1 ? `Move ${moves.length} instruments` : 'Move');
    const preview = labEditor.get().placementPreview;
    if (preview?.snap.status === 'valid') {
      const definition = getApparatusDefinition(labEditor.get().scene.apparatus.get(session.primaryId)?.definitionId ?? '');
      if (definition) this.autoAttach(session.primaryId, preview, definition);
    }
    setPlacementPreview(null);
  }

  // ---------- marquee ----------

  private updateMarquee(session: Extract<Session, { kind: 'marquee' }>, e: PointerEvent): void {
    const left = Math.min(session.x, e.clientX);
    const top = Math.min(session.y, e.clientY);
    const width = Math.abs(e.clientX - session.x);
    const height = Math.abs(e.clientY - session.y);
    Object.assign(this.deps.marquee.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  private finishMarquee(session: Extract<Session, { kind: 'marquee' }>): void {
    this.deps.marquee.style.display = 'none';
    if (!this.lastPointer || !session.moved) return;
    const left = Math.min(session.x, this.lastPointer.x);
    const top = Math.min(session.y, this.lastPointer.y);
    const right = Math.max(session.x, this.lastPointer.x);
    const bottom = Math.max(session.y, this.lastPointer.y);

    const inside: UUID[] = [];
    for (const id of pickApparatusInBox(pickIndex, { min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] })) {
      const screen = this.project(labEditor.get().scene.apparatus.get(id)!.transform.positionM);
      if (screen && screen[0] >= left && screen[0] <= right && screen[1] >= top && screen[1] <= bottom) inside.push(id);
    }
    if (session.additive) {
      const next = new Set(labEditor.get().selection);
      for (const id of inside) next.add(id);
      setSelection(next);
    } else {
      setSelection(inside);
    }
  }

  // ---------- click (select / clear) ----------

  private finishClick(session: Extract<Session, { kind: 'click' }>): void {
    if (session.hitId) {
      if (session.shift) toggleSelection(session.hitId);
      else setSelection([session.hitId]);
    } else if (!session.shift) {
      clearSelection();
    }
  }

  // ---------- hover ----------

  private updateHover(clientX: number, clientY: number): void {
    const ray = this.rayAt(clientX, clientY);
    const hit = pickApparatus(pickIndex, ray);
    setHovered(hit?.instanceId ?? null);
  }

  // ---------- operate (stopcock / stirrer dial drag) ----------

  private currentControlValue(instanceId: UUID, controlId: string): number {
    const instance = labEditor.get().scene.apparatus.get(instanceId);
    const config = instance?.config as Record<string, unknown> | undefined;
    const key = controlId === 'valve' ? 'valveOpenFraction' : controlId === 'speed' ? 'speed' : controlId;
    const value = config?.[key];
    return typeof value === 'number' ? value : 0;
  }

  private updateOperate(session: Extract<Session, { kind: 'operate' }>, e: PointerEvent): void {
    const deltaPx = session.startY - e.clientY; // up increases the value
    const fraction = Math.min(Math.max(session.startValue + deltaPx / session.pixelsForFullRange, 0), 1);
    if (session.controlId === 'valve') setValve(session.instanceId, fraction);
    this.deps.invalidate();
  }

  // ---------- keyboard ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (labEditor.get().gesture.kind === 'placing') {
      e.preventDefault();
      this.cancelPlacement();
      return;
    }
    if (this.session) {
      e.preventDefault();
      this.abortSession();
    }
  }
}

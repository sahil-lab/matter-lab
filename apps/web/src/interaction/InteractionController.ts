import { fragmentOf, idealBondLength, vadd, vcentroid, vdot, vlen, vnorm, vrotateAbout, vscale, vsub } from '@matterlab/core';
import type { AtomId, BondId, Vec3 } from '@matterlab/core';
import type CameraControlsImpl from 'camera-controls';
import { Raycaster, Vector2, Vector3 } from 'three';
import type { Camera, OrthographicCamera, PerspectiveCamera } from 'three';
import { intersectPlane, pick } from '../render/picking';
import type { PickHit, PickRay } from '../render/picking';
import type { SceneView } from '../render/SceneView';
import { viewApi } from '../render/viewApi';
import {
  addToSelection,
  applyBondOrder,
  changeElement,
  clearSelection,
  connectAtoms,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  eraseAtoms,
  eraseBonds,
  focusSelection,
  growAtom,
  hydrogenate,
  moveAtoms,
  pasteClipboard,
  pickForMeasurement,
  placeAtom,
  redo,
  selectAll,
  selectMolecule,
  selectOnly,
  setHover,
  toggleAtomSelection,
  toggleBondSelection,
  undo,
} from '../state/actions';
import { isReadOnly, lab } from '../state/store';
import type { LabState, ToolId } from '../state/store';
import type { GhostPreview } from './GhostPreview';

export interface ControllerDeps {
  /** Element that covers the 3D view and receives pointer input. */
  readonly element: HTMLElement;
  readonly marquee: HTMLElement;
  readonly getCamera: () => Camera;
  readonly getControls: () => CameraControlsImpl | null;
  readonly view: SceneView;
  readonly ghost: GhostPreview;
  readonly invalidate: () => void;
  /** Called for commands the controller does not own (save, open, dialogs). */
  readonly onCommand: (command: 'save' | 'open' | 'periodic-table' | 'shortcuts' | 'escape' | 'optimize') => boolean;
}

const DRAG_THRESHOLD_PX = 4;
const MIN_PICK_PX = 6;
const DOUBLE_CLICK_MS = 380;

/** Keys that edit the structure, which a display-only stage ignores. */
const READ_ONLY_BLOCKED_KEYS: ReadonlySet<string> = new Set(['a', 'e', 'Delete', 'Backspace', 'h', 'o', 'g', 'r', 'p', '1', '2', '3', '4']);

/** The tool in effect: on a display-only stage everything except measuring behaves as Select. */
function effectiveTool(state: LabState): ToolId {
  return isReadOnly(state) && state.tool !== 'measure' ? 'select' : state.tool;
}

type Axis = 'x' | 'y' | 'z';
const AXES: Readonly<Record<Axis, Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

type Session =
  /** The editor does not own the drag (the camera may orbit); only a click without movement acts. */
  | { kind: 'click'; pointerId: number; x: number; y: number; moved: boolean; hit: PickHit | null; shift: boolean }
  | {
      kind: 'drag-atoms';
      pointerId: number;
      x: number;
      y: number;
      moved: boolean;
      atomId: AtomId;
      wasSelected: boolean;
      shift: boolean;
      origins: Map<AtomId, Vec3>;
      anchor: Vec3;
      normal: Vec3;
      start: Vec3;
    }
  | { kind: 'marquee'; pointerId: number; x: number; y: number; moved: boolean; additive: boolean }
  | { kind: 'bond-drag'; pointerId: number; x: number; y: number; moved: boolean; from: AtomId; targetAtom: AtomId | null; point: Vec3 | null };

interface ModalTransform {
  readonly mode: 'grab' | 'rotate';
  readonly origins: Map<AtomId, Vec3>;
  readonly pivot: Vec3;
  readonly normal: Vec3;
  /** Pointer position on the pivot plane when the transform began. */
  readonly start: Vec3 | null;
  axis: Axis | null;
  typed: string;
  /** Current result: displacement in angstrom (grab) or angle in degrees (rotate). */
  value: number;
  delta: Vec3;
}

/**
 * Routes all pointer and keyboard input in the 3D view. At pointer-down it decides who owns the
 * gesture: if the editor does (moving atoms, drawing a bond, rubber-band selection) the event is
 * stopped before the camera controls ever see it, so an edit can never also move the camera.
 */
export class InteractionController {
  /** The controller currently connected to the view, for diagnostics and automated tests. */
  static active: InteractionController | null = null;

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly forward = new Vector3();
  private session: Session | null = null;
  private modal: ModalTransform | null = null;
  private hoverFrame = 0;
  private lastPointer: { x: number; y: number } | null = null;
  private buttonsDown = 0;
  private lastAtomClick: { atomId: AtomId; time: number } | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  connect(): () => void {
    const { element } = this.deps;
    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const cancel = (e: PointerEvent) => this.onPointerCancel(e);
    const leave = () => this.onLeave();
    const key = (e: KeyboardEvent) => this.onKeyDown(e);
    const menu = (e: Event) => e.preventDefault();

    element.addEventListener('pointerdown', down, { capture: true });
    element.addEventListener('pointerleave', leave);
    element.addEventListener('contextmenu', menu);
    window.addEventListener('pointermove', move, { capture: true });
    window.addEventListener('pointerup', up, { capture: true });
    window.addEventListener('pointercancel', cancel, { capture: true });
    window.addEventListener('keydown', key);
    InteractionController.active = this;
    return () => {
      if (InteractionController.active === this) InteractionController.active = null;
      element.removeEventListener('pointerdown', down, { capture: true });
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('contextmenu', menu);
      window.removeEventListener('pointermove', move, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      window.removeEventListener('pointercancel', cancel, { capture: true });
      window.removeEventListener('keydown', key);
      cancelAnimationFrame(this.hoverFrame);
      this.cancelModal();
      this.abortSession();
    };
  }

  // ---------- geometry helpers ----------

  private rayAt(clientX: number, clientY: number): PickRay {
    const rect = this.deps.element.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.deps.getCamera());
    const { origin, direction } = this.raycaster.ray;
    return { ox: origin.x, oy: origin.y, oz: origin.z, dx: direction.x, dy: direction.y, dz: direction.z };
  }

  /** Angstrom per CSS pixel at a given distance along a pick ray. */
  private worldPerPixel(distance: number): number {
    const camera = this.deps.getCamera();
    const height = this.deps.element.clientHeight || 1;
    if ((camera as OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as OrthographicCamera;
      return (ortho.top - ortho.bottom) / ortho.zoom / height;
    }
    const perspective = camera as PerspectiveCamera;
    return (2 * distance * Math.tan((perspective.fov * Math.PI) / 360)) / height;
  }

  /** What is under a point given in client (CSS pixel) coordinates. */
  hitTest(clientX: number, clientY: number): PickHit | null {
    return this.pickAt(clientX, clientY);
  }

  private pickAt(clientX: number, clientY: number, includeBonds = true): PickHit | null {
    return pick(this.deps.view.pickData(), this.rayAt(clientX, clientY), {
      includeBonds,
      minRadiusAt: (distance) => MIN_PICK_PX * this.worldPerPixel(distance),
    });
  }

  private viewNormal(): Vec3 {
    this.deps.getCamera().getWorldDirection(this.forward);
    return [this.forward.x, this.forward.y, this.forward.z];
  }

  private pointOnPlane(clientX: number, clientY: number, anchor: Vec3, normal: Vec3): Vec3 | null {
    return intersectPlane(this.rayAt(clientX, clientY), anchor, normal);
  }

  private inViewport(target: EventTarget | null): boolean {
    return target instanceof Node && this.deps.element.contains(target);
  }

  // ---------- pointer ----------

  private own(e: PointerEvent): void {
    // Stopping the event here, in the capture phase, keeps it from the camera controls entirely.
    e.stopPropagation();
    e.preventDefault();
    try {
      this.deps.element.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone */
    }
  }

  private onPointerDown(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.buttonsDown = e.buttons;
    this.deps.invalidate();

    if (this.modal) {
      // While a keyboard transform is active, left click confirms and right click cancels.
      e.stopPropagation();
      e.preventDefault();
      if (e.button === 0) this.confirmModal();
      else this.cancelModal();
      return;
    }
    if (e.button !== 0 || !e.isPrimary) return;
    // A gesture whose release was never seen (the pointer left the window) must not block a new one.
    if (this.session) this.abortSession();
    (document.activeElement as HTMLElement | null)?.blur?.();

    const state = lab.get();
    const hit = this.pickAt(e.clientX, e.clientY);
    const base = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    // Structures on a display-only stage can be inspected and measured, never moved or rebuilt.
    const readOnly = isReadOnly(state);
    const tool = effectiveTool(state);

    if (tool === 'select') {
      if (hit?.kind === 'atom' && !readOnly) {
        const wasSelected = state.selectedAtoms.has(hit.id);
        if (!wasSelected) {
          if (e.shiftKey) addToSelection([hit.id]);
          else selectOnly([hit.id]);
        }
        const selection = lab.get().selectedAtoms;
        const ids = e.altKey ? fragmentOf(state.scene, hit.id) : selection.has(hit.id) ? selection : new Set([hit.id]);
        const origins = new Map<AtomId, Vec3>();
        for (const id of ids) {
          const atom = state.scene.atoms.get(id);
          if (atom) origins.set(id, atom.position);
        }
        const anchor = state.scene.atoms.get(hit.id)!.position;
        const normal = this.viewNormal();
        const start = this.pointOnPlane(e.clientX, e.clientY, anchor, normal) ?? anchor;
        this.session = { kind: 'drag-atoms', ...base, atomId: hit.id, wasSelected, shift: e.shiftKey, origins, anchor, normal, start };
        this.own(e);
        this.setCursor('grabbing');
        return;
      }
      if (!hit && e.shiftKey) {
        this.session = { kind: 'marquee', ...base, additive: true };
        this.own(e);
        return;
      }
      this.session = { kind: 'click', ...base, hit, shift: e.shiftKey };
      return;
    }

    if (tool === 'build' && hit?.kind === 'atom') {
      this.session = { kind: 'bond-drag', ...base, from: hit.id, targetAtom: null, point: null };
      this.own(e);
      return;
    }

    this.session = { kind: 'click', ...base, hit, shift: e.shiftKey };
  }

  private onPointerMove(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.buttonsDown = e.buttons;

    if (this.modal) {
      this.updateModal();
      return;
    }

    const session = this.session;
    if (!session) {
      if (e.buttons === 0 && this.inViewport(e.target)) this.scheduleHover();
      return;
    }
    if (e.pointerId !== session.pointerId) return;
    if (!session.moved && Math.hypot(e.clientX - session.x, e.clientY - session.y) < DRAG_THRESHOLD_PX) return;
    session.moved = true;

    switch (session.kind) {
      case 'click':
        // The camera is orbiting; suppress hover highlights until it settles.
        setHover(null, null);
        break;
      case 'drag-atoms': {
        const point = this.pointOnPlane(e.clientX, e.clientY, session.anchor, session.normal);
        if (!point) break;
        const delta = vsub(point, session.start);
        const positions = new Map<AtomId, Vec3>();
        for (const [id, origin] of session.origins) positions.set(id, vadd(origin, delta));
        this.deps.view.setTransient(positions);
        this.deps.invalidate();
        break;
      }
      case 'marquee':
        this.drawMarquee(session.x, session.y, e.clientX, e.clientY);
        break;
      case 'bond-drag':
        this.updateBondDrag(session, e);
        break;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.buttonsDown = e.buttons;
    const session = this.session;
    if (!session || e.pointerId !== session.pointerId) return;
    this.session = null;
    try {
      this.deps.element.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const state = lab.get();

    switch (session.kind) {
      case 'click':
        if (!session.moved) this.handleClick(effectiveTool(state), session.hit, session.shift, e);
        break;

      case 'drag-atoms': {
        if (session.moved) {
          const point = this.pointOnPlane(e.clientX, e.clientY, session.anchor, session.normal);
          const delta = point ? vsub(point, session.start) : ([0, 0, 0] as Vec3);
          const positions = new Map<AtomId, Vec3>();
          for (const [id, origin] of session.origins) positions.set(id, vadd(origin, delta));
          // Commit first, then drop the live override, so the atoms never jump back for a frame.
          moveAtoms(positions, positions.size === 1 ? 'Move atom' : 'Move atoms');
          this.deps.view.setTransient(null);
          this.lastAtomClick = null;
        } else {
          // Own pointer-down events suppress the browser's dblclick, so double clicks are timed here.
          const now = performance.now();
          const doubleClick = this.lastAtomClick?.atomId === session.atomId && now - this.lastAtomClick.time < DOUBLE_CLICK_MS;
          this.lastAtomClick = doubleClick ? null : { atomId: session.atomId, time: now };
          if (doubleClick) selectMolecule(session.atomId, session.shift);
          else if (session.shift && session.wasSelected) toggleAtomSelection(session.atomId);
          else if (!session.shift && session.wasSelected && state.selectedAtoms.size + state.selectedBonds.size > 1) {
            selectOnly([session.atomId]);
          }
        }
        this.setCursor('grab');
        break;
      }

      case 'marquee': {
        this.deps.marquee.style.display = 'none';
        if (session.moved) addToSelection(this.atomsInRect(session.x, session.y, e.clientX, e.clientY));
        break;
      }

      case 'bond-drag': {
        this.deps.ghost.hide();
        const from = state.scene.atoms.get(session.from);
        if (!from) break;
        if (session.targetAtom !== null && session.targetAtom !== session.from) {
          const target = state.scene.atoms.get(session.targetAtom);
          const bonded = [...state.scene.bonds.values()].some(
            (b) => (b.a === session.from && b.b === session.targetAtom) || (b.b === session.from && b.a === session.targetAtom),
          );
          // Dragging onto one of the atom's own hydrogens substitutes that hydrogen.
          if (target && bonded && target.protons === 1 && state.buildElement !== 1) changeElement([session.targetAtom], state.buildElement);
          else connectAtoms(session.from, session.targetAtom);
        } else if (session.moved && session.point) {
          growAtom(session.from, session.point);
        } else if (!session.moved && from.protons !== state.buildElement) {
          changeElement([session.from], state.buildElement);
        }
        break;
      }
    }
    this.deps.invalidate();
    this.scheduleHover();
  }

  private onPointerCancel(e: PointerEvent): void {
    if (this.session && e.pointerId === this.session.pointerId) this.abortSession();
  }

  private onLeave(): void {
    if (!this.session && !this.modal) setHover(null, null);
  }

  private abortSession(): void {
    if (!this.session) return;
    this.session = null;
    this.deps.view.setTransient(null);
    this.deps.ghost.hide();
    this.deps.marquee.style.display = 'none';
    this.deps.invalidate();
  }

  private handleClick(tool: ToolId, hit: PickHit | null, shift: boolean, e: PointerEvent): void {
    switch (tool) {
      case 'select':
        if (!hit) clearSelection();
        else if (hit.kind === 'bond') {
          if (shift) toggleBondSelection(hit.id);
          else selectOnly([], [hit.id]);
        } else {
          // Reached only on a display-only stage, where pressing an atom does not start a drag.
          const now = performance.now();
          const doubleClick = this.lastAtomClick?.atomId === hit.id && now - this.lastAtomClick.time < DOUBLE_CLICK_MS;
          this.lastAtomClick = doubleClick ? null : { atomId: hit.id, time: now };
          if (doubleClick) selectMolecule(hit.id, shift);
          else if (shift) toggleAtomSelection(hit.id);
          else selectOnly([hit.id]);
        }
        break;
      case 'build':
        if (!hit) {
          const anchor = viewApi.getTarget() ?? ([0, 0, 0] as Vec3);
          const point = this.pointOnPlane(e.clientX, e.clientY, anchor, this.viewNormal());
          if (point) placeAtom(point);
        } else if (hit.kind === 'bond') applyBondOrder(hit.id);
        break;
      case 'erase':
        if (hit?.kind === 'atom') eraseAtoms([hit.id]);
        else if (hit?.kind === 'bond') eraseBonds([hit.id]);
        break;
      case 'measure':
        if (hit?.kind === 'atom') pickForMeasurement(hit.id);
        else if (!hit) lab.set({ measurePicks: [] });
        break;
    }
  }

  // ---------- hover ----------

  private scheduleHover(): void {
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (this.session || this.modal || this.buttonsDown !== 0 || !this.lastPointer) return;
      const hit = this.pickAt(this.lastPointer.x, this.lastPointer.y);
      const before = lab.get();
      setHover(hit?.kind === 'atom' ? hit.id : null, hit?.kind === 'bond' ? hit.id : null);
      const after = lab.get();
      if (before.hoveredAtom !== after.hoveredAtom || before.hoveredBond !== after.hoveredBond) this.deps.invalidate();
      const cursor = this.cursorFor(effectiveTool(after), hit);
      this.setCursor(isReadOnly(after) && cursor === 'grab' ? 'pointer' : cursor);
    });
  }

  private cursorFor(tool: ToolId, hit: PickHit | null): string {
    if (tool === 'select') return hit?.kind === 'atom' ? 'grab' : hit ? 'pointer' : 'default';
    if (tool === 'build') return hit ? 'pointer' : 'crosshair';
    if (tool === 'erase') return hit ? 'pointer' : 'default';
    return hit?.kind === 'atom' ? 'pointer' : 'default';
  }

  private setCursor(cursor: string): void {
    if (this.deps.element.style.cursor !== cursor) this.deps.element.style.cursor = cursor;
  }

  // ---------- rubber-band selection ----------

  private drawMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const rect = this.deps.element.getBoundingClientRect();
    const style = this.deps.marquee.style;
    style.display = 'block';
    style.left = `${Math.min(x0, x1) - rect.left}px`;
    style.top = `${Math.min(y0, y1) - rect.top}px`;
    style.width = `${Math.abs(x1 - x0)}px`;
    style.height = `${Math.abs(y1 - y0)}px`;
  }

  private atomsInRect(x0: number, y0: number, x1: number, y1: number): AtomId[] {
    const rect = this.deps.element.getBoundingClientRect();
    const toNdcX = (x: number) => ((x - rect.left) / rect.width) * 2 - 1;
    const toNdcY = (y: number) => -((y - rect.top) / rect.height) * 2 + 1;
    const minX = toNdcX(Math.min(x0, x1));
    const maxX = toNdcX(Math.max(x0, x1));
    const minY = toNdcY(Math.max(y0, y1));
    const maxY = toNdcY(Math.min(y0, y1));
    const camera = this.deps.getCamera();
    const data = this.deps.view.pickData();
    const projected = new Vector3();
    const inside: AtomId[] = [];
    for (let i = 0; i < data.atomCount; i++) {
      if (data.atomRadii[i]! <= 0) continue;
      projected.set(data.atomPositions[3 * i]!, data.atomPositions[3 * i + 1]!, data.atomPositions[3 * i + 2]!).project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      if (projected.x >= minX && projected.x <= maxX && projected.y >= minY && projected.y <= maxY) inside.push(data.atomIds[i]!);
    }
    return inside;
  }

  // ---------- drawing bonds ----------

  private updateBondDrag(session: Extract<Session, { kind: 'bond-drag' }>, e: PointerEvent): void {
    const state = lab.get();
    const from = state.scene.atoms.get(session.from);
    if (!from) return;
    const hit = this.pickAt(e.clientX, e.clientY, false);
    if (hit?.kind === 'atom' && hit.id !== session.from) {
      const target = state.scene.atoms.get(hit.id)!;
      session.targetAtom = hit.id;
      session.point = null;
      setHover(hit.id, null);
      this.deps.ghost.showBond(from.position, target.position, state.bondOrder);
    } else {
      session.targetAtom = null;
      setHover(null, null);
      const raw = this.pointOnPlane(e.clientX, e.clientY, from.position, this.viewNormal());
      if (raw) {
        const offset = vsub(raw, from.position);
        const distance = vlen(offset);
        // Snap to a typical bond length unless Alt is held for a free-length bond.
        const length = e.altKey ? Math.max(0.5, distance) : idealBondLength(from.protons, state.buildElement, state.bondOrder);
        session.point = distance > 1e-6 ? vadd(from.position, vscale(offset, length / distance)) : null;
        if (session.point) this.deps.ghost.showAtom(from.position, session.point, state.buildElement, state.bondOrder);
        else this.deps.ghost.hide();
      }
    }
    this.deps.invalidate();
  }

  // ---------- keyboard ----------

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    const state = lab.get();
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (this.modal) {
      if (this.onModalKey(e, key)) e.preventDefault();
      return;
    }

    // File and history commands work everywhere except while typing into a field.
    if (mod && !typing) {
      const handled = (() => {
        switch (key) {
          case 'z': return e.shiftKey ? (redo(), true) : (undo(), true);
          case 'y': return redo(), true;
          case 'a': return selectAll(), true;
          case 'c': return copySelection();
          case 'x': return cutSelection(), true;
          case 'v': return pasteClipboard(), true;
          case 'd': return duplicateSelection(), true;
          case 's': return this.deps.onCommand('save');
          case 'o': return this.deps.onCommand('open');
          default: return false;
        }
      })();
      if (handled) {
        e.preventDefault();
        this.deps.invalidate();
      }
      return;
    }
    if (key === 'Escape') {
      if (this.deps.onCommand('escape')) return;
      if (this.session) return this.abortSession();
      if (state.measurePicks.length > 0) return lab.set({ measurePicks: [] });
      clearSelection();
      return;
    }
    if (typing || mod || e.altKey || state.dialog) return;
    // On a display-only stage only viewing, selecting and measuring keys apply.
    if (isReadOnly(state) && READ_ONLY_BLOCKED_KEYS.has(key)) return;

    const handled = (() => {
      switch (key) {
        case 'v': return lab.set({ tool: 'select' }), true;
        case 'a': return lab.set({ tool: 'build' }), true;
        case 'e': return lab.set({ tool: 'erase' }), true;
        case 'm': return lab.set({ tool: 'measure' }), true;
        case 'Delete':
        case 'Backspace': return deleteSelection(), true;
        case 'f': return focusSelection(), true;
        case 'Home': return (e.shiftKey ? viewApi.resetView(true) : viewApi.fitAll(true)), true;
        case 'h': return hydrogenate(), true;
        case 'o': return this.deps.onCommand('optimize');
        case 'g': return this.beginModal('grab');
        case 'r': return this.beginModal('rotate');
        case 'p': return this.deps.onCommand('periodic-table');
        case '?': return this.deps.onCommand('shortcuts');
        case '1': return state.tool === 'build' ? (lab.set({ bondOrder: 1 }), true) : false;
        case '2': return state.tool === 'build' ? (lab.set({ bondOrder: 2 }), true) : false;
        case '3': return state.tool === 'build' ? (lab.set({ bondOrder: 3 }), true) : false;
        case '4': return state.tool === 'build' ? (lab.set({ bondOrder: 1.5 }), true) : false;
        case '5': return lab.set({ projection: state.projection === 'perspective' ? 'orthographic' : 'perspective' }), true;
        default: return false;
      }
    })();
    if (handled) {
      e.preventDefault();
      this.deps.invalidate();
    }
  }

  // ---------- keyboard transforms (grab / rotate) ----------

  private beginModal(mode: 'grab' | 'rotate'): boolean {
    const state = lab.get();
    const ids = new Set(state.selectedAtoms);
    for (const bondId of state.selectedBonds) {
      const bond = state.scene.bonds.get(bondId as BondId);
      if (bond) ids.add(bond.a).add(bond.b);
    }
    if (ids.size === 0) return false;
    const origins = new Map<AtomId, Vec3>();
    for (const id of ids) {
      const atom = state.scene.atoms.get(id);
      if (atom) origins.set(id, atom.position);
    }
    const pivot = vcentroid(origins.values());
    const normal = this.viewNormal();
    const start = this.lastPointer ? this.pointOnPlane(this.lastPointer.x, this.lastPointer.y, pivot, normal) : null;
    this.modal = { mode, origins, pivot, normal, start, axis: null, typed: '', value: 0, delta: [0, 0, 0] };
    this.setCursor(mode === 'grab' ? 'move' : 'alias');
    this.updateModal();
    return true;
  }

  private onModalKey(e: KeyboardEvent, key: string): boolean {
    const modal = this.modal!;
    if (key === 'Escape') return this.cancelModal(), true;
    if (key === 'Enter') return this.confirmModal(), true;
    if (key === 'x' || key === 'y' || key === 'z') {
      modal.axis = modal.axis === key ? null : key;
      this.updateModal();
      return true;
    }
    if (key === 'Backspace') {
      modal.typed = modal.typed.slice(0, -1);
      this.updateModal();
      return true;
    }
    if (/^[0-9.]$/.test(key) || (key === '-' && modal.typed === '')) {
      modal.typed += key;
      this.updateModal();
      return true;
    }
    return !e.ctrlKey && !e.metaKey;
  }

  private updateModal(): void {
    const modal = this.modal;
    if (!modal) return;
    const typedValue = modal.typed !== '' && modal.typed !== '-' && Number.isFinite(Number(modal.typed)) ? Number(modal.typed) : null;
    const pointer = this.lastPointer ? this.pointOnPlane(this.lastPointer.x, this.lastPointer.y, modal.pivot, modal.normal) : null;
    const positions = new Map<AtomId, Vec3>();
    let hud: string;

    if (modal.mode === 'grab') {
      let delta: Vec3 = pointer && modal.start ? vsub(pointer, modal.start) : [0, 0, 0];
      if (modal.axis) {
        const axis = AXES[modal.axis];
        delta = vscale(axis, typedValue ?? vdot(delta, axis));
      } else if (typedValue !== null) {
        const direction = vlen(delta) > 1e-6 ? vnorm(delta) : (viewApi.getBasis()?.right ?? ([1, 0, 0] as Vec3));
        delta = vscale(direction, typedValue);
      }
      modal.delta = delta;
      modal.value = modal.axis ? vdot(delta, AXES[modal.axis]) : vlen(delta);
      for (const [id, origin] of modal.origins) positions.set(id, vadd(origin, delta));
      hud = `Move  ${modal.value.toFixed(3)} Å${modal.axis ? `  along ${modal.axis.toUpperCase()}` : ''}`;
    } else {
      const axis = modal.axis ? AXES[modal.axis] : vscale(modal.normal, -1);
      let degrees = typedValue ?? 0;
      if (typedValue === null && pointer && modal.start) {
        // Signed angle swept by the pointer around the pivot, measured in the view plane.
        const a = vsub(modal.start, modal.pivot);
        const b = vsub(pointer, modal.pivot);
        if (vlen(a) > 1e-6 && vlen(b) > 1e-6) {
          const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
          degrees = (Math.atan2(vdot(cross, vscale(modal.normal, -1)), vdot(a, b)) * 180) / Math.PI;
        }
      }
      modal.value = degrees;
      const unit = vnorm(axis);
      for (const [id, origin] of modal.origins) positions.set(id, vrotateAbout(origin, modal.pivot, unit, (degrees * Math.PI) / 180));
      hud = `Rotate  ${degrees.toFixed(1)}°  about ${modal.axis ? modal.axis.toUpperCase() : 'the view axis'}`;
    }

    this.deps.view.setTransient(positions);
    lab.set({ transformHud: `${hud}${modal.typed ? `  [${modal.typed}]` : ''}` });
    this.deps.invalidate();
  }

  private confirmModal(): void {
    const modal = this.modal;
    if (!modal) return;
    this.modal = null;
    const positions = new Map<AtomId, Vec3>();
    if (modal.mode === 'grab') {
      for (const [id, origin] of modal.origins) positions.set(id, vadd(origin, modal.delta));
    } else {
      const axis = vnorm(modal.axis ? AXES[modal.axis] : vscale(modal.normal, -1));
      for (const [id, origin] of modal.origins) positions.set(id, vrotateAbout(origin, modal.pivot, axis, (modal.value * Math.PI) / 180));
    }
    moveAtoms(positions, modal.mode === 'grab' ? 'Move' : 'Rotate');
    this.deps.view.setTransient(null);
    lab.set({ transformHud: null });
    this.setCursor('default');
    this.deps.invalidate();
  }

  private cancelModal(): void {
    if (!this.modal) return;
    this.modal = null;
    this.deps.view.setTransient(null);
    lab.set({ transformHud: null });
    this.setCursor('default');
    this.deps.invalidate();
  }
}

/**
 * Global keyboard shortcuts for the lab editor (brief item 2's shortcuts, and item 6's
 * "accessible keyboard alternatives" — every shortcut here has no mouse-only equivalent it
 * depends on). Escape is handled by `GestureController` instead, since it is tied to whatever
 * gesture/session is active rather than being a selection-wide command.
 *
 * Shortcuts are ignored while focus is inside a text input/textarea/contenteditable element, so
 * typing in a property field (Agent 01's inspector) never doubles as "delete selection".
 */
import { duplicateInstances, copyInstances, groupInstances, moveInstances, pasteClipboard, redo, removeInstances, resetRotation, setLocked, ungroup, undo } from './commands';
import { labEditor, setSelection } from './editorStore';
import { translateInstances } from './gizmo';
import type { Vec3 } from './types';

const FINE_STEP_M = 0.01;
const COARSE_STEP_M = 0.05;

/** Duck-typed so the shortcut decision logic can be unit-tested with plain objects, not only real DOM `KeyboardEvent`s. */
export interface KeyboardGestureEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  return el.isContentEditable === true || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function nudge(axis: 'x' | 'z', sign: 1 | -1, stepM: number): void {
  const { scene, selection } = labEditor.get();
  const movable = [...selection].filter((id) => !scene.locked.has(id) && scene.apparatus.has(id));
  if (movable.length === 0) return;
  const delta: Vec3 = axis === 'x' ? [sign * stepM, 0, 0] : [0, 0, sign * stepM];
  const origins = new Map(movable.map((id) => [id, scene.apparatus.get(id)!.transform]));
  const next = translateInstances(origins, delta);
  moveInstances([...next].map(([id, transform]) => ({ id, transform })), 'Nudge');
}

function cycleSelection(direction: 1 | -1): void {
  const { scene, selection } = labEditor.get();
  const ids = [...scene.apparatus.keys()];
  if (ids.length === 0) return;
  const current = selection.size === 1 ? ids.indexOf([...selection][0]!) : -1;
  const next = (((current + direction) % ids.length) + ids.length) % ids.length;
  setSelection([ids[next]!]);
}

function toggleLockSelection(): void {
  const { scene, selection } = labEditor.get();
  if (selection.size === 0) return;
  const ids = [...selection];
  const allLocked = ids.every((id) => scene.locked.has(id));
  setLocked(ids, !allLocked);
}

export function handleKeyDown(e: KeyboardGestureEvent): void {
  if (isTypingTarget(e.target)) return;
  const modifier = e.ctrlKey || e.metaKey;
  const selection = labEditor.get().selection;

  if (modifier && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (modifier && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (modifier && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (selection.size > 0) setSelection(duplicateInstances([...selection]));
    return;
  }
  if (modifier && e.key.toLowerCase() === 'c') {
    if (selection.size === 0) return;
    e.preventDefault();
    copyInstances([...selection]);
    return;
  }
  if (modifier && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    const pasted = pasteClipboard();
    if (pasted.length > 0) setSelection(pasted);
    return;
  }
  if (modifier && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    if (e.shiftKey) {
      for (const group of labEditor.get().scene.groups.values()) {
        if (group.memberIds.some((id) => selection.has(id))) ungroup(group.id);
      }
    } else if (selection.size >= 2) {
      groupInstances([...selection]);
    }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection.size === 0) return;
    e.preventDefault();
    removeInstances([...selection]);
    return;
  }
  if (e.key.toLowerCase() === 'l' && !modifier) {
    if (selection.size === 0) return;
    e.preventDefault();
    toggleLockSelection();
    return;
  }
  if (e.key.toLowerCase() === 'r' && !modifier) {
    if (selection.size === 0) return;
    e.preventDefault();
    resetRotation([...selection]);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleSelection(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key.startsWith('Arrow')) {
    const step = e.shiftKey ? COARSE_STEP_M : FINE_STEP_M;
    if (e.key === 'ArrowLeft') nudge('x', -1, step);
    else if (e.key === 'ArrowRight') nudge('x', 1, step);
    else if (e.key === 'ArrowUp') nudge('z', -1, step);
    else if (e.key === 'ArrowDown') nudge('z', 1, step);
    else return;
    e.preventDefault();
  }
}

/** Attaches the shortcut listener; returns a cleanup function (call once, typically from the editor host's top-level effect). */
export function installKeyboardShortcuts(): () => void {
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}

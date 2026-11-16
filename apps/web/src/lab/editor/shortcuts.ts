import type { LabEditorController } from './LabEditorController';

export interface EditorKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
  readonly target?: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}
export function isEditingText(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };
  return !!element.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName ?? '') ||
    !!element.closest?.('[contenteditable="true"],[role="textbox"],[role="combobox"]');
}
/** Scoped to the focused viewport/editor; never install this on document. */
export function handleEditorShortcut(event: EditorKeyEvent, editor: LabEditorController): boolean {
  if (isEditingText(event.target)) return false;
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  const state = editor.getSnapshot();
  let action: (() => void) | undefined;
  if (key === 'escape') action = () => editor.cancel();
  else if (modifier && key === 'z') action = () => { void (event.shiftKey ? editor.redo() : editor.undo()); };
  else if (modifier && key === 'y') action = () => { void editor.redo(); };
  else if (modifier && key === 'a') action = () => editor.selectStation();
  else if (modifier && key === 'c') action = () => { editor.copySelection(); };
  else if (modifier && key === 'v') action = () => { void editor.paste(); };
  else if (modifier && key === 'd') action = () => { void editor.duplicateSelection(); };
  else if (modifier && key === 'g') action = () => { void (event.shiftKey ? editor.ungroupSelection() : editor.groupSelection()); };
  else if (modifier && key === 'l') action = () => {
    void editor.lockSelection(!state.selectedIds.every((id) => state.lockedIds.includes(id)));
  };
  else if (!modifier && !event.altKey) {
    if (key === 'enter' && editor.getPreview()) action = () => { void editor.commitPreview(); };
    else if ((key === 'delete' || key === 'backspace') && state.selectedIds.length) action = () => { void editor.deleteSelection(); };
    else if (key === 'v') action = () => editor.setMode('select');
    else if (key === 'g') action = () => editor.setMode('translate');
    else if (key === 'r') action = () => editor.setMode('rotate');
    else if (key === 'o') action = () => editor.setMode('operate');
    else if (key === 'c') action = () => editor.setMode('connect');
    else if (key === 'f' && state.selectedIds.length) action = () => { editor.focusSelection(); };
    else if (state.selectedIds.length) {
      const step = event.shiftKey ? 0.001 : state.snapM || 0.01;
      if (key === 'arrowleft') action = () => { void editor.translateSelection([-step, 0, 0]); };
      if (key === 'arrowright') action = () => { void editor.translateSelection([step, 0, 0]); };
      if (key === 'arrowup') action = () => { void editor.translateSelection([0, 0, -step]); };
      if (key === 'arrowdown') action = () => { void editor.translateSelection([0, 0, step]); };
      if (key === 'q' || key === 'e') action = () => {
        void editor.rotateSelection('Y', (key === 'q' ? -1 : 1) * (event.shiftKey ? 1 : state.angleStepDeg));
      };
    }
  }
  if (!action) return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat || key.startsWith('arrow')) action();
  return true;
}

export const EDITOR_SHORTCUTS = [
  ['V / G / R / O / C', 'Select / move / rotate / operate / connect'],
  ['Arrows · Shift + arrows', 'Move on the grid · move by 1 mm'],
  ['Q / E · Shift', 'Rotate about Y · 1° precision'],
  ['Ctrl/⌘ + Z · Shift + Z', 'Preparation undo · redo (not experiment reversal)'],
  ['Ctrl/⌘ + C / V / D', 'Copy geometry / paste empty / duplicate empty'],
  ['Ctrl/⌘ + G · Shift + G', 'Group · ungroup'],
  ['Ctrl/⌘ + L', 'Lock / unlock'],
  ['Ctrl/⌘ + A · F', 'Select workstation · focus selection'],
  ['Enter · Escape · Delete', 'Commit preview · cancel · remove empty apparatus'],
] as const;

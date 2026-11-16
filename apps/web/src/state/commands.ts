import {
  FILE_FORMATS,
  MoleculeParseError,
  SceneFormatError,
  detectFileFormat,
  exportMolecule,
  findFileFormat,
  importMolecules,
  sortedAtoms,
} from '@matterlab/core';
import type { FileFormatId, ImportResult, Scene } from '@matterlab/core';
import { optimizeGeometry } from '../compute/store';
import { viewApi } from '../render/viewApi';
import { enterWorkspace, insertScene, notify, replaceDocument, selectOnly } from './actions';
import { PROJECT_FORMAT, buildProjectFile, openProjectFile, saveCurrentProject } from './persistence';
import { lab } from './store';

export type Command = 'save' | 'open' | 'periodic-table' | 'shortcuts' | 'escape' | 'optimize';

/** Application-level commands triggered from the keyboard. Returns whether the command did something. */
export function runCommand(command: Command): boolean {
  switch (command) {
    case 'save':
      void saveCurrentProject();
      return true;
    case 'open':
      lab.set({ dialog: 'library' });
      return true;
    case 'periodic-table':
      lab.set({ dialog: 'periodic-table' });
      return true;
    case 'shortcuts':
      lab.set({ dialog: 'shortcuts' });
      return true;
    case 'optimize':
      if (lab.get().workspace !== 'architect') return false;
      lab.set({ inspectorOpen: true, inspectorTab: 'compute' });
      void optimizeGeometry();
      return true;
    case 'escape':
      if (!lab.get().dialog) return false;
      lab.set({ dialog: null });
      return true;
  }
}

export function downloadText(fileName: string, text: string, mimeType: string): void {
  downloadUrl(fileName, URL.createObjectURL(new Blob([text], { type: mimeType })), true);
}

function downloadUrl(fileName: string, url: string, revoke: boolean): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (revoke) window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFileName(name: string): string {
  return (name.trim() || 'untitled').replace(/[^\w.\- ()]+/g, '_').slice(0, 80);
}

/** Saves the structure in a chemistry file format, telling the user what that format cannot hold. */
export function exportStructure(formatId: FileFormatId): void {
  const { scene, projectName } = lab.get();
  if (scene.atoms.size === 0) {
    notify('info', 'There is nothing to export yet');
    return;
  }
  const format = findFileFormat(formatId);
  try {
    const text = exportMolecule(formatId, scene, projectName);
    downloadText(`${safeFileName(projectName)}.${format.extensions[0]}`, text, format.mimeType);
    notify('success', `Exported as ${format.label}`, format.loses === 'Nothing.' ? undefined : `Not preserved: ${format.loses}`);
  } catch (error) {
    notify('error', 'Export failed', error instanceof Error ? error.message : undefined);
  }
}

/** Saves the complete project (scene, measurements, view) as a file the user can keep or share. */
export function exportProject(): void {
  const file = buildProjectFile();
  downloadText(`${safeFileName(file.name)}.matterlab.json`, `${JSON.stringify(file, null, 1)}\n`, 'application/json');
  notify('success', 'Project file downloaded');
}

export async function exportImage(): Promise<void> {
  const dataUrl = await viewApi.capture();
  if (!dataUrl) {
    notify('error', 'The view could not be captured');
    return;
  }
  downloadUrl(`${safeFileName(lab.get().projectName)}.png`, dataUrl, false);
}

function widthAlongX(scene: Scene): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const atom of scene.atoms.values()) {
    min = Math.min(min, atom.position[0]);
    max = Math.max(max, atom.position[0]);
  }
  return scene.atoms.size === 0 ? { min: 0, max: 0 } : { min, max };
}

/**
 * Puts a finished structure in the Architect: `replace` opens it as a new document, `insert` adds
 * it beside what is already there as one undoable edit and selects it.
 */
export function placeStructure(scene: Scene, name: string, mode: 'replace' | 'insert'): void {
  if (lab.get().workspace !== 'architect') enterWorkspace('architect');
  if (mode === 'replace' || lab.get().scene.atoms.size === 0) {
    replaceDocument(scene, name);
    return;
  }
  const existing = widthAlongX(lab.get().scene);
  const added = insertScene(scene, `Insert ${name}`, [existing.max + 3.5 - widthAlongX(scene).min, 0, 0]);
  if (added) {
    selectOnly(added);
    viewApi.fitAll(true);
  }
}

/** Merges several imported molecules into one scene, laid out side by side so they do not overlap. */
function combine(results: readonly ImportResult[]): { scenes: Array<{ scene: Scene; offset: number }> } {
  const scenes: Array<{ scene: Scene; offset: number }> = [];
  let cursor = 0;
  for (const result of results) {
    const { min, max } = widthAlongX(result.scene);
    scenes.push({ scene: result.scene, offset: cursor - min });
    cursor += max - min + 3.5;
  }
  return { scenes };
}

/**
 * Reads a chemistry or project file. `replace` opens it as a new document; `insert` adds its
 * molecules to the current workspace as one undoable edit.
 */
export function importText(fileName: string, text: string, mode: 'replace' | 'insert'): void {
  const formatId = detectFileFormat(fileName, text);
  if (!formatId) {
    notify('error', 'Unrecognised file', `Supported formats: ${FILE_FORMATS.map((f) => f.label).join(', ')}.`);
    return;
  }
  const baseName = fileName.replace(/\.[^.]+$/, '').replace(/\.matterlab$/, '');
  try {
    if (formatId === 'matterlab') {
      const json = JSON.parse(text) as { format?: string };
      if (json.format === PROJECT_FORMAT && mode === 'replace') {
        openProjectFile(json);
        notify('success', `Opened “${lab.get().projectName}”`);
        return;
      }
    }
    const results = importMolecules(formatId, text);
    const warnings = [...new Set(results.flatMap((r) => r.warnings))];
    const name = results[0]?.name || baseName;
    const { scenes } = combine(results);

    if (mode === 'replace' || lab.get().scene.atoms.size === 0) {
      replaceDocument(scenes[0]!.scene, name);
      for (const extra of scenes.slice(1)) insertScene(extra.scene, 'Import molecule', [extra.offset, 0, 0]);
      // A freshly opened file starts with a clean history and no unsaved-changes marker.
      lab.set((s) => ({ history: { past: [], future: [] }, savedRevision: s.revision }));
      viewApi.fitAll(false);
    } else {
      const existing = widthAlongX(lab.get().scene);
      const added: number[] = [];
      for (const part of scenes) {
        const ids = insertScene(part.scene, `Insert ${name}`, [existing.max + 3.5 + part.offset, 0, 0]);
        if (ids) added.push(...ids);
      }
      selectOnly(added);
      viewApi.fitAll(true);
    }

    const count = results.reduce((n, r) => n + sortedAtoms(r.scene).length, 0);
    const summary = `${count} atom${count === 1 ? '' : 's'}${results.length > 1 ? ` in ${results.length} molecules` : ''} from ${findFileFormat(formatId).label}`;
    if (warnings.length > 0) notify('warning', `Imported ${summary}`, warnings.join(' '));
    else notify('success', `Imported ${summary}`);
  } catch (error) {
    if (error instanceof MoleculeParseError || error instanceof SceneFormatError || error instanceof SyntaxError) {
      notify('error', `“${fileName}” could not be read`, error instanceof SyntaxError ? 'The file is not valid JSON.' : error.message);
      return;
    }
    throw error;
  }
}

export async function importFile(file: File, mode: 'replace' | 'insert'): Promise<void> {
  if (file.size > 64 * 1024 * 1024) {
    notify('error', 'That file is too large', 'Files up to 64 MB can be imported.');
    return;
  }
  importText(file.name, await file.text(), mode);
}

/** Opens the system file picker for structure and project files. */
export function pickFile(mode: 'replace' | 'insert'): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = FILE_FORMATS.flatMap((f) => f.extensions.map((e) => `.${e.split('.').pop()}`)).join(',');
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void importFile(file, mode);
  };
  input.click();
}

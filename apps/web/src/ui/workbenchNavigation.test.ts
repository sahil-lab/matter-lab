import { editScene } from '@matterlab/core';
import { afterEach, describe, expect, it } from 'vitest';
import { enterWorkspace } from '../state/actions';
import { initialState, lab } from '../state/store';
import type { Workspace } from '../state/store';
import { openLaboratory, returnToMolecular, useWorkbenchNavigation } from './workbenchNavigation';

afterEach(() => { lab.set(initialState(), true); returnToMolecular(); });

describe('meter-scale laboratory navigation', () => {
  for (const workspace of ['architect', 'reactions', 'vault'] satisfies Workspace[]) {
    it(`preserves the dirty molecular document and ${workspace} workspace by identity when entering and returning`, () => {
      const initial = initialState();
      const firstAtom = [...initial.scene.atoms.values()][0]!;
      const edited = editScene(initial.scene, 'Unsaved edit', (editor) => editor.moveAtom(firstAtom.id, [1.25, -.5, .33]));
      lab.set({ ...initial, scene: edited.scene, revision: 7, savedRevision: 6, selectedAtoms: new Set([firstAtom.id]) }, true);
      if (workspace !== 'architect') enterWorkspace(workspace);
      const before = lab.get();
      const documentBefore = before.parked?.document ?? before;
      const positionBefore = documentBefore.scene.atoms.get(firstAtom.id)!.position;

      openLaboratory();
      expect(useWorkbenchNavigation.getState().surface).toBe('laboratory');
      expect(lab.get()).toBe(before);
      returnToMolecular();
      expect(useWorkbenchNavigation.getState().surface).toBe('molecular');
      expect(lab.get()).toBe(before);
      expect(lab.get().workspace).toBe(workspace);
      const documentAfter = lab.get().parked?.document ?? lab.get();
      expect(documentAfter.scene).toBe(documentBefore.scene);
      expect(documentAfter.history).toBe(documentBefore.history);
      expect(documentAfter.selectedAtoms).toBe(documentBefore.selectedAtoms);
      expect(documentAfter.savedRevision).toBe(6);
      expect(documentAfter.scene.atoms.get(firstAtom.id)!.position).toBe(positionBefore);
      expect(positionBefore).toEqual([1.25, -.5, .33]);
    });
  }
});

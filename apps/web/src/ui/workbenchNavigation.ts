import { create } from 'zustand';

export type WorkbenchSurface = 'molecular' | 'laboratory';

/** Presentation routing only: never enters the old molecular Scene workspace state machine. */
export const useWorkbenchNavigation = create<{ readonly surface: WorkbenchSurface }>(() => ({ surface: 'molecular' }));

export function openLaboratory(): void {
  useWorkbenchNavigation.setState({ surface: 'laboratory' });
}

export function returnToMolecular(): void {
  useWorkbenchNavigation.setState({ surface: 'molecular' });
}

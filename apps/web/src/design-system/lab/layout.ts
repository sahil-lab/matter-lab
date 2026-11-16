import type { LabPanelId, LabPanelVisibility } from './types';

export const DEFAULT_LAB_PANELS: LabPanelVisibility = { library: true, inspector: false, timeline: false };
export const LAB_PANEL_LIMITS = {
  library: { min: 220, max: 380, initial: 236 },
  inspector: { min: 260, max: 420, initial: 300 },
  timeline: { min: 160, max: 360, initial: 220 },
} as const;

export function clampPanelSize(panel: LabPanelId, value: number): number {
  const { min, max, initial } = LAB_PANEL_LIMITS[panel];
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : initial;
}

/** Compact layouts use one side drawer at a time; closing a drawer never opens another. */
export function changePanelVisibility(
  current: LabPanelVisibility,
  panel: LabPanelId,
  open: boolean,
  compact: boolean,
): LabPanelVisibility {
  return {
    ...current,
    ...(compact && open && panel !== 'timeline' ? { library: false, inspector: false } : {}),
    [panel]: open,
  };
}

export function resizePanelWithKey(panel: LabPanelId, current: number, key: string, coarse = false): number | null {
  const bounds = LAB_PANEL_LIMITS[panel];
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  const increase = panel === 'library' ? 'ArrowRight' : panel === 'inspector' ? 'ArrowLeft' : 'ArrowUp';
  const decrease = panel === 'library' ? 'ArrowLeft' : panel === 'inspector' ? 'ArrowRight' : 'ArrowDown';
  if (key !== increase && key !== decrease) return null;
  return clampPanelSize(panel, current + (key === increase ? 1 : -1) * (coarse ? 40 : 10));
}

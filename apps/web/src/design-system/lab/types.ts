import type { ReactNode } from 'react';

export type LabPanelId = 'library' | 'inspector' | 'timeline';
export type LabPanelVisibility = Readonly<Record<LabPanelId, boolean>>;
export type LabMotionPreference = 'system' | 'reduced' | 'full';
export type LabSurfaceStatus = 'empty' | 'loading' | 'warning' | 'offline' | 'error' | 'unsupported';
export type LabTone = 'neutral' | 'cool' | 'warm' | 'success' | 'danger';

export interface LabSurfaceAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

export interface LabInteractionFeedback {
  readonly mode: 'idle' | 'placing' | 'dragging' | 'connecting' | 'valid' | 'invalid';
  readonly label?: string;
  readonly detail?: string;
  readonly pointerCaptured?: boolean;
}

/** Presentation slots only. The laboratory runtime and its meter-scale canvas stay outside the shell. */
export interface LabShellSlots {
  readonly viewport: ReactNode;
  readonly library?: ReactNode;
  readonly inspector?: ReactNode;
  readonly timeline?: ReactNode;
  readonly tutorial?: ReactNode;
  readonly hud?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly status?: ReactNode;
  readonly entry?: ReactNode;
}

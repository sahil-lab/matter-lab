import type { Scene } from '@matterlab/core';
import { useEffect, useState } from 'react';

/**
 * Above this many atoms, analyses that look at the whole structure (rule-based validation, counting
 * molecules, valence bookkeeping) are no longer done inside the edit that changes the scene. They
 * cost tens to hundreds of milliseconds there, which is the difference between an edit that shows
 * at once and one that stutters. They run once editing pauses instead.
 */
export const DEFERRED_ANALYSIS_ATOMS = 2000;

const PAUSE_MS = 180;

export interface SettledScene {
  /** The scene to analyse: the current one, or for a large structure the last one editing paused on. */
  readonly scene: Scene;
  /** True while `scene` is not the current scene, so that results can be shown as being worked out. */
  readonly pending: boolean;
}

/** The scene whole-structure analyses should run on. See `DEFERRED_ANALYSIS_ATOMS`. */
export function useSettledScene(current: Scene): SettledScene {
  const [settled, setSettled] = useState(current);
  const large = current.atoms.size > DEFERRED_ANALYSIS_ATOMS;
  useEffect(() => {
    if (!large || settled === current) return;
    const timer = window.setTimeout(() => setSettled(current), PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [current, settled, large]);
  return large ? { scene: settled, pending: settled !== current } : { scene: current, pending: false };
}

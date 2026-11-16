import type { NucleusModel } from './model';

/**
 * What the nucleus view currently shows, for automated tests: the model on screen, the nucleon
 * that is selected, whether the zoom from the atom has finished, what the scale bar says, and
 * where a nucleon is on screen. The view fills this in while it is open.
 */
export interface NucleusApi {
  model: NucleusModel | null;
  selected: number | null;
  introDone: boolean;
  /** The length the scale bar stands for, in femtometre, and how long the bar is on screen. */
  scaleFm: number | null;
  scaleBarPx: number | null;
  /** Viewport coordinates of the centre of a nucleon, or `null` when the view is closed. */
  screenPoint(index: number): [number, number] | null;
}

export const nucleusApi: NucleusApi = {
  model: null,
  selected: null,
  introDone: false,
  scaleFm: null,
  scaleBarPx: null,
  screenPoint: () => null,
};

export function resetNucleusApi(): void {
  nucleusApi.model = null;
  nucleusApi.selected = null;
  nucleusApi.introDone = false;
  nucleusApi.scaleFm = null;
  nucleusApi.scaleBarPx = null;
  nucleusApi.screenPoint = () => null;
}

import type { GridSpec, QmAtom } from '../types';

export interface GridOptions {
  /** Distance between grid points in angstrom. Default 0.2. */
  readonly spacing?: number;
  /** Margin added around the bounding box of the nuclei on every side, in angstrom. Default 3.0. */
  readonly padding?: number;
  /** Upper limit on the number of grid points; the spacing grows until the grid fits. Default 2 000 000. */
  readonly maxPoints?: number;
}

export const DEFAULT_GRID_SPACING = 0.2;
export const DEFAULT_GRID_PADDING = 3.0;
export const DEFAULT_GRID_MAX_POINTS = 2_000_000;

/**
 * A regular grid with cubic cells that covers the nuclei plus `padding` on every side. The grid is
 * centred on the bounding box of the nuclei. If `spacing` would need more than `maxPoints` points,
 * the spacing is increased (uniformly in all three directions) until the grid fits, so always read
 * the spacing actually used from the returned `GridSpec`.
 *
 * All lengths are in angstrom.
 */
export function createGrid(atoms: readonly QmAtom[], options: GridOptions = {}): GridSpec {
  const padding = options.padding ?? DEFAULT_GRID_PADDING;
  const maxPoints = options.maxPoints ?? DEFAULT_GRID_MAX_POINTS;
  let spacing = options.spacing ?? DEFAULT_GRID_SPACING;
  if (atoms.length === 0) throw new RangeError('createGrid needs at least one atom.');
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError('Grid spacing must be a positive number.');
  if (!(padding >= 0) || !Number.isFinite(padding)) throw new RangeError('Grid padding must be a non-negative number.');
  if (!Number.isInteger(maxPoints) || maxPoints < 8) throw new RangeError('maxPoints must be an integer of at least 8.');

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const atom of atoms) {
    for (let axis = 0; axis < 3; axis++) {
      const c = atom.position[axis];
      if (!Number.isFinite(c)) throw new RangeError('createGrid: atom positions must be finite.');
      if (c < lo[axis]) lo[axis] = c;
      if (c > hi[axis]) hi[axis] = c;
    }
  }
  const extent = [hi[0] - lo[0] + 2 * padding, hi[1] - lo[1] + 2 * padding, hi[2] - lo[2] + 2 * padding];

  const dims: [number, number, number] = [2, 2, 2];
  for (;;) {
    for (let axis = 0; axis < 3; axis++) {
      // The tolerance keeps an extent that is an exact multiple of the spacing from gaining a point through rounding.
      dims[axis] = Math.max(2, Math.ceil(extent[axis] / spacing - 1e-9) + 1);
    }
    const points = dims[0] * dims[1] * dims[2];
    if (points <= maxPoints) break;
    spacing *= Math.max(1.0005, Math.cbrt(points / maxPoints));
  }

  const origin: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    origin[axis] = 0.5 * (lo[axis] + hi[axis]) - 0.5 * (dims[axis] - 1) * spacing;
  }
  return { origin, spacing: [spacing, spacing, spacing], dims };
}

/** Throws unless the grid has finite origin and spacing, positive spacing and integer dimensions >= 1. */
export function assertValidGrid(grid: GridSpec): void {
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(grid.origin[axis])) throw new RangeError('Grid origin must be finite.');
    if (!(grid.spacing[axis] > 0) || !Number.isFinite(grid.spacing[axis])) throw new RangeError('Grid spacing must be positive and finite.');
    if (!Number.isInteger(grid.dims[axis]) || grid.dims[axis] < 1) throw new RangeError('Grid dimensions must be positive integers.');
  }
}

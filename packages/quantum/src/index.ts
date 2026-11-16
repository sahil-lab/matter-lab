/**
 * @matterlab/quantum: ab initio electronic structure in the browser.
 *
 * Restricted Hartree-Fock with the STO-3G basis for closed-shell molecules of H-Ar, evaluation of
 * the resulting orbitals, electron density and electrostatic potential, and isosurface extraction.
 * See the package README for methods, units, validation and limitations.
 */
export type {
  BasisFunctionInfo,
  GridSpec,
  IsoMesh,
  QmAtom,
  QmInput,
  ScfIteration,
  ScfOptions,
  ScfResult,
  SupportOptions,
  SupportReport,
} from './types';

export { UnsupportedSystemError } from './errors';
export { checkSupport, DEFAULT_MAX_BASIS_FUNCTIONS, HARD_MAX_BASIS_FUNCTIONS, MIN_NUCLEAR_SEPARATION } from './support';
export { runRhf, virialRatio } from './runRhf';
export { DEFAULT_DENSITY_TOLERANCE, DEFAULT_ENERGY_TOLERANCE, DEFAULT_MAX_ITERATIONS } from './scf/rhf';
export { ENGINE_NAME, ENGINE_VERSION } from './provenance';
export { createGrid, DEFAULT_GRID_MAX_POINTS, DEFAULT_GRID_PADDING, DEFAULT_GRID_SPACING } from './fields/grid';
export type { GridOptions } from './fields/grid';
export { evaluateDensityAtPoints, evaluateDensityGrid, evaluateOrbitalAtPoints, evaluateOrbitalGrid, FIELD_AMPLITUDE_CUTOFF } from './fields/evaluate';
export { evaluateEspAtPoints } from './fields/esp';
export { marchingCubes, meshStatistics } from './mesh/marchingCubes';
export type { MeshStatistics } from './mesh/marchingCubes';

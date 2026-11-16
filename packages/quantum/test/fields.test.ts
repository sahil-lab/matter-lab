import { ANGSTROM_TO_BOHR, BOHR_TO_ANGSTROM } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import { densityAtPointsWithCutoff, densityGridWithCutoff, FIELD_AMPLITUDE_CUTOFF, orbitalAtPointsWithCutoff } from '../src/fields/evaluate';
import { electrostaticPotential } from '../src/fields/esp';
import {
  createGrid,
  evaluateDensityAtPoints,
  evaluateDensityGrid,
  evaluateEspAtPoints,
  evaluateOrbitalAtPoints,
  evaluateOrbitalGrid,
  marchingCubes,
  meshStatistics,
  runRhf,
  UnsupportedSystemError,
} from '../src/index';
import type { GridSpec, QmInput, ScfResult } from '../src/index';
import { findMolecule, pyscfFixture, toInput } from './helpers/pyscf';
import { validationReporter } from './helpers/report';

const record = validationReporter('fields');
const TIGHT = { energyTolerance: 1e-12, densityTolerance: 1e-10 };

function gridPoints(grid: GridSpec): Float32Array {
  const [nx, ny, nz] = grid.dims;
  const points = new Float32Array(3 * nx * ny * nz);
  let k = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        points[k++] = grid.origin[0] + ix * grid.spacing[0];
        points[k++] = grid.origin[1] + iy * grid.spacing[1];
        points[k++] = grid.origin[2] + iz * grid.spacing[2];
      }
    }
  }
  return points;
}

/** Sum of grid values times the cell volume in bohr^3. */
function integrate(values: Float32Array, grid: GridSpec, weight?: Float32Array): number {
  let sum = 0;
  for (let k = 0; k < values.length; k++) sum += weight ? values[k] * weight[k] : values[k];
  return sum * grid.spacing[0] * grid.spacing[1] * grid.spacing[2] * ANGSTROM_TO_BOHR ** 3;
}

describe('createGrid', () => {
  const atoms = toInput(findMolecule('H2O', 'canonical')).atoms;

  it('uses 0.2 angstrom spacing and 3 angstrom padding by default and encloses the molecule', () => {
    const grid = createGrid(atoms);
    expect(grid.spacing).toEqual([0.2, 0.2, 0.2]);
    for (let axis = 0; axis < 3; axis++) {
      const lo = Math.min(...atoms.map((atom) => atom.position[axis]));
      const hi = Math.max(...atoms.map((atom) => atom.position[axis]));
      const end = grid.origin[axis] + (grid.dims[axis] - 1) * grid.spacing[axis];
      expect(grid.origin[axis]).toBeLessThanOrEqual(lo - 3 + 1e-9);
      expect(end).toBeGreaterThanOrEqual(hi + 3 - 1e-9);
      // No more than one cell of slack in total, and centred on the molecule.
      expect(end - grid.origin[axis]).toBeLessThan(hi - lo + 6 + 0.2 + 1e-9);
      expect(Math.abs((grid.origin[axis] + end) / 2 - (lo + hi) / 2)).toBeLessThan(1e-9);
      expect(Number.isInteger(grid.dims[axis])).toBe(true);
    }
  });

  it('honours spacing and padding and gives a single atom a cube', () => {
    const grid = createGrid([{ z: 10, position: [1, 2, 3] }], { spacing: 0.25, padding: 2 });
    expect(grid.dims).toEqual([17, 17, 17]);
    expect(grid.spacing).toEqual([0.25, 0.25, 0.25]);
    expect(grid.origin[0]).toBeCloseTo(-1, 12);
    expect(grid.origin[1]).toBeCloseTo(0, 12);
    expect(grid.origin[2]).toBeCloseTo(1, 12);
  });

  it('grows the spacing until the grid fits into maxPoints', () => {
    const fine = createGrid(atoms, { spacing: 0.02 });
    expect(fine.dims[0] * fine.dims[1] * fine.dims[2]).toBeLessThanOrEqual(2_000_000);
    expect(fine.spacing[0]).toBeGreaterThan(0.02);
    expect(fine.spacing[0]).toBe(fine.spacing[1]);
    expect(fine.spacing[1]).toBe(fine.spacing[2]);
    // The limit is used well: at least 90 % of the allowed points.
    expect(fine.dims[0] * fine.dims[1] * fine.dims[2]).toBeGreaterThan(1_800_000);
    const coarse = createGrid(atoms, { maxPoints: 1000 });
    expect(coarse.dims[0] * coarse.dims[1] * coarse.dims[2]).toBeLessThanOrEqual(1000);
    expect(coarse.spacing[0]).toBeGreaterThan(0.2);
    const end = coarse.origin[0] + (coarse.dims[0] - 1) * coarse.spacing[0];
    expect(end).toBeGreaterThanOrEqual(Math.max(...atoms.map((atom) => atom.position[0])) + 3 - 1e-9);
  });

  it('rejects meaningless arguments', () => {
    expect(() => createGrid([])).toThrow(RangeError);
    expect(() => createGrid(atoms, { spacing: 0 })).toThrow(RangeError);
    expect(() => createGrid(atoms, { spacing: Number.NaN })).toThrow(RangeError);
    expect(() => createGrid(atoms, { padding: -1 })).toThrow(RangeError);
    expect(() => createGrid(atoms, { maxPoints: 4 })).toThrow(RangeError);
    expect(() => createGrid([{ z: 1, position: [0, Number.NaN, 0] }])).toThrow(RangeError);
  });
});

describe('fields against PySCF at sample points', () => {
  const fixture = pyscfFixture();

  it.each(fixture.fields.map((set) => [set.name, set] as const))('%s: density, orbitals and electrostatic potential', (name, reference) => {
    const molecule = findMolecule(name);
    const input = toInput(molecule);
    const result = runRhf(input, TIGHT);
    const points = reference.pointsAngstrom.flat();
    const count = reference.pointsAngstrom.length;

    const density = densityAtPointsWithCutoff(result, input, points, 0);
    const potential = electrostaticPotential(result, input, points);
    let densityDeviation = 0;
    let potentialDeviation = 0;
    let largestDensity = 0;
    let largestPotential = 0;
    for (let k = 0; k < count; k++) {
      densityDeviation = Math.max(densityDeviation, Math.abs(density[k] - reference.density[k]));
      potentialDeviation = Math.max(potentialDeviation, Math.abs(potential[k] - reference.esp[k]));
      largestDensity = Math.max(largestDensity, reference.density[k]);
      largestPotential = Math.max(largestPotential, Math.abs(reference.esp[k]));
    }

    // Orbitals are compared up to their arbitrary sign, and only where the orbital energy is not
    // degenerate (degenerate orbitals may be rotated among themselves).
    let orbitalDeviation = 0;
    let orbitalsCompared = 0;
    const energies = molecule.orbitalEnergies;
    for (let i = 0; i < result.nBasis; i++) {
      const isolated = (i === 0 || energies[i] - energies[i - 1] > 1e-3) && (i === result.nBasis - 1 || energies[i + 1] - energies[i] > 1e-3);
      if (!isolated) continue;
      const values = orbitalAtPointsWithCutoff(result, input, i, points, 0);
      let same = 0;
      let opposite = 0;
      for (let k = 0; k < count; k++) {
        same = Math.max(same, Math.abs(values[k] - reference.orbitals[i][k]));
        opposite = Math.max(opposite, Math.abs(values[k] + reference.orbitals[i][k]));
      }
      orbitalDeviation = Math.max(orbitalDeviation, Math.min(same, opposite));
      orbitalsCompared++;
    }

    record(`pyscf/${name}`, { points: count, densityDeviation, largestDensity, potentialDeviation, largestPotential, orbitalDeviation, orbitalsCompared });
    expect(orbitalsCompared).toBeGreaterThan(0);
    expect(densityDeviation).toBeLessThan(1e-9);
    expect(orbitalDeviation).toBeLessThan(1e-8);
    expect(potentialDeviation).toBeLessThan(1e-8);
  });
});

describe('density and orbital grids', () => {
  const input = toInput(findMolecule('H2O'));
  const result = runRhf(input);
  const grid = createGrid(input.atoms, { spacing: 0.25, padding: 3 });
  const points = gridPoints(grid);
  const density = evaluateDensityGrid(result, input, grid);

  it('has one value per grid point in x-fastest order, equal to point-wise evaluation', () => {
    expect(density).toBeInstanceOf(Float32Array);
    expect(density.length).toBe(grid.dims[0] * grid.dims[1] * grid.dims[2]);
    const direct = evaluateDensityAtPoints(result, input, points);
    let worst = 0;
    for (let k = 0; k < density.length; k++) worst = Math.max(worst, Math.abs(density[k] - direct[k]) / (1 + Math.abs(direct[k])));
    // Both are single precision; the grid coordinates of the point version went through float32.
    expect(worst).toBeLessThan(2e-5);
    expect(Math.min(...density)).toBeGreaterThanOrEqual(0);
  });

  it('is unaffected by the skipping of negligible primitives beyond its documented bound', () => {
    const unscreened = densityGridWithCutoff(result, input, grid, 0);
    let worst = 0;
    let largest = 0;
    for (let k = 0; k < density.length; k++) {
      worst = Math.max(worst, Math.abs(density[k] - unscreened[k]));
      largest = Math.max(largest, unscreened[k]);
    }
    const exact = densityAtPointsWithCutoff(result, input, points, 0);
    const screened = densityAtPointsWithCutoff(result, input, points, FIELD_AMPLITUDE_CUTOFF);
    let worstPoints = 0;
    for (let k = 0; k < exact.length; k++) worstPoints = Math.max(worstPoints, Math.abs(exact[k] - screened[k]));
    record('screening', { gridDeviation: worst, pointDeviation: worstPoints, largestDensity: largest, cutoff: FIELD_AMPLITUDE_CUTOFF });
    expect(worstPoints).toBeLessThan(1e-8);
    // Single precision on top of the screening error.
    expect(worst).toBeLessThan(1e-8 + 1e-6 * largest);
  });

  it('gives orbital grids equal to point-wise evaluation, with orthonormal orbitals under numerical integration', () => {
    const homo = evaluateOrbitalGrid(result, input, result.homoIndex, grid);
    const direct = evaluateOrbitalAtPoints(result, input, result.homoIndex, points);
    let worst = 0;
    for (let k = 0; k < homo.length; k++) worst = Math.max(worst, Math.abs(homo[k] - direct[k]));
    expect(worst).toBeLessThan(2e-5);

    // Simple summation over a regular grid is a crude quadrature for functions with a tight
    // oxygen 2p/2s part: at 0.25 angstrom the norms come out within about 1 % (observed: HOMO
    // 1.0050, LUMO 1.0091, HOMO-1 0.9873; overlaps 0.0047 and -0.0013) ...
    const lumo = evaluateOrbitalGrid(result, input, result.lumoIndex!, grid);
    const below = evaluateOrbitalGrid(result, input, result.homoIndex - 1, grid);
    const coarse = {
      spacing: grid.spacing[0],
      norms: { homo: integrate(homo, grid, homo), lumo: integrate(lumo, grid, lumo), below: integrate(below, grid, below) },
      overlaps: { homoLumo: integrate(homo, grid, lumo), homoBelow: integrate(homo, grid, below) },
    };
    expect(Math.abs(coarse.norms.homo - 1)).toBeLessThan(0.02);
    expect(Math.abs(coarse.norms.lumo - 1)).toBeLessThan(0.02);
    expect(Math.abs(coarse.norms.below - 1)).toBeLessThan(0.03);
    expect(Math.abs(coarse.overlaps.homoLumo)).toBeLessThan(0.01);
    expect(Math.abs(coarse.overlaps.homoBelow)).toBeLessThan(0.01);

    // ... and at 0.1 angstrom the pure-p HOMO has unit norm to 1e-8 and is orthogonal to the other
    // two to 1e-5, while orbitals with oxygen 1s/2s character still carry the quadrature error of
    // the core region (observed norms 0.9986 and 0.9990).
    const fineGrid = createGrid(input.atoms, { spacing: 0.1, padding: 4 });
    const fineHomo = evaluateOrbitalGrid(result, input, result.homoIndex, fineGrid);
    const fineLumo = evaluateOrbitalGrid(result, input, result.lumoIndex!, fineGrid);
    const fineBelow = evaluateOrbitalGrid(result, input, result.homoIndex - 1, fineGrid);
    const fine = {
      spacing: fineGrid.spacing[0],
      norms: { homo: integrate(fineHomo, fineGrid, fineHomo), lumo: integrate(fineLumo, fineGrid, fineLumo), below: integrate(fineBelow, fineGrid, fineBelow) },
      overlaps: { homoLumo: integrate(fineHomo, fineGrid, fineLumo), homoBelow: integrate(fineHomo, fineGrid, fineBelow) },
    };
    record('orbital-integrals', { coarse, fine });
    expect(Math.abs(fine.norms.homo - 1)).toBeLessThan(1e-6);
    expect(Math.abs(fine.norms.lumo - 1)).toBeLessThan(0.005);
    expect(Math.abs(fine.norms.below - 1)).toBeLessThan(0.005);
    expect(Math.abs(fine.overlaps.homoLumo)).toBeLessThan(2e-5);
    expect(Math.abs(fine.overlaps.homoBelow)).toBeLessThan(2e-5);
  });

  it('reports progress from 0 to 1 and rejects bad arguments', () => {
    const fractions: number[] = [];
    evaluateDensityGrid(result, input, grid, (fraction) => fractions.push(fraction));
    expect(fractions.length).toBe(grid.dims[2]);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    const orbitalFractions: number[] = [];
    evaluateOrbitalGrid(result, input, 0, grid, (fraction) => orbitalFractions.push(fraction));
    expect(orbitalFractions[orbitalFractions.length - 1]).toBe(1);

    expect(() => evaluateOrbitalGrid(result, input, -1, grid)).toThrow(RangeError);
    expect(() => evaluateOrbitalGrid(result, input, result.nBasis, grid)).toThrow(RangeError);
    expect(() => evaluateOrbitalGrid(result, input, 1.5, grid)).toThrow(RangeError);
    expect(() => evaluateDensityGrid(result, input, { ...grid, spacing: [0.2, -0.2, 0.2] })).toThrow(RangeError);
    expect(() => evaluateDensityGrid(result, input, { ...grid, dims: [10, 0, 10] })).toThrow(RangeError);
    expect(() => evaluateDensityAtPoints(result, input, new Float32Array(4))).toThrow(RangeError);
  });

  it('refuses a result that does not belong to the input, an unsupported input and an empty result', () => {
    const other = toInput(findMolecule('NH3'));
    expect(() => evaluateDensityGrid(result, other, grid)).toThrow(/does not belong/);
    expect(() => evaluateEspAtPoints(result, other, new Float32Array(3))).toThrow(/does not belong/);
    expect(() => evaluateDensityGrid(result, { atoms: [{ z: 30, position: [0, 0, 0] }], charge: 0 }, grid)).toThrow(UnsupportedSystemError);
    let polls = 0;
    const cancelled = runRhf(input, { isCancelled: () => ++polls > 2 });
    expect(cancelled.cancelled).toBe(true);
    expect(() => evaluateDensityGrid(cancelled, input, grid)).toThrow(/no density/);
    expect(() => evaluateEspAtPoints(cancelled, input, new Float32Array(3))).toThrow(/no density/);
  });
});

describe('numerical integration of the density recovers the electron count', () => {
  /**
   * Summing rho over a regular grid is exact to 1e-6 for H2, whose density is smooth. With a
   * second-period atom the 1s core density is a spike about 0.05 angstrom wide that a regular grid
   * only resolves when its spacing is that small, so the count converges slowly at first and then
   * very fast. Tolerances are about twice the errors observed (given in the comments); they
   * describe the quadrature, not the density, whose point values agree with PySCF to 1e-11 and
   * whose analytic integral trace(P S) equals the electron count to 1e-10 (see scf.test.ts).
   */
  const cases: { name: string; spacing: number; padding: number; tolerance: number }[] = [
    { name: 'H2', spacing: 0.2, padding: 4, tolerance: 1e-5 }, //    observed -1.9e-6
    { name: 'H2', spacing: 0.1, padding: 4, tolerance: 1e-7 }, //    observed -1.4e-9
    { name: 'CH4', spacing: 0.1, padding: 4, tolerance: 0.1 }, //    observed +0.042 of 10
    { name: 'H2O', spacing: 0.2, padding: 4, tolerance: 1.0 }, //    observed -0.506 of 10 (default spacing: core unresolved)
    { name: 'H2O', spacing: 0.1, padding: 4, tolerance: 0.4 }, //    observed -0.208
    { name: 'H2O', spacing: 0.05, padding: 4, tolerance: 0.01 }, //  observed -0.0047
  ];
  const errors = new Map<string, number>();

  it.each(cases)('$name at $spacing angstrom', ({ name, spacing, padding, tolerance }) => {
    const input = toInput(findMolecule(name));
    const result = runRhf(input);
    const grid = createGrid(input.atoms, { spacing, padding, maxPoints: 10_000_000 });
    expect(grid.spacing[0]).toBe(spacing);
    const electrons = integrate(evaluateDensityGrid(result, input, grid), grid);
    errors.set(`${name}@${spacing}`, electrons - result.nElectrons);
    record(`electron-count/${name}@${spacing}`, { points: grid.dims[0] * grid.dims[1] * grid.dims[2], electrons, expected: result.nElectrons, error: electrons - result.nElectrons });
    expect(Math.abs(electrons - result.nElectrons)).toBeLessThan(tolerance);
  });

  it('converges as the grid is refined', () => {
    const water = [0.2, 0.1, 0.05].map((spacing) => Math.abs(errors.get(`H2O@${spacing}`) ?? Number.NaN));
    expect(water[1]).toBeLessThan(water[0]);
    expect(water[2]).toBeLessThan(water[1] / 10);
    expect(Math.abs(errors.get('H2@0.1') ?? Number.NaN)).toBeLessThan(Math.abs(errors.get('H2@0.2') ?? Number.NaN));
  });
});

describe('electrostatic potential', () => {
  it('equals the public single-precision API and reports progress', () => {
    const input = toInput(findMolecule('H2CO'));
    const result = runRhf(input);
    const points = Float32Array.from({ length: 3 * 500 }, (_, k) => Math.sin(0.37 * k + 0.1) * 4);
    const fractions: number[] = [];
    const single = evaluateEspAtPoints(result, input, points, (fraction) => fractions.push(fraction));
    const double = electrostaticPotential(result, input, points);
    expect(single).toBeInstanceOf(Float32Array);
    expect(single.length).toBe(500);
    for (let k = 0; k < 500; k++) expect(single[k]).toBe(Math.fround(double[k]));
    expect(fractions.length).toBeGreaterThan(10);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    expect(() => evaluateEspAtPoints(result, input, new Float32Array(5))).toThrow(RangeError);
    expect(evaluateEspAtPoints(result, input, new Float32Array(0)).length).toBe(0);
  });

  it('tends to zero far from a neutral molecule, as the potential of its dipole', () => {
    const input = toInput(findMolecule('H2O'));
    const result = runRhf(input, TIGHT);
    const centre = [0, 1, 2].map((axis) => input.atoms.reduce((sum, atom) => sum + atom.z * atom.position[axis], 0) / 10);
    const direction = [0.48, -0.6, 0.64];
    const rows = [5, 10, 20, 50, 100, 200].map((distance) => {
      const point = centre.map((c, axis) => c + distance * direction[axis]);
      const potential = electrostaticPotential(result, input, point)[0];
      const r = distance * ANGSTROM_TO_BOHR;
      const dipoleTerm = (result.dipole.au[0] * direction[0] + result.dipole.au[1] * direction[1] + result.dipole.au[2] * direction[2]) / (r * r);
      return { distance, potential, dipoleTerm, ratio: potential / dipoleTerm };
    });
    record('far-field/H2O', rows);
    for (let i = 1; i < rows.length; i++) expect(Math.abs(rows[i].potential)).toBeLessThan(Math.abs(rows[i - 1].potential));
    expect(Math.abs(rows[rows.length - 1].potential)).toBeLessThan(2e-6);
    // The potential approaches the dipole potential mu.n / r^2 from below; the difference is the
    // quadrupole term, one power of r smaller, so (1 - V / V_dipole) r tends to a constant
    // (observed: 5.3 % at 20 angstrom, 0.53 % at 200 angstrom).
    const far = rows.filter((row) => row.distance >= 50);
    for (const row of far) expect(Math.abs(row.ratio - 1)).toBeLessThan(0.025);
    expect(Math.abs(rows[rows.length - 1].ratio - 1)).toBeLessThan(0.006);
    const scaled = far.map((row) => (1 - row.ratio) * row.distance);
    for (const value of scaled) expect(Math.abs(value / scaled[0] - 1)).toBeLessThan(0.02);
  });

  it.each([
    ['NH4+', 1],
    ['OH-', -1],
    ['HeH+', 1],
  ] as const)('tends to q / r far from the ion %s', (name, charge) => {
    const input = toInput(findMolecule(name));
    const result = runRhf(input, TIGHT);
    const total = input.atoms.reduce((sum, atom) => sum + atom.z, 0);
    const centre = [0, 1, 2].map((axis) => input.atoms.reduce((sum, atom) => sum + atom.z * atom.position[axis], 0) / total);
    const direction = [-0.36, 0.8, 0.48];
    const rows = [10, 30, 100, 300].map((distance) => {
      const point = centre.map((c, axis) => c + distance * direction[axis]);
      const potential = electrostaticPotential(result, input, point)[0];
      return { distance, potential, timesR: potential * distance * ANGSTROM_TO_BOHR };
    });
    record(`far-field/${name}`, rows);
    expect(result.dipole.originDependent).toBe(true);
    // V r -> q. The leading correction is the dipole about the centre of nuclear charge divided by
    // r (largest for HeH+: 2 % at 10 angstrom, 0.07 % at 300 angstrom), so it shrinks like 1 / r.
    expect(Math.abs(rows[0].timesR - charge)).toBeLessThan(0.05);
    expect(Math.abs(rows[2].timesR - charge)).toBeLessThan(0.005);
    expect(Math.abs(rows[3].timesR - charge)).toBeLessThan(0.002);
    for (let i = 1; i < rows.length; i++) expect(Math.abs(rows[i].timesR - charge)).toBeLessThan(Math.abs(rows[i - 1].timesR - charge));
  });

  it('is +Infinity at a nucleus, large and positive next to it and negative in the lone-pair region of water', () => {
    const molecule = findMolecule('H2O', 'canonical');
    const input = toInput(molecule);
    const result = runRhf(input);
    const [o, h1, h2] = input.atoms.map((atom) => atom.position);
    const atNucleus = evaluateEspAtPoints(result, input, Float32Array.from(o));
    expect(atNucleus[0]).toBe(Number.POSITIVE_INFINITY);
    const near = electrostaticPotential(result, input, [o[0] + 0.01, o[1], o[2]])[0];
    expect(near).toBeGreaterThan(8 / (0.01 * ANGSTROM_TO_BOHR) - 60);
    // Behind the oxygen, away from the hydrogens (the lone pairs), about 1.2 angstrom from O.
    const mid = [(h1[0] + h2[0]) / 2, (h1[1] + h2[1]) / 2, (h1[2] + h2[2]) / 2];
    const away = [o[0] - mid[0], o[1] - mid[1], o[2] - mid[2]];
    const length = Math.hypot(away[0], away[1], away[2]);
    const lonePair = electrostaticPotential(result, input, [o[0] + (1.2 * away[0]) / length, o[1] + (1.2 * away[1]) / length, o[2] + (1.2 * away[2]) / length])[0];
    const hydrogenSide = electrostaticPotential(result, input, [h1[0] - (1.0 * away[0]) / length, h1[1] - (1.0 * away[1]) / length, h1[2] - (1.0 * away[2]) / length])[0];
    record('water-esp', { nearNucleus: near, lonePair, hydrogenSide });
    expect(lonePair).toBeLessThan(-0.02);
    expect(hydrogenSide).toBeGreaterThan(0.02);
  });
});

describe('from a calculation to a coloured isosurface', () => {
  it('produces a closed density isosurface for benzene and potentials on it', () => {
    const input: QmInput = toInput(findMolecule('C6H6'));
    const result: ScfResult = runRhf(input);
    const surface = (spacing: number) => {
      const grid = createGrid(input.atoms, { spacing });
      const mesh = marchingCubes(evaluateDensityGrid(result, input, grid), grid, 0.002);
      // How far the density at the vertices is from the isovalue: the error of interpolating an
      // exponentially decaying density linearly between grid points.
      let contourError = 0;
      for (const value of evaluateDensityAtPoints(result, input, mesh.positions)) contourError = Math.max(contourError, Math.abs(value - 0.002));
      return { mesh, stats: meshStatistics(mesh), contourError };
    };
    const coarse = surface(0.25);
    const fine = surface(0.125);
    for (const { stats } of [coarse, fine]) {
      expect(stats.closed).toBe(true);
      expect(stats.inconsistentEdges).toBe(0);
      expect(stats.eulerCharacteristic).toBe(2);
      expect(stats.volume).toBeGreaterThan(80);
      expect(stats.volume).toBeLessThan(160);
    }
    // Observed: 3.1e-4 (16 % of the isovalue) at 0.25 angstrom; a finer grid follows the contour better.
    expect(coarse.contourError).toBeLessThan(5e-4);
    expect(fine.contourError).toBeLessThan(coarse.contourError / 2.5);
    expect(Math.abs(fine.stats.volume - coarse.stats.volume) / fine.stats.volume).toBeLessThan(0.01);

    const potential = evaluateEspAtPoints(result, input, coarse.mesh.positions);
    expect(potential.length).toBe(coarse.mesh.positions.length / 3);
    const lowest = Math.min(...potential);
    const highest = Math.max(...potential);
    record('benzene-surface', {
      isoValue: 0.002,
      coarse: { spacing: 0.25, vertices: coarse.stats.vertexCount, triangles: coarse.stats.triangleCount, volumeA3: coarse.stats.volume, areaA2: coarse.stats.area, contourError: coarse.contourError },
      fine: { spacing: 0.125, vertices: fine.stats.vertexCount, triangles: fine.stats.triangleCount, volumeA3: fine.stats.volume, areaA2: fine.stats.area, contourError: fine.contourError },
      espMin: lowest,
      espMax: highest,
    });
    // Negative above and below the ring (pi cloud), positive at the hydrogens.
    expect(lowest).toBeLessThan(-0.005);
    expect(highest).toBeGreaterThan(0.005);
    expect(BOHR_TO_ANGSTROM).toBeCloseTo(1 / ANGSTROM_TO_BOHR, 15);
  });

  it('gives the two lobes of the ethylene pi orbital as separate closed surfaces of equal size', () => {
    const input = toInput(findMolecule('C2H4', 'canonical'));
    const result = runRhf(input);
    const grid = createGrid(input.atoms, { spacing: 0.15 });
    const homo = evaluateOrbitalGrid(result, input, result.homoIndex, grid);
    const plus = meshStatistics(marchingCubes(homo, grid, 0.05));
    const minus = meshStatistics(marchingCubes(homo, grid, -0.05));
    expect(plus.closed && minus.closed).toBe(true);
    expect(plus.eulerCharacteristic).toBe(2);
    expect(minus.eulerCharacteristic).toBe(2);
    expect(plus.volume).toBeGreaterThan(1);
    expect(Math.abs(plus.volume - minus.volume) / plus.volume).toBeLessThan(0.01);
  });
});

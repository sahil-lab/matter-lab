import { BOHR_TO_ANGSTROM } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import { buildBasisBohr } from '../src/basis/basis';
import type { BasisLibrary } from '../src/basis/basis';
import { computeEri, eriIndex } from '../src/integrals/eri';
import { computeNuclearAttraction, computeOverlapKineticDipole, nuclearRepulsionEnergy } from '../src/integrals/oneElectron';
import { buildShellPairs } from '../src/integrals/shellPairs';
import { runRhfCore } from '../src/scf/rhf';
import { runRhf } from '../src/index';
import {
  parseCrawfordEri,
  parseCrawfordGeometry,
  parseCrawfordMatrix,
  parseCrawfordOutput,
  parsePsi3InputBasis,
  psi3Sto3gLibrary,
  readFixture,
} from './helpers/crawford';
import { validationReporter } from './helpers/report';

const recordValidation = validationReporter('crawford');

/**
 * Element-wise validation against the reference data of the Crawford group's Programming Project
 * #3 (https://github.com/CrawfordGroup/ProgrammingProjects, fixtures pinned to a commit; see
 * test/fixtures/crawford/manifest.json). Function order in those files: for each atom of geom.dat
 * 1s, 2s, 2px, 2py, 2pz, which is also this engine's order. All quantities are in atomic units and
 * the geometry is given in bohr.
 *
 * The references were produced by PSI3 with its own STO-3G parameters: for H2O the built-in
 * 8-digit library values, for CH4 the 7-digit values written into input.dat. The first block of
 * tests therefore runs the engine with exactly those parameters, which isolates the integral and
 * SCF code from basis-set rounding. The second block uses the bundled Basis Set Exchange snapshot
 * (10 digits) and documents how much that rounding matters.
 */

interface Case {
  readonly name: string;
  readonly referenceBasis: () => BasisLibrary;
  readonly basisDescription: string;
}

const CASES: readonly Case[] = [
  { name: 'h2o', referenceBasis: psi3Sto3gLibrary, basisDescription: "PSI3 library STO-3G (psi3-sto-3g.json)" },
  { name: 'ch4', referenceBasis: () => parsePsi3InputBasis(readFixture('crawford/ch4/input.dat')), basisDescription: 'STO-3G as written in ch4/input.dat' },
];

function maxAbsDifference(a: Float64Array, b: Float64Array): number {
  let largest = 0;
  for (let i = 0; i < a.length; i++) largest = Math.max(largest, Math.abs(a[i] - b[i]));
  return largest;
}

function loadReference(name: string) {
  const geometry = parseCrawfordGeometry(readFixture(`crawford/${name}/geom.dat`));
  const output = parseCrawfordOutput(readFixture(`crawford/${name}/output.txt`));
  const enuc = Number(readFixture(`crawford/${name}/enuc.dat`).trim());
  const eri = parseCrawfordEri(readFixture(`crawford/${name}/eri.dat`));
  const matrix = (file: string, n: number) => parseCrawfordMatrix(readFixture(`crawford/${name}/${file}`), n);
  return { geometry, output, enuc, eri, matrix };
}

function integralsFor(name: string, library: BasisLibrary | undefined) {
  const reference = loadReference(name);
  const atoms = reference.geometry.z.map((z, i) => ({ z, x: reference.geometry.bohr[i][0], y: reference.geometry.bohr[i][1], zCoord: reference.geometry.bohr[i][2] }));
  const nuclei = atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord }));
  const basis = buildBasisBohr(atoms, library);
  const pairs = buildShellPairs(basis);
  const oneElectron = computeOverlapKineticDipole(basis, [0, 0, 0]);
  const nuclear = computeNuclearAttraction(basis, pairs, nuclei);
  const eri = computeEri(basis, pairs);
  const n = basis.nBasis;
  const deviations = {
    overlap: maxAbsDifference(oneElectron.overlap, reference.matrix('s.dat', n)),
    kinetic: maxAbsDifference(oneElectron.kinetic, reference.matrix('t.dat', n)),
    nuclearAttraction: maxAbsDifference(nuclear, reference.matrix('v.dat', n)),
    // The mu?.dat files hold the electronic dipole operator, i.e. minus the position integrals.
    dipole: Math.max(
      ...(['mux.dat', 'muy.dat', 'muz.dat'] as const).map((file, axis) => maxAbsDifference(oneElectron.dipole[axis].map((v) => -v), reference.matrix(file, n))),
    ),
    eriListed: 0,
    eriUnlisted: 0,
    nuclearRepulsion: Math.abs(nuclearRepulsionEnergy(nuclei) - reference.enuc),
  };
  const listed = new Set<number>();
  for (const entry of reference.eri) {
    const index = eriIndex(entry.i, entry.j, entry.k, entry.l);
    listed.add(index);
    deviations.eriListed = Math.max(deviations.eriListed, Math.abs(eri.values[index] - entry.value));
  }
  // Integrals the reference file omits are zero by symmetry.
  for (let index = 0; index < eri.values.length; index++) {
    if (!listed.has(index)) deviations.eriUnlisted = Math.max(deviations.eriUnlisted, Math.abs(eri.values[index]));
  }
  return { reference, basis, nuclei, deviations, nListed: listed.size, nUnique: eri.values.length };
}

describe.each(CASES)('Crawford Project #3 reference with the reference program\'s own basis: $name', ({ name, referenceBasis, basisDescription }) => {
  const { reference, basis, nuclei, deviations, nListed, nUnique } = integralsFor(name, referenceBasis());

  it('uses the same function order and count as the reference files', () => {
    const expected = reference.geometry.z.flatMap((z, atom) => (z === 1 ? ['1s'] : ['1s', '2s', '2px', '2py', '2pz']).map((shell) => `${atom}:${shell}`));
    expect(basis.functions.map((fn) => `${fn.atomIndex}:${fn.shell}`)).toEqual(expected);
  });

  it('reproduces S, T, V and the dipole integrals element-wise to 1e-8', () => {
    recordValidation(`crawford/${name}/reference-basis/integrals`, { basis: basisDescription, ...deviations, eriListedCount: nListed, eriUniqueCount: nUnique });
    expect(deviations.overlap).toBeLessThan(1e-8);
    expect(deviations.kinetic).toBeLessThan(1e-8);
    expect(deviations.nuclearAttraction).toBeLessThan(1e-8);
    expect(deviations.dipole).toBeLessThan(1e-8);
    expect(deviations.nuclearRepulsion).toBeLessThan(1e-8);
  });

  it('reproduces every listed two-electron integral to 1e-8 and finds the omitted ones to be zero', () => {
    expect(nListed).toBe(reference.eri.length);
    expect(deviations.eriListed).toBeLessThan(1e-8);
    expect(deviations.eriUnlisted).toBeLessThan(1e-8);
  });

  it('reproduces the SCF energy, dipole moment and Mulliken charges', () => {
    const nElectrons = reference.geometry.z.reduce((sum, z) => sum + z, 0);
    const scf = runRhfCore(basis, nuclei, nElectrons, { energyTolerance: 1e-12, densityTolerance: 1e-10 });
    expect(scf.converged).toBe(true);
    const result = {
      basis: basisDescription,
      iterations: scf.iterations.length,
      totalEnergy: scf.energy.total,
      referenceTotalEnergy: reference.output.totalEnergy,
      totalEnergyDeviation: Math.abs(scf.energy.total - reference.output.totalEnergy),
      electronicEnergyDeviation: Math.abs(scf.energy.electronic - reference.output.electronicEnergy),
      dipoleDeviation: Math.max(...scf.dipole.map((v, axis) => Math.abs(v - reference.output.dipole[axis]))),
      chargeDeviation: Math.max(...scf.mullikenCharges.map((q, atom) => Math.abs(q - reference.output.charges[atom]))),
    };
    recordValidation(`crawford/${name}/reference-basis/scf`, result);
    // The reference prints 12 decimals; both programs are converged far beyond the 1e-6 target.
    expect(result.totalEnergyDeviation).toBeLessThan(1e-9);
    expect(result.electronicEnergyDeviation).toBeLessThan(1e-9);
    expect(result.dipoleDeviation).toBeLessThan(1e-8);
    expect(result.chargeDeviation).toBeLessThan(1e-8);
  });
});

describe.each(CASES)('Crawford Project #3 reference with the bundled Basis Set Exchange STO-3G: $name', ({ name }) => {
  const { reference, deviations } = integralsFor(name, undefined);

  it('agrees to within the rounding of the reference program\'s basis-set parameters', () => {
    recordValidation(`crawford/${name}/bse-basis/integrals`, deviations);
    // PSI3's STO-3G parameters carry 7-8 significant digits, the BSE snapshot 10. Rounding a
    // parameter in the 8th digit changes integrals of magnitude up to ~60 hartree (V of a core
    // function) in about the same relative place, so absolute deviations up to a few 1e-6 are the
    // expected size here; the exact-basis tests above are the ones that validate the code.
    expect(deviations.overlap).toBeLessThan(1e-6);
    expect(deviations.kinetic).toBeLessThan(5e-6);
    expect(deviations.nuclearAttraction).toBeLessThan(5e-6);
    expect(deviations.dipole).toBeLessThan(1e-6);
    expect(deviations.eriListed).toBeLessThan(5e-6);
    expect(deviations.eriUnlisted).toBeLessThan(1e-8);
  });

  it('gives the reference SCF energy to 1e-6 hartree through the public API', () => {
    const result = runRhf({
      atoms: reference.geometry.z.map((z, i) => ({
        z,
        position: [reference.geometry.bohr[i][0] * BOHR_TO_ANGSTROM, reference.geometry.bohr[i][1] * BOHR_TO_ANGSTROM, reference.geometry.bohr[i][2] * BOHR_TO_ANGSTROM],
      })),
      charge: 0,
    });
    expect(result.converged).toBe(true);
    const summary = {
      totalEnergy: result.energy.total,
      referenceTotalEnergy: reference.output.totalEnergy,
      totalEnergyDeviation: Math.abs(result.energy.total - reference.output.totalEnergy),
      nuclearRepulsionDeviation: Math.abs(result.energy.nuclearRepulsion - reference.enuc),
      dipoleDeviation: Math.max(...result.dipole.au.map((v, axis) => Math.abs(v - reference.output.dipole[axis]))),
      chargeDeviation: Math.max(...result.mullikenCharges.map((q, atom) => Math.abs(q - reference.output.charges[atom]))),
    };
    recordValidation(`crawford/${name}/bse-basis/scf`, summary);
    expect(summary.nuclearRepulsionDeviation).toBeLessThan(1e-10);
    expect(summary.totalEnergyDeviation).toBeLessThan(1e-6);
    expect(summary.dipoleDeviation).toBeLessThan(1e-4);
    expect(summary.chargeDeviation).toBeLessThan(1e-4);
  });
});

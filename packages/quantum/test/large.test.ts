import { describe, expect, it } from 'vitest';
import { atomsToBohr, buildBasisBohr } from '../src/basis/basis';
import { STO3G_SOURCE } from '../src/basis/sto3g.generated';
import { runRhfCore } from '../src/scf/rhf';
import { checkSupport, DEFAULT_MAX_BASIS_FUNCTIONS } from '../src/index';
import type { QmInput } from '../src/index';
import { readJsonFixture } from './helpers/crawford';
import { validationReporter } from './helpers/report';

/**
 * One calculation close to the default size limit: all-trans C13H28, 93 basis functions, against
 * PySCF (tools/gen_large.py). The chain is about 16 angstrom long, so Schwarz and primitive
 * screening remove a large part of the two-electron integrals; the comparison shows that this
 * costs no accuracy, and that the engine copes with an integral table of almost full size.
 */

interface LargeFixture {
  readonly versions: { pyscf: string };
  readonly basis: { sha256: string };
  readonly molecule: {
    readonly name: string;
    readonly charge: number;
    readonly atoms: { z: number; position: [number, number, number] }[];
    readonly nBasis: number;
    readonly nElectrons: number;
    readonly energy: { total: number; nuclearRepulsion: number };
    readonly orbitalEnergies: number[];
    readonly mullikenCharges: number[];
    readonly dipoleAu: [number, number, number];
    readonly internalStable: boolean;
  };
}

const record = validationReporter('large');

describe('a molecule near the size limit (C13H28, 93 basis functions)', () => {
  const fixture = readJsonFixture<LargeFixture>('pyscf_large.json');
  const reference = fixture.molecule;
  const input: QmInput = { atoms: reference.atoms, charge: reference.charge };

  it('is supported with the default limit and gets a time estimate', () => {
    expect(fixture.basis.sha256).toBe(STO3G_SOURCE.sha256);
    const support = checkSupport(input);
    expect(support.supported).toBe(true);
    expect(support.nBasis).toBe(93);
    expect(support.nBasis).toBeLessThanOrEqual(DEFAULT_MAX_BASIS_FUNCTIONS);
    expect(support.nElectrons).toBe(reference.nElectrons);
    expect(support.estimatedSeconds).toBeGreaterThan(1);
    expect(support.estimatedSeconds).toBeLessThan(60);
  });

  it('reproduces the PySCF energy, orbital energies, charges and dipole with screening active', () => {
    const atoms = atomsToBohr(input.atoms);
    const basis = buildBasisBohr(atoms);
    const phases: string[] = [];
    const start = performance.now();
    const result = runRhfCore(
      basis,
      atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord })),
      reference.nElectrons,
      { onPhase: (phase) => (phases[phases.length - 1] === phase ? undefined : phases.push(phase)) },
    );
    const wallMs = performance.now() - start;
    const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      return worst;
    };
    const deviation = {
      totalEnergy: Math.abs(result.energy.total - reference.energy.total),
      nuclearRepulsion: Math.abs(result.energy.nuclearRepulsion - reference.energy.nuclearRepulsion),
      orbitalEnergies: maxAbs(result.orbitalEnergies, reference.orbitalEnergies),
      mullikenCharges: maxAbs(result.mullikenCharges, reference.mullikenCharges),
      dipole: maxAbs(result.dipole, reference.dipoleAu),
    };
    const statistics = result.integralStatistics;
    const totalQuartets = statistics.shellQuartets + statistics.shellQuartetsScreened;
    record('C13H28', {
      pyscf: fixture.versions.pyscf,
      nBasis: basis.nBasis,
      energy: result.energy.total,
      referenceEnergy: reference.energy.total,
      ...deviation,
      iterations: result.iterations.length,
      hessianProducts: result.stability.hessianProducts,
      orbitalRotations: result.nOccupied * (basis.nBasis - result.nOccupied),
      lowestHessianEigenvalue: result.stability.lowestEigenvalue,
      lowestHessianEigenvalueIsExact: result.stability.lowestEigenvalueIsExact,
      shellQuartets: totalQuartets,
      shellQuartetsScreened: statistics.shellQuartetsScreened,
      primitiveQuartetsComputed: statistics.primitiveQuartets,
      primitiveQuartetsWithoutScreening: totalQuartets * 81,
      wallMs,
      timings: result.timings,
    });

    expect(basis.nBasis).toBe(reference.nBasis);
    expect(result.converged).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.stability.verified).toBe(true);
    // 2120 orbital rotations: far beyond a full diagonalisation, so the iterative certificate decides.
    expect(result.stability.lowestEigenvalueIsExact).toBe(false);
    expect(result.stability.lowestEigenvalue!).toBeGreaterThan(0);
    expect(reference.internalStable).toBe(true);
    expect(phases).toEqual(['integrals', 'scf', 'properties']);
    // Screening really is at work here ...
    expect(statistics.shellQuartetsScreened).toBeGreaterThan(totalQuartets / 3);
    expect(statistics.primitiveQuartets).toBeLessThan((totalQuartets * 81) / 3);
    // ... and the target tolerances hold all the same.
    expect(deviation.nuclearRepulsion).toBeLessThan(1e-8);
    expect(deviation.totalEnergy).toBeLessThan(1e-6);
    expect(deviation.orbitalEnergies).toBeLessThan(1e-5);
    expect(deviation.mullikenCharges).toBeLessThan(1e-4);
    expect(deviation.dipole).toBeLessThan(1e-4);
  });
});

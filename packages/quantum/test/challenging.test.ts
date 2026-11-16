import { describe, expect, it } from 'vitest';
import { atomsToBohr, buildBasisBohr } from '../src/basis/basis';
import { STO3G_SOURCE } from '../src/basis/sto3g.generated';
import { runRhfCore } from '../src/scf/rhf';
import { runRhf } from '../src/index';
import type { QmInput } from '../src/index';
import { readJsonFixture } from './helpers/crawford';
import { validationReporter } from './helpers/report';

/**
 * Systems with several closed-shell SCF solutions: stretched bonds, biradicaloids, and molecules
 * for which the core-Hamiltonian guess leads to a saddle point. The reference (tools/
 * gen_challenging.py) ran PySCF from two starting guesses, with and without a level shift, and
 * followed every converged solution along its internal instabilities. PySCF's plain DIIS does not
 * converge for all of them; `lowestEnergy` is its lowest converged and internally stable energy,
 * or null when no run converged (C2).
 *
 * The engine must converge, end on a solution it has verified to be a minimum, and that solution
 * must not lie above anything PySCF found.
 */

interface Run {
  readonly energies: number[];
  readonly internalStable: boolean | null;
  readonly converged: boolean;
}
interface ChallengingSystem {
  readonly name: string;
  readonly charge: number;
  readonly atoms: { z: number; position: [number, number, number] }[];
  readonly nBasis: number;
  readonly nElectrons: number;
  readonly runs: Record<string, Run>;
  readonly lowestEnergy: number | null;
}
interface ChallengingFixture {
  readonly versions: { pyscf: string };
  readonly basis: { sha256: string };
  readonly systems: ChallengingSystem[];
}

const fixture = readJsonFixture<ChallengingFixture>('pyscf_challenging.json');
const record = validationReporter('challenging');

describe('systems with more than one SCF solution', () => {
  const rows: Record<string, unknown>[] = [];

  it('uses a reference computed with the bundled basis-set snapshot', () => {
    expect(fixture.basis.sha256).toBe(STO3G_SOURCE.sha256);
    expect(fixture.systems.length).toBeGreaterThanOrEqual(15);
  });

  it.each(fixture.systems.map((system) => [system.name, system] as const))('%s', (name, system) => {
    const input: QmInput = { atoms: system.atoms, charge: system.charge };
    const result = runRhf(input);

    // Same calculation through the internal driver, for the stability diagnostics.
    const atoms = atomsToBohr(input.atoms);
    const basis = buildBasisBohr(atoms);
    const core = runRhfCore(
      basis,
      atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord })),
      system.nElectrons,
    );
    expect(core.energy.total).toBe(result.energy.total);

    const everyEnergy = Object.values(system.runs).flatMap((run) => run.energies);
    const lowestSeen = Math.min(...everyEnergy);
    // Stationary points the engine passed through: iterations at which the energy had stopped changing.
    const plateaus = result.iterations.filter((it, k) => k > 0 && Math.abs(it.deltaEnergy) < 1e-9).map((it) => it.energy);
    rows.push({
      system: name,
      nBasis: result.nBasis,
      iterations: result.iterations.length,
      energy: result.energy.total,
      pyscfLowestStable: system.lowestEnergy,
      pyscfLowestSeen: lowestSeen,
      deviation: system.lowestEnergy === null ? null : result.energy.total - system.lowestEnergy,
      saddlePointsLeft: core.stability.saddlePointsLeft,
      lowestHessianEigenvalue: core.stability.lowestEigenvalue,
      lowestHessianEigenvalueIsExact: core.stability.lowestEigenvalueIsExact,
      hessianProducts: core.stability.hessianProducts,
      distinctPlateaus: [...new Set(plateaus.map((e) => e.toFixed(6)))],
      pyscfConvergedRuns: Object.entries(system.runs)
        .filter(([, run]) => run.converged)
        .map(([label]) => label),
      warnings: result.warnings,
    });
    record('systems', { pyscf: fixture.versions.pyscf, rows });

    expect(result.nBasis).toBe(system.nBasis);
    expect(result.converged).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(core.stability.verified).toBe(true);
    expect(core.stability.lowestEigenvalue).toBeGreaterThan(-1e-5);
    // Not above any energy PySCF reached, converged or not ...
    expect(result.energy.total).toBeLessThan(lowestSeen + 1e-6);
    // ... and equal to its lowest stable solution where it has one.
    if (system.lowestEnergy !== null) expect(Math.abs(result.energy.total - system.lowestEnergy)).toBeLessThan(1e-6);
  });

  it('includes cases where a saddle point had to be left and cases PySCF could not converge', () => {
    const left = rows.filter((row) => (row.saddlePointsLeft as number) > 0).map((row) => row.system);
    expect(left).toContain('N2 (1.098 A)');
    expect(left.length).toBeGreaterThanOrEqual(5);
    expect(fixture.systems.some((system) => system.lowestEnergy === null)).toBe(true);
  });
});

import { AU_DIPOLE_TO_DEBYE } from '@matterlab/core';
import { atomsToBohr, buildBasisBohr } from './basis/basis';
import { UnsupportedSystemError } from './errors';
import type { PointCharge } from './integrals/oneElectron';
import { engineProvenance } from './provenance';
import { runRhfCore } from './scf/rhf';
import { checkSupport } from './support';
import type { QmInput, ScfOptions, ScfResult } from './types';

/**
 * Restricted Hartree-Fock with the STO-3G basis for a closed-shell molecule of H-Ar atoms.
 *
 * Units: input positions in angstrom, charge in e; energies in hartree; dipole in e a0 and debye;
 * Mulliken charges in e. The calculation is synchronous: run it in a Web Worker and use
 * `onPhase`, `onIteration` and `isCancelled` to stay responsive.
 *
 * @throws UnsupportedSystemError when `checkSupport(input)` reports the system as unsupported.
 */
export function runRhf(input: QmInput, options: ScfOptions = {}): ScfResult {
  const report = checkSupport(input, { maxBasisFunctions: options.maxBasisFunctions });
  if (!report.supported) throw new UnsupportedSystemError(report.reasons);

  const atoms = atomsToBohr(input.atoms);
  const basis = buildBasisBohr(atoms);
  const nuclei: PointCharge[] = atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord }));
  const core = runRhfCore(basis, nuclei, report.nElectrons, options);

  const n = basis.nBasis;
  const debye: [number, number, number] = [core.dipole[0] * AU_DIPOLE_TO_DEBYE, core.dipole[1] * AU_DIPOLE_TO_DEBYE, core.dipole[2] * AU_DIPOLE_TO_DEBYE];
  return {
    method: 'RHF',
    basisSet: 'STO-3G',
    converged: core.converged,
    cancelled: core.cancelled,
    iterations: core.iterations,
    nBasis: n,
    nElectrons: report.nElectrons,
    nOccupied: core.nOccupied,
    energy: { ...core.energy },
    orbitalEnergies: core.orbitalEnergies,
    orbitalCoefficients: core.orbitalCoefficients,
    densityMatrix: core.densityMatrix,
    overlapMatrix: core.overlapMatrix,
    basisFunctions: basis.functions.map((fn) => ({ ...fn })),
    homoIndex: core.nOccupied - 1,
    lumoIndex: core.nOccupied < n ? core.nOccupied : null,
    mullikenCharges: [...core.mullikenCharges],
    dipole: {
      au: [core.dipole[0], core.dipole[1], core.dipole[2]],
      debye,
      magnitudeDebye: Math.hypot(debye[0], debye[1], debye[2]),
      originDependent: input.charge !== 0,
    },
    timings: { ...core.timings },
    warnings: [...core.warnings],
    provenance: engineProvenance(),
  };
}

/**
 * Virial ratio -V/T of a result, where T is the electronic kinetic energy and V = E_total - T is
 * all potential energy. It equals 2 for an exact wavefunction at an equilibrium geometry; for a
 * minimal basis with fixed exponents it deviates from 2 by up to about a percent.
 */
export function virialRatio(result: ScfResult): number {
  return -(result.energy.total - result.energy.kinetic) / result.energy.kinetic;
}

import { countBasisFunctions, elementSymbol, MAX_SUPPORTED_Z, sto3gLibrary } from './basis/basis';
import type { QmInput, SupportOptions, SupportReport } from './types';

/** Default upper limit on the number of basis functions. */
export const DEFAULT_MAX_BASIS_FUNCTIONS = 96;
/**
 * Limit that cannot be raised through options: the packed table of unique two-electron integrals
 * holds about n^4 / 8 doubles (273 MB at n = 128), which is as much as a browser worker should
 * be asked to allocate.
 */
export const HARD_MAX_BASIS_FUNCTIONS = 128;
/** Nuclei closer than this (angstrom) are treated as coincident and rejected. */
export const MIN_NUCLEAR_SEPARATION = 0.1;

const MAX_LISTED = 4;

/**
 * Cost model for `estimatedSeconds`, calibrated with tools/bench.ts on an Intel Core Ultra 7 165H
 * with Node 24 (single thread, engine running as native ES modules); see the README for the
 * measurements behind these numbers.
 *
 * Integrals: every shell pair has 9 primitive products, so a quartet of shell pairs costs 81
 * primitive quartets whose price depends only on which of the two shells of each pair carry p
 * functions. STO-3G for H-Ar has just two shell types (s and sp), giving three pair classes
 * (ss, s-sp, sp-sp) and six quartet classes. Screening is ignored, so for spatially extended
 * molecules, where it removes most of this work (83 % of the primitive quartets and roughly two
 * thirds of the modelled integral time for the chain C13H28), the estimate is an upper bound.
 *
 * SCF: a typical number of Fock builds (iterations, stability analysis, final energy), each a pass
 * over the n^4 / 8 packed integrals, plus the O(n^3) linear algebra of every iteration (Jacobi
 * diagonalisation and matrix products).
 */
export const COST_MODEL = {
  /** Nanoseconds per primitive quartet for (ss|ss), (s-sp|ss), (s-sp|s-sp), (sp-sp|ss), (sp-sp|s-sp), (sp-sp|sp-sp). */
  primitiveQuartetNs: [20, 80, 180, 135, 300, 1200],
  /** Nanoseconds per stored integral and Fock build. */
  fockNsPerIntegral: 8,
  /** Typical number of Fock builds: SCF iterations, Hessian products of the stability analysis, final energy. */
  fockBuilds: 28,
  /** Typical number of SCF iterations with DIIS. */
  iterations: 12,
  /** Nanoseconds per n^3 and SCF iteration for the dense linear algebra. */
  linearAlgebraNsPerCube: 60,
  /** Fixed overhead in seconds (set-up, one-electron integrals, properties). */
  overheadSeconds: 0.001,
} as const;

/** Estimated single-thread run time in seconds for a system with the given numbers of s and sp shells. */
export function estimateSeconds(sShells: number, spShells: number): number {
  const nBasis = sShells + 4 * spShells;
  const ss = (sShells * (sShells + 1)) / 2;
  const ssp = sShells * spShells;
  const spsp = (spShells * (spShells + 1)) / 2;
  const ns = COST_MODEL.primitiveQuartetNs;
  const primitiveQuartets = 81;
  const integralsNs =
    primitiveQuartets *
    (((ss * (ss + 1)) / 2) * ns[0] + ssp * ss * ns[1] + ((ssp * (ssp + 1)) / 2) * ns[2] + spsp * ss * ns[3] + spsp * ssp * ns[4] + ((spsp * (spsp + 1)) / 2) * ns[5]);
  const pairs = (nBasis * (nBasis + 1)) / 2;
  const uniqueIntegrals = (pairs * (pairs + 1)) / 2;
  const scfNs = COST_MODEL.fockBuilds * uniqueIntegrals * COST_MODEL.fockNsPerIntegral + COST_MODEL.iterations * nBasis ** 3 * COST_MODEL.linearAlgebraNsPerCube;
  return COST_MODEL.overheadSeconds + (integralsNs + scfNs) * 1e-9;
}

function listAtoms(indices: readonly number[]): string {
  const shown = indices.slice(0, MAX_LISTED).map((i) => i + 1);
  const more = indices.length - shown.length;
  return `${indices.length === 1 ? 'atom' : 'atoms'} ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Decides whether `runRhf` can treat a system and says why not when it cannot. Never throws for
 * malformed input; every problem found is listed in `reasons`.
 *
 * Rejected: no atoms; atomic numbers that are not integers >= 1 or exceed 18 (the bundled STO-3G
 * data covers H-Ar); non-finite positions; a non-integer charge; a negative or zero electron
 * count; an odd electron count (open shells are not implemented); more electron pairs than basis
 * functions; more basis functions than the limit; nuclei closer than 0.1 angstrom.
 */
export function checkSupport(input: QmInput, options: SupportOptions = {}): SupportReport {
  const requestedLimit = options.maxBasisFunctions ?? DEFAULT_MAX_BASIS_FUNCTIONS;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new RangeError('maxBasisFunctions must be a positive integer.');
  const limit = Math.min(requestedLimit, HARD_MAX_BASIS_FUNCTIONS);

  const reasons: string[] = [];
  const atoms = Array.isArray(input?.atoms) ? input.atoms : [];
  const charge = input?.charge;

  if (atoms.length === 0) reasons.push('The system contains no atoms.');

  const invalidZ: number[] = [];
  const unsupportedZ: number[] = [];
  const badPosition: number[] = [];
  let nuclearCharge = 0;
  let nBasis = 0;
  let sShells = 0;
  let spShells = 0;
  atoms.forEach((atom, index) => {
    const z = atom?.z;
    if (typeof z !== 'number' || !Number.isInteger(z) || z < 1) {
      invalidZ.push(index);
    } else {
      nuclearCharge += z;
      const shells = sto3gLibrary(z);
      if (!shells) {
        unsupportedZ.push(index);
      } else {
        nBasis += countBasisFunctions(z);
        for (const shell of shells) {
          if (shell.angularMomentum.length === 1 && shell.angularMomentum[0] === 0) sShells++;
          else spShells++;
        }
      }
    }
    const position = atom?.position;
    if (!Array.isArray(position) || position.length !== 3 || !position.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      badPosition.push(index);
    }
  });

  if (invalidZ.length > 0) {
    const values = [...new Set(invalidZ.map((i) => String(atoms[i]?.z)))].slice(0, MAX_LISTED).join(', ');
    reasons.push(`Invalid atomic number (${values}) for ${listAtoms(invalidZ)}: atomic numbers must be positive integers.`);
  }
  if (unsupportedZ.length > 0) {
    const values = [...new Set(unsupportedZ.map((i) => atoms[i].z))].sort((a, b) => a - b);
    reasons.push(
      `Unsupported element${values.length === 1 ? '' : 's'} (Z = ${values.slice(0, 8).join(', ')}${values.length > 8 ? ', ...' : ''}) at ${listAtoms(unsupportedZ)}: ` +
        `the bundled STO-3G basis covers ${elementSymbol(1)} to ${elementSymbol(MAX_SUPPORTED_Z)} (Z <= ${MAX_SUPPORTED_Z}) only.`,
    );
  }
  if (badPosition.length > 0) {
    reasons.push(`Invalid position for ${listAtoms(badPosition)}: coordinates must be three finite numbers in angstrom.`);
  }

  const chargeValid = typeof charge === 'number' && Number.isInteger(charge);
  if (!chargeValid) reasons.push(`The net charge must be an integer (got ${String(charge)}).`);

  const nElectrons = invalidZ.length === 0 && typeof charge === 'number' ? nuclearCharge - charge : NaN;
  if (atoms.length > 0 && invalidZ.length === 0 && chargeValid) {
    if (nElectrons < 0) {
      reasons.push(`A charge of ${charge > 0 ? '+' : ''}${charge} on nuclei with a total charge of +${nuclearCharge} would leave a negative number of electrons (${nElectrons}).`);
    } else if (nElectrons === 0) {
      reasons.push('The system has no electrons, so there is no electronic structure to compute.');
    } else if (nElectrons % 2 !== 0) {
      reasons.push(
        `The system has an odd number of electrons (${nElectrons}). Only closed-shell restricted Hartree-Fock is implemented; open-shell systems (radicals, most atoms) are not supported.`,
      );
    } else if (unsupportedZ.length === 0 && nElectrons / 2 > nBasis) {
      reasons.push(
        `${nElectrons} electrons need ${nElectrons / 2} doubly occupied orbitals, but the minimal STO-3G basis provides only ${nBasis} basis function${nBasis === 1 ? '' : 's'} for this system.`,
      );
    }
  }

  if (nBasis > limit) {
    reasons.push(
      limit < requestedLimit
        ? `The system needs ${nBasis} basis functions, more than the engine's hard limit of ${HARD_MAX_BASIS_FUNCTIONS} (the two-electron integral table would not fit in memory).`
        : `The system needs ${nBasis} basis functions, more than the limit of ${limit}.`,
    );
  }

  if (badPosition.length === 0) {
    const close: string[] = [];
    let closeCount = 0;
    for (let i = 0; i < atoms.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = atoms[i].position;
        const b = atoms[j].position;
        const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (distance < MIN_NUCLEAR_SEPARATION) {
          closeCount++;
          if (close.length < MAX_LISTED) close.push(`${j + 1} and ${i + 1} (${distance.toFixed(3)} A)`);
        }
      }
    }
    if (closeCount > 0) {
      reasons.push(
        `Coincident nuclei: atoms ${close.join(', ')}${closeCount > close.length ? ` and ${closeCount - close.length} more pair${closeCount - close.length === 1 ? '' : 's'}` : ''} ` +
          `are closer than ${MIN_NUCLEAR_SEPARATION} angstrom.`,
      );
    }
  }

  const basisAssigned = atoms.length > 0 && invalidZ.length === 0 && unsupportedZ.length === 0;
  return {
    supported: reasons.length === 0,
    reasons,
    nBasis,
    nElectrons,
    estimatedSeconds: basisAssigned ? estimateSeconds(sShells, spShells) : atoms.length === 0 ? 0 : NaN,
  };
}

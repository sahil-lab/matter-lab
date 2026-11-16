import { ANGSTROM_TO_BOHR } from '@matterlab/core';
import type { BasisFunctionInfo, QmAtom } from '../types';
import { STO3G_SHELLS, STO3G_SYMBOLS } from './sto3g.generated';

/**
 * A shell as listed in a basis-set library: primitives sharing one set of exponents, contracted
 * into an s function (angular momentum 0), a set of three p functions (1), or both ("SP" shell).
 */
export interface ShellDefinition {
  readonly angularMomentum: readonly number[];
  /** Exponents in bohr^-2. */
  readonly exponents: readonly number[];
  /** One row of contraction coefficients (for normalised primitives) per angular momentum. */
  readonly coefficients: readonly (readonly number[])[];
}

/** Returns the shells of element `z`, or undefined when the library has none. */
export type BasisLibrary = (z: number) => readonly ShellDefinition[] | undefined;

/** Kind of a basis function inside a shell: s, or the Cartesian p component along x, y or z. */
export const KIND_S = -1;

export interface Shell {
  readonly atomIndex: number;
  /** Centre in bohr. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly nPrim: number;
  /** Primitive exponents in bohr^-2. */
  readonly exps: Float64Array;
  readonly hasS: boolean;
  readonly hasP: boolean;
  /**
   * Coefficients of the unnormalised primitives exp(-a r^2) in the normalised contracted s
   * function (primitive norm, contraction coefficient and contracted norm all folded in). Zero
   * when the shell has no s function.
   */
  readonly coefS: Float64Array;
  /** Same for the primitives x exp(-a r^2) (and y, z) of the contracted p functions. */
  readonly coefP: Float64Array;
  /** Index of the first basis function of this shell. */
  readonly firstFunction: number;
  /** 1 (s), 3 (p) or 4 (sp). */
  readonly nFunctions: number;
  /** Kind of each function in order: KIND_S (-1) or the Cartesian axis 0, 1, 2 of a p function. */
  readonly kinds: Int8Array;
}

export interface Basis {
  readonly shells: readonly Shell[];
  readonly nBasis: number;
  readonly functions: readonly BasisFunctionInfo[];
  /** Atom index of every basis function. */
  readonly atomOfFunction: Int32Array;
  readonly nAtoms: number;
}

export const MAX_SUPPORTED_Z = STO3G_SHELLS.length;

/** The bundled STO-3G library (H-Ar), read from the Basis Set Exchange snapshot. */
export const sto3gLibrary: BasisLibrary = (z) => (Number.isInteger(z) && z >= 1 && z <= MAX_SUPPORTED_Z ? STO3G_SHELLS[z - 1] : undefined);

/** Element symbol for Z = 1..18; '?' otherwise. */
export function elementSymbol(z: number): string {
  return Number.isInteger(z) && z >= 1 && z <= STO3G_SYMBOLS.length ? STO3G_SYMBOLS[z - 1] : '?';
}

/** Number of basis functions the library assigns to element `z` (0 when it has no entry). */
export function countBasisFunctions(z: number, library: BasisLibrary = sto3gLibrary): number {
  const shells = library(z);
  if (!shells) return 0;
  let n = 0;
  for (const shell of shells) for (const l of shell.angularMomentum) n += l === 0 ? 1 : 3;
  return n;
}

/**
 * Coefficients that turn `sum_k d_k N_k g_k` into a function of unit norm, where g_k is the
 * unnormalised primitive of angular momentum `l` (0 or 1) and N_k its normalisation constant.
 */
function normalisedCoefficients(l: number, exps: readonly number[], contraction: readonly number[]): Float64Array {
  const n = exps.length;
  const coef = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = exps[k];
    // N = (2a/pi)^(3/4) for s and (2a/pi)^(3/4) * 2 sqrt(a) for a Cartesian p function.
    const norm = Math.pow((2 * a) / Math.PI, 0.75) * (l === 1 ? 2 * Math.sqrt(a) : 1);
    coef[k] = contraction[k] * norm;
  }
  let self = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = exps[i] + exps[j];
      // <g_i|g_j> = (pi/p)^(3/2) for s; an extra 1/(2p) for x exp(-a r^2).
      const overlap = Math.pow(Math.PI / p, 1.5) * (l === 1 ? 1 / (2 * p) : 1);
      self += coef[i] * coef[j] * overlap;
    }
  }
  if (!(self > 0) || !Number.isFinite(self)) throw new Error('Basis shell has a non-positive or non-finite norm.');
  const scale = 1 / Math.sqrt(self);
  for (let k = 0; k < n; k++) coef[k] *= scale;
  return coef;
}

const P_SUFFIX = ['px', 'py', 'pz'] as const;

/** One nucleus with its position already converted to bohr. */
export interface AtomBohr {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly zCoord: number;
}

/**
 * Builds the contracted Cartesian Gaussian basis for nuclei given in bohr.
 * Functions are ordered atom by atom and, within an atom, shell by shell in library order; an SP
 * shell contributes s, px, py, pz in that order. Throws when the library has no entry for an atom.
 */
export function buildBasisBohr(atoms: readonly AtomBohr[], library: BasisLibrary = sto3gLibrary): Basis {
  const shells: Shell[] = [];
  const functions: BasisFunctionInfo[] = [];
  const atomOfFunction: number[] = [];
  let next = 0;

  atoms.forEach((atom, atomIndex) => {
    const definitions = library(atom.z);
    if (!definitions) throw new Error(`No basis functions are available for atomic number ${atom.z}.`);
    const symbol = elementSymbol(atom.z);
    let sShells = 0;
    let pShells = 0;
    for (const def of definitions) {
      const sIndex = def.angularMomentum.indexOf(0);
      const pIndex = def.angularMomentum.indexOf(1);
      if (def.angularMomentum.some((l) => l !== 0 && l !== 1) || (sIndex < 0 && pIndex < 0)) {
        throw new Error(`Only s and p functions are supported (atomic number ${atom.z}).`);
      }
      const nPrim = def.exponents.length;
      const hasS = sIndex >= 0;
      const hasP = pIndex >= 0;
      const coefS = hasS ? normalisedCoefficients(0, def.exponents, def.coefficients[sIndex]) : new Float64Array(nPrim);
      const coefP = hasP ? normalisedCoefficients(1, def.exponents, def.coefficients[pIndex]) : new Float64Array(nPrim);
      const kinds: number[] = [];
      const firstFunction = next;
      if (hasS) {
        sShells++;
        const shell = `${sShells}s`;
        functions.push({ index: next, atomIndex, shell, label: `${symbol}${atomIndex + 1} ${shell}` });
        atomOfFunction.push(atomIndex);
        kinds.push(KIND_S);
        next++;
      }
      if (hasP) {
        pShells++;
        for (let axis = 0; axis < 3; axis++) {
          const shell = `${pShells + 1}${P_SUFFIX[axis]}`;
          functions.push({ index: next, atomIndex, shell, label: `${symbol}${atomIndex + 1} ${shell}` });
          atomOfFunction.push(atomIndex);
          kinds.push(axis);
          next++;
        }
      }
      shells.push({
        atomIndex,
        x: atom.x,
        y: atom.y,
        z: atom.zCoord,
        nPrim,
        exps: Float64Array.from(def.exponents),
        hasS,
        hasP,
        coefS,
        coefP,
        firstFunction,
        nFunctions: kinds.length,
        kinds: Int8Array.from(kinds),
      });
    }
  });

  return { shells, nBasis: next, functions, atomOfFunction: Int32Array.from(atomOfFunction), nAtoms: atoms.length };
}

/** Converts input atoms (angstrom) to bohr with the CODATA value shared by the whole application. */
export function atomsToBohr(atoms: readonly QmAtom[]): AtomBohr[] {
  return atoms.map((atom) => ({
    z: atom.z,
    x: atom.position[0] * ANGSTROM_TO_BOHR,
    y: atom.position[1] * ANGSTROM_TO_BOHR,
    zCoord: atom.position[2] * ANGSTROM_TO_BOHR,
  }));
}

/** Builds the STO-3G basis for input atoms given in angstrom. */
export function buildBasis(atoms: readonly QmAtom[], library: BasisLibrary = sto3gLibrary): Basis {
  return buildBasisBohr(atomsToBohr(atoms), library);
}

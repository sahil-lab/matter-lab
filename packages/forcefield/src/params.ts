/*
 * UFF atomic parameters and the formulas that turn them into term parameters.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/ForceField/UFF/Params.{h,cpp}     ParamCollection, AtomicParams
 *   Code/ForceField/UFF/BondStretch.cpp    Utils::calcBondRestLength, calcBondForceConstant
 *   Code/ForceField/UFF/AngleBend.cpp      Utils::calcAngleForceConstant
 *   Code/ForceField/UFF/TorsionAngle.cpp   Utils::equation17, isInGroup6
 *   Code/ForceField/UFF/Nonbonded.cpp      Utils::calcNonbondedMinimum, calcNonbondedDepth
 *   Code/ForceField/UFF/Utils.cpp          Utils::calcInversionCoefficientsAndForceConstant
 * Copyright (C) 2004-2024 Greg Landrum, Rational Discovery LLC, Paolo Tosco and other RDKit contributors.
 */
import { UFF_G, UFF_LAMBDA, UFF_PARAM_ROWS } from './generated/uffParams.generated';

/** RDKit's `ForceFields::UFF::AtomicParams`. */
export interface UffAtomicParams {
  readonly label: string;
  /** valence bond radius, angstrom */
  readonly r1: number;
  /** valence angle, radians */
  readonly theta0: number;
  /** vdW characteristic length, angstrom */
  readonly x1: number;
  /** vdW atomic energy, kcal/mol */
  readonly D1: number;
  /** vdW scaling term */
  readonly zeta: number;
  /** effective charge */
  readonly Z1: number;
  /** sp3 torsional barrier parameter, kcal/mol */
  readonly V1: number;
  /** torsional contribution for sp2-sp3 bonds, kcal/mol */
  readonly U1: number;
  /** GMP electronegativity */
  readonly GMP_Xi: number;
  /** GMP hardness */
  readonly GMP_Hardness: number;
  /** GMP radius */
  readonly GMP_Radius: number;
}

const PARAMS = new Map<string, UffAtomicParams>();
for (const row of UFF_PARAM_ROWS) {
  const [label, r1, theta0Deg, x1, D1, zeta, Z1, V1, U1, xi, hardness, radius] = row;
  PARAMS.set(label, {
    label,
    r1,
    // Same expression as RDKit's ParamCollection constructor: theta0 * M_PI / 180.
    theta0: (theta0Deg * Math.PI) / 180,
    x1,
    D1,
    zeta,
    Z1,
    V1,
    U1,
    GMP_Xi: xi,
    GMP_Hardness: hardness,
    GMP_Radius: radius,
  });
}

/** Looks up the parameters of a UFF atom type; `undefined` when RDKit's table has no such label. */
export function uffAtomicParams(label: string): UffAtomicParams | undefined {
  return PARAMS.get(label);
}

/** All atom-type labels of RDKit's UFF parameter table, in table order. */
export function uffAtomTypeLabels(): string[] {
  return UFF_PARAM_ROWS.map((row) => row[0]);
}

export const RAD2DEG = 180 / Math.PI;

/** Natural bond length with the bond-order (Pauling) and electronegativity (O'Keeffe-Brese) corrections. */
export function calcBondRestLength(bondOrder: number, end1: UffAtomicParams, end2: UffAtomicParams): number {
  const ri = end1.r1;
  const rj = end2.r1;
  // this is the pauling correction:
  const rBO = -UFF_LAMBDA * (ri + rj) * Math.log(bondOrder);
  // O'Keefe and Breese electronegativity correction:
  const Xi = end1.GMP_Xi;
  const Xj = end2.GMP_Xi;
  const rEN = (ri * rj * (Math.sqrt(Xi) - Math.sqrt(Xj)) * (Math.sqrt(Xi) - Math.sqrt(Xj))) / (Xi * ri + Xj * rj);
  return ri + rj + rBO - rEN;
}

export function calcBondForceConstant(restLength: number, end1: UffAtomicParams, end2: UffAtomicParams): number {
  return (2.0 * UFF_G * end1.Z1 * end2.Z1) / (restLength * restLength * restLength);
}

export function calcAngleForceConstant(
  theta0: number,
  bondOrder12: number,
  bondOrder23: number,
  at1: UffAtomicParams,
  at2: UffAtomicParams,
  at3: UffAtomicParams,
): number {
  const cosTheta0 = Math.cos(theta0);
  const r12 = calcBondRestLength(bondOrder12, at1, at2);
  const r23 = calcBondRestLength(bondOrder23, at2, at3);
  const r13 = Math.sqrt(r12 * r12 + r23 * r23 - 2.0 * r12 * r23 * cosTheta0);
  const beta = (2.0 * UFF_G) / (r12 * r23);
  const r13sq = r13 * r13;
  const preFactor = (beta * at1.Z1 * at3.Z1) / (r13sq * r13sq * r13);
  const rTerm = r12 * r23;
  const innerBit = 3.0 * rTerm * (1.0 - cosTheta0 * cosTheta0) - r13 * r13 * cosTheta0;
  return preFactor * rTerm * innerBit;
}

export function isInGroup6(atomicNumber: number): boolean {
  return atomicNumber === 8 || atomicNumber === 16 || atomicNumber === 34 || atomicNumber === 52 || atomicNumber === 84;
}

/** Equation 17 of the UFF paper: the torsional barrier about an sp2-sp2 bond. */
export function equation17(bondOrder23: number, at2: UffAtomicParams, at3: UffAtomicParams): number {
  return 5.0 * Math.sqrt(at2.U1 * at3.U1) * (1.0 + 4.18 * Math.log(bondOrder23));
}

export function calcNonbondedMinimum(at1: UffAtomicParams, at2: UffAtomicParams): number {
  return Math.sqrt(at1.x1 * at2.x1);
}

export function calcNonbondedDepth(at1: UffAtomicParams, at2: UffAtomicParams): number {
  return Math.sqrt(at1.D1 * at2.D1);
}

export interface InversionCoefficients {
  /** force constant, kcal/mol (already divided by the three inversions of a centre) */
  readonly K: number;
  readonly C0: number;
  readonly C1: number;
  readonly C2: number;
}

/**
 * Force constant and cosine-series coefficients of the inversion term for a given central atom.
 * `isCBoundToO`: the centre is an sp2 carbon bound to an sp2 oxygen.
 */
export function calcInversionCoefficientsAndForceConstant(at2AtomicNum: number, isCBoundToO: boolean): InversionCoefficients {
  let res: number;
  let C0: number;
  let C1: number;
  let C2: number;
  // if the central atom is sp2 carbon, nitrogen or oxygen
  if (at2AtomicNum === 6 || at2AtomicNum === 7 || at2AtomicNum === 8) {
    C0 = 1.0;
    C1 = -1.0;
    C2 = 0.0;
    res = isCBoundToO ? 50.0 : 6.0;
  } else {
    // group 5 elements are not clearly explained in the UFF paper
    // the following code was inspired by MCCCS Towhee's ffuff.F
    let w0 = Math.PI / 180.0;
    switch (at2AtomicNum) {
      case 15: // phosphorus
        w0 *= 84.4339;
        break;
      case 33: // arsenic
        w0 *= 86.9735;
        break;
      case 51: // antimony
        w0 *= 87.7047;
        break;
      case 83: // bismuth
        w0 *= 90.0;
        break;
    }
    C2 = 1.0;
    C1 = -4.0 * Math.cos(w0);
    C0 = -(C1 * Math.cos(w0) + C2 * Math.cos(2.0 * w0));
    res = 22.0 / (C0 + C1 + C2);
  }
  res /= 3.0;
  return { K: res, C0, C1, C2 };
}

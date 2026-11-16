/*
 * Construction of the UFF term tables for one molecule.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/GraphMol/ForceFieldHelpers/UFF/Builder.cpp   Tools::addBonds, addAngles,
 *       addTrigonalBipyramidAngles, addAngleSpecialCases, buildNeighborMatrix, addNonbonded,
 *       addTorsions, addInversions, constructForceField
 *   Code/ForceField/UFF/AngleBend.cpp      AngleBendContrib constructor
 *   Code/ForceField/UFF/TorsionAngle.cpp   TorsionAngleContrib::calcTorsionParams
 *   Code/ForceField/UFF/Nonbonded.cpp      vdWContrib constructor
 * Copyright (C) 2004-2018 Greg Landrum and Rational Discovery LLC and other RDKit contributors.
 */
import {
  calcAngleForceConstant,
  calcBondForceConstant,
  calcBondRestLength,
  calcInversionCoefficientsAndForceConstant,
  calcNonbondedDepth,
  calcNonbondedMinimum,
  equation17,
  isInGroup6,
} from './params';
import type { UffAtomicParams } from './params';
import type { Hybridization, MolGraph, Perception } from './perception';

/**
 * RDKit's default `vdwThresh` (UFFOptimizeMolecule, UFFGetMoleculeForceField) and the default
 * `threshMultiplier` of each vdW contribution: a pair further apart than this many times its
 * preferred distance x_ij contributes nothing.
 */
export const VDW_THRESHOLD_MULTIPLIER = 10.0;

export const BOND_STRIDE_IDX = 2;
export const BOND_STRIDE_PAR = 2;
export const ANGLE_STRIDE_IDX = 4;
export const ANGLE_STRIDE_PAR = 5;
export const TORSION_STRIDE_IDX = 5;
export const TORSION_STRIDE_PAR = 2;
export const INVERSION_STRIDE_IDX = 4;
export const INVERSION_STRIDE_PAR = 4;

/** Everything the energy function needs, as flat typed arrays (plain, structured-cloneable data). */
export interface UffKernel {
  readonly nAtoms: number;
  /** [i, j] per bond */
  readonly bondIdx: Int32Array;
  /** [kb, r0] per bond: kcal/mol/angstrom^2, angstrom */
  readonly bondPar: Float64Array;
  /** [i, j, k, order] per angle; j is the vertex. order 0 is the general cosine-harmonic form. */
  readonly angleIdx: Int32Array;
  /** [ka, theta0, C0, C1, C2] per angle: kcal/mol/rad^2, radians */
  readonly anglePar: Float64Array;
  /** [i, j, k, l, order] per torsion about the j-k bond */
  readonly torsionIdx: Int32Array;
  /** [V, cos(n phi0)] per torsion; V is already divided by the number of torsions about the bond */
  readonly torsionPar: Float64Array;
  /** [i, j, k, l] per inversion; j is the centre */
  readonly inversionIdx: Int32Array;
  /** [K, C0, C1, C2] per inversion */
  readonly inversionPar: Float64Array;
  /** Per atom: row/column of the van der Waals type-pair tables. */
  readonly vdwType: Int32Array;
  /** Per atom: connected fragment; atoms of different fragments do not interact. */
  readonly vdwFragment: Int32Array;
  /** CSR over atoms: partners j > i excluded from van der Waals because they are 1-2 or 1-3 related. */
  readonly vdwExclStart: Int32Array;
  readonly vdwExclJ: Int32Array;
  readonly nVdwTypes: number;
  /** Type-pair tables, nVdwTypes x nVdwTypes: preferred distance, well depth, cutoff distance. */
  readonly vdwXij: Float64Array;
  readonly vdwDij: Float64Array;
  readonly vdwThresh: Float64Array;
  /** Number of atom pairs that carry a van der Waals term. */
  readonly vdwPairCount: number;
}

export interface TorsionParams {
  readonly V: number;
  readonly order: number;
  readonly cosTerm: number;
}

/** `TorsionAngleContrib::calcTorsionParams`. Both hybridisations must be SP2 or SP3. */
export function calcTorsionParams(
  bondOrder23: number,
  atNum2: number,
  atNum3: number,
  hyb2: Hybridization,
  hyb3: Hybridization,
  at2: UffAtomicParams,
  at3: UffAtomicParams,
  endAtomIsSP2: boolean,
): TorsionParams {
  let V: number;
  let order: number;
  let cosTerm: number;
  if (hyb2 === 'SP3' && hyb3 === 'SP3') {
    // general case:
    V = Math.sqrt(at2.V1 * at3.V1);
    order = 3;
    cosTerm = -1; // phi0=60
    // special case for single bonds between group 6 elements:
    if (bondOrder23 === 1.0 && isInGroup6(atNum2) && isInGroup6(atNum3)) {
      const V2 = atNum2 === 8 ? 2.0 : 6.8;
      const V3 = atNum3 === 8 ? 2.0 : 6.8;
      V = Math.sqrt(V2 * V3);
      order = 2;
      cosTerm = -1; // phi0=90
    }
  } else if (hyb2 === 'SP2' && hyb3 === 'SP2') {
    V = equation17(bondOrder23, at2, at3);
    order = 2;
    cosTerm = 1.0; // phi0= 180
  } else {
    // SP2 - SP3,  this is, by default, independent of atom type in UFF:
    V = 1.0;
    order = 6;
    cosTerm = 1.0; // phi0 = 0
    if (bondOrder23 === 1.0) {
      // special case between group 6 sp3 and non-group 6 sp2:
      if (
        (hyb2 === 'SP3' && isInGroup6(atNum2) && !isInGroup6(atNum3)) ||
        (hyb3 === 'SP3' && isInGroup6(atNum3) && !isInGroup6(atNum2))
      ) {
        V = equation17(bondOrder23, at2, at3);
        order = 2;
        cosTerm = -1; // phi0 = 90;
      }
      // special case for sp3 - sp2 - sp2
      // (i.e. the sp2 has another sp2 neighbor, like propene)
      else if (endAtomIsSP2) {
        V = 2.0;
        order = 3;
        cosTerm = -1; // phi0 = 180;
      }
    }
  }
  return { V, order, cosTerm };
}

/** Does RDKit's default torsion-bond SMARTS, `[!$(*#*)&!D1]~[!$(*#*)&!D1]`, accept this atom? */
function isTorsionBondAtom(g: MolGraph, p: Perception, i: number): boolean {
  if (p.degree[i] === 1) return false;
  for (let q = g.nbrStart[i]; q < g.nbrStart[i + 1]; q++) {
    if (g.bondOrder[g.nbrBond[q]] === 3) return false;
  }
  return true;
}

export interface BuildResult {
  readonly kernel: UffKernel;
  readonly warnings: string[];
}

/**
 * Builds the term tables. `positions` (xyz triples, angstrom) is the geometry the force field is
 * constructed at; like RDKit, it decides which two ligands of a five-coordinate sp3d centre are axial.
 */
export function buildKernel(
  g: MolGraph,
  p: Perception,
  params: readonly UffAtomicParams[],
  positions: ArrayLike<number>,
): BuildResult {
  const n = g.nAtoms;
  const { z, bondA, bondB, bondOrder, nbrStart, nbrAtom, nbrBond } = g;
  const hyb = p.hybridization;
  const warnings: string[] = [];

  // ---- addBonds ----
  const bondIdx = new Int32Array(g.nBonds * BOND_STRIDE_IDX);
  const bondPar = new Float64Array(g.nBonds * BOND_STRIDE_PAR);
  for (let b = 0; b < g.nBonds; b++) {
    const i = bondA[b];
    const j = bondB[b];
    const r0 = calcBondRestLength(bondOrder[b], params[i], params[j]);
    bondIdx[2 * b] = i;
    bondIdx[2 * b + 1] = j;
    bondPar[2 * b] = calcBondForceConstant(r0, params[i], params[j]);
    bondPar[2 * b + 1] = r0;
  }

  // ---- addAngles ----
  const angleIdx: number[] = [];
  const anglePar: number[] = [];
  // Vertices whose natural angle is 180 degrees but which are handled by the general cosine form.
  const straightGeneralVertices = new Set<number>();
  // The AngleBendContrib constructor.
  const addAngle = (i: number, j: number, k: number, bo12: number, bo23: number, orderIn: number): void => {
    let order = orderIn;
    let theta0 = params[j].theta0;
    // the following is a hack to get decent geometries
    // with 3- and 4-membered rings incorporating sp2 atoms
    if (order >= 30) {
      switch (order) {
        case 30:
          theta0 = (150.0 / 180.0) * Math.PI;
          break;
        case 35:
          theta0 = (60.0 / 180.0) * Math.PI;
          break;
        case 40:
          theta0 = (135.0 / 180.0) * Math.PI;
          break;
        case 45:
          theta0 = (90.0 / 180.0) * Math.PI;
          break;
      }
      order = 0;
    }
    const ka = calcAngleForceConstant(theta0, bo12, bo23, params[i], params[j], params[k]);
    let C0 = 0;
    let C1 = 0;
    let C2 = 0;
    if (order === 0) {
      const sinTheta0 = Math.sin(theta0);
      const cosTheta0 = Math.cos(theta0);
      if (sinTheta0 * sinTheta0 < 1e-8) straightGeneralVertices.add(j);
      C2 = 1.0 / (4.0 * Math.max(sinTheta0 * sinTheta0, 1e-8));
      C1 = -4.0 * C2 * cosTheta0;
      C0 = C2 * (2.0 * cosTheta0 * cosTheta0 + 1.0);
    }
    angleIdx.push(i, j, k, order);
    anglePar.push(ka, theta0, C0, C1, C2);
  };

  for (let j = 0; j < n; j++) {
    if (p.degree[j] === 1) continue;
    // trigonal bipyramidal centres are handled below
    if (hyb[j] === 'SP3D' && p.degree[j] === 5) continue;
    for (let p1 = nbrStart[j]; p1 < nbrStart[j + 1]; p1++) {
      const i = nbrAtom[p1];
      for (let p2 = p1 + 1; p2 < nbrStart[j + 1]; p2++) {
        const k = nbrAtom[p2];
        let order = 0;
        switch (hyb[j]) {
          case 'SP':
            order = 1;
            break;
          case 'SP2':
            order = 3;
            // the following is a hack to get decent geometries
            // with 3- and 4-membered rings incorporating sp2 atoms
            if (p.inRing3[j]) {
              // one of the bonded atoms, but not the other, inside a ring: this angle is between a
              // ring substituent and a ring edge
              if (p.inRing3[i] !== p.inRing3[k]) {
                order = 30;
              } else if (p.inRing3[i] && p.inRing3[k]) {
                // all atoms inside the ring: one of the ring angles
                order = 35;
              }
            } else if (p.inRing4[j]) {
              if (p.inRing4[i] !== p.inRing4[k]) {
                order = 40;
              } else if (p.inRing4[i] && p.inRing4[k]) {
                order = 45;
              }
            }
            break;
          case 'SP3D2':
            order = 4;
            break;
          default:
            order = 0;
        }
        addAngle(i, j, k, bondOrder[nbrBond[p1]], bondOrder[nbrBond[p2]], order);
      }
    }
  }

  // ---- addAngleSpecialCases / addTrigonalBipyramidAngles ----
  for (let a = 0; a < n; a++) {
    if (!(hyb[a] === 'SP3D' && p.degree[a] === 5)) continue;
    // identify the axial bonds: the pair of ligands whose directions are most nearly opposite
    let mostNeg = 100.0;
    let ax1 = -1;
    let ax2 = -1;
    const dir = (q: number): [number, number, number] => {
      const o = nbrAtom[q];
      const dx = positions[3 * o] - positions[3 * a];
      const dy = positions[3 * o + 1] - positions[3 * a + 1];
      const dz = positions[3 * o + 2] - positions[3 * a + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return [dx / len, dy / len, dz / len];
    };
    for (let q1 = nbrStart[a]; q1 < nbrStart[a + 1]; q1++) {
      const v1 = dir(q1);
      for (let q2 = nbrStart[a]; q2 < nbrStart[a + 1]; q2++) {
        if (nbrBond[q2] > nbrBond[q1]) {
          const v2 = dir(q2);
          const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
          if (dot < mostNeg) {
            mostNeg = dot;
            ax1 = q1;
            ax2 = q2;
          }
        }
      }
    }
    if (ax1 < 0) {
      // Every ligand coincides with the centre, so no direction is defined. RDKit raises an
      // invariant violation here; take the first two bonds so that a force field can still be built.
      ax1 = nbrStart[a];
      ax2 = nbrStart[a] + 1;
      warnings.push(
        `Atom ${a} is five-coordinate (trigonal bipyramidal) but its ligands coincide with it, so the axial pair could not be ` +
          'identified from the geometry; the first two bonds were taken as axial.',
      );
    }
    const eq: number[] = [];
    for (let q = nbrStart[a]; q < nbrStart[a + 1]; q++) {
      if (q !== ax1 && q !== ax2) eq.push(q);
    }
    const tbpAngle = (q1: number, q2: number, order: number): void => {
      addAngle(nbrAtom[q1], a, nbrAtom[q2], bondOrder[nbrBond[q1]], bondOrder[nbrBond[q2]], order);
    };
    // Axial-Axial
    tbpAngle(ax1, ax2, 2);
    // Equatorial-Equatorial
    tbpAngle(eq[0], eq[1], 3);
    tbpAngle(eq[0], eq[2], 3);
    tbpAngle(eq[1], eq[2], 3);
    // Axial-Equatorial
    tbpAngle(ax1, eq[0], 0);
    tbpAngle(ax1, eq[1], 0);
    tbpAngle(ax1, eq[2], 0);
    tbpAngle(ax2, eq[0], 0);
    tbpAngle(ax2, eq[1], 0);
    tbpAngle(ax2, eq[2], 0);
  }

  for (const j of Array.from(straightGeneralVertices).sort((u, v) => u - v)) {
    if (p.degree[j] < 3) continue;
    warnings.push(
      `Atom ${j} has UFF type ${params[j].label}, whose natural bond angle is 180 degrees, but ${p.degree[j]} neighbours. Its angle terms ` +
        'cannot all be satisfied and are extremely stiff, so they dominate the energy (RDKit behaves the same way). ' +
        'UFF is not a meaningful model for this centre.',
    );
  }

  // ---- buildNeighborMatrix / addNonbonded ----
  // Atoms that are bonded (1-2) or share a neighbour (1-3) do not interact; everything else in the
  // same fragment does, 1-4 pairs included.
  const vdwExclStart = new Int32Array(n + 1);
  const exclLists: number[][] = [];
  let vdwPairCount = 0;
  const fragSize = new Int32Array(p.nFragments);
  for (let i = 0; i < n; i++) fragSize[p.fragment[i]]++;
  const fragSeen = new Int32Array(p.nFragments);
  for (let i = 0; i < n; i++) {
    const excluded = new Set<number>();
    for (let q = nbrStart[i]; q < nbrStart[i + 1]; q++) {
      const j = nbrAtom[q];
      if (j > i) excluded.add(j);
      for (let r = nbrStart[j]; r < nbrStart[j + 1]; r++) {
        const k = nbrAtom[r];
        if (k > i) excluded.add(k);
      }
    }
    const list = Array.from(excluded).sort((u, v) => u - v);
    exclLists.push(list);
    vdwExclStart[i + 1] = vdwExclStart[i] + list.length;
    // partners j > i in the same fragment, minus the excluded ones (which are all in the fragment)
    fragSeen[p.fragment[i]]++;
    vdwPairCount += fragSize[p.fragment[i]] - fragSeen[p.fragment[i]] - list.length;
  }
  const vdwExclJ = new Int32Array(vdwExclStart[n]);
  for (let i = 0; i < n; i++) vdwExclJ.set(exclLists[i], vdwExclStart[i]);

  const typeIndex = new Map<string, number>();
  const typeParams: UffAtomicParams[] = [];
  const vdwType = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let t = typeIndex.get(params[i].label);
    if (t === undefined) {
      t = typeParams.length;
      typeIndex.set(params[i].label, t);
      typeParams.push(params[i]);
    }
    vdwType[i] = t;
  }
  const nVdwTypes = typeParams.length;
  const vdwXij = new Float64Array(nVdwTypes * nVdwTypes);
  const vdwDij = new Float64Array(nVdwTypes * nVdwTypes);
  const vdwThresh = new Float64Array(nVdwTypes * nVdwTypes);
  for (let s = 0; s < nVdwTypes; s++) {
    for (let t = 0; t < nVdwTypes; t++) {
      // UFF uses the geometric mean of the vdW parameters:
      const xij = calcNonbondedMinimum(typeParams[s], typeParams[t]);
      vdwXij[s * nVdwTypes + t] = xij;
      vdwDij[s * nVdwTypes + t] = calcNonbondedDepth(typeParams[s], typeParams[t]);
      vdwThresh[s * nVdwTypes + t] = VDW_THRESHOLD_MULTIPLIER * xij;
    }
  }

  // ---- addTorsions ----
  const torsionIdx: number[] = [];
  const torsionPar: number[] = [];
  for (let b = 0; b < g.nBonds; b++) {
    const idx1 = bondA[b];
    const idx2 = bondB[b];
    if (!isTorsionBondAtom(g, p, idx1) || !isTorsionBondAtom(g, p, idx2)) continue;
    const h1 = hyb[idx1];
    const h2 = hyb[idx2];
    if (!((h1 === 'SP2' || h1 === 'SP3') && (h2 === 'SP2' || h2 === 'SP3'))) continue;
    const first = torsionPar.length;
    for (let q1 = nbrStart[idx1]; q1 < nbrStart[idx1 + 1]; q1++) {
      if (nbrBond[q1] === b) continue;
      const bIdx = nbrAtom[q1];
      for (let q2 = nbrStart[idx2]; q2 < nbrStart[idx2 + 1]; q2++) {
        if (nbrBond[q2] === b) continue;
        const eIdx = nbrAtom[q2];
        // make sure this isn't a three-membered ring:
        if (eIdx === bIdx) continue;
        // we now have a torsion involving atoms bIdx - idx1 - idx2 - eIdx
        // if either of the end atoms is SP2 hybridized, set a flag here.
        const hasSP2 = hyb[bIdx] === 'SP2' || hyb[eIdx] === 'SP2';
        const tp = calcTorsionParams(bondOrder[b], z[idx1], z[idx2], h1, h2, params[idx1], params[idx2], hasSP2);
        torsionIdx.push(bIdx, idx1, idx2, eIdx, tp.order);
        torsionPar.push(tp.V, tp.cosTerm);
      }
    }
    // now divide the force constant for each contribution to the torsion energy
    // about this bond by the number of contribs about this bond:
    const count = (torsionPar.length - first) / TORSION_STRIDE_PAR;
    for (let t = first; t < torsionPar.length; t += TORSION_STRIDE_PAR) torsionPar[t] /= count;
  }

  // ---- addInversions ----
  const inversionIdx: number[] = [];
  const inversionPar: number[] = [];
  for (let c = 0; c < n; c++) {
    const at2AtomicNum = z[c];
    // if the central atom is not carbon, nitrogen, oxygen,
    // phosphorous, arsenic, antimonium or bismuth, skip it
    const isCNO = at2AtomicNum === 6 || at2AtomicNum === 7 || at2AtomicNum === 8;
    const isGroup15 = at2AtomicNum === 15 || at2AtomicNum === 33 || at2AtomicNum === 51 || at2AtomicNum === 83;
    if (!(isCNO || isGroup15) || p.degree[c] !== 3) continue;
    // if the central atom is carbon, nitrogen or oxygen but hybridization is not sp2, skip it
    if (isCNO && hyb[c] !== 'SP2') continue;
    const nb0 = nbrAtom[nbrStart[c]];
    const nb2 = nbrAtom[nbrStart[c] + 1];
    const nb3 = nbrAtom[nbrStart[c] + 2];
    // if the central atom is sp2 carbon and is bound to sp2 oxygen, set a flag
    let isBoundToSP2O = false;
    for (const nb of [nb0, nb2, nb3]) {
      if (at2AtomicNum === 6 && z[nb] === 8 && hyb[nb] === 'SP2') isBoundToSP2O = true;
    }
    const coef = calcInversionCoefficientsAndForceConstant(at2AtomicNum, isBoundToSP2O);
    // the three choices of the out-of-plane atom (the last index)
    for (const [i, k, l] of [
      [nb0, nb2, nb3],
      [nb0, nb3, nb2],
      [nb2, nb3, nb0],
    ]) {
      inversionIdx.push(i, c, k, l);
      inversionPar.push(coef.K, coef.C0, coef.C1, coef.C2);
    }
  }

  return {
    kernel: {
      nAtoms: n,
      bondIdx,
      bondPar,
      angleIdx: Int32Array.from(angleIdx),
      anglePar: Float64Array.from(anglePar),
      torsionIdx: Int32Array.from(torsionIdx),
      torsionPar: Float64Array.from(torsionPar),
      inversionIdx: Int32Array.from(inversionIdx),
      inversionPar: Float64Array.from(inversionPar),
      vdwType,
      vdwFragment: Int32Array.from(p.fragment),
      vdwExclStart,
      vdwExclJ,
      nVdwTypes,
      vdwXij,
      vdwDij,
      vdwThresh,
      vdwPairCount,
    },
    warnings,
  };
}

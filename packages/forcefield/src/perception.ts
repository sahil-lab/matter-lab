/*
 * Molecular graph and the chemistry perception that RDKit's UFF atom typer depends on:
 * explicit valences, radical counts, conjugation, hybridisation, small-ring membership and
 * connected fragments. Aromaticity is NOT perceived here: by contract an atom or bond is aromatic
 * if and only if the caller says so with a bond order of 1.5.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/GraphMol/Atom.cpp          calculateExplicitValence, getEffectiveAtomicNum, isAromaticAtom
 *   Code/GraphMol/MolOps.cpp        assignRadicals
 *   Code/GraphMol/Aromaticity.cpp   countAtomElec
 *   Code/GraphMol/ConjugHybrid.cpp  isAtomConjugCand, markConjAtomBonds, setConjugation,
 *                                   numBondsPlusLonePairs, setHybridization
 * Copyright (C) 2001-2024 Greg Landrum and other RDKit contributors.
 *
 * Hydrogen model. The input contract says every hydrogen is an explicit atom, so each atom is
 * treated the way RDKit treats an atom that may not carry implicit hydrogens (`noImplicit`):
 *   total number of Hs on the atom  = 0   ->  getTotalDegree()  == getDegree()
 *   implicit valence                = 0   ->  getTotalValence() == explicit valence
 * and an atom whose valence is not filled is a radical centre, exactly as `assignRadicals` decides.
 */
import {
  RDKIT_ELEMENT_SYMBOLS,
  RDKIT_MAX_ATOMIC_NUMBER,
  RDKIT_OUTER_ELECTRONS,
  RDKIT_VALENCE_LISTS,
} from './generated/rdkitElements.generated';
import type { ForceFieldProblem } from './errors';
import type { FfMolecule } from './types';

/** Mirrors `RDKit::Atom::HybridizationType` (the values this perception can produce). */
export type Hybridization = 'UNSPECIFIED' | 'S' | 'SP' | 'SP2' | 'SP3' | 'SP2D' | 'SP3D' | 'SP3D2';

/** The molecule as a graph. Neighbour lists are in bond-index order, which is RDKit's iteration order. */
export interface MolGraph {
  readonly nAtoms: number;
  readonly nBonds: number;
  readonly z: Int32Array;
  readonly charge: Int32Array;
  readonly bondA: Int32Array;
  readonly bondB: Int32Array;
  readonly bondOrder: Float64Array;
  /** CSR adjacency: the neighbours of atom i are entries nbrStart[i] .. nbrStart[i + 1] - 1. */
  readonly nbrStart: Int32Array;
  readonly nbrAtom: Int32Array;
  readonly nbrBond: Int32Array;
}

export interface Perception {
  readonly degree: Int32Array;
  /** RDKit's `getTotalValence()` for each atom. */
  readonly totalValence: Int32Array;
  readonly radicalElectrons: Int32Array;
  /** Atom has at least one aromatic (order 1.5) bond. */
  readonly aromatic: Uint8Array;
  /** Per bond: RDKit's `getIsConjugated()`. */
  readonly conjugatedBond: Uint8Array;
  readonly hybridization: Hybridization[];
  /** Atom is a member of a three-membered ring (`RingInfo::isAtomInRingOfSize(i, 3)`). */
  readonly inRing3: Uint8Array;
  /** Atom is a member of a four-membered ring (`RingInfo::isAtomInRingOfSize(i, 4)`). */
  readonly inRing4: Uint8Array;
  /** Connected-component index of each atom. */
  readonly fragment: Int32Array;
  readonly nFragments: number;
  /** Atoms RDKit's valence model (and therefore its sanitisation) rejects. */
  readonly problems: ForceFieldProblem[];
  /** Non-fatal observations, e.g. radical centres. */
  readonly notes: string[];
}

export function elementSymbol(z: number): string {
  return RDKIT_ELEMENT_SYMBOLS[z] ?? `Z${z}`;
}

const BOND_ORDERS = new Set<number>([1, 1.5, 2, 3]);

/**
 * Checks the structural integrity of the input and builds the graph. Malformed input (as opposed to
 * chemistry UFF cannot handle) is a caller bug and raises a `RangeError`.
 */
export function buildGraph(mol: FfMolecule): MolGraph {
  if (mol === null || typeof mol !== 'object' || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) {
    throw new RangeError('Invalid molecule: expected { atoms: [...], bonds: [...] }.');
  }
  const nAtoms = mol.atoms.length;
  const nBonds = mol.bonds.length;
  const z = new Int32Array(nAtoms);
  const charge = new Int32Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    const atom = mol.atoms[i];
    if (atom === null || typeof atom !== 'object') throw new RangeError(`Invalid molecule: atom ${i} is not an object.`);
    if (!Number.isInteger(atom.z) || atom.z < 1 || atom.z > RDKIT_MAX_ATOMIC_NUMBER) {
      throw new RangeError(`Invalid molecule: atom ${i} has atomic number ${String(atom.z)}; expected an integer from 1 to ${RDKIT_MAX_ATOMIC_NUMBER}.`);
    }
    if (!Number.isInteger(atom.formalCharge)) {
      throw new RangeError(`Invalid molecule: atom ${i} has formal charge ${String(atom.formalCharge)}; expected an integer.`);
    }
    const p = atom.position;
    if (p === null || typeof p !== 'object' || p.length !== 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      throw new RangeError(`Invalid molecule: atom ${i} needs a position of three finite numbers (angstrom).`);
    }
    z[i] = atom.z;
    charge[i] = atom.formalCharge;
  }

  const bondA = new Int32Array(nBonds);
  const bondB = new Int32Array(nBonds);
  const bondOrder = new Float64Array(nBonds);
  const nbrStart = new Int32Array(nAtoms + 1);
  const seen = new Set<number>();
  for (let b = 0; b < nBonds; b++) {
    const bond = mol.bonds[b];
    if (bond === null || typeof bond !== 'object') throw new RangeError(`Invalid molecule: bond ${b} is not an object.`);
    const { a, b: c, order } = bond;
    if (!Number.isInteger(a) || !Number.isInteger(c) || a < 0 || c < 0 || a >= nAtoms || c >= nAtoms) {
      throw new RangeError(`Invalid molecule: bond ${b} joins atoms ${String(a)} and ${String(c)}, but atom indices run from 0 to ${nAtoms - 1}.`);
    }
    if (a === c) throw new RangeError(`Invalid molecule: bond ${b} joins atom ${a} to itself.`);
    if (!BOND_ORDERS.has(order)) {
      throw new RangeError(`Invalid molecule: bond ${b} has order ${String(order)}; expected 1, 1.5 (aromatic), 2 or 3.`);
    }
    const key = a < c ? a * nAtoms + c : c * nAtoms + a;
    if (seen.has(key)) throw new RangeError(`Invalid molecule: atoms ${a} and ${c} are joined by more than one bond (bond ${b}).`);
    seen.add(key);
    bondA[b] = a;
    bondB[b] = c;
    bondOrder[b] = order;
    nbrStart[a + 1]++;
    nbrStart[c + 1]++;
  }
  for (let i = 0; i < nAtoms; i++) nbrStart[i + 1] += nbrStart[i];
  const fill = nbrStart.slice(0, nAtoms);
  const nbrAtom = new Int32Array(2 * nBonds);
  const nbrBond = new Int32Array(2 * nBonds);
  for (let b = 0; b < nBonds; b++) {
    const a = bondA[b];
    const c = bondB[b];
    nbrAtom[fill[a]] = c;
    nbrBond[fill[a]++] = b;
    nbrAtom[fill[c]] = a;
    nbrBond[fill[c]++] = b;
  }
  return { nAtoms, nBonds, z, charge, bondA, bondB, bondOrder, nbrStart, nbrAtom, nbrBond };
}

/** Index of the bond between atoms i and j, or -1. */
export function bondBetween(g: MolGraph, i: number, j: number): number {
  for (let p = g.nbrStart[i]; p < g.nbrStart[i + 1]; p++) {
    if (g.nbrAtom[p] === j) return g.nbrBond[p];
  }
  return -1;
}

function defaultValence(z: number): number {
  return RDKIT_VALENCE_LISTS[z][0];
}

/** `getEffectiveAtomicNum(atom, checkValue = false)`: the isoelectronic element, clamped to the table. */
function effectiveAtomicNum(z: number, charge: number): number {
  return Math.min(Math.max(z - charge, 0), RDKIT_MAX_ATOMIC_NUMBER);
}

function canBeHypervalent(z: number, effZ: number): boolean {
  return (effZ > 16 && (z === 15 || z === 16)) || (effZ > 34 && (z === 33 || z === 34));
}

export function perceive(g: MolGraph): Perception {
  const n = g.nAtoms;
  const { z, charge, bondOrder, nbrStart, nbrAtom, nbrBond } = g;
  const problems: ForceFieldProblem[] = [];
  const notes: string[] = [];

  const degree = new Int32Array(n);
  const aromatic = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    degree[i] = nbrStart[i + 1] - nbrStart[i];
    let nAromaticBonds = 0;
    for (let p = nbrStart[i]; p < nbrStart[i + 1]; p++) {
      if (bondOrder[nbrBond[p]] === 1.5) nAromaticBonds++;
    }
    aromatic[i] = nAromaticBonds > 0 ? 1 : 0;
    if (nAromaticBonds === 1) {
      // After RDKit's sanitisation every aromatic bond lies in a ring whose bonds are all aromatic,
      // so an aromatic atom always has at least two aromatic bonds.
      problems.push({
        atomIndex: i,
        reason:
          `${elementSymbol(z[i])} has exactly one aromatic (order 1.5) bond. Aromatic bonds must be those RDKit reports after ` +
          'sanitisation, where they always form rings; this input cannot have come from RDKit.',
      });
    }
  }

  // ---- explicit valence: Atom.cpp, calculateExplicitValence(atom, strict = true, checkIt = false) ----
  const totalValence = new Int32Array(n);
  // What assignRadicals() sums: the bond orders of the Kekule form RDKit holds at that stage.
  const valenceForRadicals = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let accum = 0;
    // The minimum possible valence of an aromatic atom: every aromatic bond kekulised to a single bond.
    let minAccum = 0;
    for (let p = nbrStart[i]; p < nbrStart[i + 1]; p++) {
      const contrib = bondOrder[nbrBond[p]];
      accum += contrib;
      minAccum += contrib === 1.5 ? 1.0 : contrib;
    }
    const rawAccum = accum;
    const ovalens = RDKIT_VALENCE_LISTS[z[i]];
    // If the element has no specified valences we stick with it, otherwise use the isoelectronic element.
    let effZ = z[i];
    if (ovalens.length > 1 || ovalens[0] !== -1) effZ = effectiveAtomicNum(z[i], charge[i]);
    const valens = RDKIT_VALENCE_LISTS[effZ];
    // RDKit stores the default valence in an unsigned int, so -1 ("anything") compares as huge.
    const dvRaw = defaultValence(effZ);
    const dv = dvRaw === -1 ? Number.POSITIVE_INFINITY : dvRaw;
    if (accum > dv && aromatic[i]) {
      // An aromatic atom whose bond-order sum exceeds the default valence: take the largest allowed
      // valence that does not exceed the sum, provided the Kekule form can actually reach it.
      let pval = dv;
      for (const val of valens) {
        if (val === -1) break;
        if (val > accum) break;
        pval = val;
      }
      if (minAccum - pval <= 0.1 && accum - pval <= 1.5) accum = pval;
    }
    // A bond-order sum of x.5 rounds up.
    accum += 0.1;
    const res = Math.round(accum);

    let maxValence = valens[valens.length - 1];
    let offset = 0;
    // Negatively charged P, S, As and Se support hypervalent forms although they are isoelectronic
    // to elements that do not.
    if (canBeHypervalent(z[i], effZ)) {
      maxValence = ovalens[ovalens.length - 1];
      offset -= charge[i];
    }
    // RDKit has historically accepted two-coordinate [H-].
    if (z[i] === 1 && charge[i] === -1) maxValence = 2;
    // maxValence == -1 signifies that anything is accepted at the high end.
    if (maxValence >= 0 && ovalens[ovalens.length - 1] >= 0 && res + offset > maxValence) {
      const chargeText = charge[i] === 0 ? '' : ` with formal charge ${charge[i] > 0 ? '+' : ''}${charge[i]}`;
      const hint =
        z[i] === 7 && charge[i] === 0 && res === 5
          ? ' Pentavalent nitrogen (for example a nitro group drawn as N(=O)=O) must be passed in the charge-separated form RDKit produces, [N+](=O)[O-].'
          : '';
      problems.push({
        atomIndex: i,
        reason:
          `${elementSymbol(z[i])}${chargeText} has valence ${res}, more than the ${maxValence} that RDKit's valence model permits, ` +
          `so RDKit cannot sanitise this molecule and UFF cannot type it.${hint}`,
      });
    }
    totalValence[i] = res;
    valenceForRadicals[i] = aromatic[i] ? res : Math.trunc(rawAccum + 0.1);
  }

  // ---- radicals: MolOps.cpp, assignRadicals(), applied to atoms that carry no implicit Hs (all of ours) ----
  const radicalElectrons = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const valens = RDKIT_VALENCE_LISTS[z[i]];
    const chg = charge[i];
    const nOuter = RDKIT_OUTER_ELECTRONS[z[i]];
    let numRadicals: number;
    if (valens.length !== 1 || valens[0] !== -1) {
      const tv = valenceForRadicals[i];
      const baseCount = z[i] === 1 || z[i] === 2 ? 2 : 8;
      // applies to later (more electronegative) elements:
      numRadicals = baseCount - nOuter - tv + chg;
      if (numRadicals < 0) {
        numRadicals = 0;
        // can the atom be "hypervalent"?
        if (valens.length > 1) {
          for (const val of valens) {
            if (val - tv + chg >= 0) {
              numRadicals = val - tv + chg;
              break;
            }
          }
        }
      }
      // applies to earlier elements:
      const numRadicals2 = nOuter - tv - chg;
      if (numRadicals2 >= 0) numRadicals = Math.min(numRadicals, numRadicals2);
    } else if (degree[i] > 0) {
      // if there's a bond to the metal center, then don't assign radicals
      numRadicals = 0;
    } else {
      let nValence = nOuter - chg;
      if (nValence < 0) {
        nValence = 0;
        notes.push(`Unusual charge on atom ${i} (${elementSymbol(z[i])}); number of radical electrons set to zero, as RDKit does.`);
      }
      numRadicals = nValence % 2;
    }
    radicalElectrons[i] = numRadicals;
  }

  // ---- conjugation: Aromaticity.cpp countAtomElec, ConjugHybrid.cpp setConjugation ----
  const countAtomElec = (i: number): number => {
    const dv = defaultValence(z[i]);
    // univalent elements can't be either aromatic or conjugated
    if (dv <= 1) return -1;
    const deg = degree[i];
    // if we are more than 3 coordinated we should not be aromatic
    if (deg > 3) return -1;
    // number of lone pair electrons = (outer shell elecs) - (default valence)
    let nlp = RDKIT_OUTER_ELECTRONS[z[i]] - dv;
    // subtract the charge to get the true number of lone pair electrons:
    nlp = Math.max(nlp - charge[i], 0);
    // num electrons available for donation into the pi system:
    let res = dv - deg + nlp - radicalElectrons[i];
    if (res > 1) {
      // with an incident bond of order higher than 2 only one electron is returned
      const nUnsaturations = totalValence[i] - degree[i];
      if (nUnsaturations > 1) res = 1;
    }
    return res;
  };
  const isConjugCand = new Uint8Array(n);
  const numSubstituents = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const vals = RDKIT_VALENCE_LISTS[z[i]];
    let cand: boolean;
    // neutral atoms whose valence exceeds the minimal valence are hypervalent, hence not conjugated
    if (charge[i] === 0 && vals[0] >= 0 && totalValence[i] > vals[0]) {
      cand = false;
    } else {
      // Conjugation is not extended to group 15/16 atoms beyond the first row (RDKit Issue211),
      // except terminal chalcogens.
      const nouter = RDKIT_OUTER_ELECTRONS[z[i]];
      cand = (z[i] <= 10 || (nouter !== 5 && nouter !== 6) || (nouter === 6 && degree[i] < 2)) && countAtomElec(i) > 0;
    }
    isConjugCand[i] = cand ? 1 : 0;
    numSubstituents[i] = cand ? degree[i] : 0;
  }
  const conjugatedBond = new Uint8Array(g.nBonds);
  // start with all bonds being marked unconjugated except for aromatic bonds
  for (let b = 0; b < g.nBonds; b++) conjugatedBond[b] = bondOrder[b] === 1.5 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    if (!isConjugCand[i]) continue;
    // make sure that we have either 2 or 3 substitutions on this atom
    if (numSubstituents[i] < 2 || numSubstituents[i] > 3) continue;
    for (let p1 = nbrStart[i]; p1 < nbrStart[i + 1]; p1++) {
      const bnd1 = nbrBond[p1];
      if (bondOrder[bnd1] < 1.5 || !isConjugCand[nbrAtom[p1]]) continue;
      for (let p2 = nbrStart[i]; p2 < nbrStart[i + 1]; p2++) {
        if (p1 === p2) continue;
        const at2 = nbrAtom[p2];
        if (numSubstituents[at2] > 3) continue;
        if (isConjugCand[at2]) {
          conjugatedBond[bnd1] = 1;
          conjugatedBond[nbrBond[p2]] = 1;
        }
      }
    }
  }
  const atomHasConjugatedBond = (i: number): boolean => {
    for (let p = nbrStart[i]; p < nbrStart[i + 1]; p++) {
      if (conjugatedBond[nbrBond[p]]) return true;
    }
    return false;
  };

  // ---- hybridisation: ConjugHybrid.cpp numBondsPlusLonePairs, setHybridization ----
  const numBondsPlusLonePairs = (i: number): number => {
    const deg = degree[i];
    if (z[i] <= 1) return deg;
    const nouter = RDKIT_OUTER_ELECTRONS[z[i]];
    const tv = totalValence[i];
    const chg = charge[i];
    const numFreeElectrons = nouter - (tv + chg);
    if (tv + nouter - chg < 8) {
      // we're below an octet, so we need to think about radicals:
      const numRadicals = radicalElectrons[i];
      const numLonePairs = Math.trunc((numFreeElectrons - numRadicals) / 2);
      return deg + numLonePairs + numRadicals;
    }
    return deg + Math.trunc(numFreeElectrons / 2);
  };
  const hybridization: Hybridization[] = new Array<Hybridization>(n);
  for (let i = 0; i < n; i++) {
    // try to be smart for early elements, but for later ones just use the degree
    const norbs = z[i] < 89 ? numBondsPlusLonePairs(i) : degree[i];
    let hyb: Hybridization;
    switch (norbs) {
      case 0: // This occurs for things like Na+
      case 1:
        hyb = 'S';
        break;
      case 2:
        hyb = 'SP';
        break;
      case 3:
        hyb = 'SP2';
        break;
      case 4:
        // potentially SP3, but set down to SP2 if we have a conjugated bond (like the second O in
        // O=CO), unless the atom has more than three neighbours (RDKit Issue276)
        hyb = degree[i] > 3 || !atomHasConjugatedBond(i) ? 'SP3' : 'SP2';
        break;
      case 5:
        hyb = 'SP3D';
        break;
      case 6:
        hyb = 'SP3D2';
        break;
      default:
        hyb = 'UNSPECIFIED';
    }
    hybridization[i] = hyb;
  }

  const { inRing3, inRing4 } = smallRingMembership(g);
  const { fragment, nFragments } = fragments(g);

  return {
    degree,
    totalValence,
    radicalElectrons,
    aromatic,
    conjugatedBond,
    hybridization,
    inRing3,
    inRing4,
    fragment,
    nFragments,
    problems,
    notes,
  };
}

/**
 * Membership in three- and four-membered rings, as RDKit's ring information (a symmetrised smallest
 * set of smallest rings) reports it. Instead of porting RDKit's general ring finder, the two sizes
 * the UFF builder asks about are enumerated directly:
 *   - every triangle is a smallest ring;
 *   - a four-membered cycle is a smallest ring unless it is a sum of triangles, which happens when
 *     it has a diagonal bond (two fused triangles) or when one further atom is bonded to all four
 *     of its atoms (the base of a square pyramid).
 */
function smallRingMembership(g: MolGraph): { inRing3: Uint8Array; inRing4: Uint8Array } {
  const n = g.nAtoms;
  const { nbrStart, nbrAtom } = g;
  const inRing3 = new Uint8Array(n);
  const inRing4 = new Uint8Array(n);
  const bonded = (i: number, j: number): boolean => bondBetween(g, i, j) >= 0;
  for (let a = 0; a < n; a++) {
    for (let p = nbrStart[a]; p < nbrStart[a + 1]; p++) {
      const b = nbrAtom[p];
      for (let q = p + 1; q < nbrStart[a + 1]; q++) {
        const d = nbrAtom[q];
        if (bonded(b, d)) {
          inRing3[a] = 1;
          inRing3[b] = 1;
          inRing3[d] = 1;
        }
        // four-membered cycles a-b-c-d through the neighbour pair (b, d); take each once (a < c)
        for (let r = nbrStart[b]; r < nbrStart[b + 1]; r++) {
          const c = nbrAtom[r];
          if (c <= a || c === d || !bonded(c, d)) continue;
          if (bonded(a, c) || bonded(b, d)) continue;
          let apex = false;
          for (let s = nbrStart[a]; s < nbrStart[a + 1] && !apex; s++) {
            const x = nbrAtom[s];
            if (x !== b && x !== d && bonded(x, b) && bonded(x, c) && bonded(x, d)) apex = true;
          }
          if (apex) continue;
          inRing4[a] = 1;
          inRing4[b] = 1;
          inRing4[c] = 1;
          inRing4[d] = 1;
        }
      }
    }
  }
  return { inRing3, inRing4 };
}

function fragments(g: MolGraph): { fragment: Int32Array; nFragments: number } {
  const n = g.nAtoms;
  const fragment = new Int32Array(n).fill(-1);
  let nFragments = 0;
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (fragment[start] >= 0) continue;
    fragment[start] = nFragments;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      for (let p = g.nbrStart[i]; p < g.nbrStart[i + 1]; p++) {
        const j = g.nbrAtom[p];
        if (fragment[j] < 0) {
          fragment[j] = nFragments;
          stack.push(j);
        }
      }
    }
    nFragments++;
  }
  return { fragment, nFragments };
}

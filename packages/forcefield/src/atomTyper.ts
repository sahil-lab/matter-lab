/*
 * UFF atom typing.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.cpp   Tools::getAtomLabel, Tools::addAtomChargeFlags,
 *                                                       getAtomTypes
 * Copyright (C) 2004-2021 Greg Landrum and other RDKit contributors.
 *
 * RDKit's typer writes to its warning and error logs and carries on. Here every such message is
 * returned: the ones after which RDKit still finds parameters become warnings, the ones that leave
 * an atom without parameters become the reasons of an `UnsupportedForceFieldError`.
 */
import { RDKIT_ELEMENT_SYMBOLS, RDKIT_OUTER_ELECTRONS, RDKIT_VALENCE_LISTS } from './generated/rdkitElements.generated';
import type { Hybridization, MolGraph, Perception } from './perception';

export interface AtomLabel {
  readonly label: string;
  /** RDKit: "UFFTYPER: Warning: hybridization set to SP3/SP for atom i" */
  readonly hybridizationOverride: 'SP3' | 'SP' | null;
  /** RDKit: "UFFTYPER: Unrecognized charge state for atom: i" */
  readonly unrecognizedChargeState: boolean;
  /** RDKit: "UFFTYPER: Unrecognized hybridization for atom: i" */
  readonly unrecognizedHybridization: boolean;
}

/** Elements whose UFF types exist for a single oxidation state; RDKit appends it unconditionally. */
const FIXED_CHARGE_SUFFIX = new Map<number, string>();
for (const zz of [29, 47]) FIXED_CHARGE_SUFFIX.set(zz, '+1'); // Cu, Ag
for (const zz of [4, 20, 25, 26, 28, 46, 78]) FIXED_CHARGE_SUFFIX.set(zz, '+2'); // Be, Ca, Mn, Fe, Ni, Pd, Pt
for (const zz of [21, 24, 27, 79, 89, 96, 97, 98, 99, 100, 101, 102, 103]) FIXED_CHARGE_SUFFIX.set(zz, '+3'); // Sc, Cr, Co, Au, Ac, Cm..Lr
for (const zz of [2, 18, 22, 36, 54, 90, 91, 92, 93, 94, 95]) FIXED_CHARGE_SUFFIX.set(zz, '+4'); // He, Ar, Ti, Kr, Xe, Th..Am
for (const zz of [23, 41, 43, 73]) FIXED_CHARGE_SUFFIX.set(zz, '+5'); // V, Nb, Tc, Ta
FIXED_CHARGE_SUFFIX.set(42, '+6'); // Mo

/**
 * Elements typed by total valence: the valence that selects the suffix, and the suffix RDKit falls
 * back to (while logging "Unrecognized charge state") for any other valence.
 */
const VALENCE_SUFFIX = new Map<number, { byValence: Readonly<Record<number, string>>; fallback: string }>([
  [12, { byValence: { 2: '+2' }, fallback: '+2' }], // Mg
  [15, { byValence: { 3: '+3', 5: '+5' }, fallback: '+5' }], // P
  [30, { byValence: { 2: '+2' }, fallback: '+2' }], // Zn
  [31, { byValence: { 3: '+3' }, fallback: '+3' }], // Ga
  [33, { byValence: { 3: '+3' }, fallback: '+3' }], // As
  [34, { byValence: { 2: '+2' }, fallback: '+2' }], // Se
  [48, { byValence: { 2: '+2' }, fallback: '+2' }], // Cd
  [49, { byValence: { 3: '+3' }, fallback: '+3' }], // In
  [51, { byValence: { 3: '+3' }, fallback: '+3' }], // Sb
  [52, { byValence: { 2: '+2' }, fallback: '+2' }], // Te
  [80, { byValence: { 2: '+2' }, fallback: '+2' }], // Hg
  [81, { byValence: { 3: '+3' }, fallback: '+3' }], // Tl
  [82, { byValence: { 3: '+3' }, fallback: '+3' }], // Pb
  [83, { byValence: { 3: '+3' }, fallback: '+3' }], // Bi
  [84, { byValence: { 2: '+2' }, fallback: '+2' }], // Po
]);

const S_VALENCE_SUFFIX: Readonly<Record<number, string>> = { 2: '+2', 4: '+4', 6: '+6' };

/** Elements RDKit types as sp3 whatever their perceived hybridisation. */
const FORCED_SP3 = new Set<number>([12, 13, 14, 15, 50, 51, 52, 81, 82, 83, 84]);

/**
 * `Tools::addAtomChargeFlags(atom, atomKey, tolerateChargeMismatch = true)`.
 * Returns the extended key and whether RDKit logs "Unrecognized charge state".
 */
function addAtomChargeFlags(
  atomicNum: number,
  totalValence: number,
  hybridization: Hybridization,
  atomKey: string,
): { key: string; unrecognized: boolean } {
  let key = atomKey;
  let unrecognized = false;
  const fixed = FIXED_CHARGE_SUFFIX.get(atomicNum);
  const byValence = VALENCE_SUFFIX.get(atomicNum);
  if (fixed !== undefined) {
    // "totalValence == n || fc == n || tolerateChargeMismatch" is always true with the default flag.
    key += fixed;
  } else if (byValence !== undefined) {
    const suffix = byValence.byValence[totalValence];
    if (suffix !== undefined) {
      key += suffix;
    } else {
      key += byValence.fallback;
      unrecognized = true;
    }
  } else if (atomicNum === 13) {
    // Al
    if (totalValence !== 3) unrecognized = true;
  } else if (atomicNum === 14) {
    // Si
    if (totalValence !== 4) unrecognized = true;
  } else if (atomicNum === 16) {
    // S
    if (hybridization !== 'SP2') {
      const suffix = S_VALENCE_SUFFIX[totalValence];
      if (suffix !== undefined) {
        key += suffix;
      } else {
        key += '+6';
        unrecognized = true;
      }
    }
  } else if (atomicNum === 75) {
    // Re
    if (key === 'Re6') {
      key = 'Re6+5';
    } else if (key === 'Re3') {
      key = 'Re3+7';
    }
    unrecognized = true;
  }
  // lanthanides
  if (atomicNum >= 57 && atomicNum <= 71) {
    if (totalValence === 6) {
      key += '+3';
    } else {
      key += '+3';
      unrecognized = true;
    }
  }
  return { key, unrecognized };
}

/** `Tools::getAtomLabel(atom)`. */
export function getAtomLabel(g: MolGraph, p: Perception, i: number): AtomLabel {
  const atNum = g.z[i];
  let atomKey = RDKIT_ELEMENT_SYMBOLS[atNum];
  if (atomKey.length === 1) atomKey += '_';
  const hyb = p.hybridization[i];
  let hybridizationOverride: 'SP3' | 'SP' | null = null;
  let unrecognizedHybridization = false;

  // do not do hybridization on alkali metals or halogens:
  const defaultValence = RDKIT_VALENCE_LISTS[atNum][0];
  const nOuter = RDKIT_OUTER_ELECTRONS[atNum];
  if (defaultValence === -1 || (nOuter !== 1 && nOuter !== 7)) {
    if (FORCED_SP3.has(atNum)) {
      atomKey += '3';
      if (hyb !== 'SP3') hybridizationOverride = 'SP3';
    } else if (atNum === 80) {
      atomKey += '1';
      if (hyb !== 'SP') hybridizationOverride = 'SP';
    } else {
      switch (hyb) {
        case 'S':
          // don't need to do anything here
          break;
        case 'SP':
          atomKey += '1';
          break;
        case 'SP2': {
          let conjugated = p.aromatic[i] === 1;
          for (let q = g.nbrStart[i]; q < g.nbrStart[i + 1] && !conjugated; q++) {
            if (p.conjugatedBond[g.nbrBond[q]]) conjugated = true;
          }
          atomKey += conjugated && (atNum === 6 || atNum === 7 || atNum === 8 || atNum === 16) ? 'R' : '2';
          break;
        }
        case 'SP3':
          atomKey += '3';
          break;
        case 'SP2D':
          atomKey += '4';
          break;
        case 'SP3D':
          atomKey += '5';
          break;
        case 'SP3D2':
          atomKey += '6';
          break;
        default:
          unrecognizedHybridization = true;
      }
    }
  }
  // special cases by element type:
  const flagged = addAtomChargeFlags(atNum, p.totalValence[i], hyb, atomKey);
  return {
    label: flagged.key,
    hybridizationOverride,
    unrecognizedChargeState: flagged.unrecognized,
    unrecognizedHybridization,
  };
}

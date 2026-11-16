/*
 * Public entry points for typing a molecule and evaluating its UFF energy, plus the parameter
 * getters that mirror RDKit's `rdForceFieldHelpers.GetUFF*Params` functions.
 *
 * Ported from the RDKit (BSD 3-Clause, see ../README.md):
 *   Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.cpp   getAtomTypes, getUFFBondStretchParams,
 *       getUFFAngleBendParams, getUFFTorsionParams, getUFFInversionParams, getUFFVdWParams
 * Copyright (C) 2004-2021 Greg Landrum and other RDKit contributors.
 */
import { getAtomLabel } from './atomTyper';
import { buildKernel, calcTorsionParams } from './builder';
import type { UffKernel } from './builder';
import { evaluate, N_TERM_TYPES, TERM_ANGLE, TERM_BOND, TERM_INVERSION, TERM_TORSION, TERM_VDW } from './energy';
import { UnsupportedForceFieldError } from './errors';
import type { ForceFieldProblem } from './errors';
import {
  calcAngleForceConstant,
  calcBondForceConstant,
  calcBondRestLength,
  calcInversionCoefficientsAndForceConstant,
  calcNonbondedDepth,
  calcNonbondedMinimum,
  RAD2DEG,
  uffAtomicParams,
} from './params';
import type { UffAtomicParams } from './params';
import { bondBetween, buildGraph, elementSymbol, perceive } from './perception';
import type { Hybridization, MolGraph, Perception } from './perception';
import type { FfMolecule, UffEnergyTerms, UffSystem } from './types';

/**
 * What RDKit's perception and UFF atom typer conclude about a molecule. Plain data.
 * `atomTypes[i]` is the UFF label of atom i; the other arrays are RDKit's per-atom or per-bond
 * properties that the typing rests on.
 */
export interface UffPerception {
  readonly nAtoms: number;
  readonly atomicNumbers: readonly number[];
  readonly atomTypes: readonly string[];
  readonly hybridization: readonly Hybridization[];
  /** RDKit's `Atom::getTotalValence()`. */
  readonly totalValence: readonly number[];
  /** RDKit's `Atom::getNumRadicalElectrons()`. */
  readonly radicalElectrons: readonly number[];
  /** Per atom: has an aromatic (order 1.5) bond. */
  readonly aromatic: readonly boolean[];
  /** Per bond, in input order: RDKit's `Bond::getIsConjugated()`. */
  readonly conjugatedBonds: readonly boolean[];
  /** Per atom: member of a three- / four-membered ring. */
  readonly inRing3: readonly boolean[];
  readonly inRing4: readonly boolean[];
  /** Per atom: index of its connected fragment. */
  readonly fragments: readonly number[];
  readonly warnings: readonly string[];
}

/** A molecule after perception and typing; internal to this package. */
export interface TypedMolecule {
  readonly graph: MolGraph;
  readonly perception: Perception;
  readonly labels: string[];
  readonly params: UffAtomicParams[];
  readonly warnings: string[];
}

/**
 * Runs RDKit's perception and UFF atom typing.
 *
 * @throws UnsupportedForceFieldError naming every atom that cannot be typed and why
 * @throws RangeError if the molecule is structurally malformed (bad indices, orders, positions)
 */
export function typeMolecule(mol: FfMolecule): TypedMolecule {
  const graph = buildGraph(mol);
  const perception = perceive(graph);
  const n = graph.nAtoms;
  const problems: ForceFieldProblem[] = [...perception.problems];
  const flagged = new Set(problems.map((pr) => pr.atomIndex));
  const warnings: string[] = [...perception.notes];
  const labels: string[] = new Array<string>(n);
  const params: UffAtomicParams[] = [];

  for (let i = 0; i < n; i++) {
    const sym = elementSymbol(graph.z[i]);
    const res = getAtomLabel(graph, perception, i);
    labels[i] = res.label;
    const found = uffAtomicParams(res.label);
    if (found === undefined) {
      if (flagged.has(i)) continue; // the valence problem already explains this atom
      const details: string[] = [];
      if (res.unrecognizedHybridization) details.push(`its hybridisation (${perception.hybridization[i]}) is not one UFF distinguishes`);
      if (res.unrecognizedChargeState) details.push(`its valence (${perception.totalValence[i]}) matches no UFF oxidation state of ${sym}`);
      const because = details.length > 0 ? `; ${details.join(' and ')}` : '';
      problems.push({
        atomIndex: i,
        reason:
          `${sym} (hybridisation ${perception.hybridization[i]}, valence ${perception.totalValence[i]}, formal charge ${graph.charge[i]}) ` +
          `would be UFF atom type "${res.label}", which is not in RDKit's UFF parameter table${because}`,
      });
      continue;
    }
    params[i] = found;
    if (res.hybridizationOverride !== null) {
      warnings.push(
        `Atom ${i} (${sym}): perceived hybridisation ${perception.hybridization[i]} was set to ${res.hybridizationOverride} for typing as ` +
          `${res.label}, because UFF has a single type for this element (RDKit does the same and warns).`,
      );
    }
    if (res.unrecognizedChargeState) {
      warnings.push(
        `Atom ${i} (${sym}): valence ${perception.totalValence[i]} matches no UFF oxidation state of ${sym}; RDKit's fallback type ` +
          `${res.label} was used.`,
      );
    }
    if (perception.radicalElectrons[i] > 0) {
      const count = perception.radicalElectrons[i];
      warnings.push(
        `Atom ${i} (${sym}) has an unfilled valence and is treated as a radical centre with ${count} unpaired electron${count === 1 ? '' : 's'}, ` +
          'as RDKit treats an atom without implicit hydrogens. UFF has no radical-specific terms; add the missing hydrogens if this is unintended.',
      );
    }
  }
  if (problems.length > 0) {
    problems.sort((a, b) => a.atomIndex - b.atomIndex);
    throw new UnsupportedForceFieldError(problems);
  }
  return { graph, perception, labels, params, warnings };
}

function toBooleans(flags: Uint8Array): boolean[] {
  return Array.from(flags, (f) => f !== 0);
}

/**
 * Reports the UFF atom types of a molecule together with the perceived properties RDKit derives
 * them from (hybridisation, conjugation, valence, small-ring membership).
 *
 * @throws UnsupportedForceFieldError naming every atom that cannot be typed and why
 */
export function perceiveUffMolecule(mol: FfMolecule): UffPerception {
  const tm = typeMolecule(mol);
  const p = tm.perception;
  return {
    nAtoms: tm.graph.nAtoms,
    atomicNumbers: Array.from(tm.graph.z),
    atomTypes: tm.labels,
    hybridization: p.hybridization,
    totalValence: Array.from(p.totalValence),
    radicalElectrons: Array.from(p.radicalElectrons),
    aromatic: toBooleans(p.aromatic),
    conjugatedBonds: toBooleans(p.conjugatedBond),
    inRing3: toBooleans(p.inRing3),
    inRing4: toBooleans(p.inRing4),
    fragments: Array.from(p.fragment),
    warnings: tm.warnings,
  };
}

/** The object `createUffSystem` returns: the public `UffSystem` fields plus the term tables. Plain data. */
export interface UffSystemData extends UffSystem {
  /** Marks objects made by `createUffSystem`, so that a structured clone is still recognised. */
  readonly kind: 'matterlab.uff.system';
  readonly warnings: readonly string[];
  readonly kernel: UffKernel;
}

function positionsOf(mol: FfMolecule): Float64Array {
  const x = new Float64Array(3 * mol.atoms.length);
  for (let i = 0; i < mol.atoms.length; i++) {
    const p = mol.atoms[i].position;
    x[3 * i] = p[0];
    x[3 * i + 1] = p[1];
    x[3 * i + 2] = p[2];
  }
  return x;
}

/** Builds the system for an already typed molecule at the given construction geometry. */
export function systemFromTyped(tm: TypedMolecule, positions: ArrayLike<number>): UffSystemData {
  const built = buildKernel(tm.graph, tm.perception, tm.params, positions);
  const k = built.kernel;
  return {
    kind: 'matterlab.uff.system',
    nAtoms: k.nAtoms,
    atomTypes: tm.labels.slice(),
    termCounts: {
      bonds: k.bondIdx.length / 2,
      angles: k.angleIdx.length / 4,
      torsions: k.torsionIdx.length / 5,
      inversions: k.inversionIdx.length / 4,
      vdwPairs: k.vdwPairCount,
    },
    warnings: [...tm.warnings, ...built.warnings],
    kernel: k,
  };
}

/**
 * Types the molecule and builds its UFF force field: bond stretches, angle bends, torsions,
 * inversions and van der Waals pairs, as RDKit's `UFFGetMoleculeForceField` does with its default
 * settings (van der Waals threshold 10, no interactions between separate fragments).
 *
 * The atom positions matter in one case only: for a five-coordinate sp3d centre they decide which
 * two ligands are axial.
 *
 * @throws UnsupportedForceFieldError naming every atom that cannot be typed and why
 * @throws RangeError if the molecule is structurally malformed
 */
export function createUffSystem(mol: FfMolecule): UffSystem {
  return systemFromTyped(typeMolecule(mol), positionsOf(mol));
}

/** Recovers the term tables of a system made by `createUffSystem` (or a structured clone of one). */
export function systemData(system: UffSystem): UffSystemData {
  const s = system as Partial<UffSystemData>;
  if (s === null || typeof s !== 'object' || s.kind !== 'matterlab.uff.system' || s.kernel === undefined) {
    throw new TypeError('Expected a UffSystem created by createUffSystem().');
  }
  return s as UffSystemData;
}

/** Warnings raised while typing and building a system (the cases where RDKit itself warns or falls back). */
export function uffSystemWarnings(system: UffSystem): readonly string[] {
  return systemData(system).warnings;
}

function checkCoordinates(name: string, array: Float64Array, nAtoms: number): void {
  if (!(array instanceof Float64Array) || array.length !== 3 * nAtoms) {
    throw new RangeError(`${name} must be a Float64Array of ${3 * nAtoms} numbers (xyz for each of the ${nAtoms} atoms).`);
  }
}

/** UFF energy (kcal/mol), by term, at `positions` (xyz triples, angstrom). */
export function uffEnergy(system: UffSystem, positions: Float64Array): UffEnergyTerms {
  const s = systemData(system);
  checkCoordinates('positions', positions, s.nAtoms);
  const terms = new Float64Array(N_TERM_TYPES);
  const total = evaluate(s.kernel, positions, null, terms);
  return {
    bondStretch: terms[TERM_BOND],
    angleBend: terms[TERM_ANGLE],
    torsion: terms[TERM_TORSION],
    inversion: terms[TERM_INVERSION],
    vanDerWaals: terms[TERM_VDW],
    total,
  };
}

/** Writes dE/dx (kcal/mol/angstrom) into `gradient` and returns the total energy. */
export function uffEnergyAndGradient(system: UffSystem, positions: Float64Array, gradient: Float64Array): number {
  const s = systemData(system);
  checkCoordinates('positions', positions, s.nAtoms);
  checkCoordinates('gradient', gradient, s.nAtoms);
  return evaluate(s.kernel, positions, gradient, null);
}

// -------------------------------------------------------------------------------------------------
// Parameter getters, equivalent to RDKit's rdForceFieldHelpers.GetUFF*Params(mol, ...)
// -------------------------------------------------------------------------------------------------

/**
 * A typed molecule from which individual UFF term parameters can be read, like RDKit's
 * `GetUFFBondStretchParams` and friends. Every getter returns `null` where RDKit returns `None`.
 */
export interface UffParameterLookup {
  readonly atomTypes: readonly string[];
  /** Force constant kb (kcal/mol/angstrom^2) and rest length r0 (angstrom) of the bond i-j. */
  bondStretch(i: number, j: number): { kb: number; r0: number } | null;
  /**
   * Force constant ka (kcal/mol/rad^2) and natural angle theta0 (degrees) of i-j-k from the atom
   * type of the vertex j. Like RDKit's getter, this does not include the small-ring adjustments
   * the force field itself applies.
   */
  angleBend(i: number, j: number, k: number): { ka: number; theta0: number } | null;
  /** Barrier V (kcal/mol) of the torsion i-j-k-l, before division by the number of torsions about j-k. */
  torsion(i: number, j: number, k: number, l: number): { V: number } | null;
  /** Force constant K (kcal/mol) of the inversion at centre j with neighbours i, k, l. */
  inversion(i: number, j: number, k: number, l: number): { K: number } | null;
  /** Preferred distance x_ij (angstrom) and well depth D_ij (kcal/mol) of the pair i, j. */
  vdw(i: number, j: number): { x_ij: number; D_ij: number } | null;
}

/**
 * Types a molecule and returns getters for its UFF term parameters.
 *
 * @throws UnsupportedForceFieldError naming every atom that cannot be typed and why
 */
export function uffParameterLookup(mol: FfMolecule): UffParameterLookup {
  const tm = typeMolecule(mol);
  const g = tm.graph;
  const p = tm.perception;
  const par = tm.params;
  const n = g.nAtoms;
  const valid = (...idx: number[]): boolean => idx.every((i) => Number.isInteger(i) && i >= 0 && i < n);
  return {
    atomTypes: tm.labels,
    bondStretch(i, j) {
      if (!valid(i, j)) return null;
      const b = bondBetween(g, i, j);
      if (b < 0) return null;
      const r0 = calcBondRestLength(g.bondOrder[b], par[i], par[j]);
      return { kb: calcBondForceConstant(r0, par[i], par[j]), r0 };
    },
    angleBend(i, j, k) {
      if (!valid(i, j, k)) return null;
      const b1 = bondBetween(g, i, j);
      const b2 = bondBetween(g, j, k);
      if (b1 < 0 || b2 < 0) return null;
      return {
        theta0: RAD2DEG * par[j].theta0,
        ka: calcAngleForceConstant(par[j].theta0, g.bondOrder[b1], g.bondOrder[b2], par[i], par[j], par[k]),
      };
    },
    torsion(i, j, k, l) {
      if (!valid(i, j, k, l)) return null;
      const b = bondBetween(g, j, k);
      if (bondBetween(g, i, j) < 0 || b < 0 || bondBetween(g, k, l) < 0) return null;
      const h2 = p.hybridization[j];
      const h3 = p.hybridization[k];
      if (!((h2 === 'SP2' || h2 === 'SP3') && (h3 === 'SP2' || h3 === 'SP3'))) return null;
      const hasSP2 = p.hybridization[i] === 'SP2' || p.hybridization[l] === 'SP2';
      return { V: calcTorsionParams(g.bondOrder[b], g.z[j], g.z[k], h2, h3, par[j], par[k], hasSP2).V };
    },
    inversion(i, j, k, l) {
      if (!valid(i, j, k, l)) return null;
      if (bondBetween(g, i, j) < 0 || bondBetween(g, j, k) < 0 || bondBetween(g, j, l) < 0) return null;
      const at2 = g.z[j];
      const isCNO = at2 === 6 || at2 === 7 || at2 === 8;
      const isGroup15 = at2 === 15 || at2 === 33 || at2 === 51 || at2 === 83;
      if (!(isCNO || isGroup15) || p.degree[j] !== 3) return null;
      if (isCNO && p.hybridization[j] !== 'SP2') return null;
      let isBoundToSP2O = false;
      for (const nb of [i, k, l]) {
        if (g.z[nb] === 8 && p.hybridization[nb] === 'SP2') isBoundToSP2O = true;
      }
      return { K: calcInversionCoefficientsAndForceConstant(at2, isBoundToSP2O && at2 === 6).K };
    },
    vdw(i, j) {
      if (!valid(i, j)) return null;
      return { x_ij: calcNonbondedMinimum(par[i], par[j]), D_ij: calcNonbondedDepth(par[i], par[j]) };
    },
  };
}

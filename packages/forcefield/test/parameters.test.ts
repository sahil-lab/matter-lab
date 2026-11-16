/**
 * Per-term parameters against RDKit's rdForceFieldHelpers getters:
 * GetUFFBondStretchParams, GetUFFAngleBendParams, GetUFFTorsionParams, GetUFFInversionParams and
 * GetUFFVdWParams, for every bond, angle, torsion, inversion and non-bonded pair of every molecule.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUffSystem, uffParameterLookup } from '../src';
import { loadReference, toMolecule } from './helpers/reference';
import { publish, Worst } from './helpers/report';

const ref = loadReference();

/** Tight: the port evaluates the same formulas in the same order, so only the last bits may differ. */
const RELATIVE_TOLERANCE = 1e-12;

const worst = { bondStretch: new Worst(), angleBend: new Worst(), torsion: new Worst(), inversion: new Worst(), vdw: new Worst() };
const counts = { molecules: 0, bondStretch: 0, angleBend: 0, torsion: 0, torsionWithoutTerm: 0, inversion: 0, inversionWithoutTerm: 0, vdw: 0 };

function relativeDifference(ours: number, theirs: number): number {
  return Math.abs(ours - theirs) / Math.max(Math.abs(theirs), 1e-300);
}

/** Number of atom pairs in the same fragment that are neither bonded (1-2) nor share a neighbour (1-3). */
function eligiblePairs(nAtoms: number, bonds: readonly (readonly [number, number, number])[], fragment: readonly number[]): number {
  const nbrs: number[][] = Array.from({ length: nAtoms }, () => []);
  for (const [a, b] of bonds) {
    nbrs[a].push(b);
    nbrs[b].push(a);
  }
  let count = 0;
  for (let i = 0; i < nAtoms; i++) {
    const close = new Set<number>(nbrs[i]);
    for (const j of nbrs[i]) for (const k of nbrs[j]) close.add(k);
    for (let j = i + 1; j < nAtoms; j++) {
      if (fragment[i] === fragment[j] && !close.has(j)) count++;
    }
  }
  return count;
}

describe('UFF term parameters', () => {
  afterAll(() => publish('parameters', { relativeTolerance: RELATIVE_TOLERANCE, compared: counts, worstRelativeDeviation: worst }));

  for (const m of ref.molecules) {
    it(`match RDKit for ${m.name}`, () => {
      const mol = toMolecule(m, m.coords);
      const lookup = uffParameterLookup(mol);
      const check = (kind: keyof typeof worst, ours: number, theirs: number, what: string): void => {
        const d = relativeDifference(ours, theirs);
        worst[kind].note(d, `${m.name} ${what}`);
        expect(d, `${kind} ${what}: ours ${ours}, RDKit ${theirs}`).toBeLessThanOrEqual(RELATIVE_TOLERANCE);
      };

      for (const [i, j, kb, r0] of m.params.bondStretch) {
        const p = lookup.bondStretch(i, j);
        expect(p).not.toBeNull();
        if (!p) continue;
        check('bondStretch', p.kb, kb, `kb ${i}-${j}`);
        check('bondStretch', p.r0, r0, `r0 ${i}-${j}`);
        counts.bondStretch++;
      }
      for (const [i, j, k, ka, theta0] of m.params.angleBend) {
        const p = lookup.angleBend(i, j, k);
        expect(p).not.toBeNull();
        if (!p) continue;
        check('angleBend', p.ka, ka, `ka ${i}-${j}-${k}`);
        check('angleBend', p.theta0, theta0, `theta0 ${i}-${j}-${k}`);
        counts.angleBend++;
      }
      let torsionTerms = 0;
      for (const [i, j, k, l, V] of m.params.torsion) {
        const p = lookup.torsion(i, j, k, l);
        if (V === null) {
          // RDKit has no torsion here (one of the central atoms is neither sp2 nor sp3)
          expect(p, `torsion ${i}-${j}-${k}-${l}`).toBeNull();
          counts.torsionWithoutTerm++;
        } else {
          expect(p, `torsion ${i}-${j}-${k}-${l}`).not.toBeNull();
          if (!p) continue;
          check('torsion', p.V, V, `V ${i}-${j}-${k}-${l}`);
          counts.torsion++;
          torsionTerms++;
        }
      }
      let inversionTerms = 0;
      for (const [i, j, k, l, K] of m.params.inversion) {
        const p = lookup.inversion(i, j, k, l);
        if (K === null) {
          expect(p, `inversion ${i}-${j}-${k}-${l}`).toBeNull();
          counts.inversionWithoutTerm++;
        } else {
          expect(p, `inversion ${i}-${j}-${k}-${l}`).not.toBeNull();
          if (!p) continue;
          check('inversion', p.K, K, `K ${i}-${j}-${k}-${l}`);
          counts.inversion++;
          inversionTerms++;
        }
      }
      for (const [i, j, xij, dij] of m.params.vdw) {
        const p = lookup.vdw(i, j);
        expect(p).not.toBeNull();
        if (!p) continue;
        check('vdw', p.x_ij, xij, `x_ij ${i}-${j}`);
        check('vdw', p.D_ij, dij, `D_ij ${i}-${j}`);
        counts.vdw++;
      }

      // The force field itself has exactly these terms.
      const system = createUffSystem(mol);
      expect(system.termCounts.bonds).toBe(m.params.bondStretch.length);
      expect(system.termCounts.angles).toBe(m.params.angleBend.length);
      expect(system.termCounts.torsions).toBe(torsionTerms);
      expect(system.termCounts.inversions).toBe(inversionTerms);
      // GetUFFVdWParams answers for any pair of atoms, but RDKit's force field (with its default
      // ignoreInterfragInteractions=True) only has van der Waals terms within a fragment. So the
      // number of pair terms is counted from the topology: same fragment (RDKit's GetMolFrags),
      // neither bonded nor sharing a neighbour. (Pairs beyond the distance cutoff are included in
      // this count; they contribute zero. The energy tests prove that the right pairs contribute.)
      const fragment = m.perception.fragments;
      expect(system.termCounts.vdwPairs).toBe(eligiblePairs(m.nAtoms, m.bonds, fragment));
      if (!m.params.vdwSampled) {
        expect(m.params.vdw.filter(([i, j]) => fragment[i] === fragment[j])).toHaveLength(system.termCounts.vdwPairs);
      }
      counts.molecules++;
    });
  }

  it('returns null, like RDKit returns None, where there is no such term', () => {
    const m = ref.molecules.find((x) => x.name === 'ethane');
    expect(m).toBeDefined();
    if (!m) return;
    const lookup = uffParameterLookup(toMolecule(m, m.coords));
    expect(lookup.bondStretch(2, 5)).toBeNull(); // two hydrogens on different carbons
    expect(lookup.angleBend(0, 2, 1)).toBeNull(); // a hydrogen is not a vertex
    expect(lookup.torsion(2, 0, 5, 1)).toBeNull();
    expect(lookup.inversion(1, 0, 2, 3)).toBeNull(); // sp3 carbon: no inversion term
    expect(lookup.bondStretch(0, 99)).toBeNull();
    expect(lookup.vdw(2, 5)).not.toBeNull();
    expect(lookup.atomTypes[0]).toBe('C_3');
  });
});

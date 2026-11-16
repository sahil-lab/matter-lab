/**
 * UFF atom typing: the labels RDKit assigns, the molecules RDKit cannot type, the cases in which
 * RDKit warns or falls back, and what is rejected before typing.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createUffSystem, optimizeUff, perceiveUffMolecule, RDKIT_VERSION, uffEnergyAndGradient, uffSystemWarnings, UnsupportedForceFieldError } from '../src';
import type { FfAtom, FfBond, FfMolecule } from '../src';
import { uffAtomTypeLabels } from '../src/params';
import { loadReference, toMolecule } from './helpers/reference';
import { publish } from './helpers/report';

const ref = loadReference();

function atom(z: number, x = 0, y = 0, zc = 0, formalCharge = 0): FfAtom {
  return { z, formalCharge, position: [x, y, zc] };
}
function bond(a: number, b: number, order: FfBond['order'] = 1): FfBond {
  return { a, b, order };
}
function unsupported(mol: FfMolecule): UnsupportedForceFieldError {
  try {
    createUffSystem(mol);
  } catch (err) {
    if (err instanceof UnsupportedForceFieldError) return err;
    throw err;
  }
  throw new Error('expected an UnsupportedForceFieldError, but the molecule was typed');
}

const counts = { molecules: 0, atoms: 0, uniquelyDetermined: 0, labelsSeen: new Set<string>() };

describe('UFF atom types', () => {
  afterAll(() =>
    publish('typing', {
      molecules: counts.molecules,
      atoms: counts.atoms,
      atomsWhoseRdkitTypeIsUniquelyDetermined: counts.uniquelyDetermined,
      distinctAtomTypesExercised: counts.labelsSeen.size,
      atomTypesExercised: Array.from(counts.labelsSeen).sort(),
      atomTypesInRdkitTable: uffAtomTypeLabels().length,
    }),
  );

  for (const m of ref.molecules) {
    it(`are those RDKit's parameters imply for ${m.name}`, () => {
      const system = createUffSystem(toMolecule(m, m.coords));
      expect(system.nAtoms).toBe(m.nAtoms);
      expect(system.atomTypes.length).toBe(m.nAtoms);
      for (let i = 0; i < m.nAtoms; i++) {
        const candidates = m.uffLabelCandidates[i];
        expect(candidates, `atom ${i} is ${system.atomTypes[i]}, RDKit's parameters allow ${candidates.join(' or ')}`).toContain(system.atomTypes[i]);
        if (candidates.length === 1) counts.uniquelyDetermined++;
        counts.labelsSeen.add(system.atomTypes[i]);
      }
      // Types that share one set of parameters cannot be told apart from parameters; the only such
      // pair in the reference set is P_3+5 / P_3+q, of which RDKit's typer can only produce P_3+5.
      for (let i = 0; i < m.nAtoms; i++) {
        if (m.uffLabelCandidates[i].length > 1) expect(m.uffLabelCandidates[i]).toEqual(['P_3+5', 'P_3+q']);
      }
      counts.molecules++;
      counts.atoms += m.nAtoms;
    });
  }

  const withTestLabels = ref.molecules.filter((m) => m.rdkitTestLabels !== undefined);
  it('reproduce the labels asserted by RDKit\'s own unit tests (testUFFHelpers.cpp)', () => {
    expect(withTestLabels.length).toBeGreaterThanOrEqual(10);
    let checked = 0;
    for (const m of withTestLabels) {
      const types = perceiveUffMolecule(toMolecule(m, m.coords)).atomTypes;
      for (const [index, label] of m.rdkitTestLabels ?? []) {
        expect(types[index], `${m.smiles}, atom ${index}`).toBe(label);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(35);
  });
});

describe('molecules RDKit cannot type', () => {
  it('are represented in the reference set', () => {
    expect(ref.unsupported.length).toBeGreaterThanOrEqual(10);
  });

  for (const u of ref.unsupported) {
    it(`${u.name} is refused, naming the atoms and labels RDKit rejects`, () => {
      const err = unsupported(toMolecule(u, u.coords));
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('UnsupportedForceFieldError');
      // exactly the atoms RDKit logs as "Unrecognized atom type: <label> (<index>)"
      expect(err.problems.map((p) => p.atomIndex)).toEqual(u.unrecognized.map((r) => r.atomIndex).sort((a, b) => a - b));
      for (const r of u.unrecognized) {
        const problem = err.problems.find((p) => p.atomIndex === r.atomIndex);
        expect(problem?.reason).toContain(`"${r.label}"`);
      }
      expect(err.message).toContain(`atom ${u.unrecognized[0].atomIndex}`);
      expect(() => perceiveUffMolecule(toMolecule(u, u.coords))).toThrow(UnsupportedForceFieldError);
    });
  }
});

describe('warnings where RDKit warns or falls back', () => {
  const hybridisationLine = /UFFTYPER: Warning: hybridization set to (SP3|SP) for atom (\d+)/;
  const chargeLine = /UFFTYPER: Unrecognized charge state for atom: (\d+)/;
  const logged = ref.molecules.filter((m) => m.typerLog.length > 0);

  it('the reference set contains such cases', () => {
    expect(logged.length).toBeGreaterThanOrEqual(4);
  });

  for (const m of ref.molecules) {
    it(`${m.name}: one warning per line RDKit logs, none otherwise`, () => {
      const warnings = uffSystemWarnings(createUffSystem(toMolecule(m, m.coords)));
      const overrides = warnings.filter((w) => /perceived hybridisation .* was set to/.test(w));
      const fallbacks = warnings.filter((w) => /fallback type/.test(w));
      let expectedOverrides = 0;
      let expectedFallbacks = 0;
      for (const line of m.typerLog) {
        const h = hybridisationLine.exec(line);
        const c = chargeLine.exec(line);
        if (h) {
          expectedOverrides++;
          expect(overrides.some((w) => w.startsWith(`Atom ${h[2]} (`) && w.includes(`was set to ${h[1]} `))).toBe(true);
        } else if (c) {
          expectedFallbacks++;
          expect(fallbacks.some((w) => w.startsWith(`Atom ${c[1]} (`))).toBe(true);
        } else {
          throw new Error(`unexpected RDKit log line: ${line}`);
        }
      }
      expect(overrides.length).toBe(expectedOverrides);
      expect(fallbacks.length).toBe(expectedFallbacks);
      // radical centres are flagged too (RDKit is silent about them)
      const radicals = m.perception.radicalElectrons.filter((r) => r > 0).length;
      expect(warnings.filter((w) => /radical centre/.test(w)).length).toBe(radicals);
    });
  }
});

describe('input taken as written', () => {
  interface ChecksFixture {
    meta: { rdkitVersion: string };
    kekuleBenzene: {
      z: number[];
      formalCharge: number[];
      bonds: [number, number, number][];
      hybridization: string[];
      conjugatedBonds: number[];
      coords: number[];
      energy: number;
      gradient: number[];
      optimized: { energy: number; coords: number[]; ccBondLengths: number[] };
    };
    untypeable: { name: string; smiles: string; hasAllMoleculeParams: boolean; optimizeMoleculeReturned: number; energyOfTheForceFieldRdkitBuilt: number }[];
  }
  const checks = JSON.parse(readFileSync(new URL('./fixtures/rdkit_checks.json', import.meta.url), 'utf8')) as ChecksFixture;

  it('a Kekule benzene is treated exactly as RDKit treats it without aromaticity perception', () => {
    expect(checks.meta.rdkitVersion).toBe(RDKIT_VERSION);
    const k = checks.kekuleBenzene;
    // alternating double and single bonds, nothing aromatic
    expect(k.bonds.filter(([, , order]) => order === 2)).toHaveLength(3);
    expect(k.bonds.some(([, , order]) => order === 1.5)).toBe(false);
    const mol = toMolecule(k, k.coords);
    const p = perceiveUffMolecule(mol);
    expect(p.aromatic.some(Boolean)).toBe(false);
    expect(p.conjugatedBonds).toEqual(k.conjugatedBonds.map((v) => v === 1));
    for (let i = 0; i < 6; i++) expect(p.hybridization[i]).toBe(k.hybridization[i]);
    // the carbons are still resonant (conjugated sp2) ...
    expect(p.atomTypes.slice(0, 6)).toEqual(['C_R', 'C_R', 'C_R', 'C_R', 'C_R', 'C_R']);

    // ... and energy and gradient are RDKit's
    const system = createUffSystem(mol);
    const x = Float64Array.from(k.coords);
    const g = new Float64Array(x.length);
    const e = uffEnergyAndGradient(system, x, g);
    expect(Math.abs(e - k.energy)).toBeLessThanOrEqual(1e-9 * Math.abs(k.energy));
    for (let i = 0; i < g.length; i++) expect(Math.abs(g[i] - k.gradient[i])).toBeLessThanOrEqual(1e-8 * Math.max(1, Math.abs(k.gradient[i])));

    // optimised: bond lengths alternate (they would all be equal with aromatic bonds), as in RDKit
    const r = optimizeUff(mol);
    expect(r.converged).toBe(true);
    expect(r.finalEnergy).toBeLessThanOrEqual(k.optimized.energy + 1e-4);
    const cc = k.bonds.filter(([a, b]) => k.z[a] === 6 && k.z[b] === 6);
    const ours = cc.map(([a, b]) => Math.hypot(r.positions[3 * a] - r.positions[3 * b], r.positions[3 * a + 1] - r.positions[3 * b + 1], r.positions[3 * a + 2] - r.positions[3 * b + 2]));
    ours.forEach((length, i) => expect(Math.abs(length - k.optimized.ccBondLengths[i])).toBeLessThan(1e-3));
    expect(Math.max(...ours) - Math.min(...ours)).toBeGreaterThan(0.1);
  });

  it('RDKit reports success for molecules it cannot type; this package refuses them', () => {
    expect(checks.untypeable.length).toBeGreaterThanOrEqual(3);
    for (const rdkitSays of checks.untypeable) {
      // RDKit: parameters are missing, yet UFFOptimizeMolecule returns 0 ("converged")
      expect(rdkitSays.hasAllMoleculeParams, rdkitSays.name).toBe(false);
      expect(rdkitSays.optimizeMoleculeReturned, rdkitSays.name).toBe(0);
      const u = ref.unsupported.find((x) => x.name === rdkitSays.name);
      expect(u, rdkitSays.name).toBeDefined();
      if (!u) continue;
      expect(() => optimizeUff(toMolecule(u, u.coords)), rdkitSays.name).toThrow(UnsupportedForceFieldError);
    }
    // sulfur hexafluoride: without sulfur's terms nothing is left, and RDKit "converges" at zero energy
    expect(checks.untypeable.find((x) => x.name === 'sulfur hexafluoride')?.energyOfTheForceFieldRdkitBuilt).toBe(0);
  });
});

describe('what is rejected before typing', () => {
  const methane = (): FfMolecule => ({
    atoms: [atom(6), atom(1, 1.09, 0, 0), atom(1, -0.36, 1.03, 0), atom(1, -0.36, -0.51, 0.89), atom(1, -0.36, -0.51, -0.89)],
    bonds: [bond(0, 1), bond(0, 2), bond(0, 3), bond(0, 4)],
  });

  it('a valence RDKit\'s valence model does not permit', () => {
    const ch5: FfMolecule = { atoms: [...methane().atoms, atom(1, 0, 0, 1.2)], bonds: [...methane().bonds, bond(0, 5)] };
    const err = unsupported(ch5);
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0].atomIndex).toBe(0);
    expect(err.problems[0].reason).toMatch(/C has valence 5, more than the 4/);
  });

  it('a pentavalent nitro nitrogen, with a hint at the charge-separated form', () => {
    // CH3-N(=O)=O as often drawn; RDKit's sanitisation turns it into C[N+](=O)[O-] before perceiving anything
    const nitro: FfMolecule = {
      atoms: [atom(6), atom(7, 1.5, 0, 0), atom(8, 2.1, 1.1, 0), atom(8, 2.1, -1.1, 0), atom(1, -0.4, 1, 0), atom(1, -0.4, -0.5, 0.9), atom(1, -0.4, -0.5, -0.9)],
      bonds: [bond(0, 1), bond(1, 2, 2), bond(1, 3, 2), bond(0, 4), bond(0, 5), bond(0, 6)],
    };
    const err = unsupported(nitro);
    expect(err.problems.map((p) => p.atomIndex)).toEqual([1]);
    expect(err.problems[0].reason).toMatch(/N has valence 5/);
    expect(err.problems[0].reason).toMatch(/\[N\+\]\(=O\)\[O-\]/);
    // the same group in the form RDKit reports is fine
    const separated: FfMolecule = {
      atoms: nitro.atoms.map((a, i) => (i === 1 ? { ...a, formalCharge: 1 } : i === 3 ? { ...a, formalCharge: -1 } : a)),
      bonds: nitro.bonds.map((b) => (b.a === 1 && b.b === 3 ? bond(1, 3, 1) : b)),
    };
    expect(createUffSystem(separated).atomTypes.slice(0, 4)).toEqual(['C_3', 'N_R', 'O_R', 'O_R']);
  });

  it('an aromatic bond that is not part of an aromatic ring', () => {
    const odd: FfMolecule = { atoms: [atom(6), atom(6, 1.4, 0, 0)], bonds: [bond(0, 1, 1.5)] };
    const err = unsupported(odd);
    expect(err.problems.map((p) => p.atomIndex)).toEqual([0, 1]);
    expect(err.problems[0].reason).toMatch(/exactly one aromatic/);
  });

  it('lists every offending atom, not just the first', () => {
    // two heliums and a neon: none of them has a UFF type RDKit can reach
    const err = unsupported({ atoms: [atom(2), atom(10, 3, 0, 0), atom(2, 6, 0, 0)], bonds: [] });
    expect(err.problems.map((p) => p.atomIndex)).toEqual([0, 1, 2]);
    expect(err.message).toMatch(/3 atoms unsupported/);
  });

  it('malformed input raises a RangeError that says what is wrong', () => {
    const m = methane();
    expect(() => createUffSystem({ atoms: m.atoms, bonds: [...m.bonds, bond(0, 9)] })).toThrow(/bond 4 joins atoms 0 and 9/);
    expect(() => createUffSystem({ atoms: m.atoms, bonds: [...m.bonds, bond(2, 2)] })).toThrow(/joins atom 2 to itself/);
    expect(() => createUffSystem({ atoms: m.atoms, bonds: [...m.bonds, bond(1, 0)] })).toThrow(/more than one bond/);
    expect(() => createUffSystem({ atoms: m.atoms, bonds: [{ a: 0, b: 1, order: 4 as unknown as FfBond['order'] }] })).toThrow(/order 4/);
    expect(() => createUffSystem({ atoms: [{ ...m.atoms[0], z: 0 }], bonds: [] })).toThrow(/atomic number 0/);
    expect(() => createUffSystem({ atoms: [{ ...m.atoms[0], z: 119 }], bonds: [] })).toThrow(/atomic number 119/);
    expect(() => createUffSystem({ atoms: [{ ...m.atoms[0], formalCharge: 0.5 }], bonds: [] })).toThrow(/formal charge 0.5/);
    expect(() => createUffSystem({ atoms: [{ ...m.atoms[0], position: [0, Number.NaN, 0] }], bonds: [] })).toThrow(/three finite numbers/);
    for (const bad of [
      () => createUffSystem({ atoms: m.atoms, bonds: [...m.bonds, bond(0, 9)] }),
      () => createUffSystem(null as unknown as FfMolecule),
    ]) {
      expect(bad).toThrow(RangeError);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  ELECTRON_MASS_U,
  ELEMENTS,
  atomCharge,
  atomLabel,
  atomMass,
  atomMassNumber,
  atomSymbol,
  describeAtom,
  editScene,
  electronConfiguration,
  formatCharge,
  neutralSubshells,
} from '../src';
import { build } from './helpers';

describe('atomic identity bookkeeping', () => {
  it('changes the element when the proton count changes, and nothing else', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 6, neutrons: 6, position: [0, 0, 0] });
    });
    const carbon = scene.atoms.get(1)!;
    expect(atomSymbol(carbon)).toBe('C');
    expect(atomCharge(carbon)).toBe(0);
    expect(atomMassNumber(carbon)).toBe(12);

    // Adding one proton: carbon-12 becomes nitrogen-13 with one electron too few.
    const plus = editScene(scene, 'add proton', (e) => e.updateAtom(1, { protons: 7 })).scene.atoms.get(1)!;
    expect(atomSymbol(plus)).toBe('N');
    expect(plus.neutrons).toBe(6);
    expect(atomMassNumber(plus)).toBe(13);
    expect(plus.electrons).toBe(6);
    expect(atomCharge(plus)).toBe(1);
    expect(atomLabel(plus)).toBe('¹³N⁺');

    // Removing one proton: carbon-12 becomes boron-11 with one electron too many.
    const minus = editScene(scene, 'remove proton', (e) => e.updateAtom(1, { protons: 5 })).scene.atoms.get(1)!;
    expect(atomSymbol(minus)).toBe('B');
    expect(atomMassNumber(minus)).toBe(11);
    expect(atomCharge(minus)).toBe(-1);
  });

  it('changes only the isotope when the neutron count changes', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 6, position: [0, 0, 0] });
    });
    const natural = scene.atoms.get(1)!;
    expect(atomMassNumber(natural)).toBeNull();
    expect(atomLabel(natural)).toBe('C');

    const c13 = editScene(scene, 'isotope', (e) => e.updateAtom(1, { neutrons: 7 })).scene.atoms.get(1)!;
    expect(atomSymbol(c13)).toBe('C');
    expect(atomCharge(c13)).toBe(0);
    expect(atomMassNumber(c13)).toBe(13);
    expect(atomLabel(c13)).toBe('¹³C');

    const back = editScene(scene, 'natural', (e) => e.updateAtom(1, { neutrons: null })).scene.atoms.get(1)!;
    expect(back.neutrons).toBeNull();
  });

  it('changes only the charge when the electron count changes', () => {
    for (const [protons, electrons, label, kind] of [
      [11, 10, 'Na⁺', 'cation'],
      [17, 18, 'Cl⁻', 'anion'],
      [8, 10, 'O²⁻', 'anion'],
      [26, 23, 'Fe³⁺', 'cation'],
      [1, 0, 'H⁺', 'cation'],
      [6, 6, 'C', 'neutral atom'],
    ] as const) {
      const atom = { protons, electrons, neutrons: null };
      expect(atomCharge(atom)).toBe(protons - electrons);
      expect(atomLabel(atom)).toBe(label);
      expect(describeAtom(atom).kind).toBe(kind);
      expect(atomSymbol(atom)).toBe(ELEMENTS[protons - 1]!.symbol);
    }
    expect(formatCharge(0)).toBe('');
    expect(formatCharge(1)).toBe('+');
    expect(formatCharge(-1)).toBe('−');
    expect(formatCharge(3)).toBe('3+');
    expect(formatCharge(-2)).toBe('2−');
  });

  it('uses the standard atomic weight, the isotope mass, or a labelled estimate as appropriate', () => {
    expect(atomMass({ protons: 6, neutrons: null, electrons: 6 })).toEqual({ mass: 12.011, basis: 'standard-atomic-weight' });
    expect(atomMass({ protons: 6, neutrons: 6, electrons: 6 })).toEqual({ mass: 12, basis: 'isotope-mass' });
    const deuterium = atomMass({ protons: 1, neutrons: 1, electrons: 1 });
    expect(deuterium.basis).toBe('isotope-mass');
    expect(deuterium.mass).toBeCloseTo(2.014102, 5);

    // An ion is lighter or heavier than the neutral atom by the electrons it lost or gained.
    const sodium = atomMass({ protons: 11, neutrons: 12, electrons: 11 }).mass;
    expect(atomMass({ protons: 11, neutrons: 12, electrons: 10 }).mass).toBeCloseTo(sodium - ELECTRON_MASS_U, 12);
    expect(atomMass({ protons: 17, neutrons: null, electrons: 18 }).mass).toBeCloseTo(35.45 + ELECTRON_MASS_U, 9);

    const hypothetical = atomMass({ protons: 6, neutrons: 60, electrons: 6 });
    expect(hypothetical).toEqual({ mass: 66, basis: 'mass-number-estimate' });
  });

  it('warns honestly about unstable, hypothetical and unusual configurations', () => {
    const codes = (atom: { protons: number; neutrons: number | null; electrons: number }, bonded?: boolean) =>
      describeAtom(atom, { bonded }).notes.map((n) => `${n.severity}:${n.code}`);

    expect(codes({ protons: 6, neutrons: 6, electrons: 6 })).toEqual([]);
    expect(codes({ protons: 6, neutrons: null, electrons: 6 })).toEqual([]);
    expect(codes({ protons: 6, neutrons: 8, electrons: 6 })).toEqual(['info:radioactive']);
    expect(describeAtom({ protons: 6, neutrons: 8, electrons: 6 }).notes[0]!.message).toMatch(/¹⁴C is radioactive.*5\.7 ky/);
    expect(codes({ protons: 6, neutrons: 60, electrons: 6 })).toEqual(['warning:hypothetical-nuclide']);
    expect(codes({ protons: 43, neutrons: null, electrons: 43 })).toEqual(['info:no-natural-isotope']);
    expect(codes({ protons: 118, neutrons: null, electrons: 118 })).toEqual(['info:no-natural-isotope', 'info:superheavy']);
    expect(codes({ protons: 1, neutrons: null, electrons: 0 })).toEqual(['info:bare-nucleus']);
    expect(codes({ protons: 11, neutrons: null, electrons: 8 })).toEqual(['warning:unusual-charge']);
    expect(codes({ protons: 11, neutrons: null, electrons: 10 })).toEqual([]);
    expect(codes({ protons: 8, neutrons: null, electrons: 10 }, false)).toEqual(['info:unbound-anion']);
    expect(codes({ protons: 8, neutrons: null, electrons: 10 }, true)).toEqual([]);

    // A nuclide that lives for less than a second is flagged more strongly than a long-lived one.
    const og = describeAtom({ protons: 118, neutrons: 176, electrons: 118 });
    expect(og.notes.map((n) => n.code)).toContain('short-lived');
    expect(og.isotope?.a).toBe(294);
  });
});

describe('electron configurations', () => {
  it('has a tabulated neutral configuration whose electrons add up to Z for all 118 elements', () => {
    for (const element of ELEMENTS) {
      const total = neutralSubshells(element.z).reduce((sum, s) => sum + s.electrons, 0);
      expect(total, element.symbol).toBe(element.z);
      for (const s of neutralSubshells(element.z)) {
        expect(s.electrons).toBeGreaterThan(0);
        expect(s.electrons).toBeLessThanOrEqual(2 * (2 * s.l + 1));
        expect(s.l).toBeLessThan(s.n);
      }
    }
  });

  it('reports neutral ground states from reference data', () => {
    expect(electronConfiguration(6, 6)).toMatchObject({ text: '[He] 2s2 2p2', unpaired: 2, evidence: 'reference' });
    expect(electronConfiguration(7, 7).unpaired).toBe(3);
    expect(electronConfiguration(8, 8).unpaired).toBe(2);
    expect(electronConfiguration(10, 10)).toMatchObject({ text: '[He] 2s2 2p6', unpaired: 0 });
    expect(electronConfiguration(24, 24)).toMatchObject({ text: '[Ar] 3d5 4s1', unpaired: 6 });
    expect(electronConfiguration(29, 29).text).toBe('[Ar] 3d10 4s1');
    expect(electronConfiguration(1, 1).text).toBe('1s1');
  });

  it('applies the textbook rules to ions and labels the result as rule-based', () => {
    // Condensed notation always names the largest noble-gas core that is strictly smaller than the ion.
    const cases: Array<[number, number, string, number]> = [
      [11, 10, '[He] 2s2 2p6', 0], // Na+
      [26, 24, '[Ar] 3d6', 4], // Fe2+ loses 4s before 3d
      [26, 23, '[Ar] 3d5', 5], // Fe3+
      [29, 28, '[Ar] 3d10', 0], // Cu+
      [29, 27, '[Ar] 3d9', 1], // Cu2+
      [58, 55, '[Xe] 4f1', 1], // Ce3+
      [58, 54, '[Kr] 4d10 5s2 5p6', 0], // Ce4+ has the xenon configuration
      [17, 18, '[Ne] 3s2 3p6', 0], // Cl-
      [8, 10, '[He] 2s2 2p6', 0], // O2-
      [1, 2, '1s2', 0], // H-
      [79, 80, '[Xe] 4f14 5d10 6s2', 0], // Au-
      [1, 0, '(no electrons)', 0], // H+
    ];
    for (const [z, electrons, text, unpaired] of cases) {
      const config = electronConfiguration(z, electrons);
      expect(config.text, `Z=${z}, e=${electrons}`).toBe(text);
      expect(config.unpaired, `Z=${z}, e=${electrons}`).toBe(unpaired);
      expect(config.evidence).toBe('rule-based');
      expect(config.subshells.reduce((sum, s) => sum + s.electrons, 0)).toBe(electrons);
    }
  });

  it('flags predicted ground states of superheavy elements', () => {
    expect(electronConfiguration(118, 118).basis).toMatch(/Predicted/);
    expect(electronConfiguration(6, 6).basis).toMatch(/Tabulated/);
  });
});

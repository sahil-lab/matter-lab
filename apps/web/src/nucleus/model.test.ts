import { describe, expect, it } from 'vitest';
import { MAX_NUCLEONS, NUCLEON_FACTS, NUCLEON_RADIUS_FM, buildNucleus, formatLength, nuclideOf, roundLength } from './model';
import type { NucleusModel } from './model';

const NUCLIDES: ReadonlyArray<readonly [string, number, number]> = [
  ['hydrogen-1', 1, 0],
  ['deuterium', 1, 1],
  ['helium-4', 2, 2],
  ['carbon-12', 6, 6],
  ['carbon-14', 6, 8],
  ['iron-56', 26, 30],
  ['lead-208', 82, 126],
  ['uranium-238', 92, 146],
  ['oganesson-294', 118, 176],
];

function closestPair(model: NucleusModel): number {
  let closest = Infinity;
  for (let i = 0; i < model.nucleons.length; i++) {
    for (let j = i + 1; j < model.nucleons.length; j++) {
      const a = model.nucleons[i]!.position;
      const b = model.nucleons[j]!.position;
      closest = Math.min(closest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return closest;
}

const centre = (points: ReadonlyArray<readonly [number, number, number]>): number[] => [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / points.length);

// Packing the heaviest nuclei takes a few tenths of a second each, and several are packed per test;
// on a busy machine that runs past the default limit of five seconds.
describe('the picture of a nucleus', { timeout: 60_000 }, () => {
  it('has exactly the protons and neutrons of the nuclide, each numbered once', () => {
    for (const [name, z, n] of NUCLIDES) {
      const model = buildNucleus(z, n);
      expect(model.massNumber, name).toBe(z + n);
      const protons = model.nucleons.filter((nucleon) => nucleon.kind === 'proton');
      const neutrons = model.nucleons.filter((nucleon) => nucleon.kind === 'neutron');
      expect(protons.length, name).toBe(z);
      expect(neutrons.length, name).toBe(n);
      expect(protons.map((p) => p.ordinal).sort((a, b) => a - b), name).toEqual(Array.from({ length: z }, (_, i) => i + 1));
      expect(neutrons.map((p) => p.ordinal).sort((a, b) => a - b), name).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(model.nucleons.map((nucleon) => nucleon.index), name).toEqual(Array.from({ length: z + n }, (_, i) => i));
    }
  });

  it('never lets two spheres overlap, and is centred on itself', () => {
    for (const [name, z, n] of NUCLIDES) {
      const model = buildNucleus(z, n);
      if (model.massNumber > 1) expect(closestPair(model), name).toBeGreaterThanOrEqual(2 * NUCLEON_RADIUS_FM);
      for (const coordinate of centre(model.nucleons.map((nucleon) => nucleon.position))) expect(Math.abs(coordinate), name).toBeLessThan(1e-9);
      // The stated extent really holds every sphere.
      for (const nucleon of model.nucleons) expect(Math.hypot(...nucleon.position) + NUCLEON_RADIUS_FM, name).toBeLessThanOrEqual(model.extentFm + 1e-12);
    }
  });

  it('is about as large as nuclei are measured to be: r0 A^(1/3) with r0 = 1.2 fm', () => {
    expect(buildNucleus(6, 6).empiricalRadiusFm).toBeCloseTo(1.2 * Math.cbrt(12), 12);
    for (const [name, z, n] of NUCLIDES) {
      const model = buildNucleus(z, n);
      const ratio = model.extentFm / model.empiricalRadiusFm;
      if (model.massNumber === 1) {
        // One nucleon is one sphere, whatever the rule says.
        expect(model.extentFm).toBe(NUCLEON_RADIUS_FM);
      } else if (model.massNumber < 4) {
        // Two or three spheres cannot touch inside so small a ball; the picture is as tight as they allow.
        expect(ratio, name).toBeGreaterThan(1);
        expect(ratio, name).toBeLessThan(1.15);
      } else {
        expect(ratio, name).toBeGreaterThan(0.98);
        expect(ratio, name).toBeLessThan(1.08);
      }
    }
    // Twice the nucleons, about the cube root of two times the radius.
    expect(buildNucleus(82, 126).extentFm / buildNucleus(40, 64).extentFm).toBeCloseTo(Math.cbrt(2), 1);
  });

  it('is the same every time, and mixes protons with neutrons', () => {
    expect(buildNucleus(26, 30)).toEqual(buildNucleus(26, 30));
    expect(buildNucleus(6, 6).nucleons).not.toEqual(buildNucleus(6, 8).nucleons.slice(0, 12));
    const lead = buildNucleus(82, 126);
    const protons = centre(lead.nucleons.filter((nucleon) => nucleon.kind === 'proton').map((nucleon) => nucleon.position));
    const neutrons = centre(lead.nucleons.filter((nucleon) => nucleon.kind === 'neutron').map((nucleon) => nucleon.position));
    // Neither kind is gathered on one side. With all protons on one side of this ball of 7 fm their
    // centre would lie some 5 fm from that of the neutrons; dealt out at random, as they are, the two
    // centres differ by chance alone, typically by 0.7 fm.
    expect(Math.hypot(protons[0]! - neutrons[0]!, protons[1]! - neutrons[1]!, protons[2]! - neutrons[2]!)).toBeLessThan(2);
  });

  it('refuses counts that are not a nucleus', () => {
    expect(() => buildNucleus(0, 1)).toThrow(RangeError);
    expect(() => buildNucleus(1, -1)).toThrow(RangeError);
    expect(() => buildNucleus(1.5, 1)).toThrow(RangeError);
    expect(() => buildNucleus(200, MAX_NUCLEONS)).toThrow(RangeError);
  });
});

describe('what is said about the nuclide', () => {
  it('gives the binding energies of the evaluated masses', () => {
    // Atomic Mass Evaluation 2020: deuterium 2.2246 MeV, helium-4 28.296 MeV, carbon-12 92.162 MeV, iron-56 492.26 MeV.
    expect(nuclideOf(1, 1).bindingEnergyMeV!).toBeCloseTo(2.2246, 3);
    expect(nuclideOf(2, 2).bindingEnergyMeV!).toBeCloseTo(28.296, 2);
    expect(nuclideOf(6, 6).bindingEnergyMeV!).toBeCloseTo(92.162, 2);
    expect(nuclideOf(26, 30).bindingEnergyMeV!).toBeCloseTo(492.26, 1);
    expect(nuclideOf(26, 30).bindingEnergyMeV! / 56).toBeCloseTo(8.79, 2);
    // A single proton is bound to nothing.
    expect(nuclideOf(1, 0).bindingEnergyMeV!).toBeCloseTo(0, 9);
  });

  it('shows the most abundant isotope when the atom states none, and says that it does', () => {
    expect(nuclideOf(6, null)).toMatchObject({ name: 'Carbon-12', neutrons: 6, massNumber: 12, standsForNaturalMix: true });
    expect(nuclideOf(17, null)).toMatchObject({ name: 'Chlorine-35', standsForNaturalMix: true });
    expect(nuclideOf(6, 8)).toMatchObject({ name: 'Carbon-14', standsForNaturalMix: false });
    expect(nuclideOf(6, 8).isotope!.stability).not.toBe('S');
  });

  it('has no data to offer for a nuclide that is not in the evaluation', () => {
    const made = nuclideOf(6, 40);
    expect(made).toMatchObject({ name: 'Carbon-46', isotope: null, bindingEnergyMeV: null });
  });

  it('states the nucleon masses of CODATA 2018', () => {
    expect(NUCLEON_FACTS.proton.massMeV).toBeCloseTo(938.272, 3);
    expect(NUCLEON_FACTS.neutron.massMeV).toBeCloseTo(939.565, 3);
    expect(NUCLEON_FACTS.neutron.massMeV - NUCLEON_FACTS.proton.massMeV).toBeCloseTo(1.2933, 4);
    expect(NUCLEON_FACTS.proton.charge).toBe(1);
    expect(NUCLEON_FACTS.neutron.charge).toBe(0);
  });
});

describe('lengths on the scale bar', () => {
  it('are written with the unit that suits them', () => {
    expect(formatLength(2)).toBe('2 fm');
    expect(formatLength(500)).toBe('500 fm');
    expect(formatLength(1500)).toBe('1.5 pm');
    expect(formatLength(50_000)).toBe('50 pm');
    expect(formatLength(170_000)).toBe('1.7 Å');
  });

  it('are rounded down to 1, 2 or 5 times a power of ten', () => {
    expect(roundLength(3.7)).toBe(2);
    expect(roundLength(7.2)).toBe(5);
    expect(roundLength(0.9)).toBeCloseTo(0.5, 12);
    expect(roundLength(120)).toBe(100);
    expect(roundLength(1)).toBe(1);
    expect(roundLength(49_999)).toBe(20_000);
  });
});

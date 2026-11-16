/**
 * UFF energies and analytic gradients against RDKit, and analytic against numerical gradients.
 *
 * Tolerances. The task's target is |dE| <= 1e-3 kcal/mol or 1e-6 relative. The port evaluates
 * RDKit's formulas in RDKit's order, so the tests demand far more than that: nine significant
 * digits for energies and eight for gradients. The measured deviations (see the "energy" section
 * published at the end) are several orders of magnitude smaller still.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUffSystem, uffEnergy, uffEnergyAndGradient } from '../src';
import type { UffSystem } from '../src';
import { findMolecule, loadReference, maxAbs, toMolecule } from './helpers/reference';
import { publish, Worst } from './helpers/report';

const ref = loadReference();

/** |E - E_RDKit| <= this * max(1, |E_RDKit|) */
const ENERGY_TOLERANCE = 1e-9;
/** max |g - g_RDKit| <= this * max(1, max |g_RDKit|) */
const GRADIENT_TOLERANCE = 1e-8;
/**
 * Analytic against central-difference gradients, relative to max(1, max |g|). With a step of 1e-5
 * angstrom the finite difference itself carries a second-order truncation error and the rounding
 * of an energy difference, so this cannot be as tight as the comparison with RDKit's analytic
 * gradient. The largest deviation measured over the reference set is 3.5e-9.
 */
const NUMERICAL_GRADIENT_TOLERANCE = 1e-7;
const FD_STEP = 1e-5;

const worst = {
  energyAbsolute: new Worst(),
  energyRelative: new Worst(),
  gradientAbsolute: new Worst(),
  gradientRelative: new Worst(),
  // The same without the one molecule that is longer than the van der Waals cutoff (class "large"),
  // for which this package and RDKit differ by design away from the construction geometry (README).
  energyRelativeShorterThanCutoff: new Worst(),
  gradientRelativeShorterThanCutoff: new Worst(),
  numericalGradientRelative: new Worst(),
  distortedEnergyRelative: new Worst(),
  distortedGradientRelative: new Worst(),
};
const counts = { molecules: 0, geometries: 0, gradientComponents: 0, numericalGradientComponents: 0, distorted: 0 };
/** Worst relative deviations from RDKit per chemical class (a molecule can belong to several). */
const byClass = new Map<string, { molecules: number; energyRelative: number; gradientRelative: number }>();

function compareWithRdkit(
  name: string,
  system: UffSystem,
  coords: number[],
  energy: number,
  gradient: number[],
  energyWorst: [Worst, Worst] | null,
  gradientWorst: [Worst, Worst] | null,
): { relE: number; relG: number } {
  const x = Float64Array.from(coords);
  const g = new Float64Array(x.length);
  const e = uffEnergyAndGradient(system, x, g);
  const terms = uffEnergy(system, x);
  // the two entry points agree with each other, and the terms add up
  expect(terms.total).toBe(e);
  const sum = terms.bondStretch + terms.angleBend + terms.torsion + terms.inversion + terms.vanDerWaals;
  expect(Math.abs(sum - terms.total)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(terms.total)));

  const dE = Math.abs(e - energy);
  const relE = dE / Math.max(1, Math.abs(energy));
  energyWorst?.[0].note(dE, name);
  energyWorst?.[1].note(relE, name);
  expect(relE, `${name}: energy ${e} vs RDKit ${energy}`).toBeLessThanOrEqual(ENERGY_TOLERANCE);

  let dG = 0;
  for (let i = 0; i < g.length; i++) dG = Math.max(dG, Math.abs(g[i] - gradient[i]));
  const relG = dG / Math.max(1, maxAbs(gradient));
  gradientWorst?.[0].note(dG, name);
  gradientWorst?.[1].note(relG, name);
  expect(relG, `${name}: largest gradient deviation ${dG}`).toBeLessThanOrEqual(GRADIENT_TOLERANCE);
  counts.gradientComponents += g.length;
  return { relE, relG };
}

// Published once every test in this file has run, so that the special geometries are included.
afterAll(() =>
  publish('energy', {
    tolerances: { energyRelative: ENERGY_TOLERANCE, gradientRelative: GRADIENT_TOLERANCE, numericalGradientRelative: NUMERICAL_GRADIENT_TOLERANCE },
    compared: counts,
    worst,
    byClass: Object.fromEntries(Array.from(byClass).sort(([a], [b]) => a.localeCompare(b))),
  }),
);

describe('UFF energy and gradient', () => {
  for (const m of ref.molecules) {
    it(`match RDKit at the embedded and at a perturbed geometry of ${m.name}`, () => {
      const system = createUffSystem(toMolecule(m, m.coords));
      const a = compareWithRdkit(`${m.name} (embedded)`, system, m.coords, m.energy, m.gradient, [worst.energyAbsolute, worst.energyRelative], [worst.gradientAbsolute, worst.gradientRelative]);
      const b = compareWithRdkit(`${m.name} (perturbed)`, system, m.perturbed.coords, m.perturbed.energy, m.perturbed.gradient, [worst.energyAbsolute, worst.energyRelative], [worst.gradientAbsolute, worst.gradientRelative]);
      counts.molecules++;
      counts.geometries += 2;
      if (!m.classes.includes('large')) {
        worst.energyRelativeShorterThanCutoff.note(Math.max(a.relE, b.relE), m.name);
        worst.gradientRelativeShorterThanCutoff.note(Math.max(a.relG, b.relG), m.name);
      }
      for (const cls of m.classes) {
        const entry = byClass.get(cls) ?? { molecules: 0, energyRelative: 0, gradientRelative: 0 };
        entry.molecules++;
        entry.energyRelative = Math.max(entry.energyRelative, a.relE, b.relE);
        entry.gradientRelative = Math.max(entry.gradientRelative, a.relG, b.relG);
        byClass.set(cls, entry);
      }
    });
  }

  for (const m of ref.molecules) {
    it(`analytic gradient equals the numerical gradient for ${m.name}`, () => {
      const system = createUffSystem(toMolecule(m, m.coords));
      const x = Float64Array.from(m.perturbed.coords);
      const g = new Float64Array(x.length);
      uffEnergyAndGradient(system, x, g);
      const scale = Math.max(1, maxAbs(g));
      // every coordinate of small molecules, an even sample of the larger ones
      const stride = Math.max(1, Math.floor(x.length / 150));
      for (let i = 0; i < x.length; i += stride) {
        const saved = x[i];
        x[i] = saved + FD_STEP;
        const plus = uffEnergy(system, x).total;
        x[i] = saved - FD_STEP;
        const minus = uffEnergy(system, x).total;
        x[i] = saved;
        const numeric = (plus - minus) / (2 * FD_STEP);
        const rel = Math.abs(numeric - g[i]) / scale;
        worst.numericalGradientRelative.note(rel, `${m.name} coordinate ${i}`);
        expect(rel, `coordinate ${i}: analytic ${g[i]}, numerical ${numeric}`).toBeLessThanOrEqual(NUMERICAL_GRADIENT_TOLERANCE);
        counts.numericalGradientComponents++;
      }
    });
  }
});

describe('special geometries', () => {
  for (const d of ref.distorted) {
    it(`${d.name}: ${d.description}`, () => {
      const base = findMolecule(d.molecule);
      // RDKit builds the force field at the distorted geometry; so does this.
      const system = createUffSystem(toMolecule(base, d.coords));
      const x = Float64Array.from(d.coords);
      const g = new Float64Array(x.length);
      const e = uffEnergyAndGradient(system, x, g);
      expect(Number.isFinite(e)).toBe(true);
      expect(g.every((v) => Number.isFinite(v))).toBe(true);
      const relE = Math.abs(e - d.energy) / Math.max(1, Math.abs(d.energy));
      worst.distortedEnergyRelative.note(relE, d.name);
      expect(relE).toBeLessThanOrEqual(ENERGY_TOLERANCE);
      if (d.gradient !== null) {
        let dG = 0;
        for (let i = 0; i < g.length; i++) dG = Math.max(dG, Math.abs(g[i] - d.gradient[i]));
        const relG = dG / Math.max(1, maxAbs(d.gradient));
        worst.distortedGradientRelative.note(relG, d.name);
        expect(relG).toBeLessThanOrEqual(GRADIENT_TOLERANCE);
      } else {
        // Documented difference: RDKit divides by zero in the inversion gradient when three atoms
        // of an sp2 centre are collinear and returns NaN; here the undefined term is left out.
        expect(d.rdkitGradientNonFiniteAtoms?.length).toBeGreaterThan(0);
      }
      counts.distorted++;
    });
  }

  it('the small-angle penalty RDKit adds below 30 degrees is reproduced on both sides of its threshold', () => {
    const below = ref.distorted.find((d) => d.name === 'ethyne H-C-C 29 deg');
    const above = ref.distorted.find((d) => d.name === 'ethyne H-C-C 31 deg');
    expect(below && above).toBeTruthy();
    if (!below || !above) return;
    // both are astronomically high (the sp term is far from 180 degrees) and both match RDKit above
    expect(below.energy).toBeGreaterThan(above.energy);
  });

  it('an energy that is undefined is reported as NaN, never as a made-up number', () => {
    const water = findMolecule('water');
    const coords = water.coords.slice();
    // put one hydrogen exactly on the oxygen: the H-O-H angle no longer exists
    coords[3] = coords[0];
    coords[4] = coords[1];
    coords[5] = coords[2];
    const system = createUffSystem(toMolecule(water, water.coords));
    expect(Number.isNaN(uffEnergy(system, Float64Array.from(coords)).total)).toBe(true);
  });
});

describe('the UffSystem object', () => {
  const m = findMolecule('caffeine');
  const system = createUffSystem(toMolecule(m, m.coords));
  const x = Float64Array.from(m.coords);

  it('reports what it contains', () => {
    expect(system.nAtoms).toBe(m.nAtoms);
    expect(system.atomTypes).toHaveLength(m.nAtoms);
    expect(system.termCounts.bonds).toBe(m.bonds.length);
    expect(system.termCounts.angles).toBeGreaterThan(0);
    expect(system.termCounts.torsions).toBeGreaterThan(0);
    expect(system.termCounts.inversions).toBeGreaterThan(0);
    expect(system.termCounts.vdwPairs).toBeGreaterThan(0);
  });

  it('is plain data: a structured clone evaluates to the same energy and gradient', () => {
    const clone = structuredClone(system);
    expect(clone).not.toBe(system);
    const g1 = new Float64Array(x.length);
    const g2 = new Float64Array(x.length);
    expect(uffEnergyAndGradient(clone, x, g2)).toBe(uffEnergyAndGradient(system, x, g1));
    expect(Array.from(g2)).toEqual(Array.from(g1));
    expect(uffEnergy(clone, x)).toEqual(uffEnergy(system, x));
  });

  it('overwrites the gradient array instead of adding to it', () => {
    const g = new Float64Array(x.length).fill(1e6);
    uffEnergyAndGradient(system, x, g);
    let dG = 0;
    for (let i = 0; i < g.length; i++) dG = Math.max(dG, Math.abs(g[i] - m.gradient[i]));
    expect(dG).toBeLessThan(1e-6);
  });

  it('has no net force and no net torque', () => {
    const g = new Float64Array(x.length);
    uffEnergyAndGradient(system, x, g);
    const force = [0, 0, 0];
    const torque = [0, 0, 0];
    for (let i = 0; i < m.nAtoms; i++) {
      const [px, py, pz] = [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
      const [gx, gy, gz] = [g[3 * i], g[3 * i + 1], g[3 * i + 2]];
      force[0] += gx;
      force[1] += gy;
      force[2] += gz;
      torque[0] += py * gz - pz * gy;
      torque[1] += pz * gx - px * gz;
      torque[2] += px * gy - py * gx;
    }
    for (const v of [...force, ...torque]) expect(Math.abs(v)).toBeLessThan(1e-9 * Math.max(1, maxAbs(g)));
  });

  it('rejects arrays of the wrong shape and objects it did not make', () => {
    expect(() => uffEnergy(system, new Float64Array(3))).toThrow(RangeError);
    expect(() => uffEnergyAndGradient(system, x, new Float64Array(3))).toThrow(RangeError);
    expect(() => uffEnergy(system, Array.from(x) as unknown as Float64Array)).toThrow(RangeError);
    expect(() => uffEnergy({ nAtoms: 0, atomTypes: [], termCounts: system.termCounts }, new Float64Array(0))).toThrow(TypeError);
  });
});

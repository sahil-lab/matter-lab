/**
 * The optimiser against RDKit, started from the same embedded geometry as RDKit's UFFOptimizeMolecule.
 *
 * Three reference points are in the fixture for every molecule:
 *   optimized  what UFFOptimizeMolecule returns once it reports convergence;
 *   polished   the nearby minimum of RDKit's own energy function, located to an RMS gradient of
 *              about 1e-6 by an independent NumPy BFGS that only calls RDKit's CalcEnergy/CalcGrad;
 *   hessian    the lowest eigenvalue of RDKit's Hessian at both points (NumPy), which tells whether
 *              a point is a minimum or a saddle point.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { optimizeUff } from '../src';
import type { OptimizeResult } from '../src';
import type { RefMolecule } from './helpers/reference';
import { angleDeg, angleTriples, distance, findMolecule, loadReference, toMolecule } from './helpers/reference';
import { publish, Worst } from './helpers/report';

const ref = loadReference();

/** "No higher than RDKit's optimised energy plus a small tolerance", kcal/mol. */
const ENERGY_SLACK = 1e-4;
/** Required agreement of the optimised geometry with RDKit's: bond lengths (angstrom) and angles (degrees). */
const BOND_TOLERANCE = 0.01;
const ANGLE_TOLERANCE = 1.0;
/** A Hessian eigenvalue below this (kcal/mol/angstrom^2) marks a saddle point. */
const SADDLE_CURVATURE = -0.01;
/**
 * How far above the polished minimum a converged run may stop. The default gradient tolerance
 * (1e-4 kcal/mol/angstrom RMS) leaves this much energy in the flattest modes: the worst case is the
 * free rotation about the C=C=C axis of allene, 3e-3 kcal/mol.
 */
const POLISHED_ENERGY_SLACK = 5e-3;

const results = new Map<string, OptimizeResult>();
function optimized(m: RefMolecule): OptimizeResult {
  let r = results.get(m.name);
  if (!r) {
    r = optimizeUff(toMolecule(m, m.coords));
    results.set(m.name, r);
  }
  return r;
}

function geometryDeviation(m: RefMolecule, ours: ArrayLike<number>, theirs: ArrayLike<number>): { bond: number; angle: number } {
  let bond = 0;
  for (const [a, b] of m.bonds) bond = Math.max(bond, Math.abs(distance(ours, a, b) - distance(theirs, a, b)));
  let angle = 0;
  for (const [i, j, k] of angleTriples(m)) angle = Math.max(angle, Math.abs(angleDeg(ours, i, j, k) - angleDeg(theirs, i, j, k)));
  return { bond, angle };
}

/** Did RDKit's own optimisation end at a minimum of its energy function? */
function rdkitFoundMinimum(m: RefMolecule): boolean {
  const low = m.optimized.hessian.lowestEigenvalue;
  return m.optimized.hessian.finite && low !== undefined && low >= SADDLE_CURVATURE;
}

const worst = {
  energyAboveRdkit: new Worst(),
  energyBelowRdkit: new Worst(),
  energyAbovePolished: new Worst(),
  bondVsRdkitRigid: new Worst(),
  angleVsRdkitRigid: new Worst(),
  bondVsRdkitAll: new Worst(),
  angleVsRdkitAll: new Worst(),
  bondVsPolished: new Worst(),
  angleVsPolished: new Worst(),
  steps: new Worst(),
  rmsGradient: new Worst(),
  rdkitRmsGradient: new Worst(),
};
const counts = {
  molecules: 0,
  converged: 0,
  rigid: 0,
  sameMinimumAsRdkit: 0,
  rdkitStoppedOnSaddle: [] as string[],
  within1e6OfRdkit: 0,
  within1e6OfPolished: 0,
  totalSteps: 0,
  totalMilliseconds: 0,
};
/** Per chemical class (a molecule can belong to several): how the optimised structures compare with RDKit's. */
const byClass = new Map<string, { molecules: number; converged: number; energyAboveRdkit: number; bondVsRdkit: number; angleVsRdkit: number; excluded: string[] }>();
const classEntry = (cls: string): { molecules: number; converged: number; energyAboveRdkit: number; bondVsRdkit: number; angleVsRdkit: number; excluded: string[] } => {
  let entry = byClass.get(cls);
  if (!entry) {
    entry = { molecules: 0, converged: 0, energyAboveRdkit: 0, bondVsRdkit: 0, angleVsRdkit: 0, excluded: [] };
    byClass.set(cls, entry);
  }
  return entry;
};

describe('geometry optimisation against RDKit', () => {
  afterAll(() =>
    publish('optimisation', {
      tolerances: { energySlack: ENERGY_SLACK, bond: BOND_TOLERANCE, angle: ANGLE_TOLERANCE, polishedEnergySlack: POLISHED_ENERGY_SLACK },
      counts,
      worst,
      byClass: Object.fromEntries(Array.from(byClass).sort(([a], [b]) => a.localeCompare(b))),
    }),
  );

  it('every reference run of RDKit converged', () => {
    for (const m of ref.molecules) expect(m.optimized.converged, m.name).toBe(true);
  });

  for (const m of ref.molecules) {
    it(`${m.name}: converges, no higher in energy than RDKit, to the same geometry`, () => {
      const r = optimized(m);
      counts.molecules++;
      counts.totalSteps += r.steps;
      counts.totalMilliseconds += r.elapsedMs;
      worst.steps.note(r.steps, m.name);
      worst.rmsGradient.note(r.rmsGradient, m.name);
      worst.rdkitRmsGradient.note(m.optimized.rmsGradient, m.name);

      expect(r.converged, r.warnings.join(' | ')).toBe(true);
      expect(r.cancelled).toBe(false);
      counts.converged++;
      expect(r.rmsGradient).toBeLessThanOrEqual(1e-4);
      expect(r.finalEnergy).toBeLessThanOrEqual(r.initialEnergy);
      expect(Math.abs(r.initialEnergy - m.energy)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(m.energy)));

      // --- energy: no higher than RDKit's optimised energy
      const aboveRdkit = r.finalEnergy - m.optimized.energy;
      worst.energyAboveRdkit.note(Math.max(0, aboveRdkit), m.name);
      worst.energyBelowRdkit.note(Math.max(0, -aboveRdkit), m.name);
      expect(aboveRdkit, `E = ${r.finalEnergy}, RDKit ${m.optimized.energy}`).toBeLessThanOrEqual(ENERGY_SLACK);
      if (Math.abs(aboveRdkit) <= 1e-6) counts.within1e6OfRdkit++;

      // --- energy and geometry: the minimum of RDKit's energy function next to RDKit's result
      const abovePolished = r.finalEnergy - m.polished.energy;
      worst.energyAbovePolished.note(Math.max(0, abovePolished), m.name);
      if (Math.abs(abovePolished) <= 1e-6) counts.within1e6OfPolished++;
      expect(abovePolished, `E = ${r.finalEnergy}, polished ${m.polished.energy}`).toBeLessThanOrEqual(POLISHED_ENERGY_SLACK);
      const vsPolished = geometryDeviation(m, r.positions, m.polished.coords);
      worst.bondVsPolished.note(vsPolished.bond, m.name);
      worst.angleVsPolished.note(vsPolished.angle, m.name);
      expect(vsPolished.bond).toBeLessThanOrEqual(BOND_TOLERANCE);
      expect(vsPolished.angle).toBeLessThanOrEqual(ANGLE_TOLERANCE);

      // --- geometry: RDKit's own optimised structure
      const vsRdkit = geometryDeviation(m, r.positions, m.optimized.coords);
      for (const cls of m.classes) {
        const entry = classEntry(cls);
        entry.molecules++;
        entry.converged++;
        entry.energyAboveRdkit = Math.max(entry.energyAboveRdkit, aboveRdkit);
        if (rdkitFoundMinimum(m)) {
          entry.bondVsRdkit = Math.max(entry.bondVsRdkit, vsRdkit.bond);
          entry.angleVsRdkit = Math.max(entry.angleVsRdkit, vsRdkit.angle);
        } else {
          entry.excluded.push(m.name);
        }
      }
      if (rdkitFoundMinimum(m)) {
        // Bond lengths within 0.01 angstrom and angles within 1 degree. Required for rigid
        // molecules; in fact it holds for every molecule whose RDKit result is a minimum.
        worst.bondVsRdkitAll.note(vsRdkit.bond, m.name);
        worst.angleVsRdkitAll.note(vsRdkit.angle, m.name);
        if (m.rigid) {
          counts.rigid++;
          worst.bondVsRdkitRigid.note(vsRdkit.bond, m.name);
          worst.angleVsRdkitRigid.note(vsRdkit.angle, m.name);
        }
        expect(vsRdkit.bond, 'largest bond-length difference to RDKit').toBeLessThanOrEqual(BOND_TOLERANCE);
        expect(vsRdkit.angle, 'largest angle difference to RDKit').toBeLessThanOrEqual(ANGLE_TOLERANCE);
        counts.sameMinimumAsRdkit++;
      } else {
        // RDKit stopped where its own Hessian has a negative eigenvalue: not a minimum. This
        // optimiser must then end lower, at the true minimum next to it.
        counts.rdkitStoppedOnSaddle.push(m.name);
        expect(r.finalEnergy).toBeLessThan(m.optimized.energy - 1e-3);
        expect(m.polished.energy).toBeLessThan(m.optimized.energy - 1e-3);
      }
    });
  }

  it('RDKit stops on a saddle point for styrene; the optimiser steps off it and says so', () => {
    const m = findMolecule('styrene');
    // RDKit's own Hessian at RDKit's own result has a negative eigenvalue ...
    expect(m.optimized.hessian.lowestEigenvalue).toBeLessThan(-0.5);
    // ... while the polished geometry is a minimum, 0.07 kcal/mol lower
    expect(m.polished.hessian.lowestEigenvalue).toBeGreaterThan(SADDLE_CURVATURE);
    expect(m.optimized.energy - m.polished.energy).toBeGreaterThan(0.05);
    const r = optimized(m);
    expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-6);
    expect(r.warnings.some((w) => /saddle point/.test(w))).toBe(true);
    expect(counts.rdkitStoppedOnSaddle).toContain('styrene');
  });

  it('only exceptional molecules are excluded from the geometry comparison with RDKit', () => {
    // styrene (above) and iodine trifluoride, where RDKit reports convergence at an RMS gradient
    // of 3.6e5 kcal/mol/angstrom because its test is relative to an energy of 1e9 kcal/mol
    expect(counts.rdkitStoppedOnSaddle.sort()).toEqual(['iodine trifluoride', 'styrene']);
    expect(findMolecule('iodine trifluoride').optimized.rmsGradient).toBeGreaterThan(1e5);
    expect(counts.rigid).toBeGreaterThanOrEqual(45);
  });
});

describe('known geometries, checked against RDKit\'s own numbers', () => {
  it('a diatomic molecule ends exactly at the rest length RDKit reports for its bond', () => {
    for (const name of ['dihydrogen', 'dinitrogen', 'dioxygen', 'hydrogen chloride', 'hydrogen fluoride', 'carbon monoxide', 'hydroxide', 'nitric oxide']) {
      const m = findMolecule(name);
      expect(m.nAtoms).toBe(2);
      const [, , , r0] = m.params.bondStretch[0];
      const r = optimized(m);
      expect(Math.abs(distance(r.positions, 0, 1) - r0), name).toBeLessThan(1e-5);
      expect(Math.abs(r.finalEnergy)).toBeLessThan(1e-8);
    }
  });

  it('water: both O-H bonds at r0 and the angle at theta0, where every term is zero', () => {
    const m = findMolecule('water');
    const r = optimized(m);
    const r0 = m.params.bondStretch[0][3];
    const theta0 = m.params.angleBend[0][4];
    expect(Math.abs(distance(r.positions, 0, 1) - r0)).toBeLessThan(1e-5);
    expect(Math.abs(distance(r.positions, 0, 2) - r0)).toBeLessThan(1e-5);
    expect(Math.abs(angleDeg(r.positions, 1, 0, 2) - theta0)).toBeLessThan(1e-3);
    expect(Math.abs(r.finalEnergy)).toBeLessThan(1e-8);
    // and that is what RDKit's optimiser found too
    expect(Math.abs(angleDeg(m.optimized.coords, 1, 0, 2) - theta0)).toBeLessThan(0.01);
  });

  it('methane: a regular tetrahedron with all four bonds at r0', () => {
    const m = findMolecule('methane');
    const r = optimized(m);
    // Six angles around one atom cannot all take the theta0 of C_3 (109.47 degrees as tabulated):
    // by symmetry the minimum is the regular tetrahedron, acos(-1/3) = 109.4712 degrees, which is
    // 0.0012 degrees away from it. RDKit's minimum (polished) is the same tetrahedron.
    const tetrahedral = (Math.acos(-1 / 3) * 180) / Math.PI;
    const theta0 = m.params.angleBend[0][4];
    expect(Math.abs(theta0 - tetrahedral)).toBeLessThan(2e-3);
    for (const [i, j, k] of angleTriples(m)) {
      expect(Math.abs(angleDeg(r.positions, i, j, k) - tetrahedral)).toBeLessThan(1e-3);
      expect(Math.abs(angleDeg(m.polished.coords, i, j, k) - tetrahedral)).toBeLessThan(1e-3);
    }
    for (const [a, b, , r0] of m.params.bondStretch) expect(Math.abs(distance(r.positions, a, b) - r0)).toBeLessThan(1e-5);
  });

  it('carbon dioxide and hydrogen cyanide are linear, ethyne too', () => {
    for (const name of ['carbon dioxide', 'hydrogen cyanide', 'ethyne']) {
      const m = findMolecule(name);
      const r = optimized(m);
      for (const [i, j, k] of angleTriples(m)) {
        expect(angleDeg(r.positions, i, j, k), `${name} ${i}-${j}-${k}`).toBeGreaterThan(179.9);
        expect(angleDeg(m.optimized.coords, i, j, k)).toBeGreaterThan(179.9);
      }
    }
  });

  it('benzene: planar, six equal C-C bonds of the length RDKit finds', () => {
    const m = findMolecule('benzene');
    const r = optimized(m);
    const cc = m.bonds.filter(([a, b]) => m.z[a] === 6 && m.z[b] === 6);
    expect(cc).toHaveLength(6);
    const lengths = cc.map(([a, b]) => distance(r.positions, a, b));
    const rdkitLength = distance(m.optimized.coords, cc[0][0], cc[0][1]);
    for (const l of lengths) expect(Math.abs(l - rdkitLength)).toBeLessThan(1e-4);
    // interior angles of a planar hexagon add up to 720 degrees
    const ringAngles = angleTriples(m).filter(([i, j, k]) => m.z[i] === 6 && m.z[j] === 6 && m.z[k] === 6);
    expect(ringAngles).toHaveLength(6);
    const sum = ringAngles.reduce((s, [i, j, k]) => s + angleDeg(r.positions, i, j, k), 0);
    expect(Math.abs(sum - 720)).toBeLessThan(1e-3);
  });

  it('cyclopropane, cyclobutane and cubane keep the ring angles RDKit gives them', () => {
    for (const name of ['cyclopropane', 'cyclobutane', 'cubane', 'cyclopropene', 'cyclobutene']) {
      const m = findMolecule(name);
      const r = optimized(m);
      for (const [i, j, k] of angleTriples(m).filter(([a, b, c]) => m.z[a] === 6 && m.z[b] === 6 && m.z[c] === 6)) {
        expect(Math.abs(angleDeg(r.positions, i, j, k) - angleDeg(m.optimized.coords, i, j, k)), `${name} ${i}-${j}-${k}`).toBeLessThan(0.05);
      }
    }
  });
});

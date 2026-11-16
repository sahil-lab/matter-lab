/**
 * The optimiser on the starting geometries people actually produce in a 3D editor: atoms piled on
 * one point, flat or straight drawings of molecules that are neither, grossly stretched bonds,
 * symmetric arrangements that are saddle points. And the controls around it: frozen atoms, the
 * step callback, cancellation, the trajectory, the step limit.
 *
 * Reference values (bond lengths, angles, energies of minima) are RDKit's, from the fixture.
 */
import { describe, expect, it } from 'vitest';
import { optimizeUff, uffEnergy, createUffSystem, RDKIT_VERSION } from '../src';
import type { FfBond, FfMolecule, OptimizeResult, OptimizeStep } from '../src';
import { evaluate } from '../src/energy';
import { minimize } from '../src/minimizer';
import { lowestCurvatureMode, MAX_LANCZOS } from '../src/modes';
import { systemData } from '../src/system';
import type { RefMolecule } from './helpers/reference';
import { angleDeg, angleTriples, dihedralDeg, distance, findMolecule, toMolecule } from './helpers/reference';

function neighbours(m: RefMolecule): number[][] {
  const nb: number[][] = Array.from({ length: m.nAtoms }, () => []);
  for (const [a, b] of m.bonds) {
    nb[a].push(b);
    nb[b].push(a);
  }
  return nb;
}

/** Largest deviation of bond lengths (angstrom) and angles (degrees) from RDKit's optimised structure. */
function bondedDeviation(m: RefMolecule, x: ArrayLike<number>): { bond: number; angle: number } {
  let bond = 0;
  for (const [a, b] of m.bonds) bond = Math.max(bond, Math.abs(distance(x, a, b) - distance(m.polished.coords, a, b)));
  let angle = 0;
  for (const [i, j, k] of angleTriples(m)) angle = Math.max(angle, Math.abs(angleDeg(x, i, j, k) - angleDeg(m.polished.coords, i, j, k)));
  return { bond, angle };
}

/** A sensible structure: finite, converged, every bond and angle close to what UFF wants. */
function expectSensible(m: RefMolecule, r: OptimizeResult, bondTolerance: number, angleTolerance: number): void {
  expect(r.converged, r.warnings.join(' | ')).toBe(true);
  expect(Number.isFinite(r.finalEnergy)).toBe(true);
  expect(r.positions.every((v) => Number.isFinite(v))).toBe(true);
  const d = bondedDeviation(m, r.positions);
  expect(d.bond, 'largest bond-length deviation from RDKit').toBeLessThanOrEqual(bondTolerance);
  expect(d.angle, 'largest angle deviation from RDKit').toBeLessThanOrEqual(angleTolerance);
}

const origin = (m: RefMolecule): number[] => new Array<number>(3 * m.nAtoms).fill(0);

describe('all atoms at the origin', () => {
  // These have a single minimum (up to symmetry): the optimiser must find exactly RDKit's.
  for (const name of ['methane', 'water', 'ammonia', 'ethane', 'ethene', 'carbon dioxide', 'formaldehyde', 'benzene', 'pyridine', 'methanol']) {
    it(`${name} reaches RDKit's minimum`, () => {
      const m = findMolecule(name);
      const r = optimizeUff(toMolecule(m, origin(m)));
      expectSensible(m, r, 1e-3, 0.1);
      expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-4);
      // the user is told that the input was unusable and what was done about it
      expect(r.warnings.some((w) => /coincided with another atom/.test(w))).toBe(true);
      expect(r.warnings.some((w) => /initialEnergy is the energy of the repaired starting geometry/.test(w))).toBe(true);
      expect(Number.isFinite(r.initialEnergy)).toBe(true);
      expect(r.rmsDisplacement).toBeGreaterThan(0.3);
    });
  }

  // Flexible or polycyclic molecules: some conformer with correct bonded geometry, at an energy
  // within a few kcal/mol of the minimum RDKit reaches from a proper embedding.
  for (const [name, energyWindow] of [
    ['ethanol', 1],
    ['acetic acid', 1],
    ['cyclohexane', 10],
    ['aspirin', 5],
    ['caffeine', 5],
    ['paracetamol', 5],
    ['testosterone', 10],
  ] as const) {
    it(`${name} reaches a sensible conformer`, () => {
      const m = findMolecule(name);
      const r = optimizeUff(toMolecule(m, origin(m)));
      expectSensible(m, r, 0.05, 8);
      expect(r.finalEnergy).toBeLessThan(m.polished.energy + energyWindow);
    });
  }

  it('is deterministic: the same input gives the same result, bit for bit', () => {
    const m = findMolecule('aspirin');
    const a = optimizeUff(toMolecule(m, origin(m)));
    const b = optimizeUff(toMolecule(m, origin(m)));
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(b.steps).toBe(a.steps);
    expect(b.finalEnergy).toBe(a.finalEnergy);
  });

  it('two atoms on the same point inside an otherwise good molecule are separated', () => {
    const m = findMolecule('ethanol');
    const coords = m.coords.slice();
    // put the last hydrogen onto the first carbon
    const h = m.nAtoms - 1;
    for (let c = 0; c < 3; c++) coords[3 * h + c] = coords[c];
    const r = optimizeUff(toMolecule(m, coords));
    expectSensible(m, r, 0.01, 3);
    expect(r.finalEnergy).toBeLessThan(m.polished.energy + 1);
  });
});

describe('flat and straight starting geometries', () => {
  it('a planar methane becomes tetrahedral', () => {
    const m = findMolecule('methane');
    const r = optimizeUff(toMolecule(m, [0, 0, 0, 1.09, 0, 0, -1.09, 0, 0, 0, 1.09, 0, 0, -1.09, 0]));
    expectSensible(m, r, 1e-4, 0.01);
    const theta0 = m.params.angleBend[0][4];
    for (const [i, j, k] of angleTriples(m)) expect(Math.abs(angleDeg(r.positions, i, j, k) - theta0)).toBeLessThan(0.01);
    expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-6);
  });

  it('a linear water bends to the UFF angle', () => {
    const m = findMolecule('water');
    const r = optimizeUff(toMolecule(m, [0, 0, 0, 0.96, 0, 0, -0.96, 0, 0]));
    expectSensible(m, r, 1e-4, 0.01);
    expect(Math.abs(angleDeg(r.positions, 1, 0, 2) - m.params.angleBend[0][4])).toBeLessThan(0.01);
  });

  it('a planar ammonia becomes pyramidal (a saddle point without any singular term)', () => {
    const m = findMolecule('ammonia');
    const coords = [0, 0, 0];
    for (let k = 0; k < 3; k++) coords.push(1.01 * Math.cos((2 * Math.PI * k) / 3), 1.01 * Math.sin((2 * Math.PI * k) / 3), 0);
    const r = optimizeUff(toMolecule(m, coords));
    expectSensible(m, r, 1e-4, 0.01);
    expect(r.warnings.some((w) => /saddle point/.test(w))).toBe(true);
    // the reference: RDKit started from a proper 3D embedding
    expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-6);
  });

  it('an eclipsed ethane rotates to staggered', () => {
    const m = findMolecule('ethane');
    const nb = neighbours(m);
    const coords = new Array<number>(3 * m.nAtoms).fill(0);
    coords[3] = 1.53;
    for (const [carbon, sign] of [[0, -1], [1, 1]] as const) {
      nb[carbon].filter((a) => m.z[a] === 1).forEach((h, k) => {
        const phi = (2 * Math.PI * k) / 3;
        coords[3 * h] = coords[3 * carbon] + sign * 0.36;
        coords[3 * h + 1] = 1.03 * Math.cos(phi);
        coords[3 * h + 2] = 1.03 * Math.sin(phi);
      });
    }
    const h0 = nb[0].find((a) => m.z[a] === 1) as number;
    const h1 = nb[1].find((a) => m.z[a] === 1) as number;
    expect(Math.abs(dihedralDeg(coords, h0, 0, 1, h1))).toBeLessThan(1e-9); // eclipsed
    const r = optimizeUff(toMolecule(m, coords));
    expectSensible(m, r, 1e-4, 0.01);
    expect(Math.abs(Math.abs(dihedralDeg(r.positions, h0, 0, 1, h1)) - 60)).toBeLessThan(0.1);
    expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-6);
    expect(r.warnings.some((w) => /saddle point/.test(w))).toBe(true);
  });

  it('a flat, perfectly symmetric cyclohexane puckers', () => {
    const m = findMolecule('cyclohexane');
    const nb = neighbours(m);
    const coords = new Array<number>(3 * m.nAtoms).fill(0);
    const ring = [0];
    for (;;) {
      const next = nb[ring[ring.length - 1]].find((a) => m.z[a] === 6 && !ring.includes(a));
      if (next === undefined) break;
      ring.push(next);
    }
    expect(ring).toHaveLength(6);
    ring.forEach((a, k) => {
      const phi = (2 * Math.PI * k) / 6;
      coords[3 * a] = 1.53 * Math.cos(phi);
      coords[3 * a + 1] = 1.53 * Math.sin(phi);
      nb[a].filter((h) => m.z[h] === 1).forEach((h, s) => {
        coords[3 * h] = 2.16 * Math.cos(phi);
        coords[3 * h + 1] = 2.16 * Math.sin(phi);
        coords[3 * h + 2] = s === 0 ? 0.89 : -0.89;
      });
    });
    const r = optimizeUff(toMolecule(m, coords));
    expectSensible(m, r, 0.02, 4);
    // not flat any more: the ring carbons leave their common plane
    const zs = ring.map((a) => r.positions[3 * a + 2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.3);
    // a minimum at least as low as the one RDKit reaches from its embedding (which is a twist-boat)
    expect(r.finalEnergy).toBeLessThanOrEqual(m.polished.energy + 1e-4);
    expect(r.warnings.some((w) => /saddle point/.test(w))).toBe(true);
  });

  for (const name of ['benzene', 'ethanol', 'aspirin', 'caffeine']) {
    it(`${name} drawn with every atom on one line is untangled`, () => {
      const m = findMolecule(name);
      const r = optimizeUff(toMolecule(m, m.coords.map((v, i) => (i % 3 === 0 ? v : 0))));
      expectSensible(m, r, 0.05, 8);
      expect(r.finalEnergy).toBeLessThan(m.polished.energy + 5);
    });
    it(`${name} squashed flat ends in a proper structure`, () => {
      const m = findMolecule(name);
      const r = optimizeUff(toMolecule(m, m.coords.map((v, i) => (i % 3 === 2 ? 0 : v))));
      expectSensible(m, r, 0.05, 8);
      expect(r.finalEnergy).toBeLessThan(m.polished.energy + 5);
    });
  }
});

describe('stretched and misplaced atoms', () => {
  for (const name of ['water', 'ethane', 'benzene', 'ethanol', 'aspirin']) {
    it(`${name} blown up three-fold contracts to a proper structure`, () => {
      const m = findMolecule(name);
      const r = optimizeUff(toMolecule(m, m.coords.map((v) => 3 * v)));
      expectSensible(m, r, 0.05, 8);
      expect(r.finalEnergy).toBeLessThan(m.polished.energy + 5);
      expect(r.initialEnergy).toBeGreaterThan(100 * Math.max(1, Math.abs(m.polished.energy)));
    });
    it(`${name} with one atom dragged 15 angstrom away comes back to RDKit's minimum`, () => {
      const m = findMolecule(name);
      const coords = m.coords.slice();
      coords[0] += 15;
      const r = optimizeUff(toMolecule(m, coords));
      expectSensible(m, r, 0.05, 8);
      expect(r.finalEnergy).toBeLessThan(m.polished.energy + 5);
    });
  }

  it('a single bond stretched to 6 angstrom relaxes to its rest length', () => {
    const m = findMolecule('dihydrogen');
    const r = optimizeUff(toMolecule(m, [0, 0, 0, 6, 0, 0]));
    expect(r.converged).toBe(true);
    expect(Math.abs(distance(r.positions, 0, 1) - m.params.bondStretch[0][3])).toBeLessThan(1e-5);
  });
});

describe('frozen atoms', () => {
  const m = findMolecule('ethanol');

  it('do not move at all, while the rest relaxes around them', () => {
    const frozen = [0, 1, 2]; // the heavy atoms
    const r = optimizeUff(toMolecule(m, m.coords), { frozenAtoms: frozen });
    expect(r.converged).toBe(true);
    for (const a of frozen) {
      for (let c = 0; c < 3; c++) expect(r.positions[3 * a + c]).toBe(m.coords[3 * a + c]);
    }
    let moved = 0;
    for (let a = 3; a < m.nAtoms; a++) {
      moved = Math.max(moved, Math.hypot(r.positions[3 * a] - m.coords[3 * a], r.positions[3 * a + 1] - m.coords[3 * a + 1], r.positions[3 * a + 2] - m.coords[3 * a + 2]));
    }
    expect(moved).toBeGreaterThan(0.01);
    expect(r.finalEnergy).toBeLessThan(r.initialEnergy);
    // constrained minimum: above the free one, and the residual force sits on the frozen atoms only
    expect(r.finalEnergy).toBeGreaterThan(m.polished.energy);
    const system = createUffSystem(toMolecule(m, m.coords));
    const g = new Float64Array(3 * m.nAtoms);
    evaluate(systemData(system).kernel, r.positions, g, null);
    let freeMax = 0;
    for (let a = 3; a < m.nAtoms; a++) for (let c = 0; c < 3; c++) freeMax = Math.max(freeMax, Math.abs(g[3 * a + c]));
    expect(freeMax).toBeLessThan(1e-2);
    expect(r.maxGradient).toBeCloseTo(freeMax, 10);
  });

  it('all atoms frozen: nothing to do, reported as converged at the start', () => {
    const all = m.z.map((_, i) => i);
    const r = optimizeUff(toMolecule(m, m.coords), { frozenAtoms: all });
    expect(r.converged).toBe(true);
    expect(r.steps).toBe(0);
    expect(Array.from(r.positions)).toEqual(m.coords);
    expect(r.rmsDisplacement).toBe(0);
    expect(r.finalEnergy).toBe(r.initialEnergy);
  });

  it('an index that is not an atom is a RangeError', () => {
    expect(() => optimizeUff(toMolecule(m, m.coords), { frozenAtoms: [m.nAtoms] })).toThrow(RangeError);
    expect(() => optimizeUff(toMolecule(m, m.coords), { frozenAtoms: [-1] })).toThrow(/frozenAtoms/);
  });

  it('a frozen atom is not moved even when another atom sits on top of it', () => {
    const coords = m.coords.slice();
    const h = m.nAtoms - 1;
    for (let c = 0; c < 3; c++) coords[3 * h + c] = coords[c];
    const r = optimizeUff(toMolecule(m, coords), { frozenAtoms: [0] });
    for (let c = 0; c < 3; c++) expect(r.positions[c]).toBe(coords[c]);
    expect(r.converged).toBe(true);
    expect(distance(r.positions, 0, h)).toBeGreaterThan(1.5);
  });
});

describe('step callback, cancellation and trajectory', () => {
  const m = findMolecule('paracetamol');

  it('is called for step 0 and after every step, with a live view of the coordinates', () => {
    const steps: OptimizeStep[] = [];
    let live: Float64Array | null = null;
    const r = optimizeUff(toMolecule(m, m.coords), {
      onStep: (s) => {
        steps.push({ ...s, positions: s.positions.slice() });
        live = s.positions;
      },
    });
    expect(steps[0].step).toBe(0);
    expect(Array.from(steps[0].positions)).toEqual(m.coords);
    expect(steps[0].energy).toBe(r.initialEnergy);
    expect(steps.map((s) => s.step)).toEqual(steps.map((_, i) => i));
    expect(steps.length).toBe(r.steps + 1);
    const last = steps[steps.length - 1];
    expect(last.energy).toBe(r.finalEnergy);
    expect(last.rmsGradient).toBe(r.rmsGradient);
    expect(last.maxGradient).toBe(r.maxGradient);
    expect(Array.from(last.positions)).toEqual(Array.from(r.positions));
    // energies never go up (beyond rounding in the last digits)
    for (let i = 1; i < steps.length; i++) expect(steps[i].energy).toBeLessThanOrEqual(steps[i - 1].energy + 1e-10);
    // "live view": the same array every time, now holding the final geometry
    expect(live).toBe(r.positions);
  });

  it('returning false cancels; the geometry reached so far is returned', () => {
    const r = optimizeUff(toMolecule(m, m.coords), { onStep: (s) => s.step < 5 });
    expect(r.cancelled).toBe(true);
    expect(r.converged).toBe(false);
    expect(r.steps).toBe(5);
    expect(r.finalEnergy).toBeLessThan(r.initialEnergy);
    expect(uffEnergy(createUffSystem(toMolecule(m, m.coords)), r.positions).total).toBe(r.finalEnergy);
  });

  it('can be cancelled before the first step', () => {
    const r = optimizeUff(toMolecule(m, m.coords), { onStep: () => false });
    expect(r.cancelled).toBe(true);
    expect(r.steps).toBe(0);
    expect(Array.from(r.positions)).toEqual(m.coords);
    expect(r.finalEnergy).toBe(r.initialEnergy);
  });

  it('records the start, every n-th step and the end', () => {
    const none = optimizeUff(toMolecule(m, m.coords));
    expect(none.trajectory).toEqual([]);
    const every = 7;
    const r = optimizeUff(toMolecule(m, m.coords), { recordTrajectoryEvery: every });
    expect(r.steps).toBe(none.steps);
    const expectedFrames = 1 + Math.floor(r.steps / every) + (r.steps % every === 0 ? 0 : 1);
    expect(r.trajectory).toHaveLength(expectedFrames);
    for (const frame of r.trajectory) {
      expect(frame).toBeInstanceOf(Float32Array);
      expect(frame).toHaveLength(3 * m.nAtoms);
    }
    expect(Array.from(r.trajectory[0])).toEqual(Array.from(Float32Array.from(m.coords)));
    expect(Array.from(r.trajectory[r.trajectory.length - 1])).toEqual(Array.from(Float32Array.from(r.positions)));
    const everyStep = optimizeUff(toMolecule(m, m.coords), { recordTrajectoryEvery: 1 });
    expect(everyStep.trajectory).toHaveLength(everyStep.steps + 1);
  });
});

describe('convergence control and honest reporting', () => {
  const m = findMolecule('ibuprofen');

  it('says so when the step limit is hit', () => {
    const r = optimizeUff(toMolecule(m, m.coords), { maxSteps: 10 });
    expect(r.converged).toBe(false);
    expect(r.cancelled).toBe(false);
    expect(r.steps).toBe(10);
    expect(r.rmsGradient).toBeGreaterThan(1e-4);
    expect(r.warnings.some((w) => /Not converged: the limit of 10 steps was reached/.test(w))).toBe(true);
    expect(r.finalEnergy).toBeLessThan(r.initialEnergy);
  });

  it('maxSteps 0 evaluates the starting geometry only', () => {
    const r = optimizeUff(toMolecule(m, m.coords), { maxSteps: 0 });
    expect(r.steps).toBe(0);
    expect(r.converged).toBe(false);
    expect(Array.from(r.positions)).toEqual(m.coords);
    expect(Math.abs(r.finalEnergy - m.energy)).toBeLessThan(1e-9 * Math.abs(m.energy));
  });

  it('a geometry that is already optimised converges without moving', () => {
    const first = optimizeUff(toMolecule(m, m.coords));
    const again = optimizeUff(toMolecule(m, Array.from(first.positions)));
    expect(again.converged).toBe(true);
    expect(again.steps).toBeLessThanOrEqual(2);
    expect(again.rmsDisplacement).toBeLessThan(1e-4);
    expect(Math.abs(again.finalEnergy - first.finalEnergy)).toBeLessThan(1e-7);
  });

  it('honours the tolerances it is given', () => {
    const loose = optimizeUff(toMolecule(m, m.coords), { gradientTolerance: 1e-2, energyTolerance: 1e-2 });
    const normal = optimizeUff(toMolecule(m, m.coords));
    const tight = optimizeUff(toMolecule(m, m.coords), { gradientTolerance: 1e-6, energyTolerance: 1e-10, maxSteps: 20000 });
    expect(loose.converged && normal.converged && tight.converged).toBe(true);
    expect(loose.rmsGradient).toBeLessThanOrEqual(1e-2);
    expect(normal.rmsGradient).toBeLessThanOrEqual(1e-4);
    expect(tight.rmsGradient).toBeLessThanOrEqual(1e-6);
    expect(loose.steps).toBeLessThan(normal.steps);
    expect(normal.steps).toBeLessThanOrEqual(tight.steps);
    // tighter is lower, and the tight result is the polished RDKit minimum
    expect(tight.finalEnergy).toBeLessThanOrEqual(normal.finalEnergy);
    expect(normal.finalEnergy).toBeLessThanOrEqual(loose.finalEnergy);
    expect(Math.abs(tight.finalEnergy - m.polished.energy)).toBeLessThan(1e-7);
  });

  it('rejects nonsensical options', () => {
    const mol = toMolecule(m, m.coords);
    expect(() => optimizeUff(mol, { maxSteps: -1 })).toThrow(RangeError);
    expect(() => optimizeUff(mol, { maxSteps: 1.5 })).toThrow(RangeError);
    expect(() => optimizeUff(mol, { gradientTolerance: 0 })).toThrow(RangeError);
    expect(() => optimizeUff(mol, { energyTolerance: Number.NaN })).toThrow(RangeError);
    expect(() => optimizeUff(mol, { recordTrajectoryEvery: -2 })).toThrow(RangeError);
  });

  it('a molecule with nothing to optimise is fine', () => {
    const lone = optimizeUff({ atoms: [{ z: 11, formalCharge: 1, position: [1, 2, 3] }], bonds: [] });
    expect(lone.converged).toBe(true);
    expect(lone.steps).toBe(0);
    expect(lone.finalEnergy).toBe(0);
    expect(Array.from(lone.positions)).toEqual([1, 2, 3]);
    const empty = optimizeUff({ atoms: [], bonds: [] });
    expect(empty.converged).toBe(true);
    expect(empty.positions).toHaveLength(0);
    expect(empty.rmsDisplacement).toBe(0);
  });

  it('separate fragments do not see each other (RDKit\'s default), even when they overlap', () => {
    const m2 = findMolecule('water dimer');
    const r = optimizeUff(toMolecule(m2, m2.coords));
    expect(r.converged).toBe(true);
    expect(r.energyTerms.vanDerWaals).toBe(0);
    expect(Math.abs(r.finalEnergy - m2.optimized.energy)).toBeLessThan(1e-6);
  });
});

describe('the result object', () => {
  const m = findMolecule('caffeine');
  const r = optimizeUff(toMolecule(m, m.coords), { recordTrajectoryEvery: 25 });

  it('has every field of the public contract', () => {
    expect(r.method).toBe('UFF');
    expect(typeof r.converged).toBe('boolean');
    expect(typeof r.cancelled).toBe('boolean');
    expect(Number.isInteger(r.steps)).toBe(true);
    expect(r.positions).toBeInstanceOf(Float64Array);
    expect(r.positions).toHaveLength(3 * m.nAtoms);
    expect(r.atomTypes).toHaveLength(m.nAtoms);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.elapsedMs).toBeGreaterThan(0);
    const t = r.energyTerms;
    expect(t.total).toBe(r.finalEnergy);
    expect(Math.abs(t.bondStretch + t.angleBend + t.torsion + t.inversion + t.vanDerWaals - t.total)).toBeLessThan(1e-10);
    expect(uffEnergy(createUffSystem(toMolecule(m, m.coords)), r.positions)).toEqual(t);
  });

  it('reports the RMS displacement from the starting geometry, without alignment', () => {
    let sum = 0;
    for (let i = 0; i < r.positions.length; i++) sum += (r.positions[i] - m.coords[i]) ** 2;
    expect(r.rmsDisplacement).toBeCloseTo(Math.sqrt(sum / m.nAtoms), 12);
    expect(r.rmsDisplacement).toBeGreaterThan(0);
  });

  it('carries its provenance: the engine, its version and the literature', () => {
    const p = r.provenance;
    expect(p.source).toBe(`UFF as implemented in RDKit ${RDKIT_VERSION}, ported to TypeScript`);
    expect(p.source).toBe('UFF as implemented in RDKit 2026.09.2, ported to TypeScript');
    expect(p.version).toBe(RDKIT_VERSION);
    expect(p.license).toMatch(/BSD-3-Clause/);
    const dois = (p.citations ?? []).map((c) => c.doi);
    expect(dois).toContain('10.1021/ja00051a040'); // Rappe et al., JACS 1992
    expect(dois).toContain('10.5281/zenodo.591637'); // RDKit
    for (const c of p.citations ?? []) expect(c.title.length).toBeGreaterThan(10);
  });

  it('is plain structured-cloneable data', () => {
    const clone = structuredClone(r);
    expect(clone).toEqual(r);
    expect(clone.positions).toBeInstanceOf(Float64Array);
    expect(clone.trajectory[0]).toBeInstanceOf(Float32Array);
    // and it is the caller's own: two results never share an array
    const again = optimizeUff(toMolecule(m, m.coords));
    expect(again.positions).not.toBe(r.positions);
    expect(again.provenance).not.toBe(r.provenance);
    expect(again.provenance).toEqual(r.provenance);
  });
});

describe('saddle points in molecules beyond the exhaustive range of the curvature check', () => {
  /**
   * An all-trans n-alkane with its carbon backbone in the xy plane, mirror-symmetric in z. With
   * `eclipsedEnds` the two methyl groups are turned by 180 degrees about their C-C bond, which
   * keeps the mirror symmetry and makes them eclipsed: a stationary point by symmetry, not a minimum.
   */
  function planarAlkane(nCarbons: number, eclipsedEnds: boolean): { mol: FfMolecule; firstMethyl: [number, number, number]; carbons: number } {
    const half = ((111 / 2) * Math.PI) / 180;
    const xyz: number[][] = [];
    const bonds: FfBond[] = [];
    for (let i = 0; i < nCarbons; i++) {
      xyz.push([i * 1.53 * Math.sin(half), (i % 2) * 1.53 * Math.cos(half), 0]);
      if (i > 0) bonds.push({ a: i - 1, b: i, order: 1 });
    }
    const firstMethyl: number[] = [];
    for (let parent = 0; parent < nCarbons; parent++) {
      const terminal = parent === 0 || parent === nCarbons - 1;
      const up = parent % 2 === 1 ? 1 : -1;
      const c = xyz[parent];
      const hydrogens: number[][] = [
        [c[0], c[1] + up * 0.63, 0.89],
        [c[0], c[1] + up * 0.63, -0.89],
      ];
      if (terminal) hydrogens.push([c[0] + (parent === 0 ? -1 : 1) * 1.03, c[1] - up * 0.36, 0]);
      if (terminal && eclipsedEnds) {
        // rotate the three hydrogens by 180 degrees about the bond to the neighbouring carbon
        const nb = xyz[parent === 0 ? 1 : nCarbons - 2];
        const u = [nb[0] - c[0], nb[1] - c[1], nb[2] - c[2]];
        const len = Math.hypot(u[0], u[1], u[2]);
        for (const h of hydrogens) {
          const d = [h[0] - c[0], h[1] - c[1], h[2] - c[2]];
          const along = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (len * len);
          for (let k = 0; k < 3; k++) h[k] = c[k] + 2 * along * u[k] - d[k];
        }
      }
      for (const h of hydrogens) {
        if (parent === 0) firstMethyl.push(xyz.length);
        bonds.push({ a: parent, b: xyz.length, order: 1 });
        xyz.push(h);
      }
    }
    return {
      mol: { atoms: xyz.map((p, i) => ({ z: i < nCarbons ? 6 : 1, formalCharge: 0, position: [p[0], p[1], p[2]] as const })), bonds },
      firstMethyl: firstMethyl as [number, number, number],
      carbons: nCarbons,
    };
  }
  const flatten = (mol: FfMolecule): number[] => mol.atoms.flatMap((a) => [...a.position]);

  it('C40H82 (122 atoms) with both methyl groups eclipsed ends with them staggered', () => {
    const eclipsed = planarAlkane(40, true);
    const staggered = planarAlkane(40, false);
    expect(eclipsed.mol.atoms.length).toBeGreaterThan(80);
    const start = flatten(eclipsed.mol);
    // the start really is eclipsed: one methyl hydrogen is syn to the third carbon
    const startDihedrals = eclipsed.firstMethyl.map((h) => Math.abs(dihedralDeg(start, h, 0, 1, 2)));
    expect(Math.min(...startDihedrals)).toBeLessThan(1e-6);

    const reference = optimizeUff(staggered.mol);
    expect(reference.converged, reference.warnings.join(' | ')).toBe(true);

    // In a molecule of this size the search lingers near the saddle point long enough for rounding
    // noise to break the symmetry, so it usually leaves on its own before the curvature check is
    // needed (the next test exercises the check itself). What matters is where it ends.
    const r = optimizeUff(eclipsed.mol);
    expect(r.converged, r.warnings.join(' | ')).toBe(true);
    // staggered: the three hydrogens at 180 and +-60 degrees to the chain
    const dihedrals = eclipsed.firstMethyl.map((h) => Math.abs(dihedralDeg(r.positions, h, 0, 1, 2))).sort((a, b) => a - b);
    expect(Math.abs(dihedrals[0] - 60)).toBeLessThan(2);
    expect(Math.abs(dihedrals[1] - 60)).toBeLessThan(2);
    expect(Math.abs(dihedrals[2] - 180)).toBeLessThan(2);
    // and the same minimum as from the staggered start
    expect(Math.abs(r.finalEnergy - reference.finalEnergy)).toBeLessThan(1e-4);
  });

  for (const nCarbons of [40, 60]) {
    it(`the curvature check finds the unstable methyl rotation of C${nCarbons}H${2 * nCarbons + 2} (${3 * nCarbons + 2} atoms) at its symmetric stationary point`, () => {
      const eclipsed = planarAlkane(nCarbons, true);
      const nAtoms = eclipsed.mol.atoms.length;
      expect(3 * nAtoms).toBeGreaterThan(MAX_LANCZOS); // more coordinates than Lanczos vectors: not exhaustive
      // Follow the optimisation and keep the most nearly stationary geometry it passes through
      // while still on the eclipsed plateau (more than 1 kcal/mol above where it ends).
      const visited: { energy: number; rmsGradient: number; x: Float64Array }[] = [];
      const r = optimizeUff(eclipsed.mol, {
        onStep: (s) => {
          visited.push({ energy: s.energy, rmsGradient: s.rmsGradient, x: s.positions.slice() });
        },
      });
      expect(r.converged).toBe(true);
      const plateau = visited.filter((v) => v.energy > r.finalEnergy + 1).sort((a, b) => a.rmsGradient - b.rmsGradient)[0];
      expect(plateau).toBeDefined();
      expect(plateau.rmsGradient).toBeLessThan(1e-3);

      const kernel = systemData(createUffSystem(eclipsed.mol)).kernel;
      const mode = lowestCurvatureMode(kernel, plateau.x, null);
      expect(mode).not.toBeNull();
      if (!mode) return;
      expect(mode.unstable).toBe(true);
      expect(mode.curvature).toBeLessThan(-1); // kcal/mol/angstrom^2
      // the unstable direction is the rotation of the methyl groups
      let weight = 0;
      for (const h of [...eclipsed.firstMethyl, nAtoms - 3, nAtoms - 2, nAtoms - 1]) {
        for (let c = 0; c < 3; c++) weight += mode.vector[3 * h + c] ** 2;
      }
      expect(weight).toBeGreaterThan(0.5);
      // the minimum, in contrast, is not flagged
      const atMinimum = lowestCurvatureMode(kernel, r.positions, null);
      expect(atMinimum?.unstable).toBe(false);
    });
  }
});

describe('large systems use the limited-memory update', () => {
  it('C140H282 (422 atoms, 1266 coordinates) converges to RDKit\'s minimum', () => {
    const m = findMolecule('C140 alkane');
    expect(3 * m.nAtoms).toBeGreaterThan(1200); // above the dense-BFGS limit
    const r = optimizeUff(toMolecule(m, m.coords));
    expect(r.converged, r.warnings.join(' | ')).toBe(true);
    expect(r.finalEnergy).toBeLessThanOrEqual(m.optimized.energy + 1e-4);
    expect(Math.abs(r.finalEnergy - m.polished.energy)).toBeLessThan(1e-4);
    const d = bondedDeviation(m, r.positions);
    expect(d.bond).toBeLessThan(1e-3);
    expect(d.angle).toBeLessThan(0.05);
  });

  it('gives the same minimum as the dense update when forced on a small molecule', () => {
    for (const name of ['ibuprofen', 'caffeine', 'cubane']) {
      const m = findMolecule(name);
      const kernel = systemData(createUffSystem(toMolecule(m, m.coords))).kernel;
      const run = (limitedMemory: boolean): number => {
        const x = Float64Array.from(m.coords);
        const g = new Float64Array(x.length);
        const out = minimize((p, grad) => evaluate(kernel, p, grad, null), x, g, {
          maxSteps: 5000,
          gradientTolerance: 1e-5,
          energyTolerance: 1e-9,
          frozen: null,
          limitedMemory,
        });
        expect(out.status, `${name}, limitedMemory=${limitedMemory}`).toBe('converged');
        return out.energy;
      };
      const dense = run(false);
      const limited = run(true);
      expect(Math.abs(dense - limited), name).toBeLessThan(1e-6);
      expect(Math.abs(limited - m.polished.energy), name).toBeLessThan(1e-6);
    }
  });
});

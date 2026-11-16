import { describe, expect, it } from 'vitest';
import { intersectPlane, pick } from './picking';
import type { PickData, PickRay } from './picking';

/** Two atoms on the x axis joined by one bond, with the bond trimmed to the gap between the spheres. */
function diatomic(atomRadius: number, bondRadius: number, separation = 1.5): PickData {
  return {
    atomCount: 2,
    atomPositions: new Float32Array([0, 0, 0, separation, 0, 0]),
    atomRadii: new Float32Array([atomRadius, atomRadius]),
    atomIds: new Int32Array([10, 20]),
    bondCount: 1,
    bondStart: new Float32Array([atomRadius, 0, 0]),
    bondEnd: new Float32Array([separation - atomRadius, 0, 0]),
    bondRadii: new Float32Array([bondRadius]),
    bondIds: new Int32Array([7]),
  };
}

/** A ray travelling along -z towards the point (x, y, 0). */
const down = (x: number, y = 0): PickRay => ({ ox: x, oy: y, oz: 10, dx: 0, dy: 0, dz: -1 });

describe('picking', () => {
  it('hits the atom under the pointer and reports the distance to its surface', () => {
    const hit = pick(diatomic(0.4, 0.1), down(0));
    expect(hit).toMatchObject({ kind: 'atom', id: 10, index: 0 });
    expect(hit!.distance).toBeCloseTo(9.6, 6);
    expect(pick(diatomic(0.4, 0.1), down(1.5))).toMatchObject({ kind: 'atom', id: 20 });
  });

  it('hits the bond between the atoms, and nothing beside it', () => {
    expect(pick(diatomic(0.4, 0.1), down(0.75))).toMatchObject({ kind: 'bond', id: 7 });
    expect(pick(diatomic(0.4, 0.1), down(0.75, 0.09))).toMatchObject({ kind: 'bond', id: 7 });
    expect(pick(diatomic(0.4, 0.1), down(0.75, 0.2))).toBeNull();
    expect(pick(diatomic(0.4, 0.1), down(5))).toBeNull();
  });

  it('gives a click on an atom to the atom even when the bond is drawn thicker than it', () => {
    // Sticks and wireframe views draw multiple bonds wider than the joints they meet.
    const data = diatomic(0.2, 0.3);
    for (const x of [0, 0.1, -0.1, 1.5, 1.6]) expect(pick(data, down(x)), `x=${x}`).toMatchObject({ kind: 'atom' });
    expect(pick(data, down(0.75))).toMatchObject({ kind: 'bond' });
    // Beyond the end of the molecule the wide bond must not be hit either: it has no rounded end caps.
    expect(pick(data, down(-0.25))).toBeNull();
  });

  it('can be told to ignore bonds', () => {
    expect(pick(diatomic(0.4, 0.1), down(0.75), { includeBonds: false })).toBeNull();
  });

  it('returns the nearest of several atoms along the ray', () => {
    const data: PickData = {
      ...diatomic(0.4, 0),
      atomPositions: new Float32Array([0, 0, -3, 0, 0, 2]),
      bondCount: 0,
    };
    expect(pick(data, down(0))).toMatchObject({ kind: 'atom', id: 20 });
    // Atoms behind the ray origin are never hit.
    expect(pick(data, { ...down(0), oz: 1 })).toMatchObject({ id: 10 });
    expect(pick(data, { ...down(0), oz: -5 })).toBeNull();
  });

  it('enlarges small targets to a minimum size so thin wireframes stay clickable', () => {
    const data = diatomic(0.03, 0.02);
    expect(pick(data, down(0, 0.1))).toBeNull();
    expect(pick(data, down(0, 0.1), { minRadiusAt: () => 0.15 })).toMatchObject({ kind: 'atom', id: 10 });
    expect(pick(data, down(0.75, 0.1), { minRadiusAt: () => 0.15 })).toMatchObject({ kind: 'bond', id: 7 });
  });

  it('skips bonds hidden entirely inside overlapping atoms', () => {
    const data: PickData = { ...diatomic(1, 0.1, 1.5), bondStart: new Float32Array([0.75, 0, 0]), bondEnd: new Float32Array([0.75, 0, 0]) };
    expect(pick(data, down(0.75))).toMatchObject({ kind: 'atom' });
  });

  it('does not make hidden atoms or bonds clickable through the minimum target size', () => {
    const data = diatomic(0, 0);
    expect(pick(data, down(0), { minRadiusAt: () => 0.5 })).toBeNull();
    expect(pick(data, down(0.75), { minRadiusAt: () => 0.5 })).toBeNull();
  });
});

describe('plane intersection', () => {
  it('finds where a ray meets a plane', () => {
    expect(intersectPlane(down(2, 3), [0, 0, 1], [0, 0, 1])).toEqual([2, 3, 1]);
    const slanted = intersectPlane({ ox: 0, oy: 0, oz: 0, dx: Math.SQRT1_2, dy: 0, dz: Math.SQRT1_2 }, [0, 0, 5], [0, 0, 1])!;
    expect(slanted[0]).toBeCloseTo(5, 9);
    expect(slanted[2]).toBeCloseTo(5, 9);
  });

  it('returns null for a parallel ray or a plane behind the ray', () => {
    expect(intersectPlane({ ox: 0, oy: 0, oz: 0, dx: 1, dy: 0, dz: 0 }, [0, 0, 5], [0, 0, 1])).toBeNull();
    expect(intersectPlane(down(0), [0, 0, 20], [0, 0, 1])).toBeNull();
  });
});

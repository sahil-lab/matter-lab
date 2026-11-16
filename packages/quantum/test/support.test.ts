import { describe, expect, it } from 'vitest';
import { checkSupport, DEFAULT_MAX_BASIS_FUNCTIONS, HARD_MAX_BASIS_FUNCTIONS, MIN_NUCLEAR_SEPARATION, runRhf, UnsupportedSystemError } from '../src/index';
import type { QmAtom, QmInput } from '../src/index';

const water: QmInput = {
  atoms: [
    { z: 8, position: [0, 0, 0.1173] },
    { z: 1, position: [0, 0.7572, -0.4692] },
    { z: 1, position: [0, -0.7572, -0.4692] },
  ],
  charge: 0,
};

/** `count` atoms of element `z` on a line, 1.6 angstrom apart. */
function chain(z: number, count: number): QmAtom[] {
  return Array.from({ length: count }, (_, i) => ({ z, position: [1.6 * i, 0, 0] as [number, number, number] }));
}

function expectUnsupported(input: QmInput, pattern: RegExp, options?: { maxBasisFunctions?: number }): string[] {
  const report = checkSupport(input, options);
  expect(report.supported).toBe(false);
  expect(report.reasons.length).toBeGreaterThan(0);
  expect(report.reasons.some((reason) => pattern.test(reason)), `${JSON.stringify(report.reasons)} should match ${pattern}`).toBe(true);
  for (const reason of report.reasons) {
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(15);
  }
  // runRhf refuses with exactly the same reasons and never returns numbers for such a system.
  let thrown: unknown;
  try {
    runRhf(input, options);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnsupportedSystemError);
  expect((thrown as UnsupportedSystemError).reasons).toEqual(report.reasons);
  return [...report.reasons];
}

describe('checkSupport accepts what the engine can compute', () => {
  it('reports water as supported with its basis size and electron count', () => {
    const report = checkSupport(water);
    expect(report).toEqual({ supported: true, reasons: [], nBasis: 7, nElectrons: 10, estimatedSeconds: report.estimatedSeconds });
    expect(report.estimatedSeconds).toBeGreaterThan(0);
    expect(report.estimatedSeconds).toBeLessThan(1);
  });

  it('accepts closed-shell ions, atoms and every element up to argon', () => {
    expect(checkSupport({ atoms: [{ z: 8, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.96] }], charge: -1 }).supported).toBe(true);
    expect(checkSupport({ atoms: [{ z: 2, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.77] }], charge: 1 }).supported).toBe(true);
    expect(checkSupport({ atoms: [{ z: 18, position: [0, 0, 0] }], charge: 0 })).toMatchObject({ supported: true, nBasis: 9, nElectrons: 18 });
    expect(checkSupport({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: -1 })).toMatchObject({ supported: true, nBasis: 1, nElectrons: 2 });
    for (let z = 1; z <= 18; z++) {
      // Pair every element with itself: always an even electron count.
      const report = checkSupport({ atoms: chain(z, 2), charge: 0 });
      expect(report.supported, `Z=${z}`).toBe(true);
      expect(report.nElectrons).toBe(2 * z);
    }
  });

  it('runs the smallest possible system (hydride anion: one function, no virtual orbital)', () => {
    const result = runRhf({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: -1 });
    expect(result.converged).toBe(true);
    expect(result.nBasis).toBe(1);
    expect(result.homoIndex).toBe(0);
    expect(result.lumoIndex).toBeNull();
    expect(result.mullikenCharges[0]).toBeCloseTo(-1, 12);
    expect(result.dipole.originDependent).toBe(true);
  });

  it('grows its time estimate with system size', () => {
    const sizes = [1, 2, 4, 8].map((n) => checkSupport({ atoms: chain(6, 2 * n), charge: 0 }).estimatedSeconds);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1] * 2);
  });
});

describe('checkSupport rejects, with reasons, what the engine cannot compute', () => {
  it('no atoms', () => {
    const reasons = expectUnsupported({ atoms: [], charge: 0 }, /no atoms/i);
    expect(reasons.length).toBe(1);
    expect(checkSupport({ atoms: [], charge: 0 })).toMatchObject({ nBasis: 0, estimatedSeconds: 0 });
  });

  it('elements beyond argon', () => {
    const iron = expectUnsupported({ atoms: [{ z: 26, position: [0, 0, 0] }], charge: 0 }, /Z = 26.*H to Ar/);
    expect(iron.length).toBe(1);
    expectUnsupported({ atoms: [{ z: 19, position: [0, 0, 0] }, { z: 9, position: [0, 0, 2.2] }], charge: 0 }, /Unsupported element \(Z = 19\) at atom 1/);
    const report = checkSupport({ atoms: [{ z: 35, position: [0, 0, 0] }, { z: 1, position: [0, 0, 1.4] }, { z: 53, position: [3, 0, 0] }, { z: 1, position: [3, 0, 1.6] }], charge: 0 });
    expect(report.reasons).toEqual([expect.stringMatching(/Unsupported elements \(Z = 35, 53\) at atoms 1, 3/)]);
    // No estimate can be made without basis functions for every atom; only the hydrogens are counted.
    expect(report.estimatedSeconds).toBeNaN();
    expect(report.nBasis).toBe(2);
    expect(report.nElectrons).toBe(90);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('invalid atomic number %s', (z) => {
    const reasons = expectUnsupported({ atoms: [{ z, position: [0, 0, 0] }, { z: 1, position: [0, 0, 1] }], charge: 0 }, /Invalid atomic number .* atom 1/);
    expect(reasons.length).toBe(1);
    const report = checkSupport({ atoms: [{ z, position: [0, 0, 0] }], charge: 0 });
    expect(report.nElectrons).toBeNaN();
    expect(report.estimatedSeconds).toBeNaN();
  });

  it('an atomic number that is not a number at all', () => {
    const report = checkSupport({ atoms: [{ z: '6' as unknown as number, position: [0, 0, 0] }], charge: 0 });
    expect(report.supported).toBe(false);
    expect(report.reasons[0]).toMatch(/Invalid atomic number/);
  });

  it('an odd number of electrons (open shells are not implemented)', () => {
    const radical = expectUnsupported({ atoms: [{ z: 8, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.97] }], charge: 0 }, /odd number of electrons \(9\).*open-shell/i);
    expect(radical.length).toBe(1);
    expectUnsupported({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: 0 }, /odd number of electrons \(1\)/);
    expectUnsupported({ ...water, charge: 1 }, /odd number of electrons \(9\)/);
    expectUnsupported({ atoms: [{ z: 7, position: [0, 0, 0] }, { z: 8, position: [0, 0, 1.15] }], charge: 0 }, /odd number of electrons \(15\)/);
  });

  it('a negative number of electrons, or none', () => {
    const negative = expectUnsupported({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: 2 }, /negative number of electrons \(-1\)/);
    expect(negative.length).toBe(1);
    expect(checkSupport({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: 2 }).nElectrons).toBe(-1);
    expectUnsupported({ atoms: [{ z: 2, position: [0, 0, 0] }], charge: 5 }, /negative number of electrons \(-3\)/);
    expectUnsupported({ atoms: [{ z: 1, position: [0, 0, 0] }], charge: 1 }, /no electrons/);
    expectUnsupported({ atoms: chain(1, 2), charge: 2 }, /no electrons/);
  });

  it('more electron pairs than the minimal basis has functions', () => {
    const reasons = expectUnsupported({ atoms: [{ z: 2, position: [0, 0, 0] }], charge: -2 }, /4 electrons need 2 doubly occupied orbitals.*only 1 basis function/);
    expect(reasons.length).toBe(1);
  });

  it('more basis functions than the limit', () => {
    const big: QmInput = { atoms: chain(10, 20), charge: 0 }; // 100 functions
    expect(DEFAULT_MAX_BASIS_FUNCTIONS).toBe(96);
    const reasons = expectUnsupported(big, /needs 100 basis functions, more than the limit of 96/);
    expect(reasons.length).toBe(1);
    expect(checkSupport(big)).toMatchObject({ nBasis: 100, nElectrons: 200 });
    expect(checkSupport(big).estimatedSeconds).toBeGreaterThan(1);
    expect(checkSupport(big, { maxBasisFunctions: 100 }).supported).toBe(true);
    expectUnsupported(water, /needs 7 basis functions, more than the limit of 5/, { maxBasisFunctions: 5 });
    expect(checkSupport({ atoms: chain(10, 19), charge: 0 }).supported).toBe(true); // 95 functions
    expect(checkSupport({ atoms: [...chain(10, 19), { z: 2, position: [0, 3, 0] }], charge: 0 }).supported).toBe(true); // exactly 96
  });

  it('more basis functions than the hard limit, whatever limit is requested', () => {
    const huge: QmInput = { atoms: chain(10, 26), charge: 0 }; // 130 functions
    expectUnsupported(huge, new RegExp(`needs 130 basis functions, more than the engine's hard limit of ${HARD_MAX_BASIS_FUNCTIONS}`), { maxBasisFunctions: 1000 });
  });

  it('coincident nuclei (closer than 0.1 angstrom)', () => {
    expect(MIN_NUCLEAR_SEPARATION).toBe(0.1);
    const same = expectUnsupported({ atoms: [{ z: 1, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0] }], charge: 0 }, /Coincident nuclei: atoms 1 and 2 \(0\.000 A\)/);
    expect(same.length).toBe(1);
    expectUnsupported({ atoms: [{ z: 1, position: [0, 0, 0] }, { z: 1, position: [0.05, 0.05, 0.05] }], charge: 0 }, /Coincident nuclei: atoms 1 and 2 \(0\.087 A\)/);
    expect(checkSupport({ atoms: [{ z: 1, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.1001] }], charge: 0 }).supported).toBe(true);
    const many = checkSupport({ atoms: Array.from({ length: 6 }, (_, i) => ({ z: 1, position: [0.01 * i, 0, 0] as [number, number, number] })), charge: 0 });
    expect(many.reasons.join(' ')).toMatch(/and 11 more pairs/);
  });

  it('a non-integer or missing charge and non-finite positions', () => {
    expectUnsupported({ ...water, charge: 0.5 }, /net charge must be an integer \(got 0\.5\)/);
    expectUnsupported({ ...water, charge: Number.NaN }, /net charge must be an integer/);
    expect(checkSupport({ atoms: water.atoms } as unknown as QmInput).reasons.join(' ')).toMatch(/net charge must be an integer \(got undefined\)/);
    expectUnsupported({ atoms: [{ z: 2, position: [0, Number.NaN, 0] }], charge: 0 }, /Invalid position for atom 1/);
    expectUnsupported({ atoms: [{ z: 2, position: [0, 0, Number.POSITIVE_INFINITY] }], charge: 0 }, /Invalid position for atom 1/);
    expect(checkSupport({ atoms: [{ z: 2, position: [0, 0] as unknown as [number, number, number] }], charge: 0 }).reasons.join(' ')).toMatch(/Invalid position/);
  });

  it('lists every problem of an input with several', () => {
    const report = checkSupport({
      atoms: [
        { z: 26, position: [0, 0, 0] },
        { z: 1, position: [0, 0, 0.05] },
        { z: 2.5, position: [1, 0, Number.NaN] },
      ],
      charge: 0.5,
    });
    expect(report.supported).toBe(false);
    const all = report.reasons.join('\n');
    expect(all).toMatch(/Invalid atomic number \(2\.5\) for atom 3/);
    expect(all).toMatch(/Unsupported element \(Z = 26\)/);
    expect(all).toMatch(/Invalid position for atom 3/);
    expect(all).toMatch(/net charge must be an integer/);
    expect(report.reasons.length).toBe(4);
  });

  it('never throws on malformed input, but does on a meaningless limit', () => {
    expect(checkSupport(null as unknown as QmInput).supported).toBe(false);
    expect(checkSupport({} as unknown as QmInput).reasons.join(' ')).toMatch(/no atoms/);
    expect(checkSupport({ atoms: [null], charge: 0 } as unknown as QmInput).supported).toBe(false);
    expect(() => checkSupport(water, { maxBasisFunctions: 0 })).toThrow(RangeError);
    expect(() => checkSupport(water, { maxBasisFunctions: 12.5 })).toThrow(RangeError);
  });
});

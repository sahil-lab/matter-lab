import { describe, expect, it } from 'vitest';
import { atomsToBohr, buildBasisBohr } from '../src/basis/basis';
import { STO3G_REFERENCES, STO3G_SOURCE } from '../src/basis/sto3g.generated';
import { computeEri, eriIndex } from '../src/integrals/eri';
import { buildShellPairs } from '../src/integrals/shellPairs';
import { symmetricEigen } from '../src/math/linalg';
import { runRhfCore } from '../src/scf/rhf';
import { buildTwoElectronFock } from '../src/scf/fock';
import { lowestRotationEigenpair, RotationHessian } from '../src/scf/stability';
import { ENGINE_NAME, ENGINE_VERSION, runRhf, UnsupportedSystemError, virialRatio } from '../src/index';
import type { QmInput, ScfIteration } from '../src/index';
import { findMolecule, pyscfFixture, toInput } from './helpers/pyscf';
import { validationReporter } from './helpers/report';

const record = validationReporter('scf');

function coreRun(input: QmInput, options = {}) {
  const atoms = atomsToBohr(input.atoms);
  const basis = buildBasisBohr(atoms);
  const nuclei = atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord }));
  const nElectrons = input.atoms.reduce((sum, atom) => sum + atom.z, 0) - input.charge;
  return { basis, result: runRhfCore(basis, nuclei, nElectrons, options) };
}

/** Rotation about a general axis followed by a translation, applied to every atom. */
function moved(input: QmInput): { input: QmInput; rotate: (v: readonly number[]) => [number, number, number] } {
  const axis = [0.36, -0.48, 0.8];
  const angle = 1.234;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const rotate = (v: readonly number[]): [number, number, number] => {
    const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    const cross = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
    return [v[0] * c + cross[0] * s + axis[0] * d * (1 - c), v[1] * c + cross[1] * s + axis[1] * d * (1 - c), v[2] * c + cross[2] * s + axis[2] * d * (1 - c)];
  };
  const shift = [3.7, -1.9, 0.6];
  return {
    rotate,
    input: {
      charge: input.charge,
      atoms: input.atoms.map((atom) => {
        const r = rotate(atom.position);
        return { z: atom.z, position: [r[0] + shift[0], r[1] + shift[1], r[2] + shift[2]] };
      }),
    },
  };
}

const INVARIANT_SYSTEMS = ['H2', 'HeH+', 'LiH', 'H2O', 'NH4+', 'OH-', 'HCl', 'N2', 'C2H4', 'SO2', 'Ar'];

describe.each(INVARIANT_SYSTEMS)('internal consistency of the RHF result: %s', (name) => {
  const reference = findMolecule(name);
  const input = toInput(reference);
  const result = runRhf(input);
  const n = result.nBasis;

  it('has orthonormal orbitals: C^T S C = I', () => {
    const { orbitalCoefficients: c, overlapMatrix: s } = result;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let mu = 0; mu < n; mu++) for (let nu = 0; nu < n; nu++) sum += c[mu * n + i] * s[mu * n + nu] * c[nu * n + j];
        worst = Math.max(worst, Math.abs(sum - (i === j ? 1 : 0)));
      }
    }
    expect(worst).toBeLessThan(1e-11);
  });

  it('has a density matrix P = 2 C_occ C_occ^T with trace(P S) equal to the number of electrons', () => {
    const { orbitalCoefficients: c, densityMatrix: p, overlapMatrix: s } = result;
    let worst = 0;
    let trace = 0;
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu < n; nu++) {
        let sum = 0;
        for (let i = 0; i < result.nOccupied; i++) sum += 2 * c[mu * n + i] * c[nu * n + i];
        worst = Math.max(worst, Math.abs(sum - p[mu * n + nu]));
        trace += p[mu * n + nu] * s[nu * n + mu];
      }
    }
    expect(worst).toBeLessThan(1e-12);
    expect(Math.abs(trace - result.nElectrons)).toBeLessThan(1e-10);
    expect(result.nElectrons).toBe(reference.nElectrons);
    expect(result.nOccupied).toBe(result.nElectrons / 2);
  });

  it('has Mulliken charges that sum to the molecular charge', () => {
    expect(result.mullikenCharges.length).toBe(input.atoms.length);
    expect(Math.abs(result.mullikenCharges.reduce((sum, q) => sum + q, 0) - input.charge)).toBeLessThan(1e-10);
  });

  it('has energies that add up and orbital energies in ascending order', () => {
    const e = result.energy;
    expect(Math.abs(e.kinetic + e.nuclearAttraction + e.twoElectron - e.electronic)).toBeLessThan(1e-10);
    expect(Math.abs(e.electronic + e.nuclearRepulsion - e.total)).toBeLessThan(1e-10);
    expect(e.kinetic).toBeGreaterThan(0);
    expect(e.nuclearAttraction).toBeLessThan(0);
    expect(e.twoElectron).toBeGreaterThan(0);
    for (let i = 1; i < n; i++) expect(result.orbitalEnergies[i]).toBeGreaterThanOrEqual(result.orbitalEnergies[i - 1]);
    expect(result.homoIndex).toBe(result.nOccupied - 1);
    expect(result.lumoIndex).toBe(result.nOccupied < n ? result.nOccupied : null);
    // The last iteration's energy is that of the density entering it; the reported energy belongs
    // to the final density. At convergence they agree to second order.
    const last = result.iterations[result.iterations.length - 1];
    expect(Math.abs(last.energy - e.total)).toBeLessThan(1e-8);
  });

  it('reports a virial ratio near 2', () => {
    const ratio = virialRatio(result);
    record(`virial/${name}`, ratio);
    // -V/T = 2 holds for exact and for fully optimised wavefunctions; STO-3G exponents are fixed
    // (and H2 / HeH+ are far from their minimal-basis equilibrium), so a few percent off is expected.
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.25);
  });

  it('labels every basis function and survives structured cloning unchanged', () => {
    expect(result.basisFunctions.length).toBe(n);
    result.basisFunctions.forEach((fn, index) => {
      expect(fn.index).toBe(index);
      expect(fn.atomIndex).toBeGreaterThanOrEqual(0);
      expect(fn.atomIndex).toBeLessThan(input.atoms.length);
      expect(fn.shell).toMatch(/^[123](s|px|py|pz)$/);
      expect(fn.label).toMatch(new RegExp(`^[A-Z][a-z]?${fn.atomIndex + 1} ${fn.shell}$`));
    });
    const clone = structuredClone(result);
    expect(clone).toEqual(result);
    expect(clone.orbitalEnergies).toBeInstanceOf(Float64Array);
    expect(clone.densityMatrix).toBeInstanceOf(Float64Array);
  });
});

describe('RHF result metadata', () => {
  const result = runRhf(toInput(findMolecule('H2O')));

  it('labels water as O1 1s, O1 2s, O1 2px, O1 2py, O1 2pz, H2 1s, H3 1s', () => {
    expect(result.basisFunctions.map((fn) => fn.label)).toEqual(['O1 1s', 'O1 2s', 'O1 2px', 'O1 2py', 'O1 2pz', 'H2 1s', 'H3 1s']);
    expect(result.method).toBe('RHF');
    expect(result.basisSet).toBe('STO-3G');
  });

  it('carries provenance: engine, Basis Set Exchange version and the references it lists', () => {
    const { provenance } = result;
    expect(provenance.source).toBe(ENGINE_NAME);
    expect(provenance.version).toBe(ENGINE_VERSION);
    expect(provenance.url).toBe(STO3G_SOURCE.url);
    expect(provenance.retrieved).toBe(STO3G_SOURCE.retrieved);
    expect(provenance.notes).toContain(`library version ${STO3G_SOURCE.bseVersion}`);
    expect(provenance.notes).toContain(STO3G_SOURCE.sha256);
    const dois = (provenance.citations ?? []).map((citation) => citation.doi);
    for (const reference of STO3G_REFERENCES) expect(dois).toContain(reference.doi);
    expect(dois).toContain('10.1103/RevModPhys.23.69');
    expect(dois).toContain('10.1016/0021-9991(78)90092-X');
    expect(dois).toContain('10.1016/0009-2614(80)80396-4');
  });

  it('reports plausible timings and convergence history', () => {
    expect(result.timings.integralsMs).toBeGreaterThan(0);
    expect(result.timings.scfMs).toBeGreaterThan(0);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.integralsMs + result.timings.scfMs - 1e-6);
    result.iterations.forEach((it, index) => expect(it.iteration).toBe(index + 1));
    const last = result.iterations[result.iterations.length - 1];
    expect(Math.abs(last.deltaEnergy)).toBeLessThan(1e-9);
    expect(last.rmsDensityChange).toBeLessThan(1e-7);
    expect(result.iterations[0].deltaEnergy).toBe(result.iterations[0].energy);
    for (let k = 1; k < result.iterations.length; k++) {
      expect(result.iterations[k].deltaEnergy).toBeCloseTo(result.iterations[k].energy - result.iterations[k - 1].energy, 12);
    }
  });
});

describe('invariance under rigid motion', () => {
  it.each(['H2O', 'NH3', 'HCl', 'C2H4', 'CN-'])('%s: energies, charges and the dipole length do not change; the dipole vector rotates', (name) => {
    const input = toInput(findMolecule(name));
    const motion = moved(input);
    const a = runRhf(input, { energyTolerance: 1e-12, densityTolerance: 1e-10 });
    const b = runRhf(motion.input, { energyTolerance: 1e-12, densityTolerance: 1e-10 });
    const expectedDipole = motion.rotate(a.dipole.au);
    const deviation = {
      totalEnergy: Math.abs(a.energy.total - b.energy.total),
      nuclearRepulsion: Math.abs(a.energy.nuclearRepulsion - b.energy.nuclearRepulsion),
      kinetic: Math.abs(a.energy.kinetic - b.energy.kinetic),
      orbitalEnergies: Math.max(...Array.from(a.orbitalEnergies, (e, i) => Math.abs(e - b.orbitalEnergies[i]))),
      charges: Math.max(...a.mullikenCharges.map((q, i) => Math.abs(q - b.mullikenCharges[i]))),
      dipoleVector: Math.max(...expectedDipole.map((d, i) => Math.abs(d - b.dipole.au[i]))),
      dipoleMagnitude: Math.abs(a.dipole.magnitudeDebye - b.dipole.magnitudeDebye),
    };
    record(`rigid-motion/${name}`, deviation);
    expect(deviation.totalEnergy).toBeLessThan(1e-10);
    expect(deviation.nuclearRepulsion).toBeLessThan(1e-11);
    expect(deviation.kinetic).toBeLessThan(1e-8);
    expect(deviation.orbitalEnergies).toBeLessThan(1e-9);
    expect(deviation.charges).toBeLessThan(1e-8);
    expect(deviation.dipoleVector).toBeLessThan(1e-8);
    expect(deviation.dipoleMagnitude).toBeLessThan(1e-8);
  });
});

describe('progress callbacks', () => {
  it('reports phases in order with fractions in [0, 1] and every iteration once', () => {
    const phases: [string, number][] = [];
    const seen: ScfIteration[] = [];
    const result = runRhf(toInput(findMolecule('NH3')), {
      onPhase: (phase, fraction) => phases.push([phase, fraction]),
      onIteration: (it) => seen.push(it),
    });
    expect(seen).toEqual(result.iterations);
    const names = phases.map(([phase]) => phase);
    expect(names[0]).toBe('integrals');
    expect(names[names.length - 1]).toBe('properties');
    const order = ['integrals', 'scf', 'properties'];
    for (let i = 1; i < names.length; i++) expect(order.indexOf(names[i])).toBeGreaterThanOrEqual(order.indexOf(names[i - 1]));
    for (const phase of order) {
      const fractions = phases.filter(([p]) => p === phase).map(([, f]) => f);
      expect(fractions.length).toBeGreaterThanOrEqual(2);
      expect(fractions[0]).toBe(0);
      expect(fractions[fractions.length - 1]).toBe(1);
      for (let i = 0; i < fractions.length; i++) {
        expect(fractions[i]).toBeGreaterThanOrEqual(0);
        expect(fractions[i]).toBeLessThanOrEqual(1);
        if (i > 0) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
      }
    }
  });

  it('gives the same result with and without callbacks', () => {
    const input = toInput(findMolecule('HF'));
    const plain = runRhf(input);
    const observed = runRhf(input, { onPhase: () => undefined, onIteration: () => undefined, isCancelled: () => false });
    expect(observed.energy.total).toBe(plain.energy.total);
    expect(Array.from(observed.orbitalEnergies)).toEqual(Array.from(plain.orbitalEnergies));
  });
});

describe('cancellation', () => {
  const input = toInput(findMolecule('C2H4'));

  it('stops during the integrals and returns an explicitly empty, unconverged result', () => {
    let polls = 0;
    const result = runRhf(input, { isCancelled: () => ++polls > 5 });
    expect(polls).toBe(6);
    expect(result.cancelled).toBe(true);
    expect(result.converged).toBe(false);
    expect(result.iterations).toEqual([]);
    expect(result.energy.total).toBeNaN();
    expect(result.orbitalEnergies.length).toBe(result.nBasis);
    expect(Array.from(result.orbitalEnergies).every(Number.isNaN)).toBe(true);
    expect(Array.from(result.densityMatrix).every(Number.isNaN)).toBe(true);
    expect(result.mullikenCharges.every(Number.isNaN)).toBe(true);
    expect(result.dipole.au.every(Number.isNaN)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/cancelled/);
    expect(result.energy.nuclearRepulsion).toBeGreaterThan(0);
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('stops between SCF iterations and flags the density as unconverged', () => {
    let iterations = 0;
    const result = runRhf(input, { onIteration: () => iterations++, isCancelled: () => iterations >= 3 });
    expect(result.cancelled).toBe(true);
    expect(result.converged).toBe(false);
    expect(result.iterations.length).toBe(3);
    expect(Number.isFinite(result.energy.total)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/cancelled after 3 SCF iterations/);
    // The partial result is still internally consistent.
    const n = result.nBasis;
    let trace = 0;
    for (let mu = 0; mu < n; mu++) for (let nu = 0; nu < n; nu++) trace += result.densityMatrix[mu * n + nu] * result.overlapMatrix[nu * n + mu];
    expect(Math.abs(trace - result.nElectrons)).toBeLessThan(1e-10);
    // ... and is not the converged answer.
    const full = runRhf(input);
    expect(full.converged).toBe(true);
    expect(Math.abs(result.energy.total - full.energy.total)).toBeGreaterThan(1e-6);
  });

  it('polls between integral batches, between iterations and during the stability analysis', () => {
    let polls = 0;
    const result = runRhf(input, {
      isCancelled: () => {
        polls++;
        return false;
      },
    });
    expect(result.cancelled).toBe(false);
    expect(result.converged).toBe(true);
    expect(polls).toBeGreaterThan(result.iterations.length + 10);
  });
});

describe('honest reporting of non-convergence and bad options', () => {
  const input = toInput(findMolecule('H2CO'));

  it('returns converged: false with a warning when the iteration limit is hit', () => {
    const result = runRhf(input, { maxIterations: 3 });
    expect(result.converged).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.iterations.length).toBe(3);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/did not converge within 3 iterations/);
    expect(Number.isFinite(result.energy.total)).toBe(true);
  });

  it('cannot be talked into convergence by impossible tolerances', () => {
    const result = runRhf(input, { maxIterations: 40, energyTolerance: 1e-30, densityTolerance: 1e-30 });
    expect(result.converged).toBe(false);
    expect(result.iterations.length).toBe(40);
    expect(result.warnings.join(' ')).toMatch(/did not converge/);
    // The numbers are nevertheless those of the converged state to machine precision.
    expect(Math.abs(result.energy.total - findMolecule('H2CO').energy.total)).toBeLessThan(1e-9);
  });

  it('rejects meaningless options', () => {
    expect(() => runRhf(input, { maxIterations: 0 })).toThrow(RangeError);
    expect(() => runRhf(input, { maxIterations: 2.5 })).toThrow(RangeError);
    expect(() => runRhf(input, { energyTolerance: 0 })).toThrow(RangeError);
    expect(() => runRhf(input, { densityTolerance: -1 })).toThrow(RangeError);
    expect(() => runRhf(input, { maxBasisFunctions: 0 })).toThrow(RangeError);
  });

  it('throws UnsupportedSystemError with reasons instead of computing an unsupported system', () => {
    try {
      runRhf({ atoms: [{ z: 8, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.97] }], charge: 0 });
      expect.unreachable('an odd-electron system must not be computed');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSystemError);
      expect(error).toBeInstanceOf(Error);
      const reasons = (error as UnsupportedSystemError).reasons;
      expect(reasons.length).toBe(1);
      expect(reasons[0]).toMatch(/odd number of electrons/);
      expect((error as Error).message).toContain(reasons[0]);
      expect((error as Error).name).toBe('UnsupportedSystemError');
    }
  });
});

describe('two-electron Fock matrix', () => {
  const systems: [string, QmInput][] = [
    ['H2S (no integral screened)', toInput(findMolecule('H2S'))],
    [
      // Separated fragments: most of the table is zero, which the build must skip correctly.
      'separated HF, HF and Ne (most integrals screened out)',
      {
        charge: 0,
        atoms: [
          { z: 9, position: [0, 0, 0] },
          { z: 1, position: [0, 0, 0.92] },
          { z: 9, position: [11, 1, 0] },
          { z: 1, position: [11, 1, 0.92] },
          { z: 10, position: [-2, 14, 6] },
        ],
      },
    ],
  ];

  it.each(systems)('equals the brute-force contraction of all n^4 integrals with a general symmetric density: %s', (_label, input) => {
    const basis = buildBasisBohr(atomsToBohr(input.atoms));
    const n = basis.nBasis;
    const table = computeEri(basis, buildShellPairs(basis));
    const eri = table.values;
    const density = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) density[i * n + j] = density[j * n + i] = Math.sin(1.3 * i + 0.7 * j) + (i === j ? 1 : 0);
    const fast = new Float64Array(n * n);
    buildTwoElectronFock(eri, density, n, fast, new Float64Array(n * n));
    let worst = 0;
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu < n; nu++) {
        let sum = 0;
        for (let lambda = 0; lambda < n; lambda++) {
          for (let sigma = 0; sigma < n; sigma++) {
            sum += density[lambda * n + sigma] * (eri[eriIndex(mu, nu, lambda, sigma)] - 0.5 * eri[eriIndex(mu, lambda, nu, sigma)]);
          }
        }
        worst = Math.max(worst, Math.abs(sum - fast[mu * n + nu]));
        expect(fast[mu * n + nu]).toBe(fast[nu * n + mu]);
      }
    }
    expect(worst).toBeLessThan(1e-11);
    const zeros = eri.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
    if (input.atoms.length === 5) expect(zeros).toBeGreaterThan(eri.length / 2);
    expect(table.shellQuartetsScreened > 0).toBe(input.atoms.length === 5);
  });
});

describe('stability of the SCF solution', () => {
  it('applies the orbital-rotation Hessian exactly as its explicit matrix (water)', () => {
    const input = toInput(findMolecule('H2O'));
    const { basis, result } = coreRun(input, { energyTolerance: 1e-12, densityTolerance: 1e-10 });
    const n = basis.nBasis;
    const nOcc = result.nOccupied;
    const nVirt = n - nOcc;
    const eri = computeEri(basis, buildShellPairs(basis)).values;
    const c = result.orbitalCoefficients;
    const mo = (p: number, q: number, r: number, s: number): number => {
      let sum = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) sum += c[a * n + p] * c[b * n + q] * c[k * n + r] * c[l * n + s] * eri[eriIndex(a, b, k, l)];
      return sum;
    };
    const dimension = nOcc * nVirt;
    const explicit = new Float64Array(dimension * dimension);
    for (let i = 0; i < nOcc; i++) {
      for (let a = 0; a < nVirt; a++) {
        for (let j = 0; j < nOcc; j++) {
          for (let b = 0; b < nVirt; b++) {
            const [va, vb] = [a + nOcc, b + nOcc];
            let value = 4 * mo(i, va, j, vb) - mo(i, vb, j, va) - mo(i, j, va, vb);
            if (i === j && a === b) value += result.orbitalEnergies[va] - result.orbitalEnergies[i];
            explicit[(i * nVirt + a) * dimension + (j * nVirt + b)] = value;
          }
        }
      }
    }
    const hessian = new RotationHessian({ n, nOcc, coefficients: c, orbitalEnergies: result.orbitalEnergies, eri });
    const v = Float64Array.from({ length: dimension }, (_, k) => Math.sin(1.7 * k + 0.3));
    const applied = new Float64Array(dimension);
    hessian.apply(v, applied);
    let worst = 0;
    for (let row = 0; row < dimension; row++) {
      let sum = 0;
      for (let col = 0; col < dimension; col++) sum += explicit[row * dimension + col] * v[col];
      worst = Math.max(worst, Math.abs(sum - applied[row]));
    }
    expect(worst).toBeLessThan(1e-10);

    const exact = symmetricEigen(explicit, dimension).values[0];
    const davidson = lowestRotationEigenpair({ n, nOcc, coefficients: c, orbitalEnergies: result.orbitalEnergies, eri });
    expect(davidson.converged).toBe(true);
    expect(Math.abs(davidson.lowestEigenvalue - exact)).toBeLessThan(1e-6);
    expect(exact).toBeGreaterThan(0);
  });

  it('leaves the saddle point the core-Hamiltonian guess leads to for N2', () => {
    const reference = findMolecule('N2', 'canonical');
    const { result } = coreRun(toInput(reference));
    expect(result.converged).toBe(true);
    expect(result.stability.saddlePointsLeft).toBe(1);
    expect(result.stability.verified).toBe(true);
    expect(result.stability.lowestEigenvalue).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(Math.abs(result.energy.total - reference.energy.total)).toBeLessThan(1e-6);
    // The saddle point is the solution PySCF itself reaches from the same guess.
    const saddle = result.iterations.find((it, k) => k > 0 && Math.abs(it.deltaEnergy) < 1e-9);
    expect(saddle).toBeDefined();
    expect(Math.abs(saddle!.energy - reference.coreGuess.totalEnergy)).toBeLessThan(1e-6);
    expect(saddle!.energy).toBeGreaterThan(result.energy.total + 0.5);
    record('stability/N2', {
      saddleEnergy: saddle!.energy,
      pyscfCoreGuessEnergy: reference.coreGuess.totalEnergy,
      finalEnergy: result.energy.total,
      referenceEnergy: reference.energy.total,
      iterations: result.iterations.length,
      hessianProducts: result.stability.hessianProducts,
    });
  });

  it('confirms every reference solution to be an energy minimum, in agreement with PySCF', () => {
    const rows = pyscfFixture().molecules.map((molecule) => {
      const { result } = coreRun(toInput(molecule));
      return {
        system: `${molecule.name} (${molecule.orientation})`,
        verified: result.stability.verified,
        lowestEigenvalue: result.stability.lowestEigenvalue,
        lowestEigenvalueIsExact: result.stability.lowestEigenvalueIsExact,
        saddlePointsLeft: result.stability.saddlePointsLeft,
        hessianProducts: result.stability.hessianProducts,
        iterations: result.iterations.length,
        pyscfInternalStable: molecule.internalStable,
        residual: result.residual,
      };
    });
    record('stability/all', rows);
    for (const row of rows) {
      expect(row.verified, row.system).toBe(true);
      // PySCF could not analyse systems without virtual orbitals (null); they are trivially stable.
      if (row.pyscfInternalStable !== null) expect(row.pyscfInternalStable, row.system).toBe(true);
      if (row.lowestEigenvalue !== null) expect(row.lowestEigenvalue, row.system).toBeGreaterThan(-1e-5);
      expect(row.saddlePointsLeft, row.system).toBe(row.system.startsWith('N2') ? 1 : 0);
      expect(row.residual, row.system).toBeLessThan(1e-5);
    }
  });
});

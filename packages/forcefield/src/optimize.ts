/*
 * Geometry optimisation with the Universal Force Field: the public `optimizeUff` entry point.
 *
 * RDKit's `UFFOptimizeMolecule` builds the force field and runs its BFGS minimiser. This does the
 * same, and adds what an interactive editor needs around it: repair of starting geometries on which
 * the energy is undefined, escape from symmetric saddle points, frozen atoms, a step callback with
 * cancellation, an optional trajectory, and a result that says honestly whether it converged.
 */
import type { UffKernel } from './builder';
import { evaluate } from './energy';
import { maskAndMeasure, minimize } from './minimizer';
import type { GradientStats, MinimizeOutcome } from './minimizer';
import { hashUnit, lowestCurvatureMode } from './modes';
import { elementSymbol } from './perception';
import { evaluatePreRelaxation, hasGrossDefects, hasTrappedAngle } from './prerelax';
import { uffProvenance } from './provenance';
import { systemFromTyped, typeMolecule, uffEnergy } from './system';
import type { TypedMolecule } from './system';
import type { FfMolecule, OptimizeOptions, OptimizeResult } from './types';

export const DEFAULT_MAX_STEPS = 2000;
/** RMS gradient, kcal/mol/angstrom. */
export const DEFAULT_GRADIENT_TOLERANCE = 1e-4;
/** kcal/mol between consecutive steps. */
export const DEFAULT_ENERGY_TOLERANCE = 1e-6;

/** Atoms closer than this (angstrom) are treated as coincident. */
const COINCIDENCE_DISTANCE = 0.01;
/** Half-width (angstrom) of the cube coincident atoms are scattered in. */
const COINCIDENCE_JITTER = 0.1;
/** An angle whose sine is below this is treated as exactly straight. */
const COLLINEAR_SINE = 1e-4;
/** Half-width (angstrom) of the cube the atoms of a straight angle are moved in. */
const COLLINEAR_JITTER = 0.01;
/** Largest atomic displacement (angstrom) when stepping off a saddle point. */
const SADDLE_DISPLACEMENT = 0.1;
/** How many times a run may step off a saddle point before giving up. */
const MAX_SADDLE_ESCAPES = 12;
/** Limits of the pre-relaxation that untangles an unusable starting geometry. */
const PRE_RELAXATION_MAX_STEPS = 3000;
const PRE_RELAXATION_GRADIENT_TOLERANCE = 0.01;
const PRE_RELAXATION_ENERGY_TOLERANCE = 1e-5;
/** How many times a run may be taken out of a small-angle trap. */
const MAX_UNTRAPS = 3;

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();

interface Settings {
  readonly maxSteps: number;
  readonly gradientTolerance: number;
  readonly energyTolerance: number;
  readonly frozen: Uint8Array | null;
  readonly nFrozen: number;
  readonly recordEvery: number;
  readonly onStep: OptimizeOptions['onStep'];
}

function readSettings(options: OptimizeOptions, nAtoms: number): Settings {
  if (options === null || typeof options !== 'object') throw new RangeError('optimizeUff: options must be an object.');
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 0) throw new RangeError(`optimizeUff: maxSteps must be a non-negative integer, got ${String(maxSteps)}.`);
  const gradientTolerance = options.gradientTolerance ?? DEFAULT_GRADIENT_TOLERANCE;
  if (!(gradientTolerance > 0) || !Number.isFinite(gradientTolerance)) {
    throw new RangeError(`optimizeUff: gradientTolerance must be a positive number (kcal/mol/angstrom), got ${String(gradientTolerance)}.`);
  }
  const energyTolerance = options.energyTolerance ?? DEFAULT_ENERGY_TOLERANCE;
  if (!(energyTolerance > 0) || !Number.isFinite(energyTolerance)) {
    throw new RangeError(`optimizeUff: energyTolerance must be a positive number (kcal/mol), got ${String(energyTolerance)}.`);
  }
  const recordEvery = options.recordTrajectoryEvery ?? 0;
  if (!Number.isInteger(recordEvery) || recordEvery < 0) {
    throw new RangeError(`optimizeUff: recordTrajectoryEvery must be a non-negative integer, got ${String(recordEvery)}.`);
  }
  if (options.onStep !== undefined && typeof options.onStep !== 'function') throw new RangeError('optimizeUff: onStep must be a function.');
  let frozen: Uint8Array | null = null;
  let nFrozen = 0;
  if (options.frozenAtoms !== undefined && options.frozenAtoms.length > 0) {
    frozen = new Uint8Array(nAtoms);
    for (const i of options.frozenAtoms) {
      if (!Number.isInteger(i) || i < 0 || i >= nAtoms) {
        throw new RangeError(`optimizeUff: frozenAtoms contains ${String(i)}, but atom indices run from 0 to ${nAtoms - 1}.`);
      }
      if (!frozen[i]) nFrozen++;
      frozen[i] = 1;
    }
  }
  return { maxSteps, gradientTolerance, energyTolerance, frozen, nFrozen, recordEvery, onStep: options.onStep };
}

function describeAtoms(tm: TypedMolecule, atoms: readonly number[]): string {
  const shown = atoms.slice(0, 12).map((i) => `${i} (${elementSymbol(tm.graph.z[i])})`);
  return shown.join(', ') + (atoms.length > shown.length ? `, and ${atoms.length - shown.length} more` : '');
}

/**
 * Moves atoms off geometries on which the force field is not defined, with a deterministic
 * pseudo-random displacement. Two situations are repaired:
 *   - coincident atoms: bond, angle and van der Waals terms have no direction to push along;
 *   - an exactly straight angle at an sp2 or sp3 atom: the planes that the torsion and inversion
 *     terms are measured from do not exist (RDKit's gradient is spurious or NaN there).
 * Frozen atoms are never moved. Returns notes describing what was done, and whether atoms coincided.
 */
function repairStart(tm: TypedMolecule, x: Float64Array, frozen: Uint8Array | null): { notes: string[]; hadCoincidentAtoms: boolean } {
  const g = tm.graph;
  const n = g.nAtoms;
  const notes: string[] = [];
  const isFrozen = (i: number): boolean => frozen !== null && frozen[i] === 1;
  const movedCoincident = new Set<number>();
  const movedCollinear = new Set<number>();
  let stuck: [number, number] | null = null;

  for (let round = 0; round < 8; round++) {
    // ---- coincident atoms (atoms of different fragments do not interact, so they may overlap)
    const coincident = new Set<number>();
    stuck = null;
    const fragment = tm.perception.fragment;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (fragment[i] !== fragment[j]) continue;
        const dx = x[3 * i] - x[3 * j];
        const dy = x[3 * i + 1] - x[3 * j + 1];
        const dz = x[3 * i + 2] - x[3 * j + 2];
        if (dx * dx + dy * dy + dz * dz < COINCIDENCE_DISTANCE * COINCIDENCE_DISTANCE) {
          if (isFrozen(i) && isFrozen(j)) {
            stuck = [i, j];
          } else {
            if (!isFrozen(i)) coincident.add(i);
            if (!isFrozen(j)) coincident.add(j);
          }
        }
      }
    }
    // ---- exactly straight angles at sp2/sp3 atoms
    const collinear = new Set<number>();
    for (let j = 0; j < n; j++) {
      const hyb = tm.perception.hybridization[j];
      if (hyb !== 'SP2' && hyb !== 'SP3') continue;
      for (let p = g.nbrStart[j]; p < g.nbrStart[j + 1]; p++) {
        const i = g.nbrAtom[p];
        const ax = x[3 * i] - x[3 * j];
        const ay = x[3 * i + 1] - x[3 * j + 1];
        const az = x[3 * i + 2] - x[3 * j + 2];
        const la = Math.sqrt(ax * ax + ay * ay + az * az);
        for (let q = p + 1; q < g.nbrStart[j + 1]; q++) {
          const k = g.nbrAtom[q];
          const bx = x[3 * k] - x[3 * j];
          const by = x[3 * k + 1] - x[3 * j + 1];
          const bz = x[3 * k + 2] - x[3 * j + 2];
          const lb = Math.sqrt(bx * bx + by * by + bz * bz);
          const cx = ay * bz - az * by;
          const cy = az * bx - ax * bz;
          const cz = ax * by - ay * bx;
          if (Math.sqrt(cx * cx + cy * cy + cz * cz) < COLLINEAR_SINE * la * lb) {
            for (const a of [i, j, k]) if (!isFrozen(a)) collinear.add(a);
          }
        }
      }
    }
    if (coincident.size === 0 && collinear.size === 0) break;
    for (const i of coincident) {
      // A larger pile of atoms is scattered over a proportionally larger volume.
      const width = COINCIDENCE_JITTER * Math.max(1, Math.cbrt(coincident.size / 2));
      for (let c = 0; c < 3; c++) x[3 * i + c] += width * hashUnit(3 * i + c, 1000 + round);
      movedCoincident.add(i);
    }
    for (const i of collinear) {
      if (coincident.has(i)) continue;
      for (let c = 0; c < 3; c++) x[3 * i + c] += COLLINEAR_JITTER * hashUnit(3 * i + c, 2000 + round);
      movedCollinear.add(i);
    }
  }

  if (movedCoincident.size > 0) {
    const atoms = Array.from(movedCoincident).sort((a, b) => a - b);
    notes.push(
      `Starting geometry repaired: atoms ${describeAtoms(tm, atoms)} coincided with another atom (closer than ${COINCIDENCE_DISTANCE} angstrom) ` +
        'and were moved apart by a small deterministic displacement before optimisation.',
    );
  }
  if (movedCollinear.size > 0) {
    const atoms = Array.from(movedCollinear).sort((a, b) => a - b);
    notes.push(
      `Starting geometry repaired: atoms ${describeAtoms(tm, atoms)} formed an exactly straight angle at an sp2 or sp3 atom, where torsion and ` +
        `inversion terms are undefined; they were displaced by up to ${COLLINEAR_JITTER} angstrom before optimisation.`,
    );
  }
  if (stuck !== null) {
    notes.push(`Frozen atoms ${stuck[0]} and ${stuck[1]} coincide and cannot be moved apart; the energy may be undefined.`);
  }
  return { notes, hadCoincidentAtoms: movedCoincident.size > 0 };
}

/**
 * Steps off a saddle point along the unstable direction `v` (unit vector), to whichever side lowers
 * the energy more. Returns false if neither side lowers it.
 */
function stepOffSaddle(kernel: UffKernel, x: Float64Array, v: Float64Array, energy: number): boolean {
  const n = x.length / 3;
  let largest = 0;
  for (let i = 0; i < n; i++) largest = Math.max(largest, Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]));
  if (!(largest > 0)) return false;
  const trial = new Float64Array(x.length);
  let s = SADDLE_DISPLACEMENT / largest;
  for (let attempt = 0; attempt < 8; attempt++, s *= 0.5) {
    let bestEnergy = energy;
    let bestSign = 0;
    for (const sign of [1, -1]) {
      for (let i = 0; i < x.length; i++) trial[i] = x[i] + sign * s * v[i];
      const e = evaluate(kernel, trial, null, null);
      if (Number.isFinite(e) && e < bestEnergy) {
        bestEnergy = e;
        bestSign = sign;
      }
    }
    if (bestSign !== 0) {
      for (let i = 0; i < x.length; i++) x[i] += bestSign * s * v[i];
      return true;
    }
  }
  return false;
}

/**
 * Optimises the geometry of a molecule with the Universal Force Field as implemented in RDKit.
 *
 * `converged` is true when the RMS gradient of the atoms that are free to move is at most
 * `gradientTolerance`, the last step changed the energy by at most `energyTolerance`, and the final
 * geometry has no direction of negative curvature (it is a minimum, not a saddle point). If the
 * step limit is reached first, `converged` is false and the best geometry so far is returned.
 * `onStep` is called once with step 0 (the starting point) and then after every step.
 *
 * @throws UnsupportedForceFieldError naming every atom UFF cannot type and why
 * @throws RangeError if the molecule or the options are malformed
 */
export function optimizeUff(mol: FfMolecule, options: OptimizeOptions = {}): OptimizeResult {
  const started = now();
  const tm = typeMolecule(mol);
  const n = tm.graph.nAtoms;
  const settings = readSettings(options, n);
  const { frozen } = settings;
  const warnings: string[] = [];

  const x0 = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = mol.atoms[i].position;
    x0[3 * i] = p[0];
    x0[3 * i + 1] = p[1];
    x0[3 * i + 2] = p[2];
  }
  const x = x0.slice();
  const repairs = repairStart(tm, x, frozen);

  // Like RDKit, build the force field at the geometry the optimisation starts from.
  let system = systemFromTyped(tm, x);
  let kernel = system.kernel;
  warnings.push(...repairs.notes);

  let initialEnergy = evaluate(kernel, x0, null, null);
  if (!Number.isFinite(initialEnergy)) {
    initialEnergy = evaluate(kernel, x, null, null);
    warnings.push(
      'The UFF energy of the geometry as given is undefined (coincident atoms); initialEnergy is the energy of the repaired starting geometry.',
    );
  }

  const g = new Float64Array(3 * n);
  const trajectory: Float32Array[] = [];
  let totalSteps = 0;
  let lastRecorded = -1;
  const record = (): void => {
    if (lastRecorded !== totalSteps) {
      trajectory.push(Float32Array.from(x));
      lastRecorded = totalSteps;
    }
  };
  const report = (energy: number, rmsGradient: number, maxGradient: number): boolean => {
    if (settings.recordEvery > 0 && totalSteps % settings.recordEvery === 0) record();
    if (settings.onStep === undefined) return true;
    return settings.onStep({ step: totalSteps, energy, rmsGradient, maxGradient, positions: x }) !== false;
  };
  const onStep = (energy: number, rmsGradient: number, maxGradient: number): boolean => {
    totalSteps++;
    return report(energy, rmsGradient, maxGradient);
  };
  const stats: GradientStats = { rms: 0, max: 0 };
  /** The UFF energy and gradient statistics at the current geometry, as a minimiser outcome. */
  const measure = (status: MinimizeOutcome['status']): MinimizeOutcome => {
    const e = evaluate(kernel, x, g, null);
    maskAndMeasure(g, frozen, stats);
    return { status, steps: 0, energy: e, rmsGradient: stats.rms, maxGradient: stats.max, restarts: 0 };
  };

  // step 0: the starting point
  let outcome = measure('cancelled');
  let escapes = 0;
  // Set when the run ends on a geometry that is known not to be a minimum.
  let saddleNote: string | null = null;
  const movable = settings.nFrozen < n;

  /**
   * Relaxes the current geometry in the smooth stand-in potential of prerelax.ts, then rebuilds the
   * force field at the result. `goOn` is false if the run was cancelled or ran out of steps.
   */
  const preRelax = (): { steps: number; goOn: boolean } => {
    const preKernel = kernel;
    const preGradient = new Float64Array(3 * n);
    const uffGradient = new Float64Array(3 * n);
    const pre = minimize((p, grad) => evaluatePreRelaxation(preKernel, p, grad), x, preGradient, {
      maxSteps: Math.min(settings.maxSteps - totalSteps, PRE_RELAXATION_MAX_STEPS),
      gradientTolerance: PRE_RELAXATION_GRADIENT_TOLERANCE,
      energyTolerance: PRE_RELAXATION_ENERGY_TOLERANCE,
      frozen,
      // Report the true UFF energy of each intermediate geometry, not the stand-in's.
      onStep: () => {
        const e = evaluate(preKernel, x, uffGradient, null);
        maskAndMeasure(uffGradient, frozen, stats);
        return onStep(e, stats.rms, stats.max);
      },
    });
    // The geometry may have changed beyond recognition: rebuild the force field where UFF starts.
    system = systemFromTyped(tm, x);
    kernel = system.kernel;
    if (pre.status === 'cancelled') {
      outcome = measure('cancelled');
      return { steps: pre.steps, goOn: false };
    }
    if (totalSteps >= settings.maxSteps) {
      outcome = measure('step-limit');
      return { steps: pre.steps, goOn: false };
    }
    return { steps: pre.steps, goOn: true };
  };

  let proceed = report(outcome.energy, outcome.rmsGradient, outcome.maxGradient);

  // ---- an unusable start is first relaxed in the stand-in potential
  if (proceed && movable && totalSteps < settings.maxSteps && (repairs.hadCoincidentAtoms || hasGrossDefects(kernel, x))) {
    const pre = preRelax();
    proceed = pre.goOn;
    warnings.push(
      'Starting geometry repaired: as given it is unusable for the force field (atoms on top of each other, or neighbours of an atom folded onto ' +
        `each other), so it was first relaxed for ${pre.steps} steps with bond, angle and soft-repulsion terms only. The UFF optimisation started ` +
        'from the result; expect a sensible conformer, not necessarily the intended one.',
    );
  }

  if (proceed) {
    const uff = (p: Float64Array, grad: Float64Array): number => evaluate(kernel, p, grad, null);
    let untraps = 0;
    for (;;) {
      outcome = minimize(uff, x, g, {
        maxSteps: settings.maxSteps - totalSteps,
        gradientTolerance: settings.gradientTolerance,
        energyTolerance: settings.energyTolerance,
        frozen,
        onStep,
      });
      // Ended against one of the small-angle walls of RDKit's UFF? Open the folded angle in the
      // stand-in potential and carry on.
      if (
        (outcome.status === 'converged' || outcome.status === 'stalled') &&
        movable &&
        untraps < MAX_UNTRAPS &&
        totalSteps < settings.maxSteps &&
        hasTrappedAngle(kernel, x)
      ) {
        untraps++;
        const pre = preRelax();
        if (untraps === 1) {
          warnings.push(
            'The optimisation ran into a small-angle trap of the force field (two neighbours of an sp2, sp or hypervalent atom on the wrong side of the ' +
              'barrier of their angle term). The geometry was relaxed with trap-free angle terms and the optimisation continued.',
          );
        }
        if (!pre.goOn) break;
        continue;
      }
      if (outcome.status !== 'converged' || !movable) break;

      // Converged, but to a minimum? Look at the lowest curvature.
      const mode = lowestCurvatureMode(kernel, x, frozen);
      if (mode === null || !mode.unstable) break;
      const curvature = `${mode.curvature.toPrecision(3)} kcal/mol/angstrom^2`;
      if (escapes >= MAX_SADDLE_ESCAPES) {
        saddleNote = `Not converged to a minimum: the final geometry is a saddle point (lowest curvature ${curvature}), even after stepping off ${escapes} saddle points.`;
        break;
      }
      if (totalSteps >= settings.maxSteps) {
        saddleNote = `Not converged to a minimum: the limit of ${settings.maxSteps} steps was reached on a saddle point (lowest curvature ${curvature}).`;
        break;
      }
      if (!stepOffSaddle(kernel, x, mode.vector, outcome.energy)) {
        saddleNote =
          `Not converged to a minimum: the final geometry has a direction of negative curvature (${curvature}), ` +
          'but no lower energy was found along it.';
        break;
      }
      escapes++;
    }
  }
  if (escapes > 0) {
    warnings.push(
      `The optimisation first converged to a saddle point (a symmetric arrangement that is not a minimum) ${escapes} time${escapes === 1 ? '' : 's'}; ` +
        'each time the geometry was displaced along the unstable direction and optimised further.',
    );
  }

  const converged = outcome.status === 'converged' && saddleNote === null;
  const cancelled = outcome.status === 'cancelled';
  if (saddleNote !== null) {
    warnings.push(saddleNote);
  } else if (outcome.status === 'step-limit') {
    warnings.push(
      `Not converged: the limit of ${settings.maxSteps} steps was reached with an RMS gradient of ${outcome.rmsGradient.toExponential(2)} kcal/mol/angstrom ` +
        `(tolerance ${settings.gradientTolerance.toExponential(2)}).`,
    );
  } else if (outcome.status === 'stalled') {
    warnings.push(
      Number.isFinite(outcome.energy)
        ? `Not converged: no step lowers the energy any further at double precision, but the RMS gradient is still ${outcome.rmsGradient.toExponential(2)} ` +
            `kcal/mol/angstrom (tolerance ${settings.gradientTolerance.toExponential(2)}).`
        : 'Not converged: the UFF energy of the starting geometry is undefined, so no optimisation was possible.',
    );
  }
  if (settings.recordEvery > 0) record();
  // What the typer and the builder had to say about the force field that was finally used comes first.
  warnings.unshift(...system.warnings);

  const energyTerms = uffEnergy(system, x);
  let sumSq = 0;
  for (let i = 0; i < x.length; i++) sumSq += (x[i] - x0[i]) * (x[i] - x0[i]);

  return {
    method: 'UFF',
    converged,
    cancelled,
    steps: totalSteps,
    initialEnergy,
    finalEnergy: energyTerms.total,
    energyTerms,
    rmsGradient: outcome.rmsGradient,
    maxGradient: outcome.maxGradient,
    positions: x,
    rmsDisplacement: n > 0 ? Math.sqrt(sumSq / n) : 0,
    trajectory,
    atomTypes: system.atomTypes.slice(),
    warnings,
    elapsedMs: now() - started,
    provenance: uffProvenance(),
  };
}

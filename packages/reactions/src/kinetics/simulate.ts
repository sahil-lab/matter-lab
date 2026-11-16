import type { EvidenceLevel, Quantity } from '@matterlab/core';
import { checkConservation, parseEquation } from '../equation';
import type { ReactionEquation } from '../equation';
import { hillFormula, parseFormula } from '../formula';
import { kineticEvidence, rateConstant } from './models';
import type { KineticModel } from './models';
import { integrateOde } from './ode';

export const KINETICS_SOLVER_METHOD = 'Dormand-Prince 5(4) explicit Runge-Kutta with adaptive step size and fourth-order dense output';

export interface KineticsInput {
  readonly model: KineticModel;
  readonly temperatureK: number;
  /**
   * Initial concentration of each species, in `model.concentrationUnit` (molecule cm-3 for the shipped
   * models, mol/L after `toMolarUnits`), keyed by the formulas used in `model.equation`. Every species that
   * appears in the rate law must be given; any other species of the reaction starts at 0 when omitted.
   */
  readonly initialConcentrations: Readonly<Record<string, number>>;
  readonly durationSeconds: number;
  /** Number of equally spaced output times, including t = 0 and t = duration (default 201). */
  readonly outputPoints?: number;
  /**
   * Error tolerance of the integration (default 1e-8, allowed 1e-13 to 1e-3). Per step, the error of each
   * concentration is kept below tolerance × (the largest change that species can undergo + its current value).
   */
  readonly tolerance?: number;
  /** Limit on the number of step attempts (default 200 000). */
  readonly maxSteps?: number;
}

/** Optional callbacks for a long simulation. They do not change the numbers; cancelling only ends the run early. */
export interface KineticsHooks {
  /** Asked after every accepted step; return true to abandon the simulation there. */
  readonly shouldCancel?: () => boolean;
  /** Told, after every accepted step, which fraction of `durationSeconds` has been reached. */
  readonly onProgress?: (fraction: number) => void;
}

export interface KineticsResult {
  /**
   * - `ok`: the trajectory covers the whole duration.
   * - `incomplete`: the integrator stopped early, or the run was cancelled; the arrays end at the time that was
   *   reached, `reasons` says why and `solver.stopReason` names the cause.
   * - `unsupported`: the request cannot be simulated; the arrays are empty and `reasons` says why.
   */
  readonly status: 'ok' | 'incomplete' | 'unsupported';
  readonly reasons: readonly string[];
  /** Output times in seconds. */
  readonly times: Float64Array;
  /**
   * Concentration of each species at the output times, in `concentrationUnit`. They satisfy the
   * stoichiometry of the reaction to rounding error and never go beyond complete conversion of the
   * limiting reactant.
   */
  readonly concentrations: Readonly<Record<string, Float64Array>>;
  /** Rate of reaction at the output times, in `rateUnit`; a species changes at its stoichiometric coefficient times this. */
  readonly rates: Float64Array;
  /** k at the requested temperature. Its value is NaN when it could not be evaluated. */
  readonly rateConstant: Quantity;
  /**
   * Time for the limiting reactant to fall to half of its initial concentration, or `null` when that is
   * undefined (no reaction, or it never gets there). It does not depend on `durationSeconds`.
   */
  readonly halfLifeSeconds: number | null;
  /** Which species the half-life refers to and how it was obtained. */
  readonly halfLife: { readonly species: string; readonly seconds: number; readonly method: 'analytic' | 'numerical-quadrature' } | null;
  readonly solver: {
    readonly method: string;
    readonly steps: number;
    readonly rejectedSteps: number;
    readonly tolerance: number;
    /**
     * Set when the reaction ran to completion before the end: from this time on, what is left of the
     * limiting reactant is smaller than 1 % of the tolerance, so the remaining outputs hold the fully
     * converted composition.
     */
    readonly reactionCompleteAfterSeconds?: number;
    /** Number of evaluations of the rate law during the integration. */
    readonly functionEvaluations: number;
    /**
     * Why the trajectory ends before the requested duration, when it does: the step budget ran out
     * (`max-steps`), the integrator failed, or the run was cancelled through `KineticsHooks.shouldCancel`.
     */
    readonly stopReason?: 'max-steps' | 'step-size-underflow' | 'non-finite-derivative' | 'cancelled';
  };
  /** Includes a prominent entry when the temperature is outside the model's validated range. */
  readonly warnings: readonly string[];
  /** `computed` inside the validated temperature range of a reference model, `rule-based` outside it, `unsupported` when nothing was simulated. */
  readonly evidence: EvidenceLevel;
  readonly withinValidatedRange: boolean;
  /** Species of the reaction, in the order they appear in the equation; the keys of `concentrations`. */
  readonly species: readonly string[];
  readonly concentrationUnit: string;
  readonly rateUnit: string;
}

/**
 * [A](t) for d[A]/dt = −κ [A]^n, the closed-form solution for a reaction whose rate depends on a single
 * species. κ is the rate constant times the stoichiometric coefficient of A (κ = k for "A -> ...", κ = 2k
 * for "2 A -> ..."). For n < 1 the reactant is used up at a finite time and stays at 0 afterwards.
 */
export function powerLawDecay(initial: number, kappa: number, order: number, t: number): number {
  if (order === 1) return initial * Math.exp(-kappa * t);
  const base = initial ** (1 - order) + (order - 1) * kappa * t;
  if (order < 1 && base <= 0) return 0;
  return base ** (1 / (1 - order));
}

/** Half-life of A for d[A]/dt = −κ [A]^n: ln 2 / κ for n = 1, otherwise (2^(n−1) − 1) / ((n − 1) κ [A]0^(n−1)). */
export function powerLawHalfLife(initial: number, kappa: number, order: number): number {
  if (order === 1) return Math.LN2 / kappa;
  return (2 ** (order - 1) - 1) / ((order - 1) * kappa * initial ** (order - 1));
}

/**
 * Closed-form solution of "A + B -> products" with rate = k [A][B]: the concentrations of A and B and the
 * extent of reaction at time t. Handles equal and unequal initial concentrations.
 */
export function secondOrderTwoReactants(a0: number, b0: number, k: number, t: number): { readonly a: number; readonly b: number; readonly extent: number } {
  let extent: number;
  if (a0 === b0) {
    extent = (a0 * a0 * k * t) / (1 + a0 * k * t);
  } else {
    const difference = b0 - a0;
    const z = difference * k * t;
    // x = a0 b0 (e^z − 1) / (b0 e^z − a0), arranged so that neither large |z| nor nearly equal a0 and b0 lose accuracy.
    extent = z > 0 ? (a0 * b0 * -Math.expm1(-z)) / (difference - a0 * Math.expm1(-z)) : (a0 * b0 * Math.expm1(z)) / (b0 * Math.expm1(z) + difference);
  }
  return { a: a0 - extent, b: b0 - extent, extent };
}

interface SpeciesInfo {
  readonly label: string;
  readonly key: string;
  /** Net stoichiometric coefficient: positive for products, negative for reactants. */
  readonly nu: number;
  order: number;
  initial: number;
  given: boolean;
}

function collectSpecies(equation: ReactionEquation): SpeciesInfo[] {
  const byKey = new Map<string, { label: string; nu: number }>();
  const add = (label: string, key: string, nu: number): void => {
    const existing = byKey.get(key);
    if (existing) existing.nu += nu;
    else byKey.set(key, { label, nu });
  };
  for (const t of equation.reactants) add(t.formula, hillFormula(t.parsed), -t.coefficient);
  for (const t of equation.products) add(t.formula, hillFormula(t.parsed), t.coefficient);
  return [...byKey].map(([key, v]) => ({ label: v.label, key, nu: v.nu, order: 0, initial: 0, given: false }));
}

/** Finds a species by the formula text used in the model or, failing that, by composition ("HO" finds "OH"). */
function findSpecies(species: readonly SpeciesInfo[], name: string): SpeciesInfo | undefined {
  const exact = species.find((s) => s.label === name);
  if (exact) return exact;
  try {
    const key = hillFormula(parseFormula(name));
    return species.find((s) => s.key === key);
  } catch {
    return undefined;
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Concentration-time curves for one reaction with a power-law rate law, by numerical integration with
 * error control.
 *
 * The rate of reaction is r = k(T) × Π [X]^order and each species changes at its net stoichiometric
 * coefficient times r. Everything else about the model (which reaction, which orders, which k) comes from
 * `input.model`; this function adds no chemistry of its own and does not decide whether a reaction happens.
 *
 * It never invents a curve. Anything it cannot simulate comes back with status `unsupported` and the
 * reasons; an integration that stops early comes back as `incomplete` with the part that was computed. A
 * temperature outside the model's validated range is simulated, but the result says so in `warnings`,
 * `withinValidatedRange` and `evidence`.
 *
 * `hooks` lets a caller follow or cancel a long run. A cancelled run comes back as `incomplete` with
 * `solver.stopReason` set to `cancelled`.
 */
export function simulateKinetics(input: KineticsInput, hooks: KineticsHooks = {}): KineticsResult {
  const { model } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const tolerance = input.tolerance ?? 1e-8;
  const outputPoints = input.outputPoints ?? 201;
  const maxSteps = input.maxSteps ?? 200_000;
  const concentrationUnit = model.concentrationUnit;
  const rateUnit = `${concentrationUnit} s-1`;

  // --- the model ---------------------------------------------------------------------------------------
  let species: SpeciesInfo[] = [];
  try {
    const equation = parseEquation(model.equation);
    if (!checkConservation(equation).balanced) reasons.push(`The model equation "${model.equation}" is not balanced.`);
    species = collectSpecies(equation);
  } catch (error) {
    reasons.push(`The model equation cannot be read: ${messageOf(error)}`);
  }
  if (species.length > 0) {
    for (const [name, order] of Object.entries(model.rateLaw.orders)) {
      const target = findSpecies(species, name);
      if (!target) reasons.push(`The rate law refers to ${name}, which is not a species of "${model.equation}".`);
      else if (!Number.isFinite(order) || order < 0) reasons.push(`The order of ${name} must be a non-negative number.`);
      else target.order += order;
    }
    if (!species.some((s) => s.nu < 0)) reasons.push('The model reaction consumes no species.');
  }
  const arrheniusValid = Number.isFinite(model.arrhenius.A) && model.arrhenius.A >= 0 && Number.isFinite(model.arrhenius.EaKJPerMol);
  if (!arrheniusValid) reasons.push('The Arrhenius parameters of the model must be finite, with a non-negative pre-exponential factor.');

  // --- the request --------------------------------------------------------------------------------------
  const temperatureOk = Number.isFinite(input.temperatureK) && input.temperatureK > 0;
  if (!temperatureOk) reasons.push('The temperature must be a positive number of kelvin.');
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) reasons.push('The duration must be a positive number of seconds.');
  if (!Number.isInteger(outputPoints) || outputPoints < 2 || outputPoints > 1_000_001) reasons.push('outputPoints must be a whole number between 2 and 1 000 001.');
  if (!(tolerance >= 1e-13 && tolerance <= 1e-3)) reasons.push('The tolerance must lie between 1e-13 and 1e-3.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) reasons.push('maxSteps must be a positive whole number.');
  for (const [name, value] of Object.entries(input.initialConcentrations)) {
    const target = findSpecies(species, name);
    if (!target) {
      if (species.length > 0) warnings.push(`${name} is not a species of "${model.equation}"; its initial concentration was ignored.`);
    } else if (target.given) {
      reasons.push(`The initial concentration of ${target.label} is given more than once.`);
    } else {
      target.given = true;
      if (!Number.isFinite(value) || value < 0) reasons.push(`The initial concentration of ${name} must be a non-negative number.`);
      else target.initial = value;
    }
  }
  for (const s of species) {
    if (s.order > 0 && !s.given) reasons.push(`No initial concentration was given for ${s.label}, which the rate law depends on.`);
  }

  // --- the rate constant -------------------------------------------------------------------------------
  let k: Quantity = { value: Number.NaN, unit: model.arrhenius.AUnits, evidence: 'unsupported' };
  let withinValidatedRange = false;
  if (temperatureOk && arrheniusValid) {
    const result = rateConstant(model, input.temperatureK);
    k = result.k;
    withinValidatedRange = result.withinValidatedRange;
    warnings.unshift(...result.warnings);
    if (!Number.isFinite(k.value) || k.value < 0) reasons.push('The rate constant is not a finite, non-negative number at this temperature.');
  }

  const labels = species.map((s) => s.label);
  if (reasons.length > 0) {
    return {
      status: 'unsupported',
      reasons,
      times: new Float64Array(0),
      concentrations: Object.fromEntries(labels.map((l) => [l, new Float64Array(0)])),
      rates: new Float64Array(0),
      rateConstant: { ...k, evidence: 'unsupported' },
      halfLifeSeconds: null,
      halfLife: null,
      solver: { method: KINETICS_SOLVER_METHOD, steps: 0, rejectedSteps: 0, tolerance, functionEvaluations: 0 },
      warnings,
      evidence: 'unsupported',
      withinValidatedRange,
      species: labels,
      concentrationUnit,
      rateUnit,
    };
  }

  // --- integration ----------------------------------------------------------------------------------------
  const n = species.length;
  const nu = Float64Array.from(species.map((s) => s.nu));
  const order = Float64Array.from(species.map((s) => s.order));
  const y0 = Float64Array.from(species.map((s) => s.initial));
  const kValue = k.value;
  const rateOf = (y: ArrayLike<number>): number => {
    let rate = kValue;
    for (let i = 0; i < n; i++) {
      const c = y[i]!;
      // A species that is consumed cannot go below zero, whatever its order: without it the reaction has stopped.
      if (nu[i]! < 0 && c <= 0) return 0;
      if (order[i]! !== 0) rate *= Math.max(c, 0) ** order[i]!;
    }
    return rate;
  };
  const remainingExtent = (y: ArrayLike<number>): number => {
    let extent = Infinity;
    for (let i = 0; i < n; i++) if (nu[i]! < 0) extent = Math.min(extent, Math.max(y[i]!, 0) / -nu[i]!);
    return extent;
  };

  const maxExtent = remainingExtent(y0);
  const largest = Math.max(...y0);
  if (largest === 0) warnings.push('Every initial concentration is zero, so nothing happens.');
  else if (rateOf(y0) === 0) warnings.push('The reaction rate is zero at the start and stays zero: a species the rate depends on is absent, or the rate constant is zero.');
  // Errors are controlled relative to the largest change each species can undergo.
  const fallbackScale = largest > 0 ? largest : 1;
  const atol = Float64Array.from(species.map((s) => tolerance * (maxExtent > 0 && s.nu !== 0 ? Math.abs(s.nu) * maxExtent : fallbackScale)));
  const completeBelow = 0.01 * tolerance * maxExtent;

  // Held in an object because it is set from inside the integrator's callback.
  const run = { cancelled: false };
  const cancelRequested = (): boolean => {
    if (!run.cancelled && hooks.shouldCancel?.()) run.cancelled = true;
    return run.cancelled;
  };
  const integration = integrateOde(
    (_t, y, dydt) => {
      const rate = rateOf(y);
      for (let i = 0; i < n; i++) dydt[i] = nu[i]! * rate;
    },
    y0,
    0,
    input.durationSeconds,
    {
      rtol: tolerance,
      atol,
      maxSteps,
      outputPoints,
      shouldStop: (t, y) => {
        if (cancelRequested()) return true;
        hooks.onProgress?.(t / input.durationSeconds);
        return maxExtent > 0 && remainingExtent(y) <= completeBelow;
      },
    },
  );

  const times: number[] = Array.from(integration.times);
  // Composition after complete conversion of the limiting reactant. Within its tolerance the integrator can
  // step marginally past this point, which would show as a negative concentration; such a state is
  // replaced by the fully converted composition, which differs from it by less than the tolerance and
  // keeps the mass balance exact.
  const converted = Float64Array.from(species.map((s, i) => (s.nu < 0 && s.initial / -s.nu === maxExtent ? 0 : y0[i]! + nu[i]! * maxExtent)));
  const pastCompletion = (state: Float64Array): boolean => {
    for (let i = 0; i < n; i++) if (nu[i]! < 0 && state[i]! < 0) return true;
    return false;
  };
  const states: Float64Array[] = integration.states.map((state) => (maxExtent > 0 && Number.isFinite(maxExtent) && pastCompletion(state) ? converted : state));
  let status: KineticsResult['status'] = 'ok';
  let reactionCompleteAfterSeconds: number | undefined;
  let stopReason: KineticsResult['solver']['stopReason'];
  if (!integration.completed) {
    if (run.cancelled) {
      status = 'incomplete';
      stopReason = 'cancelled';
      reasons.push(`The simulation was cancelled at t = ${Number(integration.tEnd.toPrecision(6))} s of ${input.durationSeconds} s. The arrays hold the part that was computed.`);
    } else if (integration.stopReason === 'stopped-by-callback') {
      // The limiting reactant is used up to within 1 % of the tolerance, so nothing can change any more
      // by an amount the tolerance would resolve. The remaining outputs hold the fully converted composition.
      reactionCompleteAfterSeconds = integration.tEnd;
      for (let i = times.length; i < outputPoints; i++) {
        times.push(i === outputPoints - 1 ? input.durationSeconds : (input.durationSeconds * i) / (outputPoints - 1));
        states.push(converted);
      }
    } else {
      status = 'incomplete';
      stopReason = integration.stopReason === 'max-steps' || integration.stopReason === 'non-finite-derivative' ? integration.stopReason : 'step-size-underflow';
      const why =
        integration.stopReason === 'max-steps'
          ? `the limit of ${maxSteps} step attempts was reached; shorten the duration, loosen the tolerance or raise maxSteps`
          : integration.stopReason === 'non-finite-derivative'
            ? 'the reaction rate became infinite or undefined'
            : 'the step size became too small to make progress';
      reasons.push(`The integration stopped at t = ${Number(integration.tEnd.toPrecision(6))} s of ${input.durationSeconds} s because ${why}. The arrays hold the part that was computed.`);
    }
  }

  const concentrations: Record<string, Float64Array> = {};
  species.forEach((s, i) => {
    concentrations[s.label] = Float64Array.from(states.map((state) => state[i]!));
  });
  const rates = Float64Array.from(states.map((state) => rateOf(state)));

  // --- half-life of the limiting reactant -----------------------------------------------------------------
  let halfLife: KineticsResult['halfLife'] = null;
  const limiting = species.find((s) => s.nu < 0 && s.initial > 0 && s.initial / -s.nu === maxExtent);
  if (limiting && maxExtent > 0 && Number.isFinite(maxExtent) && kValue > 0 && !run.cancelled) {
    const dependsOn = species.filter((s) => s.order > 0);
    if (dependsOn.length === 1 && dependsOn[0] === limiting) {
      const seconds = powerLawHalfLife(limiting.initial, -limiting.nu * kValue, limiting.order);
      if (Number.isFinite(seconds) && seconds > 0) halfLife = { species: limiting.label, seconds, method: 'analytic' };
    } else if (rateOf(y0) > 0) {
      // With one reaction everything is a function of its extent x, and dt/dx = 1 / rate(x). Integrating
      // that from 0 to the extent at which the limiting reactant is half gone gives the half-life directly.
      const halfExtent = maxExtent / 2;
      const state = new Float64Array(n);
      const timeScale = halfExtent / rateOf(y0);
      const quadrature = integrateOde(
        (x, _t, dtdx) => {
          for (let i = 0; i < n; i++) state[i] = y0[i]! + nu[i]! * x;
          dtdx[0] = 1 / rateOf(state);
        },
        new Float64Array(1),
        0,
        halfExtent,
        { rtol: 1e-10, atol: 1e-12 * timeScale, maxSteps: 100_000, shouldStop: cancelRequested },
      );
      const seconds = quadrature.finalState[0]!;
      if (quadrature.completed && Number.isFinite(seconds) && seconds > 0) halfLife = { species: limiting.label, seconds, method: 'numerical-quadrature' };
      if (run.cancelled) {
        status = 'incomplete';
        stopReason = 'cancelled';
        reasons.push('The simulation was cancelled while the half-life was being computed; the concentration curves are complete, the half-life is not given.');
      }
    }
  }

  return {
    status,
    reasons,
    times: Float64Array.from(times),
    concentrations,
    rates,
    rateConstant: k,
    halfLifeSeconds: halfLife?.seconds ?? null,
    halfLife,
    solver: {
      method: KINETICS_SOLVER_METHOD,
      steps: integration.steps,
      rejectedSteps: integration.rejectedSteps,
      tolerance,
      ...(reactionCompleteAfterSeconds !== undefined ? { reactionCompleteAfterSeconds } : {}),
      functionEvaluations: integration.functionEvaluations,
      ...(stopReason ? { stopReason } : {}),
    },
    warnings,
    evidence: kineticEvidence(model, withinValidatedRange),
    withinValidatedRange,
    species: labels,
    concentrationUnit,
    rateUnit,
  };
}

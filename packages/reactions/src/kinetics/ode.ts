/**
 * Adaptive explicit Runge-Kutta integrator: the Dormand-Prince 5(4) pair with error-controlled step size
 * and fourth-order dense output.
 *
 * Method: J. R. Dormand and P. J. Prince, "A family of embedded Runge-Kutta formulae", J. Comput. Appl.
 * Math. 6 (1980) 19-26; step-size control and continuous extension as in E. Hairer, S. P. Nørsett and
 * G. Wanner, "Solving Ordinary Differential Equations I", 2nd ed., Springer 1993 (code DOPRI5).
 *
 * The method is explicit and therefore meant for non-stiff problems. On a stiff problem it still returns
 * a correct answer or reports failure, but it may need so many steps that `maxSteps` is reached.
 */

export interface OdeOptions {
  /** Relative error tolerance per step (default 1e-8). */
  readonly rtol?: number;
  /** Absolute error tolerance per step, one value for all components or one per component (default 1e-12). */
  readonly atol?: number | ArrayLike<number>;
  /** Maximum number of step attempts, accepted or rejected (default 100 000). */
  readonly maxSteps?: number;
  /**
   * Number of equally spaced output times from t0 to t1 inclusive (at least 2), evaluated with the dense
   * output. When omitted, the output is the initial point followed by every accepted step.
   */
  readonly outputPoints?: number;
  /** Called after each accepted step; return true to end the integration there. */
  readonly shouldStop?: (t: number, y: Float64Array) => boolean;
}

export interface OdeResult {
  /** Output times; when the integration ends early these stop at the last output time that was reached. */
  readonly times: Float64Array;
  /** State at each output time. */
  readonly states: Float64Array[];
  /** Accepted steps. */
  readonly steps: number;
  readonly rejectedSteps: number;
  /** True when t1 was reached. */
  readonly completed: boolean;
  /** Why the integration ended before t1, when it did. */
  readonly stopReason?: 'max-steps' | 'step-size-underflow' | 'non-finite-derivative' | 'stopped-by-callback';
  /** Time actually reached, and the state there. */
  readonly tEnd: number;
  readonly finalState: Float64Array;
  /** Number of evaluations of the right-hand side. */
  readonly functionEvaluations: number;
}

// Butcher tableau of the Dormand-Prince 5(4) pair.
const C2 = 1 / 5;
const C3 = 3 / 10;
const C4 = 4 / 5;
const C5 = 8 / 9;
const A21 = 1 / 5;
const A31 = 3 / 40;
const A32 = 9 / 40;
const A41 = 44 / 45;
const A42 = -56 / 15;
const A43 = 32 / 9;
const A51 = 19372 / 6561;
const A52 = -25360 / 2187;
const A53 = 64448 / 6561;
const A54 = -212 / 729;
const A61 = 9017 / 3168;
const A62 = -355 / 33;
const A63 = 46732 / 5247;
const A64 = 49 / 176;
const A65 = -5103 / 18656;
// Fifth-order weights; they are also the last row of the tableau (first same as last).
const B1 = 35 / 384;
const B3 = 500 / 1113;
const B4 = 125 / 192;
const B5 = -2187 / 6784;
const B6 = 11 / 84;
// Fifth-order minus fourth-order weights: the error estimator.
const E1 = 71 / 57600;
const E3 = -71 / 16695;
const E4 = 71 / 1920;
const E5 = -17253 / 339200;
const E6 = 22 / 525;
const E7 = -1 / 40;
// Dense-output coefficients (Hairer, Nørsett and Wanner, DOPRI5).
const D1 = -12715105075 / 11282082432;
const D3 = 87487479700 / 32700410799;
const D4 = -10690763975 / 1880347072;
const D5 = 701980252875 / 199316789632;
const D6 = -1453857185 / 822651844;
const D7 = 69997945 / 29380423;

const SAFETY = 0.9;
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5;

/**
 * Integrates dy/dt = f(t, y) from t0 to t1 (t1 may be smaller than t0).
 *
 * `f` must write the derivative into its third argument and must not keep a reference to its arguments.
 * A step is accepted when the estimated local error of every component is below `atol + rtol * |y|` in the
 * root-mean-square sense; otherwise it is repeated with a smaller step.
 *
 * The integrator never throws for a failed integration: it returns what it has, with `completed: false`
 * and a `stopReason`. It throws `RangeError` only for unusable arguments.
 */
export function integrateOde(
  f: (t: number, y: Float64Array, dydt: Float64Array) => void,
  y0: Float64Array,
  t0: number,
  t1: number,
  options: OdeOptions = {},
): OdeResult {
  const n = y0.length;
  const rtol = options.rtol ?? 1e-8;
  const maxSteps = options.maxSteps ?? 100_000;
  const outputPoints = options.outputPoints;
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new RangeError('t0 and t1 must be finite.');
  if (!(rtol >= 0) || !Number.isFinite(rtol)) throw new RangeError('rtol must be a non-negative number.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be a positive integer.');
  if (outputPoints !== undefined && (!Number.isInteger(outputPoints) || outputPoints < 2)) throw new RangeError('outputPoints must be an integer of at least 2.');
  const atol = new Float64Array(n);
  const atolOption = options.atol ?? 1e-12;
  for (let i = 0; i < n; i++) {
    const a = typeof atolOption === 'number' ? atolOption : atolOption[i];
    if (a === undefined || !(a >= 0) || !Number.isFinite(a)) throw new RangeError('atol must be a non-negative number, or one per component.');
    if (a === 0 && rtol === 0) throw new RangeError('rtol and atol cannot both be zero.');
    atol[i] = a;
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(y0[i]!)) throw new RangeError('The initial state must be finite.');

  const direction = t1 >= t0 ? 1 : -1;
  const span = Math.abs(t1 - t0);
  let evaluations = 0;
  const rhs = (t: number, y: Float64Array, out: Float64Array): boolean => {
    f(t, y, out);
    evaluations++;
    for (let i = 0; i < n; i++) if (!Number.isFinite(out[i]!)) return false;
    return true;
  };

  const times: number[] = [];
  const states: Float64Array[] = [];
  const outputTime = (index: number): number => (index === outputPoints! - 1 ? t1 : t0 + ((t1 - t0) * index) / (outputPoints! - 1));

  const y = Float64Array.from(y0);
  let t = t0;
  const finish = (completed: boolean, steps: number, rejectedSteps: number, stopReason?: OdeResult['stopReason']): OdeResult => ({
    times: Float64Array.from(times),
    states,
    steps,
    rejectedSteps,
    completed,
    ...(stopReason ? { stopReason } : {}),
    tEnd: t,
    finalState: Float64Array.from(y),
    functionEvaluations: evaluations,
  });

  // The initial point is always the first output.
  times.push(t0);
  states.push(Float64Array.from(y));
  let nextOutput = 1;
  if (span === 0) {
    if (outputPoints !== undefined) {
      for (; nextOutput < outputPoints; nextOutput++) {
        times.push(t0);
        states.push(Float64Array.from(y));
      }
    }
    return finish(true, 0, 0);
  }

  const k1 = new Float64Array(n);
  const k2 = new Float64Array(n);
  const k3 = new Float64Array(n);
  const k4 = new Float64Array(n);
  const k5 = new Float64Array(n);
  const k6 = new Float64Array(n);
  const k7 = new Float64Array(n);
  const stage = new Float64Array(n);
  const yNew = new Float64Array(n);
  const scaledNorm = (v: Float64Array, ref: Float64Array): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const sc = atol[i]! + rtol * Math.abs(ref[i]!);
      // With atol = 0 a component that is exactly zero has no scale; only an exactly zero value fits it.
      sum += sc > 0 ? (v[i]! / sc) ** 2 : v[i] === 0 ? 0 : Infinity;
    }
    return n === 0 ? 0 : Math.sqrt(sum / n);
  };

  if (!rhs(t, y, k1)) return finish(false, 0, 0, 'non-finite-derivative');

  // Initial step size (Hairer, Nørsett and Wanner, section II.4).
  let h: number;
  {
    const d0 = scaledNorm(y, y);
    const d1 = scaledNorm(k1, y);
    let h0 = d0 < 1e-5 || d1 < 1e-5 ? 1e-6 : 0.01 * (d0 / d1);
    h0 = Math.min(h0, span);
    for (let i = 0; i < n; i++) stage[i] = y[i]! + direction * h0 * k1[i]!;
    if (!rhs(t + direction * h0, stage, k2)) return finish(false, 0, 0, 'non-finite-derivative');
    for (let i = 0; i < n; i++) k3[i] = k2[i]! - k1[i]!;
    const d2 = scaledNorm(k3, y) / h0;
    const h1 = Math.max(d1, d2) <= 1e-15 ? Math.max(1e-6, h0 * 1e-3) : (0.01 / Math.max(d1, d2)) ** (1 / 5);
    h = Math.min(100 * h0, h1, span);
  }

  let steps = 0;
  let rejectedSteps = 0;
  let lastRejected = false;
  let lastFailureNonFinite = false;
  const dense = new Float64Array(n);

  for (let attempts = 0; ; attempts++) {
    if (attempts >= maxSteps) return finish(false, steps, rejectedSteps, 'max-steps');
    const remaining = Math.abs(t1 - t);
    // Take the last step exactly to t1, and avoid leaving a sliver that would need a tiny extra step.
    let last = false;
    if (h >= remaining || remaining - h < 1e-12 * span) {
      h = remaining;
      last = true;
    }
    if (h <= Math.abs(t) * 4 * Number.EPSILON || h < Number.MIN_VALUE * 1e10) {
      return finish(false, steps, rejectedSteps, lastFailureNonFinite ? 'non-finite-derivative' : 'step-size-underflow');
    }
    const hs = direction * h;

    for (let i = 0; i < n; i++) stage[i] = y[i]! + hs * A21 * k1[i]!;
    let finite = rhs(t + C2 * hs, stage, k2);
    for (let i = 0; i < n; i++) stage[i] = y[i]! + hs * (A31 * k1[i]! + A32 * k2[i]!);
    finite = finite && rhs(t + C3 * hs, stage, k3);
    for (let i = 0; i < n; i++) stage[i] = y[i]! + hs * (A41 * k1[i]! + A42 * k2[i]! + A43 * k3[i]!);
    finite = finite && rhs(t + C4 * hs, stage, k4);
    for (let i = 0; i < n; i++) stage[i] = y[i]! + hs * (A51 * k1[i]! + A52 * k2[i]! + A53 * k3[i]! + A54 * k4[i]!);
    finite = finite && rhs(t + C5 * hs, stage, k5);
    for (let i = 0; i < n; i++) stage[i] = y[i]! + hs * (A61 * k1[i]! + A62 * k2[i]! + A63 * k3[i]! + A64 * k4[i]! + A65 * k5[i]!);
    finite = finite && rhs(t + hs, stage, k6);
    for (let i = 0; i < n; i++) yNew[i] = y[i]! + hs * (B1 * k1[i]! + B3 * k3[i]! + B4 * k4[i]! + B5 * k5[i]! + B6 * k6[i]!);
    finite = finite && rhs(t + hs, yNew, k7);

    let error = Infinity;
    if (finite) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const e = hs * (E1 * k1[i]! + E3 * k3[i]! + E4 * k4[i]! + E5 * k5[i]! + E6 * k6[i]! + E7 * k7[i]!);
        const sc = atol[i]! + rtol * Math.max(Math.abs(y[i]!), Math.abs(yNew[i]!));
        sum += sc > 0 ? (e / sc) ** 2 : e === 0 ? 0 : Infinity;
      }
      error = n === 0 ? 0 : Math.sqrt(sum / n);
    }

    if (!(error <= 1)) {
      // Rejected: shrink the step. A non-finite stage is treated like a very large error.
      rejectedSteps++;
      lastRejected = true;
      lastFailureNonFinite = !finite;
      const factor = Number.isFinite(error) ? Math.max(MIN_FACTOR, SAFETY * error ** (-1 / 5)) : MIN_FACTOR;
      h *= Math.min(1, factor);
      continue;
    }
    lastFailureNonFinite = false;

    // Accepted. Emit the outputs that fall inside this step before moving on.
    const tNew = last ? t1 : t + hs;
    if (outputPoints !== undefined) {
      while (nextOutput < outputPoints) {
        const tOut = outputTime(nextOutput);
        if (direction * (tOut - tNew) > 0) break;
        if (tOut === tNew) {
          states.push(Float64Array.from(yNew));
        } else {
          const theta = (tOut - t) / (tNew - t);
          const theta1 = 1 - theta;
          const step = tNew - t;
          for (let i = 0; i < n; i++) {
            const difference = yNew[i]! - y[i]!;
            const r3 = step * k1[i]! - difference;
            const r4 = difference - step * k7[i]! - r3;
            const r5 = step * (D1 * k1[i]! + D3 * k3[i]! + D4 * k4[i]! + D5 * k5[i]! + D6 * k6[i]! + D7 * k7[i]!);
            dense[i] = y[i]! + theta * (difference + theta1 * (r3 + theta * (r4 + theta1 * r5)));
          }
          states.push(Float64Array.from(dense));
        }
        times.push(tOut);
        nextOutput++;
      }
    } else {
      times.push(tNew);
      states.push(Float64Array.from(yNew));
    }

    steps++;
    t = tNew;
    y.set(yNew);
    k1.set(k7);
    if (last) return finish(true, steps, rejectedSteps);
    if (options.shouldStop?.(t, y)) return finish(false, steps, rejectedSteps, 'stopped-by-callback');

    const grow = error === 0 ? MAX_FACTOR : Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, SAFETY * error ** (-1 / 5)));
    // Do not increase the step straight after a rejection.
    h *= lastRejected ? Math.min(1, grow) : grow;
    lastRejected = false;
  }
}

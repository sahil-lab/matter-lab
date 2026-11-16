/*
 * Quasi-Newton minimiser for the UFF energy.
 *
 * The stepping is a port of the RDKit's minimiser (BSD 3-Clause, see ../README.md):
 *   Code/Numerics/Optimizer/BFGSOpt.h   BFGSOpt::minimize, BFGSOpt::linearSearch
 *                                       (after Numerical Recipes in C, sections 10.7 and 9.7)
 *   Code/ForceField/ForceField.cpp      ForceFieldsHelper::calcGradient (the gradient scaling),
 *                                       ForceField::calcGrad (fixed points)
 * Copyright (C) 2004-2008 Greg Landrum and Rational Discovery LLC and other RDKit contributors.
 *
 * Following RDKit step for step keeps the search in the same basin RDKit ends up in. What differs
 * is everything around the stepping:
 *   - convergence is decided on the true RMS gradient and the energy change, not on RDKit's loose
 *     relative tests, so a run continues well past the point where RDKit stops;
 *   - where RDKit raises ("bad direction in linearSearch") or declares victory because a line
 *     search found no lower energy, the inverse Hessian is reset and the search restarted;
 *   - when energy differences fall below double-precision resolution, a step is judged on the
 *     directional derivative instead (the "approximate Wolfe" idea of Hager and Zhang);
 *   - non-finite trial energies are treated as rejected steps;
 *   - above DENSE_BFGS_MAX_DIMENSION coordinates the dense inverse Hessian is replaced by a
 *     limited-memory (L-BFGS) two-loop recursion so that memory stays linear in the system size.
 */

/** Returns the energy at `x` and writes its gradient into `g`. */
export type Objective = (x: Float64Array, g: Float64Array) => number;

/** Default tolerance for function convergence in the line search (RDKit: FUNCTOL). */
const FUNCTOL = 1e-4;
/** Default tolerance for x changes in the line search (RDKit: MOVETOL). */
const MOVETOL = 1e-7;
/**
 * RDKit gives up on a line search, and reports convergence, once the step would move no coordinate
 * by more than MOVETOL (relative). That is where a run stops being RDKit's: if the gradient is not
 * yet small enough, backtracking simply continues down to this much smaller limit.
 */
const RESCUE_MOVETOL = 1e-13;
/** RDKit: EPS, used in the test that decides whether a BFGS update is safe. */
const EPS = 3e-8;
/** RDKit: MAXSTEP. */
const MAXSTEP = 100.0;
const MAX_ITER_LINEAR_SEARCH = 1000;

/** Up to this many coordinates (400 atoms, 11.5 MB) the inverse Hessian is stored densely, as in RDKit. */
export const DENSE_BFGS_MAX_DIMENSION = 1200;
/** Number of correction pairs kept by the limited-memory variant. */
const LBFGS_MEMORY = 30;

/** Energy differences below this fraction of the energy are treated as rounding noise. */
const ENERGY_NOISE = 1e-13;
/** Steps without measurable progress after which the search is declared stalled. */
const STALL_STEPS = 200;

export type MinimizeStatus = 'converged' | 'step-limit' | 'cancelled' | 'stalled';

export interface MinimizeControls {
  /** Maximum number of steps this call may take. */
  readonly maxSteps: number;
  /** RMS gradient over the free coordinates, kcal/mol/angstrom. */
  readonly gradientTolerance: number;
  /** kcal/mol between consecutive steps. */
  readonly energyTolerance: number;
  /** Per atom: 1 if the atom must not move. */
  readonly frozen: Uint8Array | null;
  /** Called after every accepted step; return false to stop. */
  readonly onStep?: (energy: number, rmsGradient: number, maxGradient: number) => boolean;
  /** Use the limited-memory update whatever the size of the system (for testing that branch). */
  readonly limitedMemory?: boolean;
}

export interface MinimizeOutcome {
  readonly status: MinimizeStatus;
  readonly steps: number;
  readonly energy: number;
  readonly rmsGradient: number;
  readonly maxGradient: number;
  /** How often the inverse Hessian had to be reset because a line search failed. */
  readonly restarts: number;
}

export interface GradientStats {
  rms: number;
  max: number;
}

/** Zeroes the gradient of frozen atoms (RDKit's fixed points) and measures what is left. */
export function maskAndMeasure(g: Float64Array, frozen: Uint8Array | null, out: GradientStats): void {
  let sum = 0;
  let max = 0;
  let nFree = 0;
  const n = g.length / 3;
  for (let i = 0; i < n; i++) {
    const i3 = 3 * i;
    if (frozen !== null && frozen[i]) {
      g[i3] = 0;
      g[i3 + 1] = 0;
      g[i3 + 2] = 0;
      continue;
    }
    nFree += 3;
    for (let c = 0; c < 3; c++) {
      const v = g[i3 + c];
      sum += v * v;
      const a = Math.abs(v);
      if (a > max) max = a;
    }
  }
  out.rms = nFree > 0 ? Math.sqrt(sum / nFree) : 0;
  out.max = max;
}

/**
 * RDKit's `ForceFieldsHelper::calcGradient`: the gradient handed to the minimiser is scaled by 0.1,
 * and scaled down further when its largest component still exceeds 10. Returns the last scale factor.
 */
function scaleGradient(g: Float64Array, scaled: Float64Array): number {
  let gradScale = 0.1;
  let maxGrad = -1e8;
  const dim = g.length;
  for (let i = 0; i < dim; i++) {
    const v = g[i] * gradScale;
    scaled[i] = v;
    const a = Math.abs(v);
    if (a > maxGrad) maxGrad = a;
  }
  if (maxGrad > 10.0) {
    while (maxGrad * gradScale > 10.0) gradScale *= 0.5;
    for (let i = 0; i < dim; i++) scaled[i] *= gradScale;
  }
  return gradScale;
}

/*
 * Dense inverse Hessian. It is symmetric: RDKit stores and reads all of it, here only the upper
 * triangle (column >= row, row-major in a dim x dim array) is kept. That halves the memory traffic
 * and avoids RDKit's cache-hostile mirror writes. Every component of a product H.v is still
 * accumulated over the columns 0..dim-1 in ascending order, exactly as in RDKit's row-wise loops,
 * so the numbers are bit for bit those of the full-matrix version.
 *
 * These loops are separate small functions on purpose: `minimize` is entered once per optimisation,
 * and a JavaScript engine optimises a hot loop far better in a function that is called every step
 * than in the middle of one long-running call.
 */

/** out = H.v */
function symmetricProduct(h: Float64Array, v: Float64Array, out: Float64Array, dim: number): void {
  out.fill(0.0);
  for (let i = 0; i < dim; i++) {
    const row = i * dim;
    const vi = v[i];
    let acc = out[i] + h[row + i] * vi;
    for (let j = i + 1; j < dim; j++) {
      const hij = h[row + j];
      acc += hij * v[j];
      out[j] += hij * vi;
    }
    out[i] = acc;
  }
}

/** out = -H.v (accumulated by subtraction, as RDKit does) */
function negativeSymmetricProduct(h: Float64Array, v: Float64Array, out: Float64Array, dim: number): void {
  out.fill(0.0);
  for (let i = 0; i < dim; i++) {
    const row = i * dim;
    const vi = v[i];
    let acc = out[i] - h[row + i] * vi;
    for (let j = i + 1; j < dim; j++) {
      const hij = h[row + j];
      acc -= hij * v[j];
      out[j] -= hij * vi;
    }
    out[i] = acc;
  }
}

/** The BFGS update of the inverse Hessian (upper triangle). */
function updateInverseHessian(
  h: Float64Array,
  xi: Float64Array,
  hessDGrad: Float64Array,
  dGrad: Float64Array,
  fac: number,
  fad: number,
  fae: number,
  dim: number,
): void {
  for (let i = 0; i < dim; i++) {
    const itab = i * dim;
    const pxi = fac * xi[i];
    const hdgi = fad * hessDGrad[i];
    const dgi = fae * dGrad[i];
    for (let j = i; j < dim; j++) {
      h[itab + j] = h[itab + j] + pxi * xi[j] - hdgi * hessDGrad[j] + dgi * dGrad[j];
    }
  }
}

/**
 * Minimises `objective` starting from `x`, which is updated in place and always holds the best
 * geometry found. `g` receives the gradient at the final geometry (frozen atoms zeroed).
 */
export function minimize(objective: Objective, x: Float64Array, g: Float64Array, controls: MinimizeControls): MinimizeOutcome {
  const dim = x.length;
  const { frozen, gradientTolerance, energyTolerance, maxSteps, onStep } = controls;
  const stats: GradientStats = { rms: 0, max: 0 };

  let energy = objective(x, g);
  maskAndMeasure(g, frozen, stats);
  if (!Number.isFinite(energy)) {
    // Nothing sensible can be done from a geometry whose energy is undefined (coincident bonded atoms).
    return { status: 'stalled', steps: 0, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts: 0 };
  }
  if (stats.rms <= gradientTolerance) {
    return { status: 'converged', steps: 0, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts: 0 };
  }
  if (maxSteps <= 0) {
    return { status: 'step-limit', steps: 0, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts: 0 };
  }

  const dense = dim <= DENSE_BFGS_MAX_DIMENSION && controls.limitedMemory !== true;
  const grad = new Float64Array(dim); // scaled gradient, as RDKit's minimiser sees it
  const dGrad = new Float64Array(dim);
  const hessDGrad = new Float64Array(dim);
  const xi = new Float64Array(dim);
  const newPos = new Float64Array(dim);
  const gTrial = new Float64Array(dim);
  const trialStats: GradientStats = { rms: 0, max: 0 };
  const invHessian = dense ? new Float64Array(dim * dim) : null;

  // limited-memory storage
  const memory = dense ? 0 : LBFGS_MEMORY;
  const sHist = dense ? null : new Float64Array(memory * dim);
  const yHist = dense ? null : new Float64Array(memory * dim);
  const rhoHist = new Float64Array(memory);
  const alphaHist = new Float64Array(memory);
  let histCount = 0;
  let histHead = 0; // index of the slot the next pair goes into

  const resetHessian = (): void => {
    if (invHessian !== null) {
      invHessian.fill(0);
      for (let i = 0; i < dim; i++) invHessian[i * dim + i] = 1.0;
    }
    histCount = 0;
    histHead = 0;
    for (let i = 0; i < dim; i++) xi[i] = -grad[i];
  };

  scaleGradient(g, grad);
  resetHessian();
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += x[i] * x[i];
  const maxStep = MAXSTEP * Math.max(Math.sqrt(sum), dim);

  let steps = 0;
  let restarts = 0;
  let freshHessian = true; // no update since the last reset: xi is the steepest-descent direction
  let failuresInARow = 0;
  let bestRms = stats.rms;
  let sinceProgress = 0;

  while (steps < maxSteps) {
    // ------------------------------------------------------------------ line search (linearSearch)
    let resCode = -1;
    let newVal = energy;
    {
      // get the length of the direction vector; rescale if we're trying to move too far
      let len = 0;
      for (let i = 0; i < dim; i++) len += xi[i] * xi[i];
      len = Math.sqrt(len);
      if (len > maxStep) {
        const f = maxStep / len;
        for (let i = 0; i < dim; i++) xi[i] *= f;
      }
      // make sure our direction has at least some component along -grad
      let slope = 0;
      let trueSlope = 0;
      for (let i = 0; i < dim; i++) {
        slope += xi[i] * grad[i];
        trueSlope += xi[i] * g[i];
      }
      if (slope < 0.0) {
        let test = 0;
        for (let i = 0; i < dim; i++) {
          const temp = Math.abs(xi[i]) / Math.max(Math.abs(x[i]), 1.0);
          if (temp > test) test = temp;
        }
        let lambdaMin = MOVETOL / test;
        let rescued = false;
        const noise = ENERGY_NOISE * Math.max(Math.abs(energy), 1.0);
        let lambda = 1.0;
        let lambda2 = 0;
        let val2 = 0;
        let haveTwo = false;
        resCode = 1;
        for (let it = 0; it < MAX_ITER_LINEAR_SEARCH; it++) {
          if (lambda < lambdaMin) {
            // The step got too small for RDKit, which stops here. If that would leave the gradient
            // above the tolerance, keep backtracking: a descent direction always has a lower
            // energy close enough to the starting point.
            if (rescued || stats.rms <= gradientTolerance) break;
            rescued = true;
            lambdaMin = RESCUE_MOVETOL / test;
            if (lambda < lambdaMin) break;
          }
          for (let i = 0; i < dim; i++) newPos[i] = x[i] + lambda * xi[i];
          newVal = objective(newPos, gTrial);
          if (!Number.isFinite(newVal)) {
            // an undefined or overflowing energy: back off hard and forget the interpolation history
            lambda *= 0.1;
            haveTwo = false;
            continue;
          }
          if (newVal - energy <= FUNCTOL * lambda * slope) {
            // Armijo sufficient-decrease condition satisfied; accept the step
            resCode = 0;
            break;
          }
          if (Math.abs(newVal - energy) <= noise) {
            // The energies cannot be told apart at double precision. Accept the step if the
            // gradient along the search direction says it did not overshoot. (Frozen coordinates
            // never contribute: the direction is zero there.)
            let trialSlope = 0;
            for (let i = 0; i < dim; i++) trialSlope += gTrial[i] * xi[i];
            if (trialSlope <= -0.8 * trueSlope) {
              resCode = 0;
              break;
            }
          }
          // if we made it this far, we need to backtrack:
          let tmpLambda: number;
          if (!haveTwo) {
            // Quadratic model: only one prior function value available
            tmpLambda = -slope / (2.0 * (newVal - energy - slope));
          } else {
            const rhs1 = newVal - energy - lambda * slope;
            const rhs2 = val2 - energy - lambda2 * slope;
            const a = (rhs1 / (lambda * lambda) - rhs2 / (lambda2 * lambda2)) / (lambda - lambda2);
            const b = ((-lambda2 * rhs1) / (lambda * lambda) + (lambda * rhs2) / (lambda2 * lambda2)) / (lambda - lambda2);
            if (a === 0.0) {
              tmpLambda = -slope / (2.0 * b);
            } else {
              const disc = b * b - 3 * a * slope;
              if (disc < 0.0) {
                tmpLambda = 0.5 * lambda;
              } else if (b <= 0.0) {
                tmpLambda = (-b + Math.sqrt(disc)) / (3.0 * a);
              } else {
                tmpLambda = -slope / (b + Math.sqrt(disc));
              }
            }
            if (tmpLambda > 0.5 * lambda) tmpLambda = 0.5 * lambda;
          }
          lambda2 = lambda;
          val2 = newVal;
          haveTwo = true;
          // std::max(tmpLambda, 0.1 * lambda), which also keeps a NaN out
          lambda = tmpLambda > 0.1 * lambda ? tmpLambda : 0.1 * lambda;
        }
      }
    }

    if (resCode !== 0) {
      // -1: the direction is not a descent direction (RDKit raises an invariant violation).
      //  1: no lower energy was found along it (RDKit reports convergence).
      // If the gradient criterion already holds, no further energy change is possible and the run
      // has converged. Otherwise forget the curvature information and retry along the steepest
      // descent; if even that fails, the search has gone as far as double precision allows.
      if (stats.rms <= gradientTolerance) {
        return { status: 'converged', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
      }
      failuresInARow++;
      if (freshHessian || failuresInARow > 2) {
        return { status: 'stalled', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
      }
      restarts++;
      resetHessian();
      freshHessian = true;
      continue;
    }
    failuresInARow = 0;

    // ------------------------------------------------------------------ accept the step
    const previousEnergy = energy;
    energy = newVal;
    for (let i = 0; i < dim; i++) {
      xi[i] = newPos[i] - x[i];
      x[i] = newPos[i];
      dGrad[i] = grad[i];
    }
    maskAndMeasure(gTrial, frozen, trialStats);
    g.set(gTrial);
    stats.rms = trialStats.rms;
    stats.max = trialStats.max;
    steps++;

    if (onStep !== undefined && !onStep(energy, stats.rms, stats.max)) {
      return { status: 'cancelled', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
    }
    if (stats.rms <= gradientTolerance && Math.abs(previousEnergy - energy) <= energyTolerance) {
      return { status: 'converged', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
    }

    // progress bookkeeping: either the gradient or the energy must keep improving
    if (stats.rms < 0.999 * bestRms || previousEnergy - energy > ENERGY_NOISE * Math.max(Math.abs(energy), 1.0)) {
      sinceProgress = 0;
    } else {
      sinceProgress++;
      if (sinceProgress >= STALL_STEPS) {
        return { status: 'stalled', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
      }
    }
    if (stats.rms < bestRms) bestRms = stats.rms;

    // ------------------------------------------------------------------ quasi-Newton update
    scaleGradient(g, grad);
    for (let i = 0; i < dim; i++) dGrad[i] = grad[i] - dGrad[i];

    if (invHessian !== null) {
      // BFGS inverse Hessian update (BFGSOpt::minimize, scalar path).
      symmetricProduct(invHessian, dGrad, hessDGrad, dim);
      let fac = 0;
      let fae = 0;
      let sumDGrad = 0;
      let sumXi = 0;
      for (let i = 0; i < dim; i++) {
        fac += dGrad[i] * xi[i];
        fae += dGrad[i] * hessDGrad[i];
        sumDGrad += dGrad[i] * dGrad[i];
        sumXi += xi[i] * xi[i];
      }
      if (fac > Math.sqrt(EPS * sumDGrad * sumXi)) {
        fac = 1.0 / fac;
        const fad = 1.0 / fae;
        for (let i = 0; i < dim; i++) dGrad[i] = fac * xi[i] - fad * hessDGrad[i];
        updateInverseHessian(invHessian, xi, hessDGrad, dGrad, fac, fad, fae, dim);
      }
      // the new direction: xi = -H.grad
      negativeSymmetricProduct(invHessian, grad, xi, dim);
    } else {
      // limited-memory BFGS: store the pair (s, y) = (xi, dGrad) and run the two-loop recursion
      const S = sHist as Float64Array;
      const Y = yHist as Float64Array;
      let sy = 0;
      let yy = 0;
      let ss = 0;
      for (let i = 0; i < dim; i++) {
        sy += xi[i] * dGrad[i];
        yy += dGrad[i] * dGrad[i];
        ss += xi[i] * xi[i];
      }
      if (sy > Math.sqrt(EPS * yy * ss)) {
        const base = histHead * dim;
        for (let i = 0; i < dim; i++) {
          S[base + i] = xi[i];
          Y[base + i] = dGrad[i];
        }
        rhoHist[histHead] = 1.0 / sy;
        histHead = (histHead + 1) % memory;
        if (histCount < memory) histCount++;
      }
      for (let i = 0; i < dim; i++) xi[i] = -grad[i];
      let gamma = 1.0;
      for (let c = 0; c < histCount; c++) {
        const slot = (histHead - 1 - c + 2 * memory) % memory;
        const base = slot * dim;
        let a = 0;
        for (let i = 0; i < dim; i++) a += S[base + i] * xi[i];
        a *= rhoHist[slot];
        alphaHist[slot] = a;
        for (let i = 0; i < dim; i++) xi[i] -= a * Y[base + i];
        if (c === 0) {
          let ysq = 0;
          for (let i = 0; i < dim; i++) ysq += Y[base + i] * Y[base + i];
          gamma = 1.0 / (rhoHist[slot] * ysq);
        }
      }
      if (histCount > 0) for (let i = 0; i < dim; i++) xi[i] *= gamma;
      for (let c = histCount - 1; c >= 0; c--) {
        const slot = (histHead - 1 - c + 2 * memory) % memory;
        const base = slot * dim;
        let b = 0;
        for (let i = 0; i < dim; i++) b += Y[base + i] * xi[i];
        b *= rhoHist[slot];
        const f = alphaHist[slot] - b;
        for (let i = 0; i < dim; i++) xi[i] += f * S[base + i];
      }
    }
    freshHessian = false;
  }

  return { status: 'step-limit', steps, energy, rmsGradient: stats.rms, maxGradient: stats.max, restarts };
}

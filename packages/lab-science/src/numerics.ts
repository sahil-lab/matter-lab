export const ROOT_PH_TOLERANCE = 1e-12;
export const CHARGE_RESIDUAL_TOLERANCE_MOL_L = 1e-12;

export interface BracketedRoot {
  readonly converged: boolean;
  readonly value: number;
  readonly residual: number;
  readonly lower: number;
  readonly upper: number;
  readonly iterations: number;
  readonly evaluations: number;
}

export function stableSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of [...values].sort((a, b) => Math.abs(a) - Math.abs(b))) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

export function bisect(
  evaluate: (value: number) => number,
  lower: number,
  upper: number,
  tolerance: number,
  maximumIterations = 96,
): BracketedRoot {
  let lowerResidual = evaluate(lower);
  const upperResidual = evaluate(upper);
  let evaluations = 2;
  const failed = (value: number, residual: number, iterations: number): BracketedRoot => ({
    converged: false, value, residual, lower, upper, iterations, evaluations,
  });
  if (!Number.isFinite(lowerResidual) || !Number.isFinite(upperResidual)
    || !(lower <= upper) || !(tolerance > 0)) {
    return failed(lower, lowerResidual, 0);
  }
  if (lowerResidual === 0) {
    return { converged: true, value: lower, residual: 0, lower, upper: lower, iterations: 0, evaluations };
  }
  if (upperResidual === 0) {
    return { converged: true, value: upper, residual: 0, lower: upper, upper, iterations: 0, evaluations };
  }
  if ((lowerResidual > 0) === (upperResidual > 0)) return failed(lower, lowerResidual, 0);
  for (let iterations = 1; iterations <= maximumIterations; iterations++) {
    const value = lower + (upper - lower) / 2;
    const residual = evaluate(value);
    evaluations++;
    if (!Number.isFinite(residual)) return failed(value, residual, iterations);
    if (residual === 0 || upper - lower <= tolerance) {
      return {
        converged: true, value, residual,
        lower: residual === 0 ? value : lower,
        upper: residual === 0 ? value : upper,
        iterations, evaluations,
      };
    }
    if ((residual > 0) === (lowerResidual > 0)) {
      lower = value;
      lowerResidual = residual;
    } else {
      upper = value;
    }
  }
  const value = lower + (upper - lower) / 2;
  const residual = evaluate(value);
  evaluations++;
  return failed(value, residual, maximumIterations);
}

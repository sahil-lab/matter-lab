/**
 * Boys function F_m(T) = integral_0^1 t^(2m) exp(-T t^2) dt, the one-dimensional integral every
 * Coulomb-type integral over Gaussian functions reduces to (S. F. Boys, Proc. R. Soc. A 200, 542
 * (1950)).
 *
 * Evaluation, accurate to a few units in 1e-14 (relative) for m <= BOYS_MAX_ORDER and all T >= 0;
 * the tests compare against 40-digit mpmath values:
 *
 *  - T < 36: seven-term Taylor expansion about the nearest point of a table with spacing 0.05, using
 *    dF_m/dT = -F_(m+1). The truncation error is below F_(m+7) * 0.025^7 / 7! < 1e-16.
 *  - T >= 36: F_0(T) = sqrt(pi/T)/2 * erf(sqrt(T)) with erf = 1 to within 2e-17, followed by the
 *    upward recursion F_(m+1) = ((2m+1) F_m - exp(-T)) / (2T), which is stable for T > m + 1/2.
 *
 * The table itself is built once from the everywhere-convergent series
 * F_m(T) = exp(-T) sum_k (2T)^k / ((2m+1)(2m+3)...(2m+2k+1)) for the highest order (all terms are
 * positive, so nothing cancels) and the downward recursion F_(m-1) = (2T F_m + exp(-T)) / (2m-1).
 */

/** Highest order m for which `boys` may be called. */
export const BOYS_MAX_ORDER = 8;

const TAYLOR_TERMS = 7;
const STEP = 0.05;
const INV_STEP = 20;
const T_SWITCH = 36;
const COLS = BOYS_MAX_ORDER + TAYLOR_TERMS;
const ROWS = T_SWITCH * INV_STEP + 2;
const HALF_SQRT_PI = 0.5 * Math.sqrt(Math.PI);

function buildTable(): Float64Array {
  const table = new Float64Array(ROWS * COLS);
  const top = COLS - 1;
  for (let i = 0; i < ROWS; i++) {
    const t = i * STEP;
    const expMinusT = Math.exp(-t);
    let term = 1 / (2 * top + 1);
    let sum = term;
    for (let k = 1; k < 2000; k++) {
      term *= (2 * t) / (2 * top + 2 * k + 1);
      sum += term;
      if (term < 1e-18 * sum) break;
    }
    let f = expMinusT * sum;
    table[i * COLS + top] = f;
    for (let m = top; m > 0; m--) {
      f = (2 * t * f + expMinusT) / (2 * m - 1);
      table[i * COLS + m - 1] = f;
    }
  }
  return table;
}

const TABLE = /* @__PURE__ */ buildTable();

/**
 * Writes F_0(T) .. F_mMax(T) into `out[0..mMax]`. `t` must be >= 0 and `mMax` <= BOYS_MAX_ORDER;
 * neither is checked here because this sits in the innermost integral loops.
 */
export function boys(mMax: number, t: number, out: Float64Array): void {
  if (t < T_SWITCH) {
    const i = (t * INV_STEP + 0.5) | 0;
    const d = i * STEP - t;
    const d2 = d * 0.5;
    const d3 = d * (1 / 3);
    const d4 = d * 0.25;
    const d5 = d * 0.2;
    const d6 = d * (1 / 6);
    let o = i * COLS;
    for (let m = 0; m <= mMax; m++, o++) {
      out[m] =
        TABLE[o] +
        d * (TABLE[o + 1] + d2 * (TABLE[o + 2] + d3 * (TABLE[o + 3] + d4 * (TABLE[o + 4] + d5 * (TABLE[o + 5] + d6 * TABLE[o + 6])))));
    }
    return;
  }
  const expMinusT = t < 80 ? Math.exp(-t) : 0;
  const inv2t = 0.5 / t;
  let f = HALF_SQRT_PI / Math.sqrt(t);
  out[0] = f;
  for (let m = 0; m < mMax; m++) {
    f = ((2 * m + 1) * f - expMinusT) * inv2t;
    out[m + 1] = f;
  }
}

/** F_0(T) alone, for the innermost loop of (ss|ss)-type integrals. Same algorithm as `boys`. */
export function boys0(t: number): number {
  if (t < T_SWITCH) {
    const i = (t * INV_STEP + 0.5) | 0;
    const d = i * STEP - t;
    const o = i * COLS;
    return (
      TABLE[o] +
      d * (TABLE[o + 1] + d * 0.5 * (TABLE[o + 2] + d * (1 / 3) * (TABLE[o + 3] + d * 0.25 * (TABLE[o + 4] + d * 0.2 * (TABLE[o + 5] + d * (1 / 6) * TABLE[o + 6])))))
    );
  }
  return HALF_SQRT_PI / Math.sqrt(t);
}

/** F_m(T) for a single order, with argument checks; for code that is not performance critical. */
export function boysSingle(m: number, t: number): number {
  if (!Number.isInteger(m) || m < 0 || m > BOYS_MAX_ORDER) throw new RangeError(`Boys function order ${m} is outside 0..${BOYS_MAX_ORDER}.`);
  if (!(t >= 0)) throw new RangeError(`Boys function argument ${t} must be non-negative.`);
  const out = new Float64Array(m + 1);
  boys(m, t, out);
  return out[m];
}

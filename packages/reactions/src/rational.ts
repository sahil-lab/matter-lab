/**
 * Exact rational arithmetic on BigInt, used by the equation balancer so that no coefficient is ever
 * decided by floating-point rounding.
 */
export interface Fraction {
  /** Numerator; carries the sign. */
  readonly n: bigint;
  /** Denominator; always positive, and coprime with the numerator. */
  readonly d: bigint;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

export function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return abs(a * b) / gcd(a, b);
}

export function fraction(numerator: bigint | number, denominator: bigint | number = 1n): Fraction {
  const n = typeof numerator === 'bigint' ? numerator : toBigInt(numerator);
  const d = typeof denominator === 'bigint' ? denominator : toBigInt(denominator);
  if (d === 0n) throw new RangeError('A fraction cannot have a zero denominator.');
  if (n === 0n) return ZERO;
  const g = gcd(n, d);
  const sign = d < 0n ? -1n : 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
}

function toBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${value} is not an integer that can be represented exactly.`);
  return BigInt(value);
}

export const ZERO: Fraction = { n: 0n, d: 1n };
export const ONE: Fraction = { n: 1n, d: 1n };

export const add = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a: Fraction, b: Fraction): Fraction => fraction(a.n * b.n, a.d * b.d);
export const negate = (a: Fraction): Fraction => ({ n: -a.n, d: a.d });

export function divide(a: Fraction, b: Fraction): Fraction {
  if (b.n === 0n) throw new RangeError('Division by zero.');
  return fraction(a.n * b.d, a.d * b.n);
}

export const isZero = (a: Fraction): boolean => a.n === 0n;
/** -1, 0 or 1. */
export const signOf = (a: Fraction): -1 | 0 | 1 => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0);
/** Negative, zero or positive as a is less than, equal to or greater than b. */
export const compare = (a: Fraction, b: Fraction): number => signOf(subtract(a, b));

export function toNumber(a: Fraction): number {
  return Number(a.n) / Number(a.d);
}

/**
 * Reads a non-negative decimal or fraction literal exactly: "2", "0.5", "3/2", "1.25/2".
 * Returns `undefined` when the text is not such a literal.
 */
export function parseRational(text: string): Fraction | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:\/(\d+)(?:\.(\d+))?)?$/.exec(text.trim());
  if (!m) return undefined;
  const decimal = (whole: string, frac: string | undefined): Fraction =>
    frac === undefined ? fraction(BigInt(whole)) : fraction(BigInt(whole + frac), 10n ** BigInt(frac.length));
  const top = decimal(m[1]!, m[2]);
  if (m[3] === undefined) return top;
  const bottom = decimal(m[3], m[4]);
  if (isZero(bottom)) return undefined;
  return divide(top, bottom);
}

/**
 * Smallest positive integers proportional to the given rationals, which must all have the same sign
 * and not all be zero: [1/2, 1, 3/2] -> [1, 2, 3].
 */
export function toSmallestIntegers(values: readonly Fraction[]): bigint[] {
  let denominator = 1n;
  for (const v of values) denominator = lcm(denominator, v.d);
  const scaled = values.map((v) => (v.n * denominator) / v.d);
  let divisor = 0n;
  for (const s of scaled) divisor = gcd(divisor, s);
  if (divisor === 0n) throw new RangeError('All values are zero.');
  const sign = scaled.some((s) => s < 0n) ? -1n : 1n;
  return scaled.map((s) => (sign * s) / divisor);
}

/**
 * Best rational approximation p/q of x with q <= maxDenominator (continued fractions). Used only to print
 * a coefficient such as 0.5 as "1/2"; never to decide a coefficient.
 */
export function approximateFraction(x: number, maxDenominator = 1000): Fraction | undefined {
  if (!Number.isFinite(x) || x < 0) return undefined;
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let rest = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(rest);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDenominator) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    const remainder = rest - a;
    if (remainder < 1e-12) break;
    rest = 1 / remainder;
  }
  if (k1 === 0) return undefined;
  if (Math.abs(h1 / k1 - x) > 1e-12 * Math.max(1, Math.abs(x))) return undefined;
  return fraction(h1, k1);
}

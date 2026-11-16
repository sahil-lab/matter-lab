import { describe, expect, it } from 'vitest';
import { boys, boys0, BOYS_MAX_ORDER, boysSingle } from '../src/math/boys';
import { readJsonFixture } from './helpers/crawford';
import { validationReporter } from './helpers/report';

const record = validationReporter('boys');

interface BoysFixture {
  versions: { mpmath: string; python: string };
  maxOrder: number;
  t: number[];
  values: string[][];
}

/** Nodes and weights of n-point Gauss-Legendre quadrature on [-1, 1], by Newton iteration on P_n. */
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const legendre = (x: number): [number, number] => {
    let p0 = 1;
    let p1 = x;
    for (let k = 2; k <= n; k++) {
      const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
      p0 = p1;
      p1 = p2;
    }
    return [p1, (n * (x * p1 - p0)) / (x * x - 1)];
  };
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let k = 1; k <= n; k++) {
    let x = Math.cos((Math.PI * (k - 0.25)) / (n + 0.5));
    for (let i = 0; i < 50; i++) {
      const [p, dp] = legendre(x);
      const step = p / dp;
      x -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * legendre(x)[1] ** 2));
  }
  return { nodes, weights };
}

const GAUSS = gaussLegendre(16);

/** Composite 16-point Gauss-Legendre quadrature of t^(2m) exp(-T t^2) on [0, 1], independent of the fixture. */
function quadrature(m: number, t: number): number {
  // The integrand has width ~1/sqrt(T): use panels on [0, edge] and one more for the rest.
  const edge = t > 64 ? 8 / Math.sqrt(t) : 1;
  const panels = 64;
  let sum = 0;
  const integrate = (a: number, b: number): void => {
    const half = (b - a) / 2;
    const mid = (a + b) / 2;
    for (let k = 0; k < GAUSS.nodes.length; k++) {
      const u = mid + half * GAUSS.nodes[k];
      sum += GAUSS.weights[k] * half * u ** (2 * m) * Math.exp(-t * u * u);
    }
  };
  for (let i = 0; i < panels; i++) integrate((edge * i) / panels, (edge * (i + 1)) / panels);
  if (edge < 1) integrate(edge, 1);
  return sum;
}

describe('Boys function', () => {
  const fixture = readJsonFixture<BoysFixture>('boys_reference.json');

  it('matches 40-digit mpmath values to 1e-12 over the whole range for m = 0..8', () => {
    expect(fixture.maxOrder).toBe(BOYS_MAX_ORDER);
    expect(fixture.t.length).toBeGreaterThan(400);
    const out = new Float64Array(BOYS_MAX_ORDER + 1);
    let worstRelative = 0;
    let worstAbsolute = 0;
    let worstAt = '';
    fixture.t.forEach((t, index) => {
      boys(BOYS_MAX_ORDER, t, out);
      for (let m = 0; m <= BOYS_MAX_ORDER; m++) {
        const reference = Number(fixture.values[index][m]);
        const absolute = Math.abs(out[m] - reference);
        const relative = absolute / reference;
        worstAbsolute = Math.max(worstAbsolute, absolute);
        if (relative > worstRelative) {
          worstRelative = relative;
          worstAt = `m=${m}, T=${t}`;
        }
      }
    });
    record('mpmath', { mpmath: fixture.versions.mpmath, arguments: fixture.t.length, orders: BOYS_MAX_ORDER + 1, worstRelative, worstAbsolute, worstAt, range: [fixture.t[0], fixture.t[fixture.t.length - 1]] });
    expect(worstAbsolute).toBeLessThan(1e-13);
    expect(worstRelative).toBeLessThan(1e-12);
  });

  it('gives the same values when fewer orders are requested, and through the single-order helpers', () => {
    const full = new Float64Array(BOYS_MAX_ORDER + 1);
    const partial = new Float64Array(BOYS_MAX_ORDER + 1);
    for (const t of [0, 0.013, 1.7, 12.5, 35.99, 36, 36.01, 59, 300]) {
      boys(BOYS_MAX_ORDER, t, full);
      for (let mMax = 0; mMax <= BOYS_MAX_ORDER; mMax++) {
        boys(mMax, t, partial);
        for (let m = 0; m <= mMax; m++) expect(partial[m]).toBe(full[m]);
        expect(boysSingle(mMax, t)).toBe(full[mMax]);
      }
      expect(boys0(t)).toBe(full[0]);
    }
  });

  it('agrees with direct numerical quadrature of the defining integral', () => {
    let worst = 0;
    for (const t of [0, 0.4, 3, 11.1, 29.5, 35.99, 36.01, 47, 120, 900]) {
      for (const m of [0, 1, 2, 4, 8]) worst = Math.max(worst, Math.abs(boysSingle(m, t) - quadrature(m, t)) / boysSingle(m, t));
    }
    expect(worst).toBeLessThan(1e-11);
  });

  it('is continuous across the switch between table and asymptotic formula and satisfies its recurrence', () => {
    const below = new Float64Array(BOYS_MAX_ORDER + 1);
    const above = new Float64Array(BOYS_MAX_ORDER + 1);
    boys(BOYS_MAX_ORDER, 36 - 1e-9, below);
    boys(BOYS_MAX_ORDER, 36 + 1e-9, above);
    for (let m = 0; m <= BOYS_MAX_ORDER; m++) expect(Math.abs(below[m] - above[m]) / above[m]).toBeLessThan(1e-9);
    // F_m(T) = (2 T F_(m+1)(T) + exp(-T)) / (2m + 1)
    const out = new Float64Array(BOYS_MAX_ORDER + 1);
    for (const t of [0.02, 0.9, 7.3, 21, 35.5, 36.5, 70]) {
      boys(BOYS_MAX_ORDER, t, out);
      for (let m = 0; m < BOYS_MAX_ORDER; m++) {
        const expected = (2 * t * out[m + 1] + Math.exp(-t)) / (2 * m + 1);
        expect(Math.abs(out[m] - expected) / out[m]).toBeLessThan(1e-12);
      }
    }
  });

  it('has the exact limits F_m(0) = 1/(2m+1) and F_0(T) -> sqrt(pi/T)/2', () => {
    for (let m = 0; m <= BOYS_MAX_ORDER; m++) expect(boysSingle(m, 0)).toBeCloseTo(1 / (2 * m + 1), 15);
    expect(boysSingle(0, 1e6)).toBeCloseTo(0.5 * Math.sqrt(Math.PI / 1e6), 18);
  });

  it('rejects arguments outside its domain in the checked helper', () => {
    expect(() => boysSingle(BOYS_MAX_ORDER + 1, 1)).toThrow(RangeError);
    expect(() => boysSingle(-1, 1)).toThrow(RangeError);
    expect(() => boysSingle(0, -1)).toThrow(RangeError);
    expect(() => boysSingle(0, Number.NaN)).toThrow(RangeError);
  });
});

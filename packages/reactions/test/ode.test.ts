import { describe, expect, it } from 'vitest';
import { integrateOde } from '../src';
import type { OdeResult } from '../src';

type Rhs = (t: number, y: Float64Array, dydt: Float64Array) => void;

const decay: Rhs = (_t, y, d) => {
  d[0] = -y[0]!;
};
const oscillator: Rhs = (_t, y, d) => {
  d[0] = y[1]!;
  d[1] = -y[0]!;
};

/** Largest absolute difference between the computed outputs and an exact solution. */
function maxError(result: OdeResult, exact: (t: number) => number[]): number {
  let worst = 0;
  result.times.forEach((t, i) => {
    exact(t).forEach((value, component) => {
      worst = Math.max(worst, Math.abs(result.states[i]![component]! - value));
    });
  });
  return worst;
}

describe('integrateOde on problems with a known solution', () => {
  it('integrates exponential decay, y′ = −y, to within a small multiple of the tolerance', () => {
    const result = integrateOde(decay, Float64Array.of(1), 0, 5, { rtol: 1e-10, atol: 1e-13, outputPoints: 51 });
    expect(result.completed).toBe(true);
    expect(result.stopReason).toBeUndefined();
    expect(result.times).toHaveLength(51);
    expect(result.states).toHaveLength(51);
    // Requested: 1e-10 per step. Asserted: 1e-9 over the whole interval, at every output point.
    expect(maxError(result, (t) => [Math.exp(-t)])).toBeLessThan(1e-9);
    expect(result.tEnd).toBe(5);
    expect(result.finalState[0]).toBeCloseTo(Math.exp(-5), 10);
  });

  it('integrates the harmonic oscillator over ten periods', () => {
    const result = integrateOde(oscillator, Float64Array.of(1, 0), 0, 20 * Math.PI, { rtol: 1e-10, atol: 1e-10, outputPoints: 401 });
    expect(result.completed).toBe(true);
    // Requested: 1e-10 per step. Asserted: 1e-7 in position and velocity after ten periods.
    expect(maxError(result, (t) => [Math.cos(t), -Math.sin(t)])).toBeLessThan(1e-7);
    // The energy x² + v² is not conserved exactly by the method, but it must not drift visibly.
    const energyDrift = Math.max(...result.states.map((s) => Math.abs(s[0]! ** 2 + s[1]! ** 2 - 1)));
    expect(energyDrift).toBeLessThan(1e-7);
  });

  it('integrates a nonlinear equation, the logistic equation', () => {
    const logistic: Rhs = (_t, y, d) => {
      d[0] = y[0]! * (1 - y[0]!);
    };
    const result = integrateOde(logistic, Float64Array.of(0.1), 0, 10, { rtol: 1e-9, atol: 1e-12, outputPoints: 101 });
    expect(result.completed).toBe(true);
    expect(maxError(result, (t) => [1 / (1 + 9 * Math.exp(-t))])).toBeLessThan(1e-7);
  });

  it('integrates an equation with an explicit time dependence', () => {
    const forced: Rhs = (t, _y, d) => {
      d[0] = Math.cos(t);
    };
    const result = integrateOde(forced, Float64Array.of(0), 0, 12, { rtol: 1e-10, atol: 1e-12, outputPoints: 121 });
    expect(maxError(result, (t) => [Math.sin(t)])).toBeLessThan(1e-9);
  });

  it('is exact for polynomials up to the order of the method, at the steps and in between', () => {
    // A fifth-order method integrates y′ = p(t) exactly when y has degree 5 or less, and its fourth-order
    // dense output reproduces y of degree 4 or less between the steps. Rounding is all that remains.
    const quartic: Rhs = (t, _y, d) => {
      d[0] = 4 * t ** 3 - 3 * t ** 2 + 2 * t - 1;
    };
    const dense = integrateOde(quartic, Float64Array.of(0), 0, 2, { rtol: 1e-3, atol: 1e-3, outputPoints: 41 });
    expect(dense.steps).toBeLessThan(20);
    expect(maxError(dense, (t) => [t ** 4 - t ** 3 + t ** 2 - t])).toBeLessThan(1e-12);

    const quintic: Rhs = (t, _y, d) => {
      d[0] = 5 * t ** 4;
    };
    const atSteps = integrateOde(quintic, Float64Array.of(0), 0, 2, { rtol: 1e-3, atol: 1e-3 });
    expect(maxError(atSteps, (t) => [t ** 5])).toBeLessThan(1e-12);
  });

  it('becomes more accurate as the tolerance is tightened, roughly in proportion', () => {
    const errors = [1e-4, 1e-6, 1e-8, 1e-10].map((rtol) => {
      const result = integrateOde(decay, Float64Array.of(1), 0, 5, { rtol, atol: rtol * 1e-3, outputPoints: 51 });
      return { rtol, error: maxError(result, (t) => [Math.exp(-t)]), steps: result.steps };
    });
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!.error).toBeLessThan(errors[i - 1]!.error / 10);
      expect(errors[i]!.steps).toBeGreaterThan(errors[i - 1]!.steps);
    }
    for (const { rtol, error } of errors) expect(error).toBeLessThan(10 * rtol);
  });

  it('converges with the fifth order of the method', () => {
    // For a method of order p the global error falls as (number of steps)^-p. Measured on the oscillator
    // between three tolerances, the slope must be about 5: a wrong coefficient in the tableau lowers it.
    const runs = [1e-6, 1e-8, 1e-10].map((rtol) => {
      const result = integrateOde(oscillator, Float64Array.of(1, 0), 0, 20 * Math.PI, { rtol, atol: rtol, outputPoints: 401 });
      return { steps: result.steps, error: maxError(result, (t) => [Math.cos(t), -Math.sin(t)]) };
    });
    for (let i = 1; i < runs.length; i++) {
      const order = Math.log(runs[i - 1]!.error / runs[i]!.error) / Math.log(runs[i]!.steps / runs[i - 1]!.steps);
      expect(order).toBeGreaterThan(4.5);
      expect(order).toBeLessThan(5.5);
    }
  });

  it('integrates backwards in time', () => {
    const start = Math.exp(-5);
    const result = integrateOde(decay, Float64Array.of(start), 5, 0, { rtol: 1e-10, atol: 1e-14, outputPoints: 6 });
    expect(result.completed).toBe(true);
    expect(Array.from(result.times)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(maxError(result, (t) => [Math.exp(-t)])).toBeLessThan(1e-8);
  });

  it('preserves linear invariants to rounding error', () => {
    // A -> B -> C with rate constants 3 and 1: the total amount is constant.
    const chain: Rhs = (_t, y, d) => {
      d[0] = -3 * y[0]!;
      d[1] = 3 * y[0]! - y[1]!;
      d[2] = y[1]!;
    };
    const result = integrateOde(chain, Float64Array.of(1, 0.25, 0), 0, 8, { rtol: 1e-6, atol: 1e-9, outputPoints: 81 });
    for (const state of result.states) expect(state[0]! + state[1]! + state[2]!).toBeCloseTo(1.25, 12);
    // The individual species follow their closed-form solutions to within the (loose) tolerance asked for.
    expect(maxError({ ...result, states: result.states.map((s) => Float64Array.of(s[0]!)) }, (t) => [Math.exp(-3 * t)])).toBeLessThan(1e-5);
    const b = (t: number): number => 0.25 * Math.exp(-t) + 1.5 * (Math.exp(-t) - Math.exp(-3 * t));
    expect(maxError({ ...result, states: result.states.map((s) => Float64Array.of(s[1]!)) }, (t) => [b(t)])).toBeLessThan(1e-5);
  });

  it('copes with a discontinuous right-hand side by rejecting steps', () => {
    const kinked: Rhs = (t, _y, d) => {
      d[0] = t < 1 ? 1 : -1;
    };
    const result = integrateOde(kinked, Float64Array.of(0), 0, 2, { rtol: 1e-8, atol: 1e-10 });
    expect(result.completed).toBe(true);
    expect(result.rejectedSteps).toBeGreaterThan(0);
    expect(Math.abs(result.finalState[0]!)).toBeLessThan(1e-6);
  });

  it('still gets a mildly stiff problem right, at the price of many steps', () => {
    const stiff: Rhs = (t, y, d) => {
      d[0] = -1000 * (y[0]! - Math.cos(t));
    };
    const result = integrateOde(stiff, Float64Array.of(0), 0, 1, { rtol: 1e-6, atol: 1e-9 });
    expect(result.completed).toBe(true);
    // After the initial transient, y = (10⁶ cos t + 10³ sin t) / (10⁶ + 1).
    expect(result.finalState[0]).toBeCloseTo((1e6 * Math.cos(1) + 1e3 * Math.sin(1)) / (1e6 + 1), 5);
    expect(result.steps).toBeGreaterThan(200);
  });
});

describe('integrateOde output', () => {
  it('returns equally spaced outputs that include both ends exactly', () => {
    const result = integrateOde(decay, Float64Array.of(1), 0, 3, { outputPoints: 7 });
    expect(Array.from(result.times)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    expect(result.states[0]![0]).toBe(1);
    expect(result.states[6]).toEqual(result.finalState);
  });

  it('returns the accepted steps when no output grid is asked for', () => {
    const result = integrateOde(decay, Float64Array.of(1), 0, 3, { rtol: 1e-6 });
    expect(result.times[0]).toBe(0);
    expect(result.times[result.times.length - 1]).toBe(3);
    expect(result.times).toHaveLength(result.steps + 1);
    for (let i = 1; i < result.times.length; i++) expect(result.times[i]!).toBeGreaterThan(result.times[i - 1]!);
    expect(maxError(result, (t) => [Math.exp(-t)])).toBeLessThan(1e-5);
  });

  it('does not let the caller’s later changes leak into the result, or its own into the input', () => {
    const y0 = Float64Array.of(1);
    const result = integrateOde(decay, y0, 0, 1, { outputPoints: 3 });
    expect(y0[0]).toBe(1);
    y0[0] = 99;
    expect(result.states[0]![0]).toBe(1);
  });

  it('handles an interval of zero length', () => {
    const result = integrateOde(decay, Float64Array.of(2), 1, 1, { outputPoints: 3 });
    expect(result.completed).toBe(true);
    expect(result.steps).toBe(0);
    expect(Array.from(result.times)).toEqual([1, 1, 1]);
    expect(result.states.map((s) => s[0])).toEqual([2, 2, 2]);
  });

  it('counts steps, rejections and function evaluations', () => {
    const result = integrateOde(decay, Float64Array.of(1), 0, 5, { rtol: 1e-8, atol: 1e-11 });
    expect(result.steps).toBeGreaterThan(10);
    expect(result.steps).toBeLessThan(200);
    // Two evaluations to choose the first step, then six per attempted step (the seventh stage is reused).
    expect(result.functionEvaluations).toBe(2 + 6 * (result.steps + result.rejectedSteps));
  });

  it('accepts one absolute tolerance per component', () => {
    const result = integrateOde(oscillator, Float64Array.of(1, 0), 0, 1, { rtol: 1e-9, atol: [1e-12, 1e-9], outputPoints: 2 });
    expect(result.completed).toBe(true);
    expect(result.finalState[0]).toBeCloseTo(Math.cos(1), 7);
  });
});

describe('integrateOde when it cannot finish', () => {
  it('stops at the step limit and returns what it has', () => {
    const result = integrateOde(oscillator, Float64Array.of(1, 0), 0, 100, { rtol: 1e-10, atol: 1e-10, maxSteps: 25, outputPoints: 1001 });
    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe('max-steps');
    expect(result.steps + result.rejectedSteps).toBe(25);
    expect(result.tEnd).toBeGreaterThan(0);
    expect(result.tEnd).toBeLessThan(100);
    // Only outputs that were actually reached are returned, and they are still correct.
    expect(result.times.length).toBeLessThan(1001);
    expect(result.times[result.times.length - 1]!).toBeLessThanOrEqual(result.tEnd);
    expect(result.states).toHaveLength(result.times.length);
    expect(maxError(result, (t) => [Math.cos(t), -Math.sin(t)])).toBeLessThan(1e-7);
    expect(result.finalState[0]).toBeCloseTo(Math.cos(result.tEnd), 7);
  });

  it('reports a solution that blows up instead of returning nonsense', () => {
    // y′ = y², y(0) = 1 has the solution 1/(1 − t), which does not exist beyond t = 1.
    const explosive: Rhs = (_t, y, d) => {
      d[0] = y[0]! * y[0]!;
    };
    const result = integrateOde(explosive, Float64Array.of(1), 0, 2, { rtol: 1e-8, atol: 1e-10, maxSteps: 5000 });
    expect(result.completed).toBe(false);
    expect(['step-size-underflow', 'non-finite-derivative', 'max-steps']).toContain(result.stopReason);
    expect(result.tEnd).toBeLessThan(1.001);
    expect(result.tEnd).toBeGreaterThan(0.99);
  });

  it('reports a right-hand side that is not finite', () => {
    const singular: Rhs = (t, _y, d) => {
      d[0] = 1 / (1 - t);
    };
    const result = integrateOde(singular, Float64Array.of(0), 0, 2, { rtol: 1e-8, atol: 1e-10, maxSteps: 5000 });
    expect(result.completed).toBe(false);
    expect(result.tEnd).toBeLessThan(1);
    const immediately = integrateOde(
      (_t, _y, d) => {
        d[0] = Number.NaN;
      },
      Float64Array.of(0),
      0,
      1,
    );
    expect(immediately.completed).toBe(false);
    expect(immediately.stopReason).toBe('non-finite-derivative');
    expect(immediately.steps).toBe(0);
    expect(Array.from(immediately.times)).toEqual([0]);
  });

  it('stops when the callback asks it to', () => {
    const result = integrateOde(decay, Float64Array.of(1), 0, 10, { rtol: 1e-9, atol: 1e-12, outputPoints: 101, shouldStop: (_t, y) => y[0]! < 0.5 });
    expect(result.completed).toBe(false);
    expect(result.stopReason).toBe('stopped-by-callback');
    expect(result.finalState[0]!).toBeLessThan(0.5);
    // It stops at the end of the first step that crosses the threshold, i.e. shortly after t = ln 2.
    expect(result.tEnd).toBeGreaterThan(Math.LN2);
    expect(result.tEnd).toBeLessThan(Math.LN2 + 0.5);
    expect(result.times[result.times.length - 1]!).toBeLessThanOrEqual(result.tEnd);
    expect(maxError(result, (t) => [Math.exp(-t)])).toBeLessThan(1e-8);
  });

  it('rejects unusable arguments', () => {
    const y0 = Float64Array.of(1);
    expect(() => integrateOde(decay, y0, 0, 1, { outputPoints: 1 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { outputPoints: 2.5 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { rtol: -1 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { rtol: 0, atol: 0 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { atol: -1 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { atol: [] })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, 1, { maxSteps: 0 })).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => integrateOde(decay, y0, Number.NaN, 1)).toThrow(RangeError);
    expect(() => integrateOde(decay, Float64Array.of(Number.NaN), 0, 1)).toThrow(RangeError);
  });
});

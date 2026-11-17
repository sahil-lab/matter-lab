import { describe, expect, it } from 'vitest';
import { duration, prefersReducedMotion, transitionFor } from './motion';

describe('duration', () => {
  it('returns the token value when motion is not reduced', () => {
    expect(duration('base', false)).toBe(240);
    expect(duration('cinematic', false)).toBe(900);
  });

  it('collapses to zero when motion is reduced', () => {
    expect(duration('base', true)).toBe(0);
    expect(duration('cinematic', true)).toBe(0);
  });
});

describe('transitionFor', () => {
  it('builds one CSS transition declaration per comma-separated property', () => {
    expect(transitionFor('fast', 'opacity, transform')).toBe('opacity 150ms cubic-bezier(0.2, 0.7, 0.2, 1), transform 150ms cubic-bezier(0.2, 0.7, 0.2, 1)');
  });

  it('uses the requested easing curve', () => {
    expect(transitionFor('slow', 'height', 'entrance')).toBe('height 420ms cubic-bezier(0.1, 0.9, 0.2, 1)');
  });
});

describe('prefersReducedMotion (no window, as in this test environment)', () => {
  it('is false rather than throwing when `window` is unavailable', () => {
    expect(typeof window).toBe('undefined');
    expect(prefersReducedMotion()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { FLUID_QUALITY, prefersReducedMotion, resolveFluidQuality, shouldAnimateSurface } from './fluidQuality';

describe('resolveFluidQuality', () => {
  it('returns the requested tier when no device hints are given', () => {
    expect(resolveFluidQuality('quality')).toEqual(FLUID_QUALITY.quality);
    expect(resolveFluidQuality('balanced')).toEqual(FLUID_QUALITY.balanced);
  });

  it('demotes to efficient on a software rasterizer regardless of the requested tier', () => {
    expect(resolveFluidQuality('quality', { webgl2: true, software: true })).toEqual(FLUID_QUALITY.efficient);
  });

  it('demotes to efficient when WebGL2 is unavailable', () => {
    expect(resolveFluidQuality('balanced', { webgl2: false, software: false })).toEqual(FLUID_QUALITY.efficient);
  });

  it('keeps the requested tier on a capable device', () => {
    expect(resolveFluidQuality('quality', { webgl2: true, software: false })).toEqual(FLUID_QUALITY.quality);
  });

  it('enables glass transmission at balanced/quality, and never enables liquid transmission (nested transmission was found to hide the liquid color almost entirely)', () => {
    expect(FLUID_QUALITY.efficient.glassTransmission).toBe(false);
    expect(FLUID_QUALITY.efficient.liquidTransmission).toBe(false);
    expect(FLUID_QUALITY.balanced.glassTransmission).toBe(true);
    expect(FLUID_QUALITY.balanced.liquidTransmission).toBe(false);
    expect(FLUID_QUALITY.quality.glassTransmission).toBe(true);
    expect(FLUID_QUALITY.quality.liquidTransmission).toBe(false);
  });
});

describe('prefersReducedMotion', () => {
  it('is false outside a browser (no window.matchMedia), never throws', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('shouldAnimateSurface', () => {
  it('is false when the tier disables surface animation even if agitated', () => {
    expect(shouldAnimateSurface(FLUID_QUALITY.efficient, 1, false)).toBe(false);
  });

  it('is false when reduced motion is requested, even on a tier that otherwise animates', () => {
    expect(shouldAnimateSurface(FLUID_QUALITY.quality, 1, true)).toBe(false);
  });

  it('is false when there is nothing to animate (agitation is zero)', () => {
    expect(shouldAnimateSurface(FLUID_QUALITY.quality, 0, false)).toBe(false);
  });

  it('is true for an agitated liquid on an animation-capable tier with no reduced-motion request', () => {
    expect(shouldAnimateSurface(FLUID_QUALITY.quality, 0.5, false)).toBe(true);
  });
});

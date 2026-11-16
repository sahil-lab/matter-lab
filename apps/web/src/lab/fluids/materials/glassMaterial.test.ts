import { describe, expect, it } from 'vitest';
import { FLUID_QUALITY } from '../quality/fluidQuality';
import { createGlassMaterial } from './glassMaterial';

describe('createGlassMaterial', () => {
  it('uses real transmission at the quality tier', () => {
    const material = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.0016 });
    expect(material.transmission).toBeGreaterThan(0);
    expect(material.transparent).toBe(true);
    material.dispose();
  });

  it('falls back to alpha blending (no transmission) at the efficient tier', () => {
    const material = createGlassMaterial(FLUID_QUALITY.efficient, { wallThicknessM: 0.0016 });
    expect(material.transmission).toBe(0);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeLessThan(1);
    material.dispose();
  });

  it('is clear (no attenuation tint) by default', () => {
    const material = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.0016 });
    expect(material.attenuationDistance).toBe(Infinity);
    material.dispose();
  });

  it('applies a body tint and finite attenuation distance when requested (e.g. an amber reagent bottle)', () => {
    const material = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.0018, tintHex: '#6b4a1a' });
    expect(material.attenuationDistance).toBeLessThan(Infinity);
    expect(material.attenuationColor.getHexString()).toBe('6b4a1a');
    material.dispose();
  });

  it('scales the refraction thickness parameter with the real wall thickness, never below a visible floor', () => {
    const thin = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.0001 });
    const thick = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.002 });
    expect(thick.thickness).toBeGreaterThan(thin.thickness);
    expect(thin.thickness).toBeGreaterThan(0);
    thin.dispose();
    thick.dispose();
  });
});

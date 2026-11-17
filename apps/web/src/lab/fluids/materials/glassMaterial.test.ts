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

  it('keeps the transmission-ray thickness small relative to a typical vessel, regardless of the real wall thickness', () => {
    // A thickness on the order of the object's own size (centimeters) is correct here; several
    // centimeters or more pushed the refraction sample off the transmission texture in practice
    // (verified visually: the vessel rendered solid black instead of refracting its surroundings).
    const thin = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.0001 });
    const thick = createGlassMaterial(FLUID_QUALITY.quality, { wallThicknessM: 0.002 });
    expect(thin.thickness).toBe(thick.thickness);
    expect(thin.thickness).toBeGreaterThan(0);
    expect(thin.thickness).toBeLessThan(0.02);
    thin.dispose();
    thick.dispose();
  });
});

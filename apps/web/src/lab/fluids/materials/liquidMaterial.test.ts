import { describe, expect, it } from 'vitest';
import { FLUID_QUALITY } from '../quality/fluidQuality';
import type { FluidQualitySettings } from '../quality/fluidQuality';
import { createLiquidMaterial, updateLiquidMaterial } from './liquidMaterial';

// No built-in preset currently enables liquid transmission (see fluidQuality.ts's comment: nested
// transmission with the glass shell was found, via screenshots, to hide the liquid's own color).
// The factory function must still handle it correctly in isolation, so these tests build a custom
// settings object rather than relying on any `FLUID_QUALITY` preset for it.
const TRANSMISSIVE_LIQUID: FluidQualitySettings = { ...FLUID_QUALITY.quality, liquidTransmission: true };

describe('createLiquidMaterial', () => {
  it('uses real transmission when requested and tints the attenuation color to match', () => {
    const material = createLiquidMaterial(TRANSMISSIVE_LIQUID, { colorHex: '#3e8fd6' });
    expect(material.transmission).toBeGreaterThan(0);
    expect(material.attenuationColor.getHexString()).toBe('3e8fd6');
    material.dispose();
  });

  it('falls back to alpha blending at every built-in tier', () => {
    for (const quality of Object.values(FLUID_QUALITY)) {
      const material = createLiquidMaterial(quality, { colorHex: '#3e8fd6', opacity: 0.5 });
      expect(material.transmission).toBe(0);
      expect(material.opacity).toBeCloseTo(0.5, 9);
      material.dispose();
    }
  });

  it('matches the requested color', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.efficient, { colorHex: '#d43f94' });
    expect(material.color.getHexString()).toBe('d43f94');
    material.dispose();
  });
});

describe('updateLiquidMaterial', () => {
  it('updates color and attenuation color for a transmissive material without rebuilding it', () => {
    const material = createLiquidMaterial(TRANSMISSIVE_LIQUID, { colorHex: '#3e8fd6' });
    updateLiquidMaterial(material, { colorHex: '#d43f94' });
    expect(material.color.getHexString()).toBe('d43f94');
    expect(material.attenuationColor.getHexString()).toBe('d43f94');
    material.dispose();
  });

  it('updates color and opacity for an alpha-blended material', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.efficient, { colorHex: '#3e8fd6', opacity: 0.6 });
    updateLiquidMaterial(material, { colorHex: '#d43f94', opacity: 0.9 });
    expect(material.color.getHexString()).toBe('d43f94');
    expect(material.opacity).toBeCloseTo(0.9, 9);
    material.dispose();
  });
});

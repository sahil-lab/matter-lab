import { describe, expect, it } from 'vitest';
import { FLUID_QUALITY } from '../quality/fluidQuality';
import { createLiquidMaterial, updateLiquidMaterial } from './liquidMaterial';

describe('createLiquidMaterial', () => {
  it('uses real transmission at the quality tier and tints the attenuation color to match', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.quality, { colorHex: '#3e8fd6' });
    expect(material.transmission).toBeGreaterThan(0);
    expect(material.attenuationColor.getHexString()).toBe('3e8fd6');
    material.dispose();
  });

  it('falls back to alpha blending at tiers without liquid transmission', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.balanced, { colorHex: '#3e8fd6', opacity: 0.5 });
    expect(material.transmission).toBe(0);
    expect(material.opacity).toBeCloseTo(0.5, 9);
    material.dispose();
  });

  it('matches the requested color', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.efficient, { colorHex: '#d43f94' });
    expect(material.color.getHexString()).toBe('d43f94');
    material.dispose();
  });
});

describe('updateLiquidMaterial', () => {
  it('updates color and attenuation color for a transmissive material without rebuilding it', () => {
    const material = createLiquidMaterial(FLUID_QUALITY.quality, { colorHex: '#3e8fd6' });
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

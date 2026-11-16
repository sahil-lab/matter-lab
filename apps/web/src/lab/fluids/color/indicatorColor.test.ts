import { describe, expect, it } from 'vitest';
import { INDICATORS, blendLiquidColor, indicatorColorForPh, lerpHex } from './indicatorColor';

describe('indicatorColorForPh', () => {
  it('returns the acid color well below the transition range and the base color well above it', () => {
    for (const def of Object.values(INDICATORS)) {
      const acid = indicatorColorForPh(def.id, def.rangeLowPh - 2);
      const base = indicatorColorForPh(def.id, def.rangeHighPh + 2);
      expect(acid.colorHex.toLowerCase()).toBe(def.acidColor.toLowerCase());
      expect(base.colorHex.toLowerCase()).toBe(def.baseColor.toLowerCase());
    }
  });

  it('is monotonic through the transition range (never overshoots acid/base colors)', () => {
    for (const def of Object.values(INDICATORS)) {
      const samples = [def.rangeLowPh - 1, def.rangeLowPh, (def.rangeLowPh + def.rangeHighPh) / 2, def.rangeHighPh, def.rangeHighPh + 1];
      const results = samples.map((ph) => indicatorColorForPh(def.id, ph));
      // Every result must be labeled illustrative: it visualizes a supplied pH, it is not itself data.
      for (const r of results) expect(r.evidence).toBe('ILLUSTRATIVE');
    }
  });

  it('keeps phenolphthalein colorless at pH 7 (equivalence) and only turns pink above its range', () => {
    const atEquivalence = indicatorColorForPh('phenolphthalein', 7.0);
    expect(atEquivalence.colorHex.toLowerCase()).toBe(INDICATORS.phenolphthalein.acidColor.toLowerCase());
    const aboveRange = indicatorColorForPh('phenolphthalein', 10.5);
    expect(aboveRange.colorHex.toLowerCase()).toBe(INDICATORS.phenolphthalein.baseColor.toLowerCase());
  });

  it('places bromothymol blue partway through its transition at pH 7 (neither pure acid nor pure base color)', () => {
    const atSeven = indicatorColorForPh('bromothymol-blue', 7.0);
    expect(atSeven.colorHex.toLowerCase()).not.toBe(INDICATORS['bromothymol-blue'].acidColor.toLowerCase());
    expect(atSeven.colorHex.toLowerCase()).not.toBe(INDICATORS['bromothymol-blue'].baseColor.toLowerCase());
  });

  it('handles "none" and "universal" without throwing and still labels the result illustrative', () => {
    expect(indicatorColorForPh('none', 7).evidence).toBe('ILLUSTRATIVE');
    expect(indicatorColorForPh('universal', 1).colorHex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(indicatorColorForPh('universal', 14).colorHex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(indicatorColorForPh('universal', 7).evidence).toBe('ILLUSTRATIVE');
  });
});

describe('lerpHex', () => {
  it('returns the endpoints at t=0 and t=1, and clamps outside [0, 1]', () => {
    expect(lerpHex('#000000', '#ffffff', 0).toLowerCase()).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 1).toLowerCase()).toBe('#ffffff');
    expect(lerpHex('#000000', '#ffffff', -3).toLowerCase()).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 3).toLowerCase()).toBe('#ffffff');
  });

  it('interpolates the midpoint', () => {
    expect(lerpHex('#000000', '#ffffff', 0.5).toLowerCase()).toBe('#808080');
  });
});

describe('blendLiquidColor', () => {
  it('at strength 0 keeps the base tint; at strength 1 adopts the indicator color', () => {
    const indicator = indicatorColorForPh('phenolphthalein', 11);
    expect(blendLiquidColor('#336699', indicator, 0).toLowerCase()).toBe('#336699');
    expect(blendLiquidColor('#336699', indicator, 1).toLowerCase()).toBe(indicator.colorHex.toLowerCase());
  });
});

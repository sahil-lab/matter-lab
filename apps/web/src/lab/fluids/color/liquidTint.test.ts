import { describe, expect, it } from 'vitest';
import { baseTintForSpecies, genericAqueousTint } from './liquidTint';

describe('genericAqueousTint', () => {
  it('is illustrative and not pure white (so a liquid still reads as a liquid)', () => {
    const tint = genericAqueousTint();
    expect(tint.evidence).toBe('ILLUSTRATIVE');
    expect(tint.colorHex.toLowerCase()).not.toBe('#ffffff');
    expect(tint.colorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('baseTintForSpecies', () => {
  it('recognizes a known distinctively colored species', () => {
    const tint = baseTintForSpecies(['copper(ii)-sulfate']);
    expect(tint.colorHex.toLowerCase()).toBe('#3e8fd6');
    expect(tint.evidence).toBe('ILLUSTRATIVE');
  });

  it('falls back to the generic tint for an unrecognized species, never inventing a color', () => {
    const tint = baseTintForSpecies(['some-unlisted-species']);
    expect(tint).toEqual(genericAqueousTint());
  });

  it('falls back to the generic tint for an empty species list', () => {
    expect(baseTintForSpecies([])).toEqual(genericAqueousTint());
  });

  it('picks the first recognized species when several are present', () => {
    const tint = baseTintForSpecies(['unlisted', 'potassium-permanganate', 'copper(ii)-sulfate']);
    expect(tint.colorHex.toLowerCase()).toBe('#5b1e6e');
  });
});

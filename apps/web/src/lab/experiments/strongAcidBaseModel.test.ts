import { describe, expect, it } from 'vitest';
import { computeStrongAcidBasePh } from './strongAcidBaseModel';

const T = 298.15;

describe('computeStrongAcidBasePh', () => {
  it('reaches pH 7 at the equivalence point of 25.00 mL 0.100 M HCl with 0.100 M NaOH', () => {
    // 25.00 mL acid + 25.00 mL titrant delivered = 50.00 mL total, equal moles.
    const result = computeStrongAcidBasePh(
      [
        { speciesId: 'HCl', moles: 0.025 * 0.1 },
        { speciesId: 'NaOH', moles: 0.025 * 0.1 },
      ],
      0.05,
      T,
    );
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.pH).toBeCloseTo(7, 6);
  });

  it('gives a sensible acidic pH before equivalence', () => {
    // 10.00 mL of titrant delivered into the 25.00 mL aliquot.
    const result = computeStrongAcidBasePh(
      [
        { speciesId: 'HCl', moles: 0.025 * 0.1 },
        { speciesId: 'NaOH', moles: 0.01 * 0.1 },
      ],
      0.035,
      T,
    );
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.pH).toBeCloseTo(1.368, 2);
  });

  it('gives a sensible basic pH after equivalence', () => {
    // 30.00 mL of titrant delivered, 5.00 mL past equivalence.
    const result = computeStrongAcidBasePh(
      [
        { speciesId: 'HCl', moles: 0.025 * 0.1 },
        { speciesId: 'NaOH', moles: 0.03 * 0.1 },
      ],
      0.055,
      T,
    );
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.pH).toBeGreaterThan(11);
  });

  it('is monotonically non-decreasing in pH as titrant is added', () => {
    const acidMoles = 0.025 * 0.1;
    let previous = -Infinity;
    for (let deliveredMl = 0; deliveredMl <= 50; deliveredMl += 2.5) {
      const deliveredL = deliveredMl / 1000;
      const baseMoles = deliveredL * 0.1;
      const result = computeStrongAcidBasePh([{ speciesId: 'HCl', moles: acidMoles }, { speciesId: 'NaOH', moles: baseMoles }], 0.025 + deliveredL, T);
      expect(result.supported).toBe(true);
      if (result.supported) {
        expect(result.pH).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = result.pH;
      }
    }
  });

  it('refuses species outside the strong acid/base list as unsupported, not a guess', () => {
    const result = computeStrongAcidBasePh([{ speciesId: 'CH3COOH', moles: 0.001 }], 0.025, T);
    expect(result.supported).toBe(false);
  });

  it('refuses temperatures away from 298.15 K rather than silently reusing Kw', () => {
    const result = computeStrongAcidBasePh([{ speciesId: 'HCl', moles: 0.001 }], 0.025, 350);
    expect(result.supported).toBe(false);
  });

  it('refuses zero or negative volume', () => {
    expect(computeStrongAcidBasePh([{ speciesId: 'HCl', moles: 0.001 }], 0, T).supported).toBe(false);
  });
});

import { ACETIC_ACID_KA, AMMONIUM_KA, KW } from './model.js';
import { stableSum } from './numerics.js';
import type { ValidatedComposition } from './validation.js';

export interface Speciation {
  readonly hydronium: number;
  readonly hydroxide: number;
  readonly aceticAcid: number;
  readonly acetate: number;
  readonly ammonia: number;
  readonly ammonium: number;
  readonly chargeResidualMolL: number;
  readonly ionicStrengthMolL: number;
}

export function speciateAtPH(pH: number, composition: ValidatedComposition): Speciation {
  const hydronium = 10 ** -pH;
  const hydroxide = KW / hydronium;
  const acidTotal = composition.concentrations['family:acetate'];
  const baseTotal = composition.concentrations['family:ammonia'];
  const aceticAcid = acidTotal * (hydronium / (ACETIC_ACID_KA + hydronium));
  const acetate = acidTotal * (ACETIC_ACID_KA / (ACETIC_ACID_KA + hydronium));
  const ammonium = baseTotal * (hydronium / (AMMONIUM_KA + hydronium));
  const ammonia = baseTotal * (AMMONIUM_KA / (AMMONIUM_KA + hydronium));
  let chargeTerms = [hydronium, -hydroxide, composition.strongChargeMolL];
  // Use the minority form near complete conversion rather than subtracting two nearly equal large concentrations.
  if (acidTotal > 0) {
    chargeTerms = hydronium <= ACETIC_ACID_KA
      ? [hydronium, -hydroxide, composition.acidOffsetMolL, aceticAcid]
      : [hydronium, -hydroxide, composition.strongChargeMolL, -acetate];
  } else if (baseTotal > 0) {
    chargeTerms = hydronium >= AMMONIUM_KA
      ? [hydronium, -hydroxide, composition.baseOffsetMolL, -ammonia]
      : [hydronium, -hydroxide, composition.strongChargeMolL, ammonium];
  }
  return {
    hydronium, hydroxide, aceticAcid, acetate, ammonia, ammonium,
    chargeResidualMolL: stableSum(chargeTerms),
    ionicStrengthMolL: 0.5 * stableSum([
      hydronium, hydroxide, composition.concentrations['ion:sodium'],
      composition.concentrations['ion:chloride'], acetate, ammonium,
    ]),
  };
}

import { describe, expect, it } from 'vitest';
import { getIndicatorDefinitions, getTitrationReference, solveEquilibrium } from '../src/index.js';
import { KW } from '../src/model.js';
import { inputFor, prepared, succeeded } from './helpers.js';

describe('trace indicator equilibrium and illustrative colors', () => {
  it.each(getIndicatorDefinitions())('$id has equal acid/base forms at its effective pKa', (indicator) => {
    const h = 10 ** -indicator.effectivePKa;
    const strongAcidConcentration = h - KW / h;
    const input = inputFor(prepared(
      strongAcidConcentration >= 0 ? 'hcl' : 'naoh', 0.05, Math.abs(strongAcidConcentration),
    ), [indicator.id]);
    const result = succeeded(solveEquilibrium(input));
    expect(result.pH.value).toBeCloseTo(indicator.effectivePKa, 9);
    expect(result.indicators[0].baseFraction).toBeCloseTo(0.5, 9);
    expect(result.indicators[0].colorEvidence).toBe('ILLUSTRATIVE');
    result.indicators[0].colorSrgb.forEach((channel, index) => {
      expect(channel).toBeCloseTo(indicator.midpointColorSrgb[index], 9);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    });
    expect(result.warnings.some((warning) => warning.includes('TRACE_INDICATOR'))).toBe(true);
  });

  it('indicator selection does not alter bulk pH or inventories in the trace approximation', () => {
    const contents = prepared('sodium-acetate');
    const without = succeeded(solveEquilibrium(inputFor(contents)));
    const withIndicators = succeeded(solveEquilibrium(inputFor(contents, ['phenolphthalein', 'methyl-orange', 'bromothymol-blue'])));
    expect(withIndicators.pH).toEqual(without.pH);
    expect(withIndicators.equilibriumSpecies).toEqual(without.equilibriumSpecies);
    expect(withIndicators.indicators).toHaveLength(3);
  });

  it('does not imply the phenolphthalein endpoint equals neutral strong-acid/base equivalence', () => {
    const contents = prepared('sodium-chloride', 0.05, 0.05);
    const result = succeeded(solveEquilibrium(inputFor(contents, ['phenolphthalein'])));
    expect(result.pH.value).toBeCloseTo(7, 10);
    expect(result.indicators[0].baseFraction).toBeLessThan(0.004);
  });

  it('rejects unknown indicators and unmodeled alkaline phenolphthalein fading', () => {
    expect(solveEquilibrium(inputFor(prepared('hcl'), ['universal-mixture'])).status).toBe('UNSUPPORTED');
    const contents = prepared('naoh', 0.05, 0.1);
    const requested = solveEquilibrium(inputFor(contents, ['phenolphthalein']));
    expect(requested.status).toBe('UNSUPPORTED');
    expect(requested).not.toHaveProperty('pH');
    expect(solveEquilibrium(inputFor(contents)).status).toBe('SUCCEEDED');
  });
});

describe('reference quantities and endpoint versus equivalence', () => {
  const strong = {
    analyte: { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 },
    titrantReagentId: 'naoh', titrantConcentrationMolL: 0.1, deliveredVolumeL: 0.0125,
  };

  it('computes the 25 mL equivalence from amounts, with explicit caller-supplied delivered volume', () => {
    const result = getTitrationReference(strong);
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.equivalenceVolume.unit).toBe('L');
    expect(result.equivalenceVolume.value).toBeCloseTo(0.025, 14);
    expect(result.equivalencePH.value).toBeCloseTo(7, 10);
    expect(result.deliveredVolume.value).toBe(0.0125);
    expect(result.analyteAmount.value).toBeCloseTo(0.0025, 14);
    expect(result).not.toHaveProperty('halfEquivalencePH');
    expect(result).not.toHaveProperty('endpoint');
  });

  it.each([
    ['acetic-acid', 'naoh', 'INCREASING_PH', 4.7447274949, 8.72],
    ['ammonia', 'hcl', 'DECREASING_PH', 9.2552725051, 5.28],
  ] as const)('returns %s half-equivalence and conjugate hydrolysis references', (reagentId, titrantReagentId, direction, halfPH, equivalencePH) => {
    const result = getTitrationReference({
      ...strong, analyte: { ...strong.analyte, reagentId }, titrantReagentId,
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.direction).toBe(direction);
    expect(result.halfEquivalenceVolume!.value).toBeCloseTo(0.0125, 14);
    expect(Math.abs(result.halfEquivalencePH!.value - halfPH)).toBeLessThan(0.001);
    expect(Math.abs(result.equivalencePH.value - equivalencePH)).toBeLessThan(0.005);
  });

  it.each([
    ['phenolphthalein', 9.5, 1],
    ['methyl-orange', -Math.log10(4e-4), -1],
  ] as const)('estimates an explicit %s color threshold by solving actual mixtures', (indicatorId, targetPH, offsetSign) => {
    const result = getTitrationReference({ ...strong, indicatorId, endpointBaseFraction: 0.5 });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    const endpoint = result.endpoint!;
    expect(endpoint.targetPH.value).toBeCloseTo(targetPH, 10);
    expect(Math.sign(endpoint.offsetFromEquivalence.value)).toBe(offsetSign);
    const h = 10 ** -targetPH;
    const netHydronium = h - KW / h;
    const independentVolume = (0.0025 - netHydronium * 0.025) / (0.1 + netHydronium);
    expect(Math.abs(endpoint.estimatedVolume.value - independentVolume)).toBeLessThan(1e-12);
    expect(endpoint.interpretation).toContain('not stoichiometric equivalence');
  });

  it('does not hardcode 25 mL or require equal titrant/analyte concentrations', () => {
    const result = getTitrationReference({
      ...strong, analyte: { reagentId: 'hcl', volumeL: 0.01, concentrationMolL: 0.02 }, titrantConcentrationMolL: 0.05,
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.equivalenceVolume.value).toBeCloseTo(0.004, 14);
    expect(result.equivalencePH.value).toBeCloseTo(7, 10);
  });

  it('recognizes an endpoint already present initially within the solver tolerance', () => {
    const h = 4e-4;
    const result = getTitrationReference({
      ...strong,
      analyte: { ...strong.analyte, concentrationMolL: h - KW / h },
      indicatorId: 'methyl-orange', endpointBaseFraction: 0.5,
    });
    expect(result.status).toBe('SUCCEEDED');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.endpoint!.estimatedVolume.value).toBe(0);
  });

  it('rejects unspecified endpoint thresholds, unsupported pairs, and unreachable thresholds', () => {
    expect(getTitrationReference({ ...strong, indicatorId: 'phenolphthalein' }).status).toBe('FAILED');
    expect(getTitrationReference({ ...strong, titrantReagentId: 'ammonia' }).status).toBe('UNSUPPORTED');
    const unreachable = getTitrationReference({
      ...strong, titrantConcentrationMolL: 1e-6, indicatorId: 'phenolphthalein', endpointBaseFraction: 0.5,
    });
    expect(unreachable.status).toBe('UNSUPPORTED');
    expect(unreachable).not.toHaveProperty('equivalencePH');
  });
});

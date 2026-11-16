import type { EquilibriumInput } from '@matterlab/contracts';
import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/replay-v1.json';
import { prepareSolution, solveEquilibrium, solveJson } from '../src/index.js';
import { ACETIC_ACID_KA, AMMONIUM_KA, KW } from '../src/model.js';
import { freezeDeep, inputFor, mixture, prepared, succeeded } from './helpers.js';

describe('reference snapshots and deterministic replay', () => {
  it.each(fixtures.cases)('$id', (fixture) => {
    const input = fixture.input as EquilibriumInput;
    const request = { schemaVersion: 1, operation: 'equilibrium', input };
    const first = solveJson(JSON.stringify(request));
    expect(solveJson(JSON.stringify(request))).toBe(first);
    expect(JSON.parse(first)).toEqual(solveEquilibrium(freezeDeep(input)));
    const result = solveEquilibrium(input);
    expect(result.status).toBe(fixture.expected.status);
    if (result.status === 'SUCCEEDED') {
      expect(Math.abs(result.pH.value - fixture.expected.pH!)).toBeLessThan(fixture.expected.absolutePHTolerance!);
      expect(result.pH.unit).toBe('pH');
      expect(result.pH).not.toHaveProperty('uncertainty');
      expect(Math.abs(result.diagnostics.chargeResidualMolL as number)).toBeLessThan(1e-12);
      expect(Math.abs(result.diagnostics.reconstructedChargeResidualMolL as number)).toBeLessThan(1e-12);
      expect(result.diagnostics.maximumMassResidualMolL as number).toBeLessThan(1e-12);
    } else {
      expect(result.error.code).toBe(fixture.expected.code);
      expect(result).not.toHaveProperty('pH');
      expect(result).not.toHaveProperty('equilibriumSpecies');
      expect(result).not.toHaveProperty('indicators');
    }
  });
});

describe('strong acid/base, dilution and water', () => {
  it('converts 25 mL aliquots to 0.025 L and solves the required 0.100 M equivalence', () => {
    const result = mixture([
      { reagentId: 'hcl', volumeL: 25 / 1000, concentrationMolL: 0.1 },
      { reagentId: 'naoh', volumeL: 25 / 1000, concentrationMolL: 0.1 },
    ]);
    expect(result.pH.value).toBeCloseTo(7, 10);
    expect(result.diagnostics.volumeL).toBe(0.05);
    expect(result.equilibriumSpecies.find((species) => species.speciesId === 'ion:sodium')!.concentrationMolL).toBeCloseTo(0.05, 14);
    expect(result.equilibriumSpecies.some((species) => species.speciesId.toLowerCase().includes('hcl'))).toBe(false);
  });

  it('matches an independent stable strong-electrolyte quadratic on both sides of sharp equivalence', () => {
    const volumes = [0, 0.005, 0.0125, 0.024, 0.02499, 0.02499999, 0.025, 0.02500001, 0.02501, 0.026, 0.0375, 0.05];
    const calculated: number[] = [];
    for (const delivered of volumes) {
      const result = succeeded(solveEquilibrium(inputFor({
        ...prepared('hcl'),
        volumeL: 0.025 + delivered,
        species: [
          { speciesId: 'ion:chloride', moles: 0.0025 },
          { speciesId: 'ion:sodium', moles: delivered * 0.1 },
        ],
      })));
      const excessAcid = (0.0025 - delivered * 0.1) / (0.025 + delivered);
      const discriminant = Math.sqrt(excessAcid ** 2 + 4 * KW);
      const hydronium = excessAcid >= 0
        ? (excessAcid + discriminant) / 2
        : 2 * KW / (discriminant - excessAcid);
      expect(result.pH.value).toBeCloseTo(-Math.log10(hydronium), 9);
      calculated.push(result.pH.value);
    }
    expect(calculated.every((value, index) => index === 0 || value > calculated[index - 1])).toBe(true);
  });

  it('dilutes conserved acid/base amounts toward neutrality, not along a stored trajectory', () => {
    for (const reagentId of ['hcl', 'naoh']) {
      const stock = prepared(reagentId);
      const initial = succeeded(solveEquilibrium(inputFor(stock)));
      const diluted = succeeded(solveEquilibrium(inputFor({ ...stock, volumeL: stock.volumeL * 10 })));
      expect(Math.abs(diluted.pH.value - 7)).toBeLessThan(Math.abs(initial.pH.value - 7));
      expect(Math.abs(initial.pH.value - diluted.pH.value)).toBeCloseTo(1, 8);
    }
  });

  it('includes water autoionization for ultra-dilute acid and base without crossing neutrality', () => {
    const acid = succeeded(solveEquilibrium(inputFor(prepared('hcl', 0.1, 1e-9))));
    const base = succeeded(solveEquilibrium(inputFor(prepared('naoh', 0.1, 1e-9))));
    expect(acid.pH.value).toBeGreaterThan(6.99);
    expect(acid.pH.value).toBeLessThan(7);
    expect(base.pH.value).toBeGreaterThan(7);
    expect(acid.pH.value + base.pH.value).toBeCloseTo(14, 10);
    for (const result of [acid, base]) {
      const concentrations = new Map(result.equilibriumSpecies.map((species) => [species.speciesId, species.concentrationMolL]));
      expect(concentrations.get('ion:hydronium')! * concentrations.get('ion:hydroxide')!).toBeCloseTo(KW, 25);
    }
  });

  it('preserves a neutral sodium chloride solution, including water in its ionic strength', () => {
    const preparation = prepareSolution({ reagentId: 'sodium-chloride', volumeL: 0.1, concentrationMolL: 0.1 });
    expect(preparation.status).toBe('SUCCEEDED');
    if (preparation.status !== 'SUCCEEDED') return;
    const result = succeeded(solveEquilibrium(inputFor(preparation.contents)));
    expect(result.pH.value).toBeCloseTo(7, 10);
    expect(result.diagnostics.ionicStrengthMolL as number).toBeCloseTo(0.1000001, 10);
    expect(result.warnings.some((warning) => warning.includes('IDEAL_ACTIVITY_LIMIT'))).toBe(true);
  });
});

describe('weak monoprotic families and buffers', () => {
  it.each([
    ['acetic-acid', 'naoh', ACETIC_ACID_KA, 8.72],
    ['ammonia', 'hcl', AMMONIUM_KA, 5.28],
  ] as const)('%s half-equivalence and conjugate hydrolysis', (reagentId, titrantId, ka, expectedEquivalence) => {
    const half = mixture([
      { reagentId, volumeL: 0.025, concentrationMolL: 0.1 },
      { reagentId: titrantId, volumeL: 0.0125, concentrationMolL: 0.1 },
    ]);
    const equivalence = mixture([
      { reagentId, volumeL: 0.025, concentrationMolL: 0.1 },
      { reagentId: titrantId, volumeL: 0.025, concentrationMolL: 0.1 },
    ]);
    expect(Math.abs(half.pH.value + Math.log10(ka))).toBeLessThan(0.001);
    expect(Math.abs(equivalence.pH.value - expectedEquivalence)).toBeLessThan(0.005);
    expect(equivalence.pH.value).not.toBeCloseTo(7, 1);
  });

  it.each([
    ['acetic-acid', 'sodium-acetate', ACETIC_ACID_KA],
    ['ammonia', 'ammonium-chloride', AMMONIUM_KA],
  ] as const)('solves a prepared %s conjugate buffer and its dilution', (acidOrBase, salt, ka) => {
    const components = [
      { reagentId: acidOrBase, volumeL: 0.025, concentrationMolL: 0.1 },
      { reagentId: salt, volumeL: 0.025, concentrationMolL: 0.1 },
    ];
    const buffer = mixture(components);
    const diluted = mixture([...components, { reagentId: 'water', volumeL: 0.05, concentrationMolL: 0 }]);
    expect(Math.abs(buffer.pH.value + Math.log10(ka))).toBeLessThan(0.001);
    expect(Math.abs(buffer.pH.value - diluted.pH.value)).toBeLessThan(0.001);
  });

  it('checks independent charge, family mass, and dissociation balances from returned equilibrium species', () => {
    for (const [reagentId, titrantId, familyId, ka, neutralId, chargedId] of [
      ['acetic-acid', 'naoh', 'family:acetate', ACETIC_ACID_KA, 'molecule:acetic-acid', 'ion:acetate'],
      ['ammonia', 'hcl', 'family:ammonia', AMMONIUM_KA, 'molecule:ammonia', 'ion:ammonium'],
    ] as const) {
      for (const addedL of [0.002, 0.0125, 0.025, 0.04]) {
        const result = mixture([
          { reagentId, volumeL: 0.025, concentrationMolL: 0.1 },
          { reagentId: titrantId, volumeL: addedL, concentrationMolL: 0.1 },
        ]);
        const c = new Map(result.equilibriumSpecies.map((species) => [species.speciesId, species.concentrationMolL]));
        const charge = c.get('ion:hydronium')! - c.get('ion:hydroxide')!
          + (c.get('ion:sodium') ?? 0) - (c.get('ion:chloride') ?? 0)
          + (c.get('ion:ammonium') ?? 0) - (c.get('ion:acetate') ?? 0);
        expect(Math.abs(charge)).toBeLessThan(1e-12);
        expect(c.get(neutralId)! + c.get(chargedId)!).toBeCloseTo(0.0025 / (0.025 + addedL), 13);
        const calculatedKa = familyId === 'family:acetate'
          ? c.get('ion:hydronium')! * c.get(chargedId)! / c.get(neutralId)!
          : c.get('ion:hydronium')! * c.get(neutralId)! / c.get(chargedId)!;
        expect(Math.abs(calculatedKa / ka - 1)).toBeLessThan(1e-12);
      }
    }
  });

  it('does not mutate inputs and aggregates duplicate conserved entries independent of their ordering', () => {
    const contents = prepared('acetic-acid');
    const input = freezeDeep(inputFor({
      ...contents,
      species: [
        ...contents.species,
        { speciesId: 'ion:sodium', moles: 0.0002, sourceId: 'source-a' },
        { speciesId: 'ion:sodium', moles: 0.0009, sourceId: 'source-b' },
        { speciesId: 'ion:sodium', moles: 0.00015, sourceId: 'source-c' },
      ],
    }));
    const original = JSON.stringify(input);
    const result = solveEquilibrium(input);
    const reversed = solveEquilibrium({ ...input, contents: { ...input.contents, species: [...input.contents.species].reverse() } });
    expect(JSON.stringify(input)).toBe(original);
    expect(reversed).toEqual(result);
  });
});

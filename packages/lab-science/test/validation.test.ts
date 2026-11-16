import type { ContainerContents, EquilibriumInput, PreparationInput } from '@matterlab/contracts';
import { describe, expect, it } from 'vitest';
import { getReagentDefinitions, prepareSolution, solveEquilibrium, solveJson } from '../src/index.js';
import { bisect } from '../src/numerics.js';
import { inputFor, prepared } from './helpers.js';

function uncheckedContents(patch: Record<string, unknown>): EquilibriumInput {
  return inputFor({ ...prepared('water', 0.05, 0), ...patch } as ContainerContents);
}

describe('physical and model eligibility', () => {
  it.each([
    ['zero volume', { volumeL: 0 }, 'FAILED'],
    ['negative volume', { volumeL: -1 }, 'FAILED'],
    ['nonfinite volume', { volumeL: Infinity }, 'FAILED'],
    ['volume with wrong units shape', { volumeL: { value: 25, unit: 'mL' } }, 'FAILED'],
    ['tiny volume', { volumeL: 1e-12 }, 'UNSUPPORTED'],
    ['large volume', { volumeL: 101 }, 'UNSUPPORTED'],
    ['invalid temperature', { temperatureK: NaN }, 'FAILED'],
    ['Celsius passed as kelvin', { temperatureK: 25 }, 'UNSUPPORTED'],
    ['off-reference temperature', { temperatureK: 298.15001 }, 'UNSUPPORTED'],
    ['missing mixing state', { mixing: undefined }, 'FAILED'],
    ['unmixed contents', { mixing: 'UNMIXED' }, 'UNSUPPORTED'],
    ['negative moles', { species: [{ speciesId: 'ion:chloride', moles: -0.01 }] }, 'FAILED'],
    ['nonfinite moles', { species: [{ speciesId: 'ion:chloride', moles: Infinity }] }, 'FAILED'],
    ['missing moles', { species: [{ speciesId: 'ion:chloride' }] }, 'FAILED'],
    ['too concentrated', { species: [{ speciesId: 'ion:chloride', moles: 0.01 }] }, 'UNSUPPORTED'],
    ['overflowing totals', { species: [{ speciesId: 'ion:chloride', moles: Number.MAX_VALUE }, { speciesId: 'ion:chloride', moles: Number.MAX_VALUE }] }, 'UNSUPPORTED'],
    ['underflowing concentration', { volumeL: 100, species: [{ speciesId: 'ion:chloride', moles: Number.MIN_VALUE }] }, 'UNSUPPORTED'],
    ['invalid species collection', { species: {} }, 'FAILED'],
    ['foreign model', { modelId: 'nonideal-pitzer' }, 'UNSUPPORTED'],
    ['unknown solvent modifier', { solventId: 'ethanol' }, 'FAILED'],
    ['unrecognized species modifier', { species: [{ speciesId: 'ion:chloride', moles: 0.0025, activityCoefficient: 0.2 }] }, 'FAILED'],
  ] as const)('rejects %s without publishing pH', (_name, patch, status) => {
    const result = solveEquilibrium(uncheckedContents(patch));
    expect(result.status).toBe(status);
    expect(result).not.toHaveProperty('pH');
    expect(result).not.toHaveProperty('equilibriumSpecies');
  });

  it.each(['HCl', 'ion:hydronium', 'ion:hydroxide', 'ion:acetate', 'ion:ammonium', 'family:carbonate', 'family:phosphate', '__proto__'])(
    'rejects unresolved or non-conserved input identity %s, including zero amounts',
    (speciesId) => {
      const result = solveEquilibrium(uncheckedContents({ species: [{ speciesId, moles: 0 }] }));
      expect(result.status).toBe('UNSUPPORTED');
      if (result.status === 'SUCCEEDED') return;
      expect(result.error.code).toBe('UNSUPPORTED_SPECIES');
    },
  );

  it('enforces ionic strength independently of component concentration', () => {
    const result = solveEquilibrium(uncheckedContents({
      species: [
        { speciesId: 'ion:sodium', moles: 0.005 },
        { speciesId: 'family:ammonia', moles: 0.005 },
      ],
    }));
    expect(result.status).toBe('UNSUPPORTED');
    if (result.status === 'SUCCEEDED') return;
    expect(result.error.detail).toContain('ionic strength');
    expect(result.diagnostics.ionicStrengthMolL as number).toBeGreaterThan(0.100001);
  });

  it('rejects two weak families rather than implying validated mixture chemistry', () => {
    const result = solveEquilibrium(uncheckedContents({
      species: [{ speciesId: 'family:acetate', moles: 0.001 }, { speciesId: 'family:ammonia', moles: 1e-15 }],
    }));
    expect(result.status).toBe('UNSUPPORTED');
  });

  it('requires explicit, supported assumptions and the agreed method', () => {
    const input = inputFor(prepared('hcl'));
    for (const patch of [{ assumptions: [] }, { assumptions: ['NONIDEAL_ACTIVITIES'] }, { methodId: 'curve-lookup' }]) {
      const result = solveEquilibrium({ ...input, ...patch });
      expect(result.status).toBe('UNSUPPORTED');
      expect(result).not.toHaveProperty('pH');
    }
    expect(solveEquilibrium(null as unknown as EquilibriumInput).status).toBe('FAILED');
  });

  it('caps analytical entries to bound work and cannot silently ignore unknown identifiers', () => {
    expect(solveEquilibrium(uncheckedContents({
      species: Array.from({ length: 129 }, () => ({ speciesId: 'ion:chloride', moles: 0 })),
    })).status).toBe('FAILED');
    expect(JSON.parse(solveJson('{"schemaVersion":1,"operation":"equilibrium","input":null}')).status).toBe('FAILED');
  });

  it('reports a failed numerical bracket rather than manufacturing a root', () => {
    expect(bisect((x) => x * x + 1, -2, 2, 1e-12).converged).toBe(false);
    expect(bisect(() => NaN, -2, 2, 1e-12).converged).toBe(false);
    expect(bisect((x) => x - 0.1, 0, 1, 1e-12, 1).converged).toBe(false);
  });
});

describe('preparation is the only reagent-to-inventory authority', () => {
  it('represents strong reagents as dissolved spectator components, not intact acid/base or conserved protons', () => {
    expect(prepared('hcl').species).toEqual([{ speciesId: 'ion:chloride', moles: expect.closeTo(0.0025, 14) }]);
    expect(prepared('naoh').species).toEqual([{ speciesId: 'ion:sodium', moles: expect.closeTo(0.0025, 14) }]);
    expect(prepared('sodium-acetate').species).toEqual([
      { speciesId: 'ion:sodium', moles: expect.closeTo(0.0025, 14) }, { speciesId: 'family:acetate', moles: expect.closeTo(0.0025, 14) },
    ]);
    expect(prepared('ammonium-chloride').species).toEqual([
      { speciesId: 'ion:chloride', moles: expect.closeTo(0.0025, 14) }, { speciesId: 'family:ammonia', moles: expect.closeTo(0.0025, 14) },
    ]);
  });

  it('all catalogue defaults and declared maximum concentrations are supported', () => {
    for (const reagent of getReagentDefinitions()) {
      for (const concentrationMolL of [reagent.defaultConcentrationMolL, reagent.maximumConcentrationMolL]) {
        expect(prepareSolution({ reagentId: reagent.id, volumeL: 0.05, concentrationMolL }).status).toBe('SUCCEEDED');
      }
    }
  });

  it('allows preparing an explicitly unmixed state without fabricating a pH', () => {
    const result = prepareSolution({ reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1, mixing: 'UNMIXED' });
    expect(result.status).toBe('SUCCEEDED');
    expect(result).not.toHaveProperty('pH');
    if (result.status !== 'SUCCEEDED') return;
    expect(result.contents.mixing).toBe('UNMIXED');
    expect(solveEquilibrium(inputFor(result.contents)).status).toBe('UNSUPPORTED');
  });

  it.each([
    { reagentId: 'sulfuric-acid', volumeL: 0.025, concentrationMolL: 0.1 },
    { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.2 },
    { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: -1 },
    { reagentId: 'water', volumeL: 0.025, concentrationMolL: 55.5 },
    { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1, temperatureK: null },
    { reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1, mixing: null },
  ])('rejects invalid preparation without returning inventory: %j', (input) => {
    const result = prepareSolution(input as PreparationInput);
    expect(result.status).not.toBe('SUCCEEDED');
    expect(result).not.toHaveProperty('contents');
  });

  it('isolates returned catalogue data and prepared inventory from later mutations', () => {
    const definitions = getReagentDefinitions();
    (definitions[1].components as { speciesId: string; molesPerMole: number }[])[0].molesPerMole = 99;
    const contents = prepared('hcl');
    (contents.species as { speciesId: string; moles: number }[])[0].moles = 42;
    expect(prepared('hcl').species[0].moles).toBeCloseTo(0.0025, 14);
  });
});

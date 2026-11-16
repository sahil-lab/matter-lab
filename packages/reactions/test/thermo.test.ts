import { GAS_CONSTANT_J_PER_MOL_K, STANDARD_TEMPERATURE_K } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import {
  ENTHALPY_UNIT,
  ENTROPY_UNIT,
  KINETIC_MODELS,
  THERMO_DATA_SOURCES,
  THERMO_OMITTED_ROWS,
  THERMO_SPECIES,
  THERMO_VALIDATED_SPAN_K,
  balanceEquation,
  findThermoSpecies,
  hillFormula,
  lookupThermoSpecies,
  parseEquation,
  parseFormula,
  reactionThermodynamics,
  reverseEquation,
  scaleEquation,
} from '../src';
import type { Phase, ThermoSpecies } from '../src';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function species(formula: string, phase: Phase): ThermoSpecies {
  const found = findThermoSpecies(formula, phase);
  if (!found) throw new Error(`${formula}(${phase}) is not in the table`);
  return found;
}
const hf = (formula: string, phase: Phase): number => species(formula, phase).deltaHf298!.value;
const s0 = (formula: string, phase: Phase): number => species(formula, phase).s298!.value;

describe('thermodynamic species table', () => {
  it('holds more than 40 species across gases, liquids, solids and aqueous ions', () => {
    expect(THERMO_SPECIES.length).toBeGreaterThanOrEqual(40);
    for (const phase of ['g', 'l', 's', 'aq'] as const) {
      expect(THERMO_SPECIES.filter((sp) => sp.phase === phase).length, phase).toBeGreaterThan(3);
    }
    expect(THERMO_SPECIES.filter((sp) => sp.phase === 'aq' && sp.parsed.charge !== 0).length).toBeGreaterThan(20);
  });

  it('gives every species a provenance with an https URL, a retrieval date and a citation', () => {
    for (const sp of THERMO_SPECIES) {
      const p = sp.provenance;
      expect(p.source.length, sp.id).toBeGreaterThan(0);
      expect(p.url, sp.id).toMatch(/^https:\/\/\S+$/);
      expect(p.retrieved, sp.id).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(p.retrieved!)), sp.id).toBe(false);
      expect(p.citations?.length ?? 0, sp.id).toBeGreaterThan(0);
      for (const c of p.citations!) expect(c.title.length, sp.id).toBeGreaterThan(0);
      expect(p.notes, sp.id).toMatch(/snapshot packages\/reactions\/data\/sources\//);
      expect(p.notes, sp.id).toMatch(/SHA-256 of the page as retrieved: [0-9a-f]{64}/);
    }
  });

  it('gives every value its unit, the reference label and its own provenance', () => {
    for (const sp of THERMO_SPECIES) {
      // Every species in the table has at least an enthalpy of formation.
      expect(sp.deltaHf298, sp.id).not.toBeNull();
      for (const [q, unit] of [
        [sp.deltaHf298, ENTHALPY_UNIT],
        [sp.s298, ENTROPY_UNIT],
      ] as const) {
        if (!q) continue;
        expect(q.unit, sp.id).toBe(unit);
        expect(q.evidence, sp.id).toBe('reference');
        expect(Number.isFinite(q.value), sp.id).toBe(true);
        expect(q.provenance?.url, sp.id).toMatch(/^https:\/\//);
        expect(q.provenance?.retrieved, sp.id).toMatch(ISO_DATE);
        expect(q.provenance?.citations?.length ?? 0, sp.id).toBeGreaterThan(0);
        if (q.uncertainty !== undefined) expect(q.uncertainty, sp.id).toBeGreaterThanOrEqual(0);
      }
    }
    expect(ENTHALPY_UNIT).toBe('kJ/mol');
    expect(ENTROPY_UNIT).toBe('J/(mol K)');
  });

  it('has unique ids, and a formula that parses to the stored composition', () => {
    expect(new Set(THERMO_SPECIES.map((sp) => sp.id)).size).toBe(THERMO_SPECIES.length);
    const keys = new Set<string>();
    for (const sp of THERMO_SPECIES) {
      expect(sp.id).toBe(`${sp.formula}(${sp.phase})`);
      expect(parseFormula(sp.formula)).toEqual(sp.parsed);
      // No two entries share composition, charge and phase, so a lookup can never be ambiguous.
      const key = `${hillFormula(sp.parsed)}|${sp.phase}`;
      expect(keys.has(key), sp.id).toBe(false);
      keys.add(key);
      expect(sp.name.length, sp.id).toBeGreaterThan(0);
    }
  });

  it('only carries a charge on aqueous species', () => {
    for (const sp of THERMO_SPECIES) if (sp.parsed.charge !== 0) expect(sp.phase, sp.id).toBe('aq');
  });

  it('follows the conventions of the source: element reference states and the hydrogen ion are exactly zero', () => {
    for (const id of ['H2(g)', 'O2(g)', 'N2(g)', 'C(s)', 'Na(s)', 'Hg(l)', 'Br2(l)', 'I2(s)', 'S(s)', 'Cl2(g)', 'Ar(g)']) {
      const sp = THERMO_SPECIES.find((x) => x.id === id)!;
      expect(sp.deltaHf298, id).toMatchObject({ value: 0, uncertainty: 0 });
      // The entropy of an element is a measured quantity, not a convention.
      expect(sp.s298!.value, id).toBeGreaterThan(0);
      expect(sp.s298!.uncertainty, id).toBeGreaterThan(0);
    }
    const proton = species('H+', 'aq');
    expect(proton.deltaHf298).toMatchObject({ value: 0, uncertainty: 0 });
    expect(proton.s298).toMatchObject({ value: 0, uncertainty: 0 });
    // Because ionic entropies are relative to H+(aq), some are negative. That is the convention, not an error.
    expect(THERMO_SPECIES.some((sp) => sp.phase === 'aq' && sp.s298!.value < 0)).toBe(true);
    // Nothing else is exactly zero.
    for (const sp of THERMO_SPECIES) {
      if (sp.deltaHf298!.value === 0) expect(sp.deltaHf298!.uncertainty, sp.id).toBe(0);
      else if (sp.deltaHf298!.uncertainty !== undefined) expect(sp.deltaHf298!.uncertainty, sp.id).toBeGreaterThan(0);
    }
  });

  it('records which graphite, phosphorus, sulfur and tin the solid entries are', () => {
    expect(species('C', 's').stateDetail).toBe('graphite');
    expect(species('P', 's').stateDetail).toBe('white');
    expect(species('S', 's').stateDetail).toBe('rhombic');
    expect(species('Sn', 's').stateDetail).toBe('white');
    expect(species('CO2', 'aq').stateDetail).toBe('undissociated');
  });

  it('describes its sources, their citations and their conventions', () => {
    expect(THERMO_DATA_SOURCES.map((s) => s.id)).toEqual(['codata-key-values', 'nist-webbook']);
    const [codata, webbook] = THERMO_DATA_SOURCES;
    expect(codata!.citation).toMatchObject({ authors: 'Cox, J. D., Wagman, D. D., and Medvedev, V. A.', title: 'CODATA Key Values for Thermodynamics', year: 1989 });
    expect(codata!.url).toBe('https://www.codata.info/resources/databases/key1.html');
    expect(codata!.statements).toContain('The standard state pressure is 100000 Pa (1 bar).');
    expect(webbook!.citation.doi).toBe('10.18434/T4D303');
    expect(webbook!.license).toMatch(/copyright by the U\.S\. Secretary of Commerce/);
    for (const source of THERMO_DATA_SOURCES) {
      expect(source.retrieved).toMatch(ISO_DATE);
      expect(source.conventions.length).toBeGreaterThan(2);
      expect(source.speciesCount).toBe(THERMO_SPECIES.filter((sp) => sp.source === source.id).length);
    }
    expect(THERMO_DATA_SOURCES.reduce((n, s) => n + s.speciesCount, 0)).toBe(THERMO_SPECIES.length);
    // The one row of the CODATA table that is left out is listed with its reason, not silently dropped.
    expect(THERMO_OMITTED_ROWS).toHaveLength(1);
    expect(THERMO_OMITTED_ROWS[0]!.reason).toMatch(/fractional/);
  });

  it('cites the original reference the WebBook lists, and the WebBook itself', () => {
    const methane = species('CH4', 'g');
    expect(methane.source).toBe('nist-webbook');
    expect(methane.deltaHf298!.provenance!.citations!.map((c) => c.title)).toEqual([
      'NIST-JANAF Themochemical Tables, Fourth Edition',
      'NIST Chemistry WebBook, NIST Standard Reference Database Number 69',
    ]);
    expect(methane.deltaHf298!.provenance!.notes).toMatch(/row "ΔfH°gas"; method Review; reference Chase, 1998/);
    // An average computed by the WebBook is cited to every determination that went into it.
    const ethanol = species('C2H5OH', 'l');
    const cited = ethanol.deltaHf298!.provenance!.citations!.map((c) => c.authors);
    expect(cited).toHaveLength(8);
    expect(cited).toContain('Chao, J.; Rossini, F.D.');
    expect(ethanol.deltaHf298!.provenance!.notes).toMatch(/averaged by the source from/);
    for (const sp of THERMO_SPECIES.filter((x) => x.source === 'nist-webbook')) {
      const titles = sp.provenance.citations!.map((c) => `${c.title} ${c.source ?? ''}`);
      expect(titles.some((t) => t.includes('NIST Chemistry WebBook')), sp.id).toBe(true);
      expect(titles.some((t) => !t.includes('NIST Chemistry WebBook')), sp.id).toBe(true);
      expect(sp.provenance.license, sp.id).toMatch(/All rights reserved/);
    }
  });
});

describe('findThermoSpecies and lookupThermoSpecies', () => {
  it('finds a species by formula and phase, whatever the spelling', () => {
    expect(findThermoSpecies('H2O', 'l')?.name).toBe('water');
    expect(findThermoSpecies('H2O', 'g')?.id).toBe('H2O(g)');
    expect(findThermoSpecies('OH-', 'aq')?.id).toBe('OH-(aq)');
    expect(findThermoSpecies('HO-', 'aq')?.id).toBe('OH-(aq)');
    expect(findThermoSpecies('SO4-2', 'aq')?.id).toBe('SO4^2-(aq)');
    expect(findThermoSpecies('SO\u2084\u00b2\u207b', 'aq')?.id).toBe('SO4^2-(aq)');
    expect(findThermoSpecies('CH3CH2OH', 'l')?.name).toBe('ethanol');
    expect(findThermoSpecies('CaO2H2', 's')?.id).toBe('Ca(OH)2(s)');
  });

  it('does not confuse an ion with the neutral species or with another charge', () => {
    expect(findThermoSpecies('Na', 's')?.id).toBe('Na(s)');
    expect(findThermoSpecies('Na+', 'aq')?.id).toBe('Na+(aq)');
    expect(findThermoSpecies('Na+', 's')).toBeUndefined();
    expect(findThermoSpecies('Hg^2+', 'aq')?.id).toBe('Hg^2+(aq)');
    expect(findThermoSpecies('Hg2^2+', 'aq')?.id).toBe('Hg2^2+(aq)');
    expect(findThermoSpecies('Cu+', 'aq')).toBeUndefined();
  });

  it('returns undefined for what is not tabulated', () => {
    expect(findThermoSpecies('H2O', 's')).toBeUndefined();
    expect(findThermoSpecies('C6H12O6', 's')).toBeUndefined();
    expect(findThermoSpecies('NaCl', 'aq')).toBeUndefined();
    expect(findThermoSpecies('Fe', 's')).toBeUndefined();
  });

  it('uses the only tabulated phase when none is given, and refuses to choose between several', () => {
    expect(findThermoSpecies('CH4')?.id).toBe('CH4(g)');
    expect(findThermoSpecies('NaCl')?.id).toBe('NaCl(s)');
    expect(findThermoSpecies('H2O')).toBeUndefined();
    expect(lookupThermoSpecies('H2O')).toMatchObject({ status: 'phase-required', availablePhases: ['l', 'g'] });
    expect(lookupThermoSpecies('CH4')).toMatchObject({ status: 'found', phaseAssumed: true, availablePhases: ['g'] });
    expect(lookupThermoSpecies('CH4', 'g')).toMatchObject({ status: 'found', phaseAssumed: false });
    expect(lookupThermoSpecies('CH4', 'l')).toMatchObject({ status: 'phase-not-tabulated', availablePhases: ['g'] });
    expect(lookupThermoSpecies('XeF4', 's')).toMatchObject({ status: 'not-tabulated', availablePhases: [] });
  });

  it('throws for a formula it cannot read', () => {
    expect(() => findThermoSpecies('h2o')).toThrow(/capital letter/);
  });
});

describe('reactionThermodynamics: sign conventions and units', () => {
  it("applies Hess's law: products minus reactants, each times its coefficient", () => {
    const r = reactionThermodynamics('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    expect(r.status).toBe('ok');
    expect(r.temperatureK).toBe(STANDARD_TEMPERATURE_K);
    expect(r.deltaH!.value).toBeCloseTo(hf('CO2', 'g') + 2 * hf('H2O', 'l') - hf('CH4', 'g') - 2 * hf('O2', 'g'), 9);
    expect(r.deltaS!.value).toBeCloseTo(s0('CO2', 'g') + 2 * s0('H2O', 'l') - s0('CH4', 'g') - 2 * s0('O2', 'g'), 9);
    expect(r.deltaH!.unit).toBe('kJ/mol');
    expect(r.deltaS!.unit).toBe('J/(mol K)');
    expect(r.deltaG!.unit).toBe('kJ/mol');
  });

  it('gives a negative enthalpy for exothermic combustions', () => {
    for (const text of [
      'CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)',
      '2 H2(g) + O2(g) -> 2 H2O(l)',
      'C(s) + O2(g) -> CO2(g)',
      '2 CO(g) + O2(g) -> 2 CO2(g)',
      'C2H5OH(l) + 3 O2(g) -> 2 CO2(g) + 3 H2O(l)',
      'C2H2(g) + 5/2 O2(g) -> 2 CO2(g) + H2O(l)',
      '2 Mg(s) + O2(g) -> 2 MgO(s)',
    ]) {
      const r = reactionThermodynamics(text);
      expect(r.status, text).toBe('ok');
      expect(r.deltaH!.value, text).toBeLessThan(0);
      expect(r.deltaG!.value, text).toBeLessThan(0);
      expect(r.spontaneity, text).toBe('product-favoured');
      expect(r.evidence, text).toBe('computed');
    }
  });

  it('gives a positive enthalpy for endothermic processes', () => {
    expect(reactionThermodynamics('H2O(l) -> H2O(g)').deltaH!.value).toBeGreaterThan(0);
    expect(reactionThermodynamics('2 HgO(s) -> 2 Hg(l) + O2(g)').deltaH!.value).toBeGreaterThan(0);
    expect(reactionThermodynamics('N2O4(g) <=> 2 NO2(g)').deltaH!.value).toBeGreaterThan(0);
    expect(reactionThermodynamics('N2(g) + O2(g) -> 2 NO(g)').spontaneity).toBe('reactant-favoured');
  });

  it('gives a positive entropy when gas is produced and a negative one when it is consumed', () => {
    expect(reactionThermodynamics('H2O(l) -> H2O(g)').deltaS!.value).toBeGreaterThan(0);
    expect(reactionThermodynamics('2 HgO(s) -> 2 Hg(l) + O2(g)').deltaS!.value).toBeGreaterThan(0);
    expect(reactionThermodynamics('N2(g) + 3 H2(g) <=> 2 NH3(g)').deltaS!.value).toBeLessThan(0);
    expect(reactionThermodynamics('2 H2(g) + O2(g) -> 2 H2O(l)').deltaS!.value).toBeLessThan(0);
  });

  it('keeps the Gibbs energy consistent with ΔH − TΔS and with −RT ln K, minding the J/kJ factor', () => {
    for (const [text, temperature] of [
      ['N2(g) + 3 H2(g) <=> 2 NH3(g)', 298.15],
      ['N2(g) + 3 H2(g) <=> 2 NH3(g)', 350],
      ['N2O4(g) <=> 2 NO2(g)', 320],
      ['H+(aq) + OH-(aq) -> H2O(l)', 298.15],
      ['NaCl(s) -> Na+(aq) + Cl-(aq)', 310],
      ['Zn(s) + Cu^2+(aq) -> Zn^2+(aq) + Cu(s)', 298.15],
    ] as const) {
      const r = reactionThermodynamics(text, temperature);
      expect(r.status, text).toBe('ok');
      expect(r.temperatureK).toBe(temperature);
      const g = r.deltaH!.value - (temperature * r.deltaS!.value) / 1000;
      expect(r.deltaG!.value, text).toBeCloseTo(g, 9);
      expect(r.lnK!, text).toBeCloseTo((-r.deltaG!.value * 1000) / (GAS_CONSTANT_J_PER_MOL_K * temperature), 9);
      expect(r.equilibriumConstant, text).toBe(Math.exp(r.lnK!));
      expect(r.log10K!, text).toBeCloseTo(r.lnK! / Math.LN10, 12);
      // A negative Gibbs energy must mean K > 1.
      expect(Math.sign(r.lnK!), text).toBe(-Math.sign(r.deltaG!.value));
    }
  });

  it('flips every sign when the reaction is reversed', () => {
    for (const text of ['N2(g) + 3 H2(g) <=> 2 NH3(g)', 'CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)', 'AgCl(s) -> Ag+(aq) + Cl-(aq)']) {
      const forward = reactionThermodynamics(text, 310);
      const backward = reactionThermodynamics(reverseEquation(parseEquation(text)), 310);
      expect(backward.status).toBe('ok');
      expect(backward.deltaH!.value).toBeCloseTo(-forward.deltaH!.value, 9);
      expect(backward.deltaS!.value).toBeCloseTo(-forward.deltaS!.value, 9);
      expect(backward.deltaG!.value).toBeCloseTo(-forward.deltaG!.value, 9);
      expect(backward.lnK!).toBeCloseTo(-forward.lnK!, 9);
      // The uncertainty does not depend on the direction.
      if (forward.deltaG!.uncertainty === undefined) expect(backward.deltaG!.uncertainty).toBeUndefined();
      else expect(backward.deltaG!.uncertainty).toBeCloseTo(forward.deltaG!.uncertainty, 12);
    }
    const forward = reactionThermodynamics('AgCl(s) -> Ag+(aq) + Cl-(aq)');
    const backward = reactionThermodynamics('Ag+(aq) + Cl-(aq) -> AgCl(s)');
    expect(forward.spontaneity).toBe('reactant-favoured');
    expect(backward.spontaneity).toBe('product-favoured');
    expect(forward.equilibriumConstant! * backward.equilibriumConstant!).toBeCloseTo(1, 9);
  });

  it('scales extensive quantities with the coefficients, and K as a power', () => {
    const text = 'N2(g) + 3 H2(g) <=> 2 NH3(g)';
    const once = reactionThermodynamics(text, 320);
    for (const factor of [2, 0.5, 3]) {
      const scaled = reactionThermodynamics(scaleEquation(parseEquation(text), factor), 320);
      expect(scaled.status).toBe('ok');
      expect(scaled.deltaH!.value).toBeCloseTo(factor * once.deltaH!.value, 9);
      expect(scaled.deltaS!.value).toBeCloseTo(factor * once.deltaS!.value, 9);
      expect(scaled.deltaG!.value).toBeCloseTo(factor * once.deltaG!.value, 9);
      expect(scaled.lnK!).toBeCloseTo(factor * once.lnK!, 9);
      expect(scaled.deltaH!.uncertainty!).toBeCloseTo(factor * once.deltaH!.uncertainty!, 9);
      expect(scaled.equilibriumConstant! / once.equilibriumConstant! ** factor).toBeCloseTo(1, 9);
    }
  });

  it('reproduces an enthalpy of formation for a formation reaction', () => {
    expect(reactionThermodynamics('H2(g) + 1/2 O2(g) -> H2O(l)').deltaH!.value).toBeCloseTo(hf('H2O', 'l'), 12);
    expect(reactionThermodynamics('1/2 N2(g) + 3/2 H2(g) -> NH3(g)').deltaH!.value).toBeCloseTo(hf('NH3', 'g'), 12);
    expect(reactionThermodynamics('C(s) + 2 H2(g) -> CH4(g)').deltaH!.value).toBeCloseTo(hf('CH4', 'g'), 12);
    expect(reactionThermodynamics('Na(s) + 1/2 Cl2(g) -> NaCl(s)').deltaH!.value).toBeCloseTo(hf('NaCl', 's'), 12);
  });

  it('obeys the additivity of reactions', () => {
    // C + O2 -> CO2 is the sum of C + 1/2 O2 -> CO and CO + 1/2 O2 -> CO2.
    const total = reactionThermodynamics('C(s) + O2(g) -> CO2(g)');
    const first = reactionThermodynamics('C(s) + 1/2 O2(g) -> CO(g)');
    const second = reactionThermodynamics('CO(g) + 1/2 O2(g) -> CO2(g)');
    expect(first.deltaH!.value + second.deltaH!.value).toBeCloseTo(total.deltaH!.value, 9);
    expect(first.deltaG!.value + second.deltaG!.value).toBeCloseTo(total.deltaG!.value, 9);
    expect(first.lnK! + second.lnK!).toBeCloseTo(total.lnK!, 9);
  });

  it('treats aqueous ions by the hydrogen-ion convention of the source', () => {
    const neutralisation = reactionThermodynamics('H+(aq) + OH-(aq) -> H2O(l)');
    expect(neutralisation.deltaH!.value).toBeCloseTo(hf('H2O', 'l') - hf('OH-', 'aq'), 12);
    expect(neutralisation.deltaH!.value).toBeLessThan(0);
    expect(neutralisation.assumptions.join(' ')).toMatch(/H\+\(aq\) has an enthalpy of formation of 0 and an entropy of 0/);
    // Dissolving hydrogen chloride gas gives H+(aq) + Cl-(aq): only the chloride ion contributes on the product side.
    expect(reactionThermodynamics('HCl(g) -> H+(aq) + Cl-(aq)').deltaH!.value).toBeCloseTo(hf('Cl-', 'aq') - hf('HCl', 'g'), 12);
    expect(reactionThermodynamics('2 H2(g) + O2(g) -> 2 H2O(l)').assumptions.join(' ')).not.toMatch(/Aqueous ions/);
  });

  it('agrees with the reaction enthalpies printed on the IUPAC kinetic data sheets', () => {
    // An independent source: the enthalpy the evaluators print for each reaction, read from the saved excerpt.
    const checked: string[] = [];
    for (const model of KINETIC_MODELS) {
      const printed = model.asPublished?.reactionEnthalpyKJPerMol;
      const r = reactionThermodynamics(model.equation);
      if (printed === undefined || r.status !== 'ok') continue;
      expect(Math.abs(r.deltaH!.value - printed), model.id).toBeLessThan(0.5);
      checked.push(model.id);
    }
    expect(checked.sort()).toEqual(['no-o2-termolecular', 'no-o3', 'o-o3']);
  });
});

describe('reactionThermodynamics: uncertainties', () => {
  it('combines the stated uncertainties in quadrature, weighted by the coefficients', () => {
    const r = reactionThermodynamics('2 H2(g) + O2(g) -> 2 H2O(l)');
    const water = species('H2O', 'l');
    expect(r.deltaH!.uncertainty).toBeCloseTo(2 * water.deltaHf298!.uncertainty!, 12);
    const expectedS = Math.hypot(2 * water.s298!.uncertainty!, 2 * species('H2', 'g').s298!.uncertainty!, species('O2', 'g').s298!.uncertainty!);
    expect(r.deltaS!.uncertainty).toBeCloseTo(expectedS, 12);
    expect(r.deltaG!.uncertainty).toBeCloseTo(Math.hypot(r.deltaH!.uncertainty!, (STANDARD_TEMPERATURE_K * expectedS) / 1000), 12);
    expect(r.assumptions.join(' ')).toMatch(/combined in quadrature as if they were independent/);
  });

  it('gives no uncertainty, and says why, when a source prints none for a species', () => {
    const r = reactionThermodynamics('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    expect(r.deltaH!.uncertainty).toBeUndefined();
    expect(r.deltaG!.uncertainty).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/No uncertainty is given for the reaction enthalpy because the source prints none for CH4\(g\)/);
  });

  it('lets a species written on both sides cancel exactly, in the value and in the uncertainty', () => {
    const plain = reactionThermodynamics('AgCl(s) -> Ag+(aq) + Cl-(aq)');
    const withSolvent = reactionThermodynamics('AgCl(s) + 55 H2O(l) -> Ag+(aq) + Cl-(aq) + 55 H2O(l)');
    expect(withSolvent.status).toBe('ok');
    for (const key of ['deltaH', 'deltaS', 'deltaG'] as const) {
      expect(withSolvent[key]!.value).toBeCloseTo(plain[key]!.value, 12);
      expect(withSolvent[key]!.uncertainty).toBeCloseTo(plain[key]!.uncertainty!, 12);
    }
    // A species without an entropy does not matter either, as long as it cancels.
    const spectator = reactionThermodynamics('H2(g) + 1/2 O2(g) + C2H6(g) -> H2O(l) + C2H6(g)');
    expect(spectator.status).toBe('ok');
    expect(spectator.deltaG!.value).toBeCloseTo(reactionThermodynamics('H2(g) + 1/2 O2(g) -> H2O(l)').deltaG!.value, 12);
  });

  it('calls the direction undecided when the Gibbs energy is smaller than RT or than its uncertainty', () => {
    // Liquid water and its vapour are close to equilibrium near the boiling point.
    const boiling = reactionThermodynamics('H2O(l) -> H2O(g)', 370);
    expect(Math.abs(boiling.deltaG!.value)).toBeLessThan((GAS_CONSTANT_J_PER_MOL_K * 370) / 1000);
    expect(boiling.spontaneity).toBe('near-equilibrium');
    expect(reactionThermodynamics('H2O(l) -> H2O(g)', 298.15).spontaneity).toBe('reactant-favoured');
    expect(boiling.assumptions.join(' ')).toMatch(/says nothing about how fast the reaction is or whether it proceeds at all/);
  });

  it('warns when values from two reference tables are combined', () => {
    expect(reactionThermodynamics('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)').warnings.join(' ')).toMatch(/Values from 2 reference tables are combined/);
    expect(reactionThermodynamics('2 H2(g) + O2(g) -> 2 H2O(l)').warnings).toEqual([]);
  });

  it('labels its results and records what they were computed from', () => {
    const r = reactionThermodynamics('2 H2(g) + O2(g) -> 2 H2O(l)');
    for (const q of [r.deltaH!, r.deltaS!, r.deltaG!]) {
      expect(q.evidence).toBe('computed');
      expect(q.provenance?.source).toBe('@matterlab/reactions');
      expect(q.provenance?.notes).toMatch(/Table entries used: H2\(g\), O2\(g\), H2O\(l\)/);
      expect(q.provenance?.citations?.[0]?.title).toBe('CODATA Key Values for Thermodynamics');
    }
    expect(r.terms.map((t) => [t.role, t.term, t.coefficient, t.speciesId])).toEqual([
      ['reactant', 'H2(g)', 2, 'H2(g)'],
      ['reactant', 'O2(g)', 1, 'O2(g)'],
      ['product', 'H2O(l)', 2, 'H2O(l)'],
    ]);
  });
});

describe('reactionThermodynamics: temperature away from 298.15 K', () => {
  const ammonia = 'N2(g) + 3 H2(g) <=> 2 NH3(g)';

  it('reports the 298.15 K enthalpy and entropy at every temperature and states the approximation', () => {
    const reference = reactionThermodynamics(ammonia);
    const warm = reactionThermodynamics(ammonia, 350);
    expect(warm.deltaH!.value).toBe(reference.deltaH!.value);
    expect(warm.deltaS!.value).toBe(reference.deltaS!.value);
    expect(warm.deltaG!.value).not.toBe(reference.deltaG!.value);
    expect(reference.assumptions.join(' ')).toMatch(/at 298\.15 K, the temperature of the tabulated data/);
    expect(warm.assumptions.join(' ')).toMatch(/taken as independent of temperature/);
    expect(warm.assumptions.join(' ')).toMatch(/no phase change between 298\.15 K and T is considered/);
  });

  it('shifts an exothermic equilibrium towards the reactants on heating', () => {
    expect(reactionThermodynamics(ammonia, 350).lnK!).toBeLessThan(reactionThermodynamics(ammonia, 300).lnK!);
    expect(reactionThermodynamics('N2O4(g) <=> 2 NO2(g)', 350).lnK!).toBeGreaterThan(reactionThermodynamics('N2O4(g) <=> 2 NO2(g)', 300).lnK!);
  });

  it('stays silent close to 298.15 K, warns further away, and relabels the result far away', () => {
    const near = reactionThermodynamics(ammonia, 310);
    expect(near.warnings).toEqual([]);
    expect(near.withinValidatedRange).toBe(true);
    expect(near.evidence).toBe('computed');

    const moderate = reactionThermodynamics(ammonia, 380);
    expect(moderate.status).toBe('ok');
    expect(moderate.warnings.join(' ')).toMatch(/380 K is 81\.[89] K away from 298\.15 K/);
    expect(moderate.withinValidatedRange).toBe(true);
    expect(moderate.evidence).toBe('computed');

    const far = reactionThermodynamics(ammonia, 700);
    expect(far.status).toBe('ok');
    expect(far.warnings[0]).toMatch(/^FAR FROM 298\.15 K: 700 K is 401\.[89] K away/);
    expect(far.warnings[0]).toMatch(/the size of the error is unknown/);
    expect(far.withinValidatedRange).toBe(false);
    expect(far.evidence).toBe('rule-based');
    expect(far.deltaG!.evidence).toBe('rule-based');
    // The enthalpy and entropy are still the tabulated 298.15 K values, and are labelled as such.
    expect(far.deltaH!.evidence).toBe('computed');
    expect(far.deltaS!.evidence).toBe('computed');

    const cold = reactionThermodynamics(ammonia, STANDARD_TEMPERATURE_K - THERMO_VALIDATED_SPAN_K - 1);
    expect(cold.withinValidatedRange).toBe(false);
    expect(cold.warnings[0]).toMatch(/^FAR FROM 298\.15 K/);
  });

  it('refuses to pretend that aqueous standard states exist where water is not liquid', () => {
    const hot = reactionThermodynamics('H+(aq) + OH-(aq) -> H2O(l)', 400);
    expect(hot.status).toBe('ok');
    expect(hot.warnings[0]).toMatch(/^OUTSIDE THE LIQUID RANGE OF WATER: H\+\(aq\), OH-\(aq\), H2O\(l\)/);
    expect(hot.withinValidatedRange).toBe(false);
    expect(hot.evidence).toBe('rule-based');
    const frozen = reactionThermodynamics('NaCl(s) -> Na+(aq) + Cl-(aq)', 260);
    expect(frozen.warnings[0]).toMatch(/^OUTSIDE THE LIQUID RANGE OF WATER/);
    expect(frozen.withinValidatedRange).toBe(false);
    // Gas-phase reactions are not affected by this check.
    expect(reactionThermodynamics(ammonia, 350).warnings.join(' ')).not.toMatch(/LIQUID RANGE/);
  });

  it('does not report an equilibrium constant that a number cannot hold', () => {
    const r = reactionThermodynamics('4 Al(s) + 3 O2(g) -> 2 Al2O3(s)');
    expect(r.status).toBe('ok');
    expect(r.lnK!).toBeGreaterThan(700);
    expect(r.equilibriumConstant).toBeUndefined();
    expect(Number.isFinite(r.log10K!)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/too large to be written as an ordinary number/);
  });

  it('rejects a temperature that is not physical', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reactionThermodynamics(ammonia, bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('reactionThermodynamics: what it will not compute', () => {
  it('computes nothing for an unbalanced equation and reports the imbalance', () => {
    const r = reactionThermodynamics('H2(g) + O2(g) -> H2O(l)');
    expect(r.status).toBe('unbalanced');
    expect(r.evidence).toBe('unsupported');
    expect(r.deltaH).toBeUndefined();
    expect(r.deltaG).toBeUndefined();
    expect(r.lnK).toBeUndefined();
    expect(r.spontaneity).toBeUndefined();
    expect(r.conservation).toEqual({ balanced: false, elementImbalance: { H: 0, O: -1 }, chargeImbalance: 0 });
    expect(r.warnings[0]).toMatch(/not balanced \(products minus reactants: O -1\)/);
    // Balancing first makes it computable.
    expect(reactionThermodynamics(balanceEquation('H2(g) + O2(g) -> H2O(l)').equation!).status).toBe('ok');
  });

  it('computes nothing when the charge is not conserved', () => {
    const r = reactionThermodynamics('Zn(s) + Ag+(aq) -> Zn^2+(aq) + Ag(s)');
    expect(r.status).toBe('unbalanced');
    expect(r.warnings[0]).toMatch(/charge \+1/);
  });

  it('computes nothing when a species is not in the table, and names it', () => {
    const r = reactionThermodynamics('Fe(s) + S(s) -> FeS(s)');
    expect(r.status).toBe('missing-data');
    expect(r.missingSpecies).toEqual(['Fe(s)', 'FeS(s)']);
    expect(r.deltaH).toBeUndefined();
    expect(r.deltaS).toBeUndefined();
    expect(r.equilibriumConstant).toBeUndefined();
    expect(r.evidence).toBe('unsupported');
    expect(r.warnings).toEqual(['Fe(s) is not in the table.', 'FeS(s) is not in the table.']);
    expect(r.terms.map((t) => t.lookup)).toEqual(['not-tabulated', 'found', 'not-tabulated']);
  });

  it('says which phases exist when the requested one does not, and how to write a dissolved electrolyte', () => {
    const r = reactionThermodynamics('NaCl(aq) + AgNO3(aq) -> AgCl(s) + NaNO3(aq)');
    expect(r.status).toBe('missing-data');
    expect(r.missingSpecies).toEqual(['NaCl(aq)', 'AgNO3(aq)', 'NaNO3(aq)']);
    expect(r.warnings[0]).toMatch(/NaCl\(aq\) is not in the table; this substance is tabulated only as \(s\)\. Dissolved electrolytes are tabulated as their ions/);
    // Written as the net ionic equation, the same precipitation is covered.
    expect(reactionThermodynamics('Ag+(aq) + Cl-(aq) -> AgCl(s)').status).toBe('ok');
  });

  it('cannot evaluate a half-reaction', () => {
    const r = reactionThermodynamics('Cu^2+(aq) + 2 e- -> Cu(s)');
    expect(r.status).toBe('missing-data');
    expect(r.missingSpecies).toEqual(['e-']);
    expect(r.warnings.join(' ')).toMatch(/no entry for the electron, so a half-reaction cannot be evaluated/);
  });

  it('asks for a phase instead of guessing one', () => {
    const r = reactionThermodynamics('2 H2 + O2 -> 2 H2O');
    expect(r.status).toBe('ambiguous-phase');
    expect(r.deltaH).toBeUndefined();
    expect(r.evidence).toBe('unsupported');
    expect(r.warnings.join(' ')).toMatch(/H2O is tabulated in several phases: \(l\), \(g\)\. Add a phase label/);
    expect(r.terms.find((t) => t.term === 'H2O')).toMatchObject({ lookup: 'phase-required', availablePhases: ['l', 'g'] });
  });

  it('says so when it had to assume the only tabulated phase', () => {
    const r = reactionThermodynamics('N2 + 3 H2 -> 2 NH3');
    expect(r.status).toBe('ok');
    expect(r.warnings).toContain('No phase label was given for N2, H2, NH3. Each is tabulated in one phase only, which was used: N2(g), H2(g), NH3(g).');
    expect(r.terms.every((t) => t.phaseAssumed)).toBe(true);
    expect(r.deltaH!.value).toBe(reactionThermodynamics('N2(g) + 3 H2(g) -> 2 NH3(g)').deltaH!.value);
  });

  it('gives the enthalpy alone when an entropy is missing, and says what is missing', () => {
    const r = reactionThermodynamics('C2H6(g) + 7/2 O2(g) -> 2 CO2(g) + 3 H2O(l)');
    expect(r.status).toBe('partial');
    expect(r.missingSpecies).toEqual([]);
    expect(r.missingEntropy).toEqual(['C2H6(g)']);
    expect(r.deltaH!.value).toBeCloseTo(2 * hf('CO2', 'g') + 3 * hf('H2O', 'l') - hf('C2H6', 'g'), 9);
    expect(r.deltaH!.value).toBeLessThan(0);
    expect(r.deltaS).toBeUndefined();
    expect(r.deltaG).toBeUndefined();
    expect(r.lnK).toBeUndefined();
    expect(r.equilibriumConstant).toBeUndefined();
    expect(r.spontaneity).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/no standard entropy for C2H6\(g\).*Only the reaction enthalpy is given/);
    // Exactly the three species the catalogue names are affected.
    expect(THERMO_SPECIES.filter((sp) => sp.s298 === null).map((sp) => sp.id)).toEqual(['C2H6(g)', 'C3H8(g)', 'C6H6(g)']);
  });

  it('warns that a composition can belong to more than one compound', () => {
    const r = reactionThermodynamics('C2H6O(l) + 3 O2(g) -> 2 CO2(g) + 3 H2O(l)');
    expect(r.status).toBe('ok');
    expect(r.warnings.join(' ')).toMatch(/C2H6O\(l\) was matched to ethanol\. The composition C2H6O is shared by ethanol and dimethyl ether/);
  });

  it('passes syntax errors through', () => {
    expect(() => reactionThermodynamics('H2 + O2')).toThrow(/No reaction arrow/);
  });
});

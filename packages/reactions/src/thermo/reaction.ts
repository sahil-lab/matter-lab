import { GAS_CONSTANT_J_PER_MOL_K, STANDARD_TEMPERATURE_K } from '@matterlab/core';
import type { Citation, EvidenceLevel, Provenance, Quantity } from '@matterlab/core';
import { asEquation, checkConservation, formatEquation } from '../equation';
import type { ConservationReport, Phase, ReactionEquation, SpeciesTerm } from '../equation';
import { ENTHALPY_UNIT, ENTROPY_UNIT, THERMO_DATA_SOURCES, lookupThermoSpecies } from './species';
import type { ThermoLookup, ThermoSpecies } from './species';

/**
 * Up to this distance from 298.15 K the constant-enthalpy, constant-entropy estimate of the Gibbs energy is
 * reported without a warning.
 */
export const THERMO_NO_WARNING_SPAN_K = 25;
/**
 * Beyond this distance from 298.15 K the Gibbs energy and equilibrium constant are labelled `rule-based`
 * instead of `computed`: without heat capacities their error cannot be bounded.
 */
export const THERMO_VALIDATED_SPAN_K = 100;
/** Liquid water, and with it every aqueous standard state, only exists between about these temperatures at 1 bar. */
export const LIQUID_WATER_RANGE_K: readonly [number, number] = [273.15, 373.15];
/** |ln K| above which exp(ln K) is not representable as a finite, non-zero double. */
const LN_K_REPRESENTABLE = 700;

export interface ReactionThermoTerm {
  readonly role: 'reactant' | 'product';
  /** The term as written, e.g. "H2O(l)". */
  readonly term: string;
  readonly coefficient: number;
  /** Outcome of the table lookup, see `lookupThermoSpecies`. */
  readonly lookup: ThermoLookup['status'];
  /** Table entry used, when one was found. */
  readonly speciesId?: string;
  readonly name?: string;
  /** True when the term had no phase label and the only tabulated phase was used. */
  readonly phaseAssumed: boolean;
  readonly availablePhases: readonly Phase[];
}

export interface ReactionThermo {
  /**
   * - `ok`: enthalpy, entropy, Gibbs energy and equilibrium constant were computed.
   * - `partial`: every enthalpy of formation was found but at least one entropy was not, so only `deltaH` is given.
   * - `unbalanced`: the equation does not conserve every element and the charge; nothing is computed.
   * - `missing-data`: at least one species is not in the table (in the requested phase); nothing is computed.
   * - `ambiguous-phase`: at least one species has no phase label and is tabulated in several phases; nothing is computed.
   */
  readonly status: 'ok' | 'partial' | 'unbalanced' | 'missing-data' | 'ambiguous-phase';
  /** Terms for which no table entry (or no enthalpy of formation) was found. */
  readonly missingSpecies: readonly string[];
  /** Terms whose table entry has no entropy. */
  readonly missingEntropy: readonly string[];
  /** Temperature the Gibbs energy and equilibrium constant refer to. */
  readonly temperatureK: number;
  /** Standard reaction enthalpy at 298.15 K, in kJ per mole of reaction as written. */
  readonly deltaH?: Quantity;
  /** Standard reaction entropy at 298.15 K, in J/(mol K) of reaction as written. */
  readonly deltaS?: Quantity;
  /** Standard reaction Gibbs energy at `temperatureK`, in kJ per mole of reaction as written. */
  readonly deltaG?: Quantity;
  /** Natural logarithm of the thermodynamic equilibrium constant at `temperatureK`. */
  readonly lnK?: number;
  readonly log10K?: number;
  /** exp(lnK); omitted when it is too large or too small for a double (use `lnK`). */
  readonly equilibriumConstant?: number;
  /**
   * Where the equilibrium lies with every species in its standard state. `near-equilibrium` means that the
   * Gibbs energy is smaller in magnitude than RT, or than its own uncertainty, so its sign decides nothing.
   */
  readonly spontaneity?: 'product-favoured' | 'reactant-favoured' | 'near-equilibrium';
  /** False when `temperatureK` is further from 298.15 K than the approximation is trusted, or outside the range of liquid water for aqueous species. */
  readonly withinValidatedRange: boolean;
  /** What the numbers rest on. */
  readonly assumptions: readonly string[];
  /** Everything the reader must know before using the numbers. */
  readonly warnings: readonly string[];
  /** `computed` for results inside the validated range, `rule-based` for estimates outside it, `unsupported` when nothing was computed. */
  readonly evidence: EvidenceLevel;
  /** How each term of the equation was matched to the table. */
  readonly terms: readonly ReactionThermoTerm[];
  readonly conservation: ConservationReport;
}

const termLabel = (term: SpeciesTerm): string => `${term.formula}${term.phase ? `(${term.phase})` : ''}`;

function uniqueCitations(species: readonly ThermoSpecies[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const s of species) for (const c of s.provenance.citations ?? []) seen.set(JSON.stringify(c), c);
  return [...seen.values()];
}

interface Matched {
  readonly sign: 1 | -1;
  readonly term: SpeciesTerm;
  readonly species: ThermoSpecies;
}

interface NetSpecies {
  readonly species: ThermoSpecies;
  /** Net stoichiometric coefficient: positive on the product side. */
  nu: number;
}

/**
 * One entry per table species with its net coefficient. A species written on both sides (a solvent, a
 * catalyst) therefore cancels exactly, in the value and in the uncertainty.
 */
function netSpecies(matched: readonly Matched[]): NetSpecies[] {
  const byId = new Map<string, NetSpecies>();
  for (const { sign, term, species } of matched) {
    const entry = byId.get(species.id);
    if (entry) entry.nu += sign * term.coefficient;
    else byId.set(species.id, { species, nu: sign * term.coefficient });
  }
  return [...byId.values()].filter((entry) => entry.nu !== 0);
}

/** Coefficient-weighted sum of tabulated values and, when every value has one, their uncertainties in quadrature. */
function weightedSum(net: readonly NetSpecies[], pick: (s: ThermoSpecies) => Quantity | null): { value: number; uncertainty?: number; withoutUncertainty: string[] } {
  let value = 0;
  let variance = 0;
  const withoutUncertainty: string[] = [];
  for (const { species, nu } of net) {
    const q = pick(species)!;
    value += nu * q.value;
    if (q.uncertainty === undefined) withoutUncertainty.push(species.id);
    else variance += (nu * q.uncertainty) ** 2;
  }
  return withoutUncertainty.length ? { value, withoutUncertainty } : { value, uncertainty: Math.sqrt(variance), withoutUncertainty };
}

/**
 * Standard thermodynamics of a reaction from the reference table.
 *
 * `deltaH` and `deltaS` are the standard reaction enthalpy and entropy at 298.15 K (Hess's law over the
 * tabulated enthalpies of formation and entropies). `deltaG`, `lnK` and `equilibriumConstant` refer to
 * `temperatureK` and use ΔG°(T) ≈ ΔH°(298.15 K) − T ΔS°(298.15 K), which treats the reaction enthalpy and
 * entropy as independent of temperature; the table holds no heat capacities, so nothing better is possible
 * and the result is flagged as an estimate once T is far from 298.15 K.
 *
 * The function never fills gaps: an unbalanced equation, a species that is not tabulated, or a phase that
 * cannot be decided each produce a status and an explanation instead of numbers.
 *
 * @param eq the reaction; a string is parsed with `parseEquation`.
 * @param temperatureK temperature for the Gibbs energy and equilibrium constant; 298.15 K by default.
 * @throws RangeError when the temperature is not a positive, finite number.
 */
export function reactionThermodynamics(eq: ReactionEquation | string, temperatureK: number = STANDARD_TEMPERATURE_K): ReactionThermo {
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) throw new RangeError('The temperature must be a positive number of kelvin.');
  const equation = asEquation(eq);
  const conservation = checkConservation(equation);
  const warnings: string[] = [];
  const assumptions: string[] = [];

  const sides: readonly (readonly [readonly SpeciesTerm[], 'reactant' | 'product', 1 | -1])[] = [
    [equation.reactants, 'reactant', -1],
    [equation.products, 'product', 1],
  ];
  const terms: ReactionThermoTerm[] = [];
  const matched: Matched[] = [];
  const missingSpecies: string[] = [];
  const ambiguous: string[] = [];
  const assumedPhase: { label: string; id: string }[] = [];
  for (const [side, role, sign] of sides) {
    for (const term of side) {
      const found = lookupThermoSpecies(term.parsed, term.phase);
      const label = termLabel(term);
      terms.push({
        role,
        term: label,
        coefficient: term.coefficient,
        lookup: found.status,
        ...(found.species ? { speciesId: found.species.id, name: found.species.name } : {}),
        phaseAssumed: found.phaseAssumed,
        availablePhases: found.availablePhases,
      });
      const phases = found.availablePhases.map((p) => `(${p})`).join(', ');
      if (found.status === 'found' && found.species) {
        if (!found.species.deltaHf298) {
          missingSpecies.push(label);
          warnings.push(`The table has no enthalpy of formation for ${found.species.id}.`);
          continue;
        }
        matched.push({ sign, term, species: found.species });
        if (found.phaseAssumed && !assumedPhase.some((a) => a.id === found.species!.id)) assumedPhase.push({ label, id: found.species.id });
        if (found.species.identityNote) warnings.push(`${label} was matched to ${found.species.name}. ${found.species.identityNote}`);
      } else if (found.status === 'phase-required') {
        ambiguous.push(label);
        warnings.push(`${label} is tabulated in several phases: ${phases}. Add a phase label so the right entry can be used.`);
      } else if (found.status === 'phase-not-tabulated') {
        missingSpecies.push(label);
        warnings.push(
          `${label} is not in the table; this substance is tabulated only as ${phases}.` +
            (term.phase === 'aq' ? ' Dissolved electrolytes are tabulated as their ions: write a dissolved salt, acid or base as separate aqueous ions.' : ''),
        );
      } else {
        missingSpecies.push(label);
        warnings.push(
          term.parsed.charge === -1 && Object.keys(term.parsed.elements).length === 0
            ? 'The table has no entry for the electron, so a half-reaction cannot be evaluated; combine two half-reactions into a complete redox equation.'
            : `${label} is not in the table.`,
        );
      }
    }
  }
  if (assumedPhase.length > 0) {
    warnings.push(
      `No phase label was given for ${assumedPhase.map((a) => a.label).join(', ')}. Each is tabulated in one phase only, which was used: ${assumedPhase.map((a) => a.id).join(', ')}.`,
    );
  }

  const base = {
    temperatureK,
    terms,
    conservation,
    missingSpecies,
  };
  const nothing = (status: ReactionThermo['status'], extraWarnings: string[] = []): ReactionThermo => ({
    status,
    ...base,
    missingEntropy: [],
    withinValidatedRange: false,
    assumptions: [],
    warnings: [...extraWarnings, ...warnings],
    evidence: 'unsupported',
  });

  if (!conservation.balanced) {
    const off = Object.entries(conservation.elementImbalance)
      .filter(([, v]) => v !== 0)
      .map(([symbol, v]) => `${symbol} ${v > 0 ? '+' : ''}${v}`);
    if (conservation.chargeImbalance !== 0) off.push(`charge ${conservation.chargeImbalance > 0 ? '+' : ''}${conservation.chargeImbalance}`);
    return nothing('unbalanced', [`The equation is not balanced (products minus reactants: ${off.join(', ')}). Thermodynamic quantities are only defined for a balanced equation.`]);
  }
  if (missingSpecies.length > 0) return nothing('missing-data');
  if (ambiguous.length > 0) return nothing('ambiguous-phase');

  // --- enthalpy -------------------------------------------------------------------------------------
  const used = [...new Map(matched.map((m) => [m.species.id, m.species])).values()];
  const sourcesUsed = THERMO_DATA_SOURCES.filter((s) => used.some((u) => u.source === s.id));
  const provenance = (notes: string): Provenance => ({
    source: '@matterlab/reactions',
    citations: uniqueCitations(used),
    notes: `${notes} Reaction: ${formatEquation(equation)}. Table entries used: ${used.map((u) => u.id).join(', ')}.`,
  });

  assumptions.push(
    'All species are in their standard states: pure solids and liquids, ideal gases at 1 bar, and aqueous species in the solute standard state of the source table.',
    "Reaction enthalpy and entropy follow from Hess's law: the sum over products minus the sum over reactants of the tabulated enthalpies of formation and standard entropies at 298.15 K, each multiplied by its coefficient.",
  );
  if (used.some((u) => u.phase === 'aq')) {
    assumptions.push(
      'Aqueous ions follow the convention of the source table, in which H+(aq) has an enthalpy of formation of 0 and an entropy of 0; single-ion values are meaningful only in charge-balanced combinations.',
    );
  }
  if (sourcesUsed.length > 1) {
    warnings.push(`Values from ${sourcesUsed.length} reference tables are combined (${sourcesUsed.map((s) => s.name).join('; ')}). They were evaluated separately and are not guaranteed to be mutually consistent.`);
  }

  const net = netSpecies(matched);
  const h = weightedSum(net, (s) => s.deltaHf298);
  const uncertaintyAssumption = 'Uncertainties are the limits printed by the sources, combined in quadrature as if they were independent; correlations between tabulated values are not known to this package.';
  if (h.uncertainty === undefined) {
    warnings.push(`No uncertainty is given for the reaction enthalpy because the source prints none for ${h.withoutUncertainty.join(', ')}.`);
  }
  const deltaH: Quantity = {
    value: h.value,
    unit: ENTHALPY_UNIT,
    ...(h.uncertainty !== undefined ? { uncertainty: h.uncertainty } : {}),
    evidence: 'computed',
    provenance: provenance("Standard reaction enthalpy at 298.15 K by Hess's law from tabulated enthalpies of formation."),
  };

  const withoutEntropy = net.filter((entry) => !entry.species.s298).map((entry) => entry.species.id);
  if (withoutEntropy.length > 0) {
    const missingEntropy = [...new Set(matched.filter((m) => withoutEntropy.includes(m.species.id)).map((m) => termLabel(m.term)))];
    warnings.push(
      `The table has no standard entropy for ${withoutEntropy.join(', ')}, so the reaction entropy, Gibbs energy and equilibrium constant cannot be computed. Only the reaction enthalpy is given.`,
    );
    if (h.uncertainty !== undefined) assumptions.push(uncertaintyAssumption);
    return { status: 'partial', ...base, missingEntropy, deltaH, withinValidatedRange: true, assumptions, warnings, evidence: 'computed' };
  }

  // --- entropy, Gibbs energy, equilibrium constant ------------------------------------------------------
  const s = weightedSum(net, (sp) => sp.s298);
  if (s.uncertainty === undefined) {
    warnings.push(`No uncertainty is given for the reaction entropy because the source prints none for ${s.withoutUncertainty.join(', ')}.`);
  }
  if (h.uncertainty !== undefined || s.uncertainty !== undefined) assumptions.push(uncertaintyAssumption);
  const deltaS: Quantity = {
    value: s.value,
    unit: ENTROPY_UNIT,
    ...(s.uncertainty !== undefined ? { uncertainty: s.uncertainty } : {}),
    evidence: 'computed',
    provenance: provenance("Standard reaction entropy at 298.15 K by Hess's law from tabulated standard entropies."),
  };

  const span = Math.abs(temperatureK - STANDARD_TEMPERATURE_K);
  const atReference = span < 1e-9;
  const needsLiquidWater = used.filter((u) => u.phase === 'aq' || u.id === 'H2O(l)');
  const outsideWater = needsLiquidWater.length > 0 && (temperatureK < LIQUID_WATER_RANGE_K[0] || temperatureK > LIQUID_WATER_RANGE_K[1]);
  const withinValidatedRange = span <= THERMO_VALIDATED_SPAN_K && !outsideWater;
  const evidence: EvidenceLevel = withinValidatedRange ? 'computed' : 'rule-based';

  if (atReference) {
    assumptions.push('The Gibbs energy is ΔG° = ΔH° − TΔS° at 298.15 K, the temperature of the tabulated data.');
  } else {
    assumptions.push(
      `The Gibbs energy at ${temperatureK} K is estimated as ΔG°(T) ≈ ΔH°(298.15 K) − T ΔS°(298.15 K): the reaction enthalpy and entropy are taken as independent of temperature, ` +
        'which amounts to neglecting the difference in heat capacity between products and reactants, and no phase change between 298.15 K and T is considered.',
    );
    if (span > THERMO_VALIDATED_SPAN_K) {
      warnings.unshift(
        `FAR FROM 298.15 K: ${temperatureK} K is ${span.toFixed(1)} K away from the temperature of the tabulated data. The Gibbs energy and equilibrium constant are rough estimates ` +
          'from temperature-independent reaction enthalpy and entropy; the table holds no heat capacities, so the size of the error is unknown and it grows with the distance from 298.15 K. ' +
          'Any species may also have melted, boiled or decomposed in between, which is not checked.',
      );
    } else if (span > THERMO_NO_WARNING_SPAN_K) {
      warnings.push(
        `${temperatureK} K is ${span.toFixed(1)} K away from 298.15 K. The Gibbs energy and equilibrium constant assume temperature-independent reaction enthalpy and entropy; ` +
          'the error of that approximation is not estimated because the table holds no heat capacities.',
      );
    }
  }
  if (outsideWater) {
    warnings.unshift(
      `OUTSIDE THE LIQUID RANGE OF WATER: ${needsLiquidWater.map((u) => u.id).join(', ')} refer${needsLiquidWater.length === 1 ? 's' : ''} to liquid water or an aqueous standard state, ` +
        `which does not exist at ${temperatureK} K and 1 bar (liquid water spans roughly ${LIQUID_WATER_RANGE_K[0]} K to ${LIQUID_WATER_RANGE_K[1]} K). The Gibbs energy and equilibrium constant are a formal extrapolation only.`,
    );
  }

  const gValue = h.value - (temperatureK * s.value) / 1000;
  const gUncertainty = h.uncertainty !== undefined && s.uncertainty !== undefined ? Math.hypot(h.uncertainty, (temperatureK * s.uncertainty) / 1000) : undefined;
  const deltaG: Quantity = {
    value: gValue,
    unit: ENTHALPY_UNIT,
    ...(gUncertainty !== undefined ? { uncertainty: gUncertainty } : {}),
    evidence,
    provenance: provenance(
      atReference
        ? 'Standard reaction Gibbs energy at 298.15 K from the reaction enthalpy and entropy.'
        : `Standard reaction Gibbs energy at ${temperatureK} K estimated from the 298.15 K reaction enthalpy and entropy, taken as independent of temperature.`,
    ),
  };

  const rtKJ = (GAS_CONSTANT_J_PER_MOL_K * temperatureK) / 1000;
  const lnK = -gValue / rtKJ;
  assumptions.push('K = exp(−ΔG°/RT) is the dimensionless thermodynamic equilibrium constant, expressed in activities relative to the standard states above.');
  const representable = Math.abs(lnK) <= LN_K_REPRESENTABLE;
  if (!representable) warnings.push(`The equilibrium constant is too ${lnK > 0 ? 'large' : 'small'} to be written as an ordinary number (ln K = ${lnK.toPrecision(6)}); use lnK or log10K.`);

  const band = Math.max(rtKJ, gUncertainty ?? 0);
  const spontaneity = Math.abs(gValue) <= band ? 'near-equilibrium' : gValue < 0 ? 'product-favoured' : 'reactant-favoured';
  assumptions.push(
    'The direction label compares ΔG° with RT and with its own uncertainty; it describes all species in their standard states, not an arbitrary mixture, and says nothing about how fast the reaction is or whether it proceeds at all.',
  );

  return {
    status: 'ok',
    ...base,
    missingEntropy: [],
    deltaH,
    deltaS,
    deltaG,
    lnK,
    log10K: lnK / Math.LN10,
    ...(representable ? { equilibriumConstant: Math.exp(lnK) } : {}),
    spontaneity,
    withinValidatedRange,
    assumptions,
    warnings,
    evidence,
  };
}

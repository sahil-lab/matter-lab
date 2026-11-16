import { EVIDENCE_LEVELS } from '@matterlab/core';
import type { EvidenceLevel } from '@matterlab/core';
import type { BalanceResult } from '../balance';
import { PHASE_LABELS } from '../equation';
import type { KineticModel, RateConstantResult } from '../kinetics/models';
import type { KineticsResult } from '../kinetics/simulate';
import type { ReactionThermo } from '../thermo/reaction';
import { celsius, describeKinetics, describeThermo, formatEntered } from './describe';
import { activationEnergyText } from './diagram';
import { ROUNDING_RULES, formatSignificant, prettyUnit, superscript } from './format';
import type { ReadSpecies } from './input';
import type { Limitation } from './limitations';
import type { KineticsPlan } from './plan';
import type { EnergyDiagram, ExperimentInput, ExperimentStatus, ExperimentStep, ExplanationSection } from './types';

/**
 * The headings of the explanation, by topic and level. A completed experiment has every topic except
 * `outcome` at both levels; an experiment that produced nothing has `objective`, `outcome` and what
 * follows from them. A topic may fill more than one section, each heading then starts with the text given
 * here ("Mathematical model: rate law").
 */
export const EXPLANATION_HEADINGS = {
  objective: { beginner: 'What this experiment asks', advanced: 'Objective' },
  setup: { beginner: 'What goes in', advanced: 'Initial species and conditions' },
  method: { beginner: 'How it was worked out', advanced: 'Method' },
  model: { beginner: 'The idea behind the numbers', advanced: 'Mathematical model' },
  assumptions: { beginner: 'What is assumed', advanced: 'Assumptions' },
  results: { beginner: 'What came out', advanced: 'Results' },
  confidence: { beginner: 'How sure is this', advanced: 'Confidence and uncertainty' },
  convergence: { beginner: 'Did the calculation finish', advanced: 'Convergence status' },
  limitations: { beginner: 'What is not included', advanced: 'Known limitations' },
  reality: { beginner: 'Why reality may differ', advanced: 'Why the prediction may not match reality' },
  outcome: { beginner: 'Why there is no result', advanced: 'Outcome' },
  next: { beginner: 'What you can do', advanced: 'What to change' },
} as const;

export type ExplanationTopic = keyof typeof EXPLANATION_HEADINGS;

export interface ExplanationFacts {
  readonly input: ExperimentInput;
  readonly status: ExperimentStatus;
  readonly species: readonly ReadSpecies[];
  readonly steps: readonly ExperimentStep[];
  readonly equationText: string | null;
  readonly balance: BalanceResult | null;
  /** What fixed the coefficients of the equation. */
  readonly balanceHow: 'conservation' | 'entered' | 'data-sheet' | null;
  readonly thermoRequested: boolean;
  readonly thermo: ReactionThermo | null;
  readonly kineticsPlan: KineticsPlan;
  readonly kineticModel: KineticModel | null;
  readonly rate: RateConstantResult | null;
  readonly kinetics: KineticsResult | null;
  readonly limitations: readonly Limitation[];
  readonly warnings: readonly string[];
  readonly energyDiagrams: readonly EnergyDiagram[];
  readonly solver: { readonly tolerance: number; readonly maxSteps: number; readonly outputPoints: number };
}

type Level = 'beginner' | 'advanced';

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const EVIDENCE_ORDER: readonly EvidenceLevel[] = ['reference', 'computed', 'rule-based', 'illustrative', 'user-input', 'unsupported'];
const weaker = (a: EvidenceLevel, b: EvidenceLevel): EvidenceLevel => (EVIDENCE_ORDER.indexOf(a) >= EVIDENCE_ORDER.indexOf(b) ? a : b);

/** "methane (CH4, gas)", "CH4 (gas)", "methane (CH4)" or "CH4". */
function plainSpecies(entry: ReadSpecies): string {
  const { formula, name, phase } = entry.species;
  const phaseWord = phase ? PHASE_LABELS[phase] : undefined;
  if (name) return `${name} (${formula}${phaseWord ? `, ${phaseWord}` : ''})`;
  return phaseWord ? `${formula} (${phaseWord})` : formula;
}

const unitOf = (input: ExperimentInput): string => (input.conditions.concentrationUnit === 'mol/L' ? 'mol/L' : prettyUnit('molecule cm-3'));

/** "rate = k [NO]²[O2]" */
function rateLawEquation(model: KineticModel): string {
  const factors = Object.entries(model.rateLaw.orders)
    .map(([formula, order]) => `[${formula}]${order === 1 ? '' : superscript(String(order))}`)
    .join('');
  return `rate = k ${factors}`;
}

type Paragraph = string | undefined | null | false;

function section(heading: string, paragraphs: readonly Paragraph[], extra: { equation?: string; evidence?: EvidenceLevel } = {}): ExplanationSection | undefined {
  const kept = paragraphs.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  if (kept.length === 0) return undefined;
  return { heading, paragraphs: kept, ...(extra.equation ? { equation: extra.equation } : {}), ...(extra.evidence ? { evidence: extra.evidence } : {}) };
}

const compact = (sections: readonly (ExplanationSection | undefined)[]): ExplanationSection[] => sections.filter((s): s is ExplanationSection => s !== undefined);

// --- runs that produced nothing -----------------------------------------------------------------------------

function explainWithoutResult(facts: ExplanationFacts, level: Level): ExplanationSection[] {
  const { input, status, species, steps } = facts;
  const h = EXPLANATION_HEADINGS;
  const failed = steps.find((step) => step.status === 'failed');
  const finished = steps.filter((step) => step.status === 'passed' || step.status === 'warning').map((step) => step.title.toLowerCase());

  if (status === 'cancelled') {
    return compact([
      section(h.outcome[level], [
        'This experiment was **cancelled** before it finished, so no results are shown.',
        finished.length > 0 ? `Finished before the cancellation: ${listOf(finished)}.` : 'No step had finished when it was cancelled.',
        level === 'advanced' ? 'Nothing computed up to that point is reported as a result. Run the experiment again to obtain one.' : 'Run it again to get a result.',
      ]),
    ]);
  }

  const reactants = species.filter((entry) => entry.species.role === 'reactant').map(plainSpecies);
  const products = species.filter((entry) => entry.species.role === 'product').map(plainSpecies);
  const objective =
    status === 'invalid'
      ? 'This experiment could not be run, because something in what was entered has to be put right first.'
      : `This experiment starts from ${listOf(reactants)}${products.length > 0 ? ` and names ${listOf(products)} as the ${products.length === 1 ? 'product' : 'products'}` : ', with no products entered'}.`;

  let next: string[];
  if (status === 'invalid') {
    next = ['Correct the points listed above and run the experiment again.', 'Nothing was calculated, so there is nothing to interpret.'];
  } else if (products.length === 0) {
    next = [
      'Enter the products of the reaction you want to study.',
      'If you do not know them, the catalogue lookup lists known reactions that start from these substances. It is a list of reactions MATTER LAB can evaluate, **not a prediction** that any of them happens.',
    ];
  } else if (facts.balance?.status === 'impossible') {
    next = ['Check each formula and each charge.', 'Check whether a starting substance or a product is missing: every element on one side has to appear on the other.'];
  } else {
    next = [
      'Enter each reaction as an experiment of its own.',
      'Or give a coefficient for every starting substance and every product, so that the proportions are fixed by you.',
      'If a substance appears on both sides because it is not used up, list it as a catalyst or a solvent instead.',
    ];
  }

  // Plain words for the beginner; the step's own sentences, which may name functions and terms, for the advanced reader.
  let outcome: string[];
  if (!failed) outcome = ['No step failed, but no result was produced.'];
  else if (level === 'advanced' || status === 'invalid') outcome = [failed.summary, ...failed.details];
  else if (products.length === 0) outcome = [failed.summary];
  else if (facts.balance?.status === 'impossible') outcome = ['The substances entered cannot be made into a balanced equation: the atoms, or the electric charge, on the two sides cannot be made equal.'];
  else outcome = ['The substances entered fit more than one balanced equation, so MATTER LAB cannot tell in which proportions they are meant to react.'];

  return compact([
    section(h.objective[level], [objective, level === 'advanced' && `Method requested: ${input.method}.`]),
    section(h.outcome[level], outcome),
    section(h.next[level], next),
    section(h.limitations[level], facts.limitations.map((limitation) => (level === 'beginner' ? limitation.plain : limitation.text))),
  ]);
}

// --- runs with a balanced equation --------------------------------------------------------------------------

function explainResult(facts: ExplanationFacts, level: Level): ExplanationSection[] {
  const { input, species, thermo, kineticModel: model, rate, kinetics, kineticsPlan } = facts;
  const { conditions, method } = input;
  const h = EXPLANATION_HEADINGS;
  const beginner = level === 'beginner';
  const equation = facts.equationText!;
  const temperature = `${formatEntered(conditions.temperatureK)} K`;
  const atReference = Math.abs(conditions.temperatureK - 298.15) < 1e-9;
  /** For plain-language remarks: far enough from 298.15 K to show as another whole degree Celsius. */
  const awayFromReference = Math.abs(conditions.temperatureK - 298.15) >= 0.5;

  const thermoOk = thermo?.status === 'ok';
  const thermoPartial = thermo?.status === 'partial';
  const thermoText = thermo && (thermoOk || thermoPartial) ? describeThermo(thermo) : undefined;
  const kineticsShown = model !== null && rate !== null;
  const kineticsText = model && rate ? describeKinetics(model, rate, kinetics) : undefined;
  const kineticsWanted = method === 'auto' || method === 'kinetics';
  const step = (id: ExperimentStep['id']): ExperimentStep | undefined => facts.steps.find((s) => s.id === id);

  const reactants = species.filter((entry) => entry.species.role === 'reactant');
  const products = species.filter((entry) => entry.species.role === 'product');
  const bystanders = species.filter((entry) => entry.species.role === 'catalyst' || entry.species.role === 'solvent');
  const withConcentration = species.filter((entry) => entry.species.initialConcentration !== undefined && (entry.species.role === 'reactant' || entry.species.role === 'product'));
  const missingThermo =
    thermo && !thermoOk && !thermoPartial
      ? thermo.status === 'ambiguous-phase'
        ? thermo.terms.filter((term) => term.lookup === 'phase-required').map((term) => term.term)
        : thermo.missingSpecies
      : [];

  // --- objective ----------------------------------------------------------------------------------------
  const asks: string[] = [];
  if (method === 'stoichiometry') asks.push('in which proportions the substances react');
  if (facts.thermoRequested) asks.push('how much heat the reaction gives out or takes in', 'which side of the reaction is favoured');
  if (kineticsWanted && (kineticsShown || method === 'kinetics')) asks.push('how fast the starting substances are used up');
  const quantities: string[] = ['the balanced equation'];
  if (facts.thermoRequested) quantities.push('the standard reaction enthalpy, entropy, Gibbs energy and equilibrium constant from reference data');
  if (kineticsWanted) quantities.push('the rate constant and concentration-time curves, if a sourced rate law exists for exactly this reaction');
  const objective = beginner
    ? section(h.objective.beginner, [
        `This experiment looks at the reaction **${equation}**.`,
        `It asks ${listOf(asks)}.`,
        'MATTER LAB works on the reaction you entered. It does not decide whether these substances really react.',
      ])
    : section(h.objective.advanced, [
        `Evaluate the reaction ${equation} at ${temperature} and ${formatEntered(conditions.pressureBar)} bar: ${listOf(quantities)}.`,
        `Method requested: ${method}. The equation was built from the species entered as reactants and products; no product was predicted.`,
      ]);

  // --- initial species and conditions ---------------------------------------------------------------------
  const concentrations = withConcentration.map((entry) => `${entry.label} ${formatEntered(entry.species.initialConcentration!)} ${unitOf(input)}`);
  const setup = beginner
    ? section(
        h.setup.beginner,
        [
          `Starting substances: ${listOf(reactants.map(plainSpecies))}. Products entered: ${listOf(products.map(plainSpecies))}.`,
          bystanders.length > 0 && `Also listed: ${listOf(bystanders.map((entry) => `${plainSpecies(entry)} as ${entry.species.role}`))}.`,
          `Temperature ${temperature} (${celsius(conditions.temperatureK)}), pressure ${formatEntered(conditions.pressureBar)} bar.`,
          kineticsShown && concentrations.length > 0 && `Starting amounts: ${listOf(concentrations)}, followed for ${formatEntered(conditions.durationSeconds)} s.`,
        ],
        { evidence: 'user-input' },
      )
    : section(
        h.setup.advanced,
        [
          ...species.map(
            (entry) =>
              `${entry.label}: ${entry.species.role}${entry.species.name ? `, ${entry.species.name}` : ''}` +
              (entry.species.initialConcentration !== undefined ? `, initial concentration ${formatEntered(entry.species.initialConcentration)} ${unitOf(input)}` : '') +
              '.',
          ),
          `Temperature ${temperature}; pressure ${formatEntered(conditions.pressureBar)} bar; duration ${formatEntered(conditions.durationSeconds)} s; environment ${conditions.environment}; concentrations in ${unitOf(input)}.`,
          'These values are used as entered. They describe the experiment that was asked for, not a measured system.',
        ],
        { evidence: 'user-input' },
      );

  // --- method ---------------------------------------------------------------------------------------------
  const methodSection = beginner
    ? section(h.method.beginner, [
        'First the equation was balanced, so that no atoms and no electric charge appear or disappear.',
        facts.balanceHow === 'data-sheet' &&
          'For these substances that rule alone leaves the proportions open, so the proportions of the published reaction between exactly these substances were used.',
        thermoText && "Then published reference values for each substance were added up, products minus starting substances. This is known as Hess's law. Nothing was simulated for it.",
        facts.thermoRequested && !thermoText && 'The energy values could not be worked out, because reference data are missing (see below).',
        kineticsShown && 'For the speed, a published rate constant for exactly this reaction was used, and the amounts were followed forward in time in many small steps.',
        kineticsWanted && kineticsPlan.kind === 'none' && 'No speed was worked out: MATTER LAB has no published rate data for this reaction and does not borrow data from a similar one.',
        kineticsWanted && kineticsPlan.kind === 'refused' && 'No speed was worked out: the published rate data for this reaction do not apply to the conditions of this experiment.',
        kineticsWanted && kineticsPlan.kind === 'needs-concentrations' && 'No speed was worked out: the starting amounts needed for it were not given.',
      ])
    : section(h.method.advanced, [...(step('engine')?.details ?? []), step('reference-data')?.status !== 'skipped' && step('reference-data')?.summary, step('model-selection')?.summary]);

  // --- mathematical model -----------------------------------------------------------------------------------
  const models: (ExplanationSection | undefined)[] = [];
  if (beginner) {
    if (thermoOk) {
      models.push(
        section(
          `${h.model.beginner}: energy`,
          [
            'The heat of reaction, written \u0394H, is the heat content of the products minus that of the starting substances. A negative value means that heat is given out.',
            'Whether a reaction is favoured depends on that heat and on the change in disorder (the entropy, \u0394S). The two are combined in the Gibbs energy \u0394G. A negative \u0394G means that the products are favoured.',
          ],
          { equation: '\u0394G = \u0394H \u2212 T\u0394S' },
        ),
      );
    } else if (thermoPartial) {
      models.push(
        section(`${h.model.beginner}: energy`, ['The heat of reaction, written \u0394H, is the heat content of the products minus that of the starting substances. A negative value means that heat is given out.'], {
          equation: '\u0394H = H(products) \u2212 H(starting substances)',
        }),
      );
    }
    if (model && kineticsShown) {
      models.push(
        section(
          `${h.model.beginner}: speed`,
          [
            'The rate of the reaction is proportional to how much of each reacting substance is present; square brackets stand for the amount in a given volume.',
            'The rate constant k says how fast this particular reaction is at this temperature.',
          ],
          { equation: rateLawEquation(model) },
        ),
      );
    }
    if (models.length === 0) {
      models.push(section(h.model.beginner, ['Balancing rests on one rule: every atom and every unit of electric charge on one side of the arrow is also on the other side.'], { equation: 'atoms and charge before = atoms and charge after' }));
    }
  } else {
    models.push(
      section(
        `${h.model.advanced}: conservation`,
        [
          'The coefficients \u03bd (negative for reactants, positive for products) have to satisfy the conservation equations for every element and for the charge.',
          facts.balanceHow === 'conservation' && 'These equations have a single solution up to scale here; the smallest positive whole numbers are used.',
          facts.balanceHow === 'entered' && 'The coefficients are the ones that were entered; they satisfy the conservation equations.',
          facts.balanceHow === 'data-sheet' && facts.balance?.message,
        ],
        { equation: '\u03a3 \u03bd\u00b7(atoms of each element) = 0,  \u03a3 \u03bd\u00b7(charge) = 0' },
      ),
    );
    if (thermoText) {
      models.push(
        section(
          `${h.model.advanced}: reaction enthalpy${thermoOk ? ' and entropy' : ''}`,
          ["Hess's law: the standard reaction enthalpy" + (thermoOk ? ' and entropy' : '') + ' at 298.15 K are the stoichiometric sums of the tabulated standard enthalpies of formation' + (thermoOk ? ' and standard entropies.' : '.')],
          { equation: thermoOk ? '\u0394rH\u00b0 = \u03a3 \u03bd\u00b7\u0394fH\u00b0,  \u0394rS\u00b0 = \u03a3 \u03bd\u00b7S\u00b0' : '\u0394rH\u00b0 = \u03a3 \u03bd\u00b7\u0394fH\u00b0' },
        ),
      );
    }
    if (thermoOk) {
      models.push(
        section(
          `${h.model.advanced}: Gibbs energy and equilibrium constant`,
          [
            atReference
              ? 'The standard Gibbs energy of reaction at 298.15 K follows from the reaction enthalpy and entropy, and the thermodynamic equilibrium constant from the Gibbs energy.'
              : `The standard Gibbs energy of reaction at ${temperature} is estimated from the 298.15 K reaction enthalpy and entropy, taken as independent of temperature; the thermodynamic equilibrium constant follows from it.`,
            'K is dimensionless: it is expressed in activities relative to the standard states.',
          ],
          { equation: '\u0394rG\u00b0(T) = \u0394rH\u00b0(298.15 K) \u2212 T\u00b7\u0394rS\u00b0(298.15 K),  K = exp(\u2212\u0394rG\u00b0/RT)' },
        ),
      );
    }
    if (model && kineticsShown) {
      models.push(
        section(`${h.model.advanced}: rate law`, [model.rateLaw.description, 'The evaluation lists elementary reactions, so the orders are the stoichiometric coefficients of the reactants.'], { equation: rateLawEquation(model) }),
        section(
          `${h.model.advanced}: rate constant`,
          [
            `Arrhenius expression with the preferred values of the data sheet: A = ${formatSignificant(model.arrhenius.A, 2)} ${prettyUnit(model.arrhenius.AUnits)}, Ea = ${activationEnergyText(model)}.`,
            'The concentrations follow from integrating d[X]/dt = \u03bd\u2093\u00b7rate for every species X.',
          ],
          { equation: 'k(T) = A\u00b7exp(\u2212Ea/RT)' },
        ),
      );
    }
  }

  // --- assumptions ------------------------------------------------------------------------------------------
  const kineticAssumptions = [
    'The reaction is a single elementary step with the rate law of the data sheet; the reverse reaction and every other reaction are absent.',
    'The mixture is homogeneous, at constant temperature and constant volume.',
    'The rate constant follows the Arrhenius expression of the source.',
  ];
  const assumptions = beginner
    ? section(h.assumptions.beginner, [
        thermoText && 'Every substance is treated as pure and under standard conditions (a pressure of 1 bar).',
        thermoOk && awayFromReference && 'The table values are for 25 \u00b0C; they are assumed not to change with temperature.',
        kineticsShown && 'Only this one reaction takes place, the mixture is perfectly stirred, and its temperature stays the same.',
        !thermoText && !kineticsShown && 'Only that the formulas entered are the substances meant.',
      ])
    : section(h.assumptions.advanced, [
        ...(thermoText && thermo ? thermo.assumptions : []),
        ...(kineticsShown ? kineticAssumptions : []),
        bystanders.length > 0 && 'Catalysts and solvents take no part in any of the models.',
        !thermoText && !kineticsShown && 'None beyond the formulas as entered: balancing uses only the composition and charge of each species.',
      ]);

  // --- results ----------------------------------------------------------------------------------------------
  const resultLines: Paragraph[] = [];
  let resultEvidence: EvidenceLevel = 'computed';
  if (beginner) {
    resultLines.push(`Balanced equation: **${equation}**.`);
    if (thermoText && thermo?.deltaH) {
      const h298 = thermo.deltaH;
      const clear = Math.abs(h298.value) > (h298.uncertainty ?? 0);
      const sense = !clear
        ? 'The value is not clearly different from zero.'
        : h298.value < 0
          ? 'The minus sign means that heat is **given out** (the reaction is exothermic).'
          : 'The plus sign means that heat is **taken in** (the reaction is endothermic).';
      resultLines.push(`Heat of reaction: **${thermoText.deltaH}** for the amounts in the equation, counted in moles. ${sense}`);
    }
    if (thermoOk && thermo && thermoText) {
      const direction =
        thermo.spontaneity === 'product-favoured' ? 'The products are favoured.' : thermo.spontaneity === 'reactant-favoured' ? 'The starting substances are favoured.' : 'Neither side is clearly favoured.';
      resultLines.push(
        thermoText.approximate
          ? `Gibbs energy at ${temperature}: about **${thermoText.deltaG}**, a rough estimate. ${direction}`
          : `Gibbs energy at ${temperature}: **${thermoText.deltaG}**. ${direction}`,
        `Equilibrium constant: K \u2248 ${thermoText.K}. The larger this number, the further the balance lies towards the products.`,
      );
    } else if (thermoPartial) {
      resultLines.push('Which side is favoured cannot be said: the table lacks the entropy data needed for it.');
    } else if (facts.thermoRequested) {
      resultLines.push(`No energy values: MATTER LAB has no usable reference data for ${listOf(missingThermo)}.`);
    }
    if (kineticsText) {
      resultLines.push(`Rate constant at ${temperature}: **k = ${kineticsText.k}**.`);
      if (kineticsText.halfLife) resultLines.push(`Half of the ${kineticsText.halfLifeSpecies} is used up after about **${kineticsText.halfLife}**.`);
      if (kineticsText.conversion) resultLines.push(`After ${kineticsText.endTime}, ${kineticsText.conversion} of it has reacted.`);
    } else if (method === 'kinetics') {
      resultLines.push('No speed can be given for this reaction; the reason is under "What is not included".');
    }
  } else {
    resultLines.push(`Balanced equation: ${equation}.`);
    if (thermoText) resultLines.push(`\u0394rH\u00b0(298.15 K) = ${thermoText.deltaH}, per mole of reaction as written.`);
    if (thermoOk && thermo && thermoText) {
      resultLines.push(
        `\u0394rS\u00b0(298.15 K) = ${thermoText.deltaS}.`,
        `\u0394rG\u00b0(${temperature}) ${thermoText.approximate ? '\u2248' : '='} ${thermoText.deltaG}${thermoText.approximate ? ' (rule-based estimate)' : ''}.`,
        `${thermoText.log10K}; K \u2248 ${thermoText.K}.`,
        `Direction with every species in its standard state: ${thermo.spontaneity}.`,
      );
    } else if (thermoPartial && thermo) {
      resultLines.push(`No \u0394rS\u00b0, \u0394rG\u00b0 or K: the table has no standard entropy for ${listOf(thermo.missingEntropy)}.`);
    } else if (facts.thermoRequested) {
      resultLines.push(`No thermodynamic values: no usable table entry for ${listOf(missingThermo)}.`);
    }
    if (kineticsText && rate) {
      resultLines.push(`k(${temperature}) = ${kineticsText.k}${rate.withinValidatedRange ? '' : ' (extrapolated outside the recommended range)'}.`);
      if (kineticsText.halfLife && kinetics?.halfLife) {
        resultLines.push(`Half-life of ${kineticsText.halfLifeSpecies} (limiting reactant): ${kineticsText.halfLife}, ${kinetics.halfLife.method === 'analytic' ? 'closed form' : 'by numerical quadrature of the rate law'}.`);
      }
      if (kineticsText.change.length > 0) resultLines.push(`Concentrations from t = 0 to t = ${kineticsText.endTime}: ${kineticsText.change.join('; ')}.`);
      if (kinetics?.solver.reactionCompleteAfterSeconds !== undefined) {
        resultLines.push(`The limiting reactant is used up, to within the solver tolerance, after ${formatSignificant(kinetics.solver.reactionCompleteAfterSeconds, 3)} s.`);
      }
    } else if (kineticsWanted && kineticsPlan.kind === 'none') {
      resultLines.push('No kinetic results: no sourced rate law exists for this reaction.');
    } else if (kineticsWanted && (kineticsPlan.kind === 'refused' || kineticsPlan.kind === 'needs-concentrations')) {
      resultLines.push(`No kinetic results. ${kineticsPlan.message}`);
    }
    for (const diagram of facts.energyDiagrams) {
      const barrier = diagram.levels.find((l) => l.kind === 'barrier');
      if (barrier?.note) resultLines.push(`Energy diagram: ${barrier.note}`);
    }
  }
  if (thermoText && thermo) resultEvidence = weaker(resultEvidence, thermo.evidence);
  if (rate) resultEvidence = weaker(resultEvidence, rate.k.evidence);
  if (kinetics && kinetics.status !== 'unsupported') resultEvidence = weaker(resultEvidence, kinetics.evidence);
  const results = section(h.results[level], resultLines, { evidence: resultEvidence });

  // --- confidence and uncertainty ---------------------------------------------------------------------------
  const label = EVIDENCE_LEVELS[resultEvidence];
  const confidence = beginner
    ? section(h.confidence.beginner, [
        'The balanced equation is exact arithmetic; its numbers are certain.',
        thermoText && (thermoText.enthalpyHasUncertainty ? 'The \u00b1 values come from the uncertainties given in the reference tables.' : 'The reference table gives no uncertainty for some of the values used, so none can be given for the result.'),
        thermoText?.approximate && 'At this temperature the Gibbs energy and the equilibrium constant are only rough estimates; how far off they are is not known.',
        kineticsText?.kFactor && `The published rate constant is itself uncertain by about ${kineticsText.kFactor}.`,
        kineticsText && rate && !rate.withinValidatedRange && 'The temperature is outside the range the rate data were recommended for, so how far off the speed is cannot be said.',
        (thermoText || kineticsText) && `These numbers carry the label "${label.label}": ${label.description}`,
        (thermoText || kineticsText) && 'Numbers are rounded so that they show no more digits than the data behind them support.',
      ])
    : section(h.confidence.advanced, [
        'Stoichiometric coefficients are exact (rational arithmetic).',
        thermoText && thermo && (thermoText.enthalpyHasUncertainty
          ? 'Uncertainties are the limits printed by the sources, combined in quadrature as independent quantities; correlations between tabulated values are unknown. The CODATA table gives "stated uncertainty limits" without a coverage factor.'
          : thermo.warnings.filter((w) => w.startsWith('No uncertainty is given')).join(' ') || 'The sources print no uncertainty for at least one value used, so none is propagated.'),
        thermoOk && thermo && `Evidence: reaction enthalpy and entropy are computed from reference data; the Gibbs energy and equilibrium constant are labelled ${thermo.evidence}.`,
        thermoText && thermo && thermo.warnings.find((w) => w.startsWith('Values from')),
        kineticsText && rate && (rate.log10Uncertainty !== undefined
          ? `Reliability of the rate constant, from the evaluators' figures: \u0394log10 k(T) = \u0394log10 k(298 K) + 0.4343\u00b7\u0394(E/R)\u00b7|1/T \u2212 1/298| = ${formatSignificant(rate.log10Uncertainty, 2)}, that is ${kineticsText.kFactor}; an expanded uncertainty of about 95 % confidence, assigned by the evaluators.`
          : 'No reliability figure is given for the rate constant: the temperature is outside the range for which the evaluators state one.'),
        kineticsText && kinetics && `The numerical error of the integration is controlled by the tolerance (${kinetics.solver.tolerance}, relative to the largest change each concentration can undergo)${kineticsText.kFactor ? '; it is far smaller than the uncertainty of the rate constant' : ''}. Evidence label of the kinetic results: ${kinetics.status === 'unsupported' ? rate?.k.evidence : kinetics.evidence}.`,
        ...(thermoText ? thermoText.rounding : []),
        thermoText && (thermoText.enthalpyHasUncertainty || thermoText.gibbsHasUncertainty) && ROUNDING_RULES.withUncertainty,
        kineticsText && ROUNDING_RULES.kinetics,
      ]);

  // --- convergence ------------------------------------------------------------------------------------------
  const numerics = kinetics?.solver;
  const convergence = beginner
    ? section(h.convergence.beginner, [
        !kineticsShown && thermoText && 'These results are exact arithmetic and sums of table values. There is no step-by-step calculation that could fail to finish.',
        !kineticsShown && !thermoText && 'Balancing an equation is exact arithmetic. There is no step-by-step calculation that could fail to finish.',
        kinetics?.status === 'ok' && numerics && `The step-by-step calculation ran to the end (${numerics.steps} steps) and met its accuracy target.`,
        kinetics?.status === 'incomplete' && 'The step-by-step calculation **stopped early**, so the curves do not cover the whole time asked for.',
        kineticsShown && kinetics?.status === 'unsupported' && 'The step-by-step calculation could not be run.',
      ])
    : section(h.convergence.advanced, [
        'Balancing: exact, nothing to converge.',
        thermoText && 'Thermodynamics: closed-form sums over table values, nothing to converge.',
        kinetics && numerics && `Integrator: ${numerics.method}. Status: ${kinetics.status}. Accepted steps: ${numerics.steps}; rejected: ${numerics.rejectedSteps}; evaluations of the rate law: ${numerics.functionEvaluations}; tolerance: ${numerics.tolerance}; budget of ${facts.solver.maxSteps} step attempts ${numerics.stopReason === 'max-steps' ? '**exhausted**' : 'not exhausted'}.`,
        kinetics?.status === 'incomplete' && kinetics.reasons.join(' '),
        numerics?.reactionCompleteAfterSeconds !== undefined && `The integration ended at ${formatSignificant(numerics.reactionCompleteAfterSeconds, 3)} s because the limiting reactant was used up to within 1 % of the tolerance; the later output points hold the fully converted composition.`,
      ]);

  // --- limitations and reality ------------------------------------------------------------------------------
  const limitations = section(h.limitations[level], facts.limitations.map((limitation) => (beginner ? limitation.plain : limitation.text)));
  const reality = beginner
    ? section(h.reality.beginner, [
        thermoText && 'Real mixtures are not under standard conditions: the actual pressures and concentrations shift the balance.',
        thermoText && 'A favoured reaction can still be so slow that nothing visible happens, or it may need a spark or a catalyst to start.',
        thermoOk && awayFromReference && 'Away from 25 \u00b0C the heat and entropy values change; that change is ignored here.',
        kineticsShown && 'In a real mixture other reactions use up or re-form the same substances, so the amounts change differently.',
        kineticsShown && 'Real mixtures are not perfectly stirred and may warm up or cool down as they react.',
        'The reaction that really happens may not be the one written down: other products can form.',
      ])
    : section(h.reality.advanced, [
        'The equation as written may not be the reaction that occurs: side reactions, incomplete conversion and other products are not considered.',
        thermoText && 'Composition and non-ideality: the driving force in an actual mixture is \u0394G = \u0394G\u00b0 + RT ln Q with activities that differ from the standard states; neither Q nor activity coefficients are computed.',
        thermoText && 'Kinetic hindrance: thermodynamics implies nothing about rate, and metastable mixtures are common.',
        thermoOk && !atReference && 'Temperature dependence: heat capacities and any phase transition between 298.15 K and the temperature of the experiment are neglected.',
        thermoText && 'Reference data: tabulated values carry their own uncertainties and, where two tables are combined, need not be mutually consistent.',
        kineticsShown && 'Coupled chemistry: in any real mixture the reactants and products take part in other reactions, including the reverse one.',
        kineticsShown && 'Rate data: the rate constant is an evaluated measurement with a stated reliability, recommended for a limited temperature range; pressure effects are not modelled beyond what the data sheet states.',
        kineticsShown && 'Transport and heat: mixing, diffusion, wall reactions, photochemistry and the temperature change caused by the heat of reaction are neglected.',
      ]);

  return compact([objective, setup, methodSection, ...models, assumptions, results, confidence, convergence, limitations, reality]);
}

/** The explanation of an experiment at both levels. */
export function buildExplanation(facts: ExplanationFacts): { readonly beginner: ExplanationSection[]; readonly advanced: ExplanationSection[] } {
  const withoutResult = facts.status === 'cancelled' || facts.status === 'invalid' || facts.equationText === null;
  const build = withoutResult ? explainWithoutResult : explainResult;
  return { beginner: build(facts, 'beginner'), advanced: build(facts, 'advanced') };
}

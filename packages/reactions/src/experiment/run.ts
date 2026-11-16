import { BAR_TO_PA, BOLTZMANN_J_PER_K } from '@matterlab/core';
import type { Citation, EvidenceLevel } from '@matterlab/core';
import type { BalanceResult } from '../balance';
import { formatEquation } from '../equation';
import type { ReactionEquation, SpeciesTerm } from '../equation';
import { MOLECULES_PER_CM3_PER_MOL_PER_L, rateConstant } from '../kinetics/models';
import type { KineticModel, RateConstantResult } from '../kinetics/models';
import { KINETICS_SOLVER_METHOD, simulateKinetics } from '../kinetics/simulate';
import type { KineticsResult } from '../kinetics/simulate';
import { reactionThermodynamics } from '../thermo/reaction';
import type { ReactionThermo } from '../thermo/reaction';
import { THERMO_SPECIES } from '../thermo/species';
import { canonicalJson } from './canonical';
import { describeKinetics, describeThermo, formatEntered } from './describe';
import { buildEnergyDiagrams } from './diagram';
import { buildExplanation } from './explain';
import { formatSignificant, prettyUnit } from './format';
import { normaliseInput, validateInput } from './input';
import type { ReadSpecies } from './input';
import { buildLimitations, environmentMismatches } from './limitations';
import type { Limitation } from './limitations';
import { kineticDataSource, planEquation, planKinetics, thermoDataSources, thermoReferences } from './plan';
import type { EquationPlan, KineticsPlan } from './plan';
import { sha256Hex } from './sha256';
import { EXPERIMENT_ENGINE, EXPERIMENT_ENGINE_VERSION, EXPERIMENT_RESULT_SCHEMA, EXPERIMENT_RESULT_SCHEMA_VERSION, EXPERIMENT_STEP_IDS, EXPERIMENT_STEP_TITLES } from './types';
import type { ExperimentDataSource, ExperimentInput, ExperimentResult, ExperimentStatus, ExperimentStep, ExperimentStepId, RunExperimentOptions } from './types';

/** Fraction of the whole run that is done when a step ends. */
const STEP_END: Readonly<Record<ExperimentStepId, number>> = {
  'validate-species': 0.05,
  conservation: 0.1,
  'model-selection': 0.15,
  'reference-data': 0.2,
  engine: 0.25,
  calculation: 0.95,
  limitations: 0.99,
};
/** Within the calculation step: after the thermodynamics, and the span that the integration fills. */
const THERMO_DONE = 0.3;
const INTEGRATION_SPAN: readonly [number, number] = [0.3, 0.93];
/** Progress during the integration is reported in steps of at least this size, not once per integration step. */
const PROGRESS_INCREMENT = 0.01;

const EVIDENCE_ORDER: readonly EvidenceLevel[] = ['reference', 'computed', 'rule-based', 'illustrative', 'user-input', 'unsupported'];
const DEFAULT_SOLVER = { tolerance: 1e-8, maxSteps: 200_000, outputPoints: 201 } as const;

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `\u2212${-value}` : '0');

/** Atoms of each element and the charge on each side of a balanced equation, as sentences. */
function conservationLines(equation: ReactionEquation): string[] {
  const tally = (terms: readonly SpeciesTerm[]): { atoms: Map<string, number>; charge: number } => {
    const atoms = new Map<string, number>();
    let charge = 0;
    for (const term of terms) {
      for (const [symbol, count] of Object.entries(term.parsed.elements)) atoms.set(symbol, (atoms.get(symbol) ?? 0) + term.coefficient * count);
      charge += term.coefficient * term.parsed.charge;
    }
    return { atoms, charge };
  };
  const left = tally(equation.reactants);
  const right = tally(equation.products);
  const symbols = [...new Set([...left.atoms.keys(), ...right.atoms.keys()])];
  return [
    `Atoms on the reactant side and on the product side: ${symbols.map((symbol) => `${symbol} ${left.atoms.get(symbol) ?? 0} = ${right.atoms.get(symbol) ?? 0}`).join(', ')}.`,
    `Charge on the reactant side and on the product side: ${signed(left.charge)} = ${signed(right.charge)}.`,
  ];
}

function weakest(levels: readonly EvidenceLevel[]): EvidenceLevel {
  if (levels.length === 0) return 'unsupported';
  return levels.reduce((worst, level) => (EVIDENCE_ORDER.indexOf(level) > EVIDENCE_ORDER.indexOf(worst) ? level : worst));
}

/** Warnings without repeats, with the ones written as an alarm ("FAR FROM 298.15 K: ...") first. */
function orderWarnings(warnings: readonly string[]): string[] {
  const unique = [...new Set(warnings.filter((w) => w.trim() !== ''))];
  const alarm = (text: string): boolean => /^[A-Z][A-Z0-9 .]{8,}:/.test(text);
  return [...unique.filter(alarm), ...unique.filter((w) => !alarm(w))];
}

/** The literature behind the numbers of a result: only what was actually used. */
function referencesOf(thermo: ReactionThermo | null, model: KineticModel | null): Citation[] {
  const seen = new Map<string, Citation>();
  const add = (citations: readonly Citation[] | undefined): void => {
    for (const citation of citations ?? []) seen.set(JSON.stringify(citation), citation);
  };
  if (thermo && (thermo.status === 'ok' || thermo.status === 'partial')) {
    for (const term of thermo.terms) {
      const species = THERMO_SPECIES.find((candidate) => candidate.id === term.speciesId);
      if (!species) continue;
      add(species.deltaHf298?.provenance?.citations);
      if (thermo.status === 'ok') add(species.s298?.provenance?.citations);
    }
  }
  if (model) add(model.provenance.citations);
  return [...seen.values()];
}

/**
 * Runs one experiment from the species and conditions a user entered to everything an interface has to
 * show: the seven steps of the calculation, the balanced equation, thermodynamics, kinetics, energy
 * diagrams, explanations at two levels, warnings, limitations and what is needed to reproduce it.
 *
 * The function is synchronous and deterministic: it reads no clock and uses no random numbers, so the
 * same input gives an equal result. It does not throw for anything that is wrong with the experiment;
 * every such case comes back as a result with a status and an explanation.
 *
 * It never predicts chemistry. The equation is built from the reactants and products that were entered;
 * when no products are entered nothing is guessed, and when no sourced data exist for a species or a rate
 * law, nothing is substituted.
 */
export function runExperiment(input: ExperimentInput, options: RunExperimentOptions = {}): ExperimentResult {
  const normalised = normaliseInput(input);
  const inputHash = sha256Hex(canonicalJson(normalised));
  const { conditions, method } = normalised;

  // --- bookkeeping of the run ------------------------------------------------------------------------------
  const steps = new Map<ExperimentStepId, ExperimentStep>();
  const record = (id: ExperimentStepId, status: ExperimentStep['status'], summary: string, details: readonly string[] = []): void => {
    steps.set(id, { id, title: EXPERIMENT_STEP_TITLES[id], status, summary, details: [...details] });
  };
  const run = {
    cancelled: false,
    /** `stop`: nothing more can be calculated, go straight to the limitations. `abort`: the input is not valid. */
    flow: 'run' as 'run' | 'stop' | 'abort',
    stopReason: '',
    lastFraction: -1,
    lastStep: 'validate-species' as ExperimentStepId,
  };
  const cancelRequested = (): boolean => {
    if (!run.cancelled && options.shouldCancel?.() === true) run.cancelled = true;
    return run.cancelled;
  };
  const progress = (fraction: number, step: ExperimentStepId): void => {
    const bounded = Math.min(1, Math.max(0, fraction));
    if (bounded <= run.lastFraction) return;
    run.lastFraction = bounded;
    run.lastStep = step;
    options.onProgress?.(bounded, step);
  };
  const stage = (id: ExperimentStepId, body: () => void): void => {
    if (run.cancelled || run.flow === 'abort' || (run.flow === 'stop' && id !== 'limitations')) return;
    if (cancelRequested()) return;
    body();
    if (!run.cancelled) progress(STEP_END[id], id);
  };

  // --- what the steps find out -----------------------------------------------------------------------------
  let species: readonly ReadSpecies[] = [];
  let balance: BalanceResult | null = null;
  let balanced: ReactionEquation | null = null;
  let balanceHow: EquationPlan['how'] = null;
  let thermoRequested = false;
  /** What the reference table can give for the equation; set by the reference-data step. */
  let thermoData: 'complete' | 'enthalpy-only' | 'missing' = 'complete';
  let kineticsPlan: KineticsPlan = { kind: 'not-requested' };
  let thermo: ReactionThermo | null = null;
  let kineticModel: KineticModel | null = null;
  let rate: RateConstantResult | null = null;
  let kinetics: KineticsResult | null = null;
  let limitations: Limitation[] = [];
  const warnings: string[] = [];
  const solver = { ...DEFAULT_SOLVER, ...normalised.solver };

  progress(0, 'validate-species');

  // --- 1. validate-species ---------------------------------------------------------------------------------
  stage('validate-species', () => {
    const validation = validateInput(normalised);
    const failures = [...validation.failures];
    if (failures.length === 0 && method === 'kinetics' && validation.species.some((entry) => entry.species.role === 'product')) {
      // Kinetics asked for by name: the concentrations its rate law needs are part of a runnable input.
      const early = planEquation(validation.species, conditions.environment);
      const plan = early.balanced ? planKinetics(early.balanced, normalised, validation.species) : undefined;
      if (plan?.kind === 'needs-concentrations') failures.push(`Kinetics was requested. ${plan.message}`);
    }
    if (failures.length > 0) {
      record('validate-species', 'failed', `The input cannot be run: ${plural(failures.length, 'problem was', 'problems were')} found.`, [...failures, ...validation.warnings]);
      warnings.push(...failures, ...validation.warnings);
      run.flow = 'abort';
      return;
    }
    species = validation.species;
    warnings.push(...validation.warnings);
    const entered = species.map((entry) => `${entry.label}: ${entry.species.role}${entry.species.name ? `, ${entry.species.name}` : ''}`);
    const details = [
      `Species: ${entered.join('; ')}.`,
      `Conditions: ${formatEntered(conditions.temperatureK)} K, ${formatEntered(conditions.pressureBar)} bar, ${formatEntered(conditions.durationSeconds)} s, environment ${conditions.environment}.`,
      ...validation.warnings,
    ];
    if (validation.warnings.length > 0) {
      record('validate-species', 'warning', `The input can be run, with ${plural(validation.warnings.length, 'remark', 'remarks')}.`, details);
    } else {
      record('validate-species', 'passed', `All ${plural(species.length, 'species', 'species')} can be read, the roles make an experiment and the conditions are physical.`, details);
    }
  });

  // --- 2. conservation --------------------------------------------------------------------------------------
  stage('conservation', () => {
    if (!species.some((entry) => entry.species.role === 'product')) {
      const summary = 'No products were given, and MATTER LAB does not predict the products of a reaction.';
      record('conservation', 'failed', summary, [
        'Nothing was balanced or calculated: an equation needs both sides, and filling in the missing side would be a prediction that this laboratory does not make.',
        'Enter the products yourself, or look up catalogued reactions of these species with suggestReactions; that is a lookup of known reactions, not a prediction.',
      ]);
      warnings.push(summary);
      run.flow = 'stop';
      run.stopReason = 'no products were given';
      return;
    }
    const outcome = planEquation(species, conditions.environment);
    balance = outcome.balance;
    balanced = outcome.balanced;
    balanceHow = outcome.how;
    warnings.push(...outcome.notes);
    if (!outcome.balanced) {
      const impossible = outcome.balance.status === 'impossible';
      record(
        'conservation',
        'failed',
        impossible
          ? 'The equation cannot be balanced: no positive coefficients conserve every element and the charge.'
          : 'The equation cannot be balanced uniquely: conservation of atoms and charge leaves the coefficients open.',
        [
          `Species entered: ${formatEquation(outcome.skeleton)}.`,
          outcome.balance.message,
          ...outcome.notes,
          ...(impossible || outcome.balance.message.includes('coefficient for every') ? [] : ['To fix the proportions yourself, give a coefficient for every reactant and product.']),
        ],
      );
      warnings.push(outcome.balance.message);
      run.flow = 'stop';
      run.stopReason = impossible ? 'the equation cannot be balanced' : 'the equation cannot be balanced uniquely';
      return;
    }
    const text = formatEquation(outcome.balanced);
    const closing = 'Balancing is bookkeeping: it shows that the equation is possible, not that the reaction takes place.';
    if (outcome.how === 'data-sheet') {
      warnings.push(outcome.balance.message);
      record('conservation', 'warning', `Balanced with the proportions of a sourced elementary reaction, because conservation alone leaves them open: ${text}.`, [
        outcome.balance.message,
        ...outcome.notes,
        ...conservationLines(outcome.balanced),
        closing,
      ]);
    } else if (outcome.how === 'entered') {
      record('conservation', outcome.notes.length > 0 ? 'warning' : 'passed', `The equation conserves every element and the charge with the coefficients that were entered: ${text}.`, [
        ...outcome.notes,
        ...conservationLines(outcome.balanced),
        closing,
      ]);
    } else {
      record('conservation', outcome.notes.length > 0 ? 'warning' : 'passed', `Balanced with the smallest whole-number coefficients: ${text}.`, [
        ...outcome.notes,
        ...conservationLines(outcome.balanced),
        closing,
      ]);
    }
  });

  // --- 3. model-selection -----------------------------------------------------------------------------------
  stage('model-selection', () => {
    const equation = balanced!;
    thermoRequested = method === 'auto' || method === 'thermodynamics';
    kineticsPlan = method === 'auto' || method === 'kinetics' ? planKinetics(equation, normalised, species) : { kind: 'not-requested' };
    const plan = kineticsPlan;
    const lines = ['Stoichiometry: applies. The equation is balanced.'];
    lines.push(
      thermoRequested
        ? 'Thermodynamics: selected. Standard reaction enthalpy, entropy, Gibbs energy and equilibrium constant from the reference table, as far as the table covers the species.'
        : `Thermodynamics: not requested (method "${method}").`,
    );
    if (plan.kind === 'not-requested') lines.push(`Kinetics: not requested (method "${method}").`);
    else if (plan.kind === 'none') lines.push('Kinetics: not available. No sourced rate law exists for this reaction, and the rate law of a similar reaction is never substituted.');
    else if (plan.kind === 'refused') lines.push(`Kinetics: not available. ${plan.message}`);
    else if (plan.kind === 'needs-concentrations') lines.push(`Kinetics: not run. ${plan.message}`);
    else {
      const [low, high] = plan.model.validTemperatureRangeK;
      lines.push(
        `Kinetics: selected. ${plan.model.name}: ${plan.model.rateLaw.description} The expression is recommended for ${low} K to ${high} K${plan.model.conditions ? ` at ${plan.model.conditions}` : ''}.`,
        ...plan.notes,
      );
      warnings.push(...plan.notes);
    }

    if (method === 'kinetics' && plan.kind !== 'selected') {
      const summary =
        plan.kind === 'refused'
          ? 'Kinetics was requested, but the only sourced rate law for this reaction does not apply to these conditions.'
          : 'Kinetics was requested, but no sourced rate law exists for this reaction.';
      record('model-selection', 'failed', summary, lines);
      warnings.push(plan.kind === 'refused' ? plan.message : `${summary} MATTER LAB does not substitute the rate law of a similar reaction.`);
      run.flow = 'stop';
      run.stopReason = 'no sourced rate law applies to this experiment';
      return;
    }
    if (plan.kind === 'refused' || plan.kind === 'needs-concentrations') {
      warnings.push(plan.message);
      record('model-selection', 'warning', 'Thermodynamics is selected; a sourced rate law exists for this reaction but is not used.', lines);
    } else if (method === 'stoichiometry') {
      record('model-selection', 'passed', 'Stoichiometry only, as requested.', lines);
    } else if (method === 'thermodynamics') {
      record('model-selection', 'passed', 'Thermodynamics from the reference table, as requested.', lines);
    } else if (method === 'kinetics') {
      record('model-selection', 'passed', 'Kinetics with a sourced rate law, as requested.', lines);
    } else if (plan.kind === 'selected') {
      record('model-selection', 'passed', 'Thermodynamics and kinetics are both selected.', lines);
    } else {
      record('model-selection', 'passed', 'Thermodynamics is selected; no sourced rate law exists for this reaction, so its kinetics is not simulated.', lines);
    }
  });

  // --- 4. reference-data ------------------------------------------------------------------------------------
  stage('reference-data', () => {
    const plan = kineticsPlan;
    if (!thermoRequested && plan.kind !== 'selected') {
      record('reference-data', 'skipped', 'No reference data are needed: only the balanced equation was requested.');
      return;
    }
    const lines: string[] = [];
    let missing: string[] = [];
    let unphased: string[] = [];
    let withoutEntropy: string[] = [];
    if (thermoRequested) {
      const references = thermoReferences(balanced!);
      lines.push(...references.map((reference) => reference.line));
      unphased = references.filter((reference) => reference.lookup.status === 'phase-required').map((reference) => reference.label);
      missing = references
        .filter((reference) => reference.lookup.status !== 'phase-required' && (reference.lookup.status !== 'found' || !reference.lookup.species?.deltaHf298))
        .map((reference) => reference.label);
      withoutEntropy = references.filter((reference) => reference.lookup.species?.deltaHf298 && !reference.lookup.species.s298).map((reference) => reference.label);
      thermoData = missing.length > 0 || unphased.length > 0 ? 'missing' : withoutEntropy.length > 0 ? 'enthalpy-only' : 'complete';
    }
    if (plan.kind === 'selected') {
      const published = plan.model.asPublished;
      if (published) {
        const exponent = published.EOverRK >= 0 ? `\u2212${formatEntered(published.EOverRK)}` : formatEntered(-published.EOverRK);
        lines.push(
          `Rate expression: ${plan.model.name}, data sheet ${published.dataSheet} of the IUPAC evaluation (${published.location}): ` +
            `k = ${formatSignificant(published.A, 2)} ${prettyUnit(published.AUnits)} \u00d7 exp(${exponent} K / T), recommended for ${plan.model.validTemperatureRangeK[0]} K to ${plan.model.validTemperatureRangeK[1]} K` +
            `${plan.model.conditions ? ` at ${plan.model.conditions}` : ''}.`,
          `The same expression as extracted from the PDF of the source, where superscripts and minus signs appear as plain characters: "${published.expression}"`,
        );
      }
      if (plan.model.reliability) {
        lines.push(
          `Reliability stated by the evaluators: \u0394log10 k = \u00b1${plan.model.reliability.deltaLog10K298} at 298 K and \u0394(E/R) = \u00b1${plan.model.reliability.deltaEOverRK} K, expanded uncertainties of about 95 % confidence.`,
        );
      }
      if (plan.model.concentrationUnit === 'mol/L') lines.push('The rate expression was converted from molecule cm\u207b\u00b3 to mol/L with the exact Avogadro constant.');
    }
    const kineticsNote = plan.kind === 'selected' ? ' The rate expression comes from a cited data sheet.' : '';
    if (!thermoRequested) {
      record('reference-data', 'passed', 'The rate expression comes from a cited data sheet.', lines);
    } else if (missing.length > 0 || unphased.length > 0) {
      const problems = [
        ...(missing.length > 0 ? [`${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} missing from the reference table`] : []),
        ...(unphased.length > 0 ? [`${listOf(unphased)} ${unphased.length === 1 ? 'is' : 'are'} tabulated in several phases and no phase was given`] : []),
      ];
      record('reference-data', plan.kind === 'selected' ? 'warning' : 'failed', `${problems.join(', and ')}, so no thermodynamic values can be computed.${kineticsNote}`, lines);
    } else if (withoutEntropy.length > 0) {
      record('reference-data', 'warning', `Every species has an enthalpy of formation, but the table has no standard entropy for ${listOf(withoutEntropy)}.${kineticsNote}`, lines);
    } else {
      record('reference-data', 'passed', `Every species of the equation is in the reference table.${kineticsNote}`, lines);
    }
  });

  // --- 5. engine --------------------------------------------------------------------------------------------
  stage('engine', () => {
    const lines = ['Balancing: exact rational null space of the element-and-charge composition matrix, scaled to the smallest whole numbers; no floating-point arithmetic.'];
    const names = ['exact rational balancing'];
    if (thermoRequested && thermoData === 'complete') {
      lines.push(
        "Thermodynamics: Hess's law on the tabulated standard enthalpies of formation and standard entropies at 298.15 K; \u0394G\u00b0(T) = \u0394H\u00b0(298.15 K) \u2212 T\u00b7\u0394S\u00b0(298.15 K) " +
          'with the reaction enthalpy and entropy taken as independent of temperature; K = exp(\u2212\u0394G\u00b0/RT); uncertainties of the table values combined in quadrature.',
      );
      names.push("Hess's law on reference values");
    } else if (thermoRequested && thermoData === 'enthalpy-only') {
      lines.push(
        "Thermodynamics: Hess's law on the tabulated standard enthalpies of formation at 298.15 K, for the reaction enthalpy only; without a standard entropy for every species no Gibbs energy or equilibrium constant is computed.",
      );
      names.push("Hess's law on reference values (reaction enthalpy only)");
    } else if (thermoRequested) {
      lines.push('Thermodynamics: no engine is run, because the reference table does not cover every species of the equation.');
    }
    if (kineticsPlan.kind === 'selected') {
      lines.push(
        `Kinetics: rate constant k = A\u00b7exp(\u2212Ea/RT) from the data sheet; concentrations by ${KINETICS_SOLVER_METHOD}, ` +
          `error tolerance ${solver.tolerance}, at most ${solver.maxSteps} step attempts, ${solver.outputPoints} output points.`,
      );
      names.push('Dormand-Prince 5(4) integration of the rate law');
    }
    lines.push(`Engine: ${EXPERIMENT_ENGINE} ${EXPERIMENT_ENGINE_VERSION}. It is deterministic: no clock and no random numbers are used.`);
    record('engine', 'passed', `Engines used: ${listOf(names)}.`, lines);
  });

  // --- 6. calculation ---------------------------------------------------------------------------------------
  stage('calculation', () => {
    const plan = kineticsPlan;
    if (!thermoRequested && plan.kind !== 'selected') {
      record('calculation', 'skipped', 'No further calculation was requested: the balanced equation is the result.');
      return;
    }
    const lines: string[] = [];
    const found: string[] = [];
    let incomplete = false;
    let computedThermo: ReactionThermo | null = null;
    let computedRate: RateConstantResult | null = null;
    let computedKinetics: KineticsResult | null = null;

    if (thermoRequested) {
      computedThermo = reactionThermodynamics(balanced!, conditions.temperatureK);
      const text = describeThermo(computedThermo);
      if (computedThermo.status === 'ok' && text) {
        const relation = text.approximate ? '\u2248' : '=';
        lines.push(
          `Reaction enthalpy \u0394rH\u00b0(298.15 K) = ${text.deltaH}; reaction entropy \u0394rS\u00b0(298.15 K) = ${text.deltaS}.`,
          `Gibbs energy \u0394rG\u00b0(${formatEntered(conditions.temperatureK)} K) ${relation} ${text.deltaG}${text.approximate ? ' (a rough estimate at this temperature)' : ''}; ${text.log10K}, K \u2248 ${text.K}.`,
          `With every species in its standard state the reaction is ${computedThermo.spontaneity}.`,
          'Thermodynamics: closed-form sums over table values; there is nothing to converge.',
        );
        found.push('thermodynamic values from the reference table');
      } else if (computedThermo.status === 'partial' && text) {
        lines.push(
          `Reaction enthalpy \u0394rH\u00b0(298.15 K) = ${text.deltaH}.`,
          `No reaction entropy, Gibbs energy or equilibrium constant: the table has no standard entropy for ${listOf(computedThermo.missingEntropy)}.`,
        );
        found.push('the reaction enthalpy');
        incomplete = true;
      } else {
        lines.push(
          computedThermo.status === 'ambiguous-phase'
            ? 'No thermodynamic values were computed: a species is tabulated in several phases and no phase was given.'
            : `No thermodynamic values were computed: ${listOf(computedThermo.missingSpecies)} ${computedThermo.missingSpecies.length === 1 ? 'is' : 'are'} not in the reference table.`,
        );
        incomplete = true;
      }
      if (cancelRequested()) return;
      progress(THERMO_DONE, 'calculation');
    }

    if (plan.kind === 'selected') {
      computedRate = rateConstant(plan.model, conditions.temperatureK);
      computedKinetics = simulateKinetics(
        {
          model: plan.model,
          temperatureK: conditions.temperatureK,
          initialConcentrations: plan.initialConcentrations,
          durationSeconds: conditions.durationSeconds,
          tolerance: solver.tolerance,
          maxSteps: solver.maxSteps,
          outputPoints: solver.outputPoints,
        },
        {
          shouldCancel: cancelRequested,
          onProgress: (fraction) => {
            const mapped = INTEGRATION_SPAN[0] + Math.min(1, Math.max(0, fraction)) * (INTEGRATION_SPAN[1] - INTEGRATION_SPAN[0]);
            if (mapped >= run.lastFraction + PROGRESS_INCREMENT) progress(mapped, 'calculation');
          },
        },
      );
      if (run.cancelled) return;
      const text = describeKinetics(plan.model, computedRate, computedKinetics);
      lines.push(
        `Rate constant at ${formatEntered(conditions.temperatureK)} K: k = ${text.k}` +
          (text.kFactor ? `, uncertain by ${text.kFactor} according to the evaluators (about 95 % confidence)` : '') +
          (computedRate.withinValidatedRange ? '.' : '; this is an extrapolation outside the recommended temperature range.'),
      );
      const numerics = computedKinetics.solver;
      if (computedKinetics.status === 'ok') {
        lines.push(
          `The integration reached t = ${formatEntered(conditions.durationSeconds)} s in ${numerics.steps} accepted steps (${numerics.rejectedSteps} rejected, ${numerics.functionEvaluations} evaluations of the rate law) ` +
            `at an error tolerance of ${numerics.tolerance}; the budget of ${solver.maxSteps} step attempts was not exhausted.`,
        );
        if (numerics.reactionCompleteAfterSeconds !== undefined) {
          lines.push(`The limiting reactant was used up to within the tolerance after ${formatSignificant(numerics.reactionCompleteAfterSeconds, 3)} s; from then on the composition does not change.`);
        }
        found.push('the rate constant and the concentration curves');
      } else if (computedKinetics.status === 'incomplete') {
        const reached = computedKinetics.times.length > 0 ? computedKinetics.times[computedKinetics.times.length - 1]! : 0;
        lines.push(
          `The integration did not reach the end: it stopped after ${numerics.steps} accepted steps (${numerics.rejectedSteps} rejected), and the curves end at the last output time before that, ` +
            `t = ${formatSignificant(reached, 3)} s of ${formatEntered(conditions.durationSeconds)} s. ` +
            (numerics.stopReason === 'max-steps' ? `The budget of ${solver.maxSteps} step attempts ran out.` : 'The integrator could not continue.'),
          ...computedKinetics.reasons,
        );
        found.push('the rate constant and part of the concentration curves');
        incomplete = true;
      } else {
        lines.push('No concentration curves were computed.', ...computedKinetics.reasons);
        found.push('the rate constant');
        incomplete = true;
      }
      if (text.halfLife && computedKinetics.halfLife) {
        lines.push(`Half-life of ${text.halfLifeSpecies}, the limiting reactant: ${text.halfLife} (${computedKinetics.halfLife.method === 'analytic' ? 'closed form' : 'numerical quadrature of the rate law'}).`);
      }
      if (text.change.length > 0) lines.push(`From t = 0 to t = ${text.endTime}: ${text.change.join('; ')}${text.conversion ? `; ${text.conversion} of ${text.halfLifeSpecies} has reacted` : ''}.`);

      // The concentrations entered must fit into an ideal gas at the pressure and temperature entered.
      const perCm3 = plan.model.concentrationUnit === 'mol/L' ? MOLECULES_PER_CM3_PER_MOL_PER_L : 1;
      const total = Object.values(plan.initialConcentrations).reduce((sum, value) => sum + value, 0) * perCm3;
      const available = (conditions.pressureBar * BAR_TO_PA) / (BOLTZMANN_J_PER_K * conditions.temperatureK) / 1e6;
      if (total > available) {
        const unit = prettyUnit('molecule cm-3');
        const warning =
          `The initial concentrations add up to ${formatSignificant(total, 2)} ${unit}, more than an ideal gas contains in total at ${formatEntered(conditions.pressureBar)} bar and ` +
          `${formatEntered(conditions.temperatureK)} K (${formatSignificant(available, 2)} ${unit}). The concentrations and the pressure do not fit together; the simulation uses the concentrations as entered.`;
        lines.push(warning);
        warnings.push(warning);
      }
    }

    thermo = computedThermo;
    kineticModel = plan.kind === 'selected' ? plan.model : null;
    rate = computedRate;
    kinetics = computedKinetics;
    if (computedThermo) warnings.push(...computedThermo.warnings);
    if (computedKinetics) warnings.push(...computedKinetics.warnings, ...(computedKinetics.status === 'ok' ? [] : computedKinetics.reasons));
    if (found.length === 0) record('calculation', 'failed', 'Nothing could be calculated beyond the balanced equation.', lines);
    else record('calculation', incomplete ? 'warning' : 'passed', `Calculated: ${listOf(found)}.${incomplete ? ' Part of what was asked for could not be calculated.' : ''}`, lines);
  });

  // --- 7. limitations ---------------------------------------------------------------------------------------
  stage('limitations', () => {
    limitations = buildLimitations({ input: normalised, species, hasEquation: balanced !== null, thermoRequested, thermo, kineticsPlan, kineticModel, rate, kinetics });
    warnings.push(...environmentMismatches(normalised, species).map((mismatch) => mismatch.text));
    const specific = limitations.filter((limitation) => limitation.specific).length;
    record(
      'limitations',
      specific > 0 ? 'warning' : 'passed',
      `${plural(limitations.length, 'limitation applies', 'limitations apply')}${specific > 0 ? `, ${specific} of them because of this particular experiment` : ''}.`,
      limitations.map((limitation) => limitation.text),
    );
  });

  // --- the result -------------------------------------------------------------------------------------------
  const notRun = run.cancelled ? 'Not run: the experiment was cancelled.' : run.flow === 'abort' ? 'Not run: the input is not valid.' : `Not run: ${run.stopReason}.`;
  for (const id of EXPERIMENT_STEP_IDS) if (!steps.has(id)) record(id, 'skipped', notRun);

  // The assignments above happen inside closures, which the type checker does not follow.
  const finalBalance = balance as BalanceResult | null;
  const finalBalanced = balanced as ReactionEquation | null;
  const finalThermo = thermo as ReactionThermo | null;
  const finalModel = kineticModel as KineticModel | null;
  const finalRate = rate as RateConstantResult | null;
  const finalKinetics = kinetics as KineticsResult | null;
  const finalPlan = kineticsPlan as KineticsPlan;

  const thermoShown = finalThermo !== null && (finalThermo.status === 'ok' || finalThermo.status === 'partial');
  const kineticsShown = finalKinetics !== null && finalKinetics.status !== 'unsupported';
  let status: ExperimentStatus;
  if (run.cancelled) status = 'cancelled';
  else if (run.flow === 'abort') status = 'invalid';
  else if (!finalBalanced) status = 'unsupported';
  else if (method === 'stoichiometry') status = 'completed';
  else {
    const thermoComplete = finalThermo?.status === 'ok';
    const kineticsComplete = finalKinetics?.status === 'ok';
    if (method === 'thermodynamics') status = thermoComplete ? 'completed' : thermoShown ? 'partial' : 'unsupported';
    else if (method === 'kinetics') status = finalPlan.kind !== 'selected' ? 'unsupported' : kineticsComplete ? 'completed' : finalRate ? 'partial' : 'unsupported';
    else {
      // auto: complete when the thermodynamics is complete and every applicable rate law was run to the end.
      const kineticsDone = finalPlan.kind === 'selected' ? kineticsComplete : finalPlan.kind === 'none' || finalPlan.kind === 'refused';
      status = thermoComplete && kineticsDone ? 'completed' : 'partial';
    }
  }

  const finished = !run.cancelled && run.flow !== 'abort';
  const energyDiagrams =
    finished && finalBalanced
      ? buildEnergyDiagrams({ balanced: finalBalanced, temperatureK: conditions.temperatureK, thermoRequested, thermo: finalThermo, kineticModel: finalRate ? finalModel : null })
      : [];

  const shown: EvidenceLevel[] = [];
  if (finalBalanced) shown.push('computed');
  if (thermoShown && finalThermo) shown.push(finalThermo.evidence);
  if (finalRate) shown.push(finalRate.k.evidence);
  if (kineticsShown && finalKinetics) shown.push(finalKinetics.evidence);
  for (const diagram of energyDiagrams) for (const level of diagram.levels) shown.push(level.evidence);

  const dataSources: ExperimentDataSource[] = [];
  if (thermoShown && finalThermo) {
    const used = finalThermo.terms.map((term) => term.speciesId).filter((id): id is string => id !== undefined);
    dataSources.push(...thermoDataSources(used, finalThermo.status === 'ok'));
  }
  if (finalModel && finalRate) {
    const source = kineticDataSource(finalModel);
    if (source) dataSources.push(source);
  }

  const orderedSteps = EXPERIMENT_STEP_IDS.map((id) => steps.get(id)!);
  const orderedWarnings = orderWarnings(warnings);
  const limitationTexts = limitations.map((limitation) => limitation.text);
  const equation = finalBalanced && finalBalance ? { text: formatEquation(finalBalanced), balanced: finalBalanced, balance: finalBalance } : null;
  const references = referencesOf(finalThermo, finalRate ? finalModel : null);
  const explanation = buildExplanation({
    input: normalised,
    status,
    species,
    steps: orderedSteps,
    equationText: equation?.text ?? null,
    balance: finalBalance,
    balanceHow: balanceHow as EquationPlan['how'],
    thermoRequested,
    thermo: finalThermo,
    kineticsPlan: finalPlan,
    kineticModel: finalRate ? finalModel : null,
    rate: finalRate,
    kinetics: finalKinetics,
    limitations,
    warnings: orderedWarnings,
    energyDiagrams,
    solver,
  });

  if (!run.cancelled) progress(1, run.lastStep);
  return {
    schema: EXPERIMENT_RESULT_SCHEMA,
    schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
    input: normalised,
    inputHash,
    status,
    evidence: weakest(shown),
    steps: orderedSteps,
    equation,
    balance: finalBalance,
    thermo: finalThermo,
    kineticModel: finalRate ? finalModel : null,
    rateConstant: finalRate,
    kinetics: finalKinetics,
    energyDiagrams,
    explanation: { beginner: explanation.beginner, advanced: explanation.advanced, references },
    warnings: orderedWarnings,
    limitations: limitationTexts,
    reproducibility: {
      engine: EXPERIMENT_ENGINE,
      engineVersion: EXPERIMENT_ENGINE_VERSION,
      dataSources,
      solver: finalKinetics
        ? { method: finalKinetics.solver.method, tolerance: finalKinetics.solver.tolerance, steps: finalKinetics.solver.steps, functionEvaluations: finalKinetics.solver.functionEvaluations }
        : null,
      deterministic: true,
    },
  };
}

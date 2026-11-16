import { EMPTY_SCENE } from '@matterlab/core';
import type { AtomId } from '@matterlab/core';
import { EXPERIMENT_PRESETS, EXPERIMENT_STEP_TITLES, parseExperimentResult } from '@matterlab/reactions';
import type {
  ExperimentConditions,
  ExperimentInput,
  ExperimentMethod,
  ExperimentResult,
  ExperimentSpecies,
  ExperimentStatus,
  ExperimentStepId,
  SpeciesTerm,
} from '@matterlab/reactions';
import { create } from 'zustand';
import { cancelJobsOfKind, runJob } from '../science/jobs';
import { JobCancelledError, WorkerClient } from '../science/rpc';
import { resolveStructure } from '../science/structures';
import type { StructureLookup } from '../science/structures';
import { notify, selectOnly, showOnStage } from '../state/actions';
import { downloadText } from '../state/commands';
import { deleteOne, getAll, getOne, putOne } from '../state/db';
import { lab } from '../state/store';
import type { ReactionMethods, ReactionProgress } from '../workers/reaction.worker';
import { buildChamber, planChamber } from './chamber';
import type { ChamberPlan, ChamberSpecies } from './chamber';

const client = new WorkerClient<ReactionMethods>(
  () => new Worker(new URL('../workers/reaction.worker.ts', import.meta.url), { type: 'module', name: 'matterlab-reactions' }),
  'reaction',
);

export type ResultTab = 'result' | 'graphs' | 'explain' | 'record';

/** What a saved experiment shows in a list, without parsing its full record. */
export interface ExperimentSummary {
  readonly id: string;
  readonly title: string;
  readonly savedAt: string;
  readonly status: ExperimentStatus;
  readonly equation: string | null;
  readonly inputHash: string;
  readonly temperatureK: number;
  readonly deltaH: number | null;
  readonly deltaG: number | null;
  readonly log10K: number | null;
  readonly rateConstant: number | null;
  readonly rateConstantUnit: string | null;
  readonly halfLifeSeconds: number | null;
}

interface ExperimentRecord extends ExperimentSummary {
  /** The result exactly as `serializeExperimentResult` wrote it. */
  readonly json: string;
}

export interface Reproduction {
  readonly status: 'running' | 'identical' | 'different' | 'failed';
  readonly detail?: string;
}

interface ReactionState {
  readonly draft: ExperimentInput;
  readonly presetId: string | null;
  readonly running: boolean;
  readonly progress: ReactionProgress | null;
  readonly result: ExperimentResult | null;
  /** The result as serialised text: what is saved, exported and compared when reproducing. */
  readonly resultJson: string | null;
  /** The draft the result was computed from; a different draft means the result is out of date. */
  readonly ranDraft: ExperimentInput | null;
  readonly error: string | null;

  readonly structures: Readonly<Record<string, StructureLookup>>;
  readonly structuresLoading: boolean;
  readonly plan: ChamberPlan | null;

  /** Index into the computed time course. */
  readonly frame: number;
  /** Fraction of the reaction events shown as products, for experiments without a time course. */
  readonly conversion: number;
  readonly playing: boolean;
  readonly speed: number;
  /** Species whose molecules are picked out in the chamber, by its key in the plan. */
  readonly highlight: string | null;

  readonly saved: readonly ExperimentSummary[];
  /** The library record the current result was opened from or saved to. */
  readonly savedId: string | null;
  readonly reproduction: Reproduction | null;
  readonly compare: readonly string[];
  readonly tab: ResultTab;
}

const FIRST_PRESET = EXPERIMENT_PRESETS[0];

const BLANK: ExperimentInput = {
  title: 'New experiment',
  species: [
    { formula: '', role: 'reactant' },
    { formula: '', role: 'product' },
  ],
  conditions: { temperatureK: 298.15, pressureBar: 1, durationSeconds: 60, environment: 'unspecified', concentrationUnit: 'mol/L' },
  method: 'auto',
};

export const useReaction = create<ReactionState>()(() => ({
  draft: FIRST_PRESET ? FIRST_PRESET.input : BLANK,
  presetId: FIRST_PRESET ? FIRST_PRESET.id : null,
  running: false,
  progress: null,
  result: null,
  resultJson: null,
  ranDraft: null,
  error: null,
  structures: {},
  structuresLoading: false,
  plan: null,
  frame: 0,
  conversion: 0,
  playing: false,
  speed: 1,
  highlight: null,
  saved: [],
  savedId: null,
  reproduction: null,
  compare: [],
  tab: 'result',
}));

const set = useReaction.setState;
const get = useReaction.getState;

// ---------- editing the experiment ----------

function editDraft(change: (draft: ExperimentInput) => ExperimentInput): void {
  set((s) => ({ draft: change(s.draft), presetId: null }));
}

export function loadPreset(id: string): void {
  const preset = EXPERIMENT_PRESETS.find((p) => p.id === id);
  if (preset) set({ draft: preset.input, presetId: id });
}

export function newExperiment(): void {
  set({ draft: BLANK, presetId: null });
}

export function setTitle(title: string): void {
  editDraft((d) => ({ ...d, title }));
}

export function setMethod(method: ExperimentMethod): void {
  editDraft((d) => ({ ...d, method }));
}

export function setCondition<K extends keyof ExperimentConditions>(key: K, value: ExperimentConditions[K]): void {
  editDraft((d) => ({ ...d, conditions: { ...d.conditions, [key]: value } }));
}

export function updateSpecies(index: number, change: Partial<ExperimentSpecies>): void {
  editDraft((d) => ({
    ...d,
    species: d.species.map((s, i) => {
      if (i !== index) return s;
      const next = { ...s, ...change } as { -readonly [K in keyof ExperimentSpecies]: ExperimentSpecies[K] };
      // Optional fields are left out rather than stored as undefined, so equal inputs serialise equally.
      if (next.phase === undefined) delete next.phase;
      if (next.name === undefined || next.name === '') delete next.name;
      if (next.initialConcentration === undefined) delete next.initialConcentration;
      return next;
    }),
  }));
}

export function addSpecies(role: ExperimentSpecies['role']): void {
  editDraft((d) => {
    // New species join the others of the same role, so the equation reads in the order shown.
    const last = d.species.map((s) => s.role).lastIndexOf(role);
    const at = last >= 0 ? last + 1 : d.species.length;
    return { ...d, species: [...d.species.slice(0, at), { formula: '', role }, ...d.species.slice(at)] };
  });
}

export function removeSpecies(index: number): void {
  editDraft((d) => ({ ...d, species: d.species.filter((_, i) => i !== index) }));
}

/** True when the experiment has been changed since the result on screen was computed. */
export function isStale(s: ReactionState): boolean {
  return s.result !== null && s.draft !== s.ranDraft;
}

// ---------- running ----------

function describe(input: ExperimentInput): string {
  const side = (role: string) => input.species.filter((s) => s.role === role && s.formula.trim()).map((s) => s.formula.trim()).join(' + ');
  const text = `${side('reactant')} → ${side('product') || '?'}`;
  return input.title ? `${input.title}: ${text}` : text;
}

function compute(input: ExperimentInput, title: string): Promise<string> {
  return runJob({ kind: 'reaction', title, detail: describe(input) }, ({ signal, report }) =>
    client.call(
      'run',
      { input },
      {
        signal,
        onProgress: (p: ReactionProgress) => {
          report(p.fraction, EXPERIMENT_STEP_TITLES[p.step as ExperimentStepId]);
          set({ progress: p });
        },
      },
    ),
  );
}

export async function runDraft(): Promise<void> {
  if (get().running) return;
  const draft = get().draft;
  set({ running: true, error: null, progress: null, reproduction: null, playing: false });
  try {
    const json = await compute(draft, 'Reaction experiment');
    const result = parseExperimentResult(json);
    set({ running: false, progress: null, result, resultJson: json, ranDraft: draft, frame: 0, conversion: 0, savedId: null });
    void prepareChamber(result);
  } catch (error) {
    if (error instanceof JobCancelledError) set({ running: false, progress: null });
    else set({ running: false, progress: null, error: error instanceof Error ? error.message : String(error) });
  }
}

export function cancelRun(): void {
  cancelJobsOfKind('reaction');
}

// ---------- the chamber ----------

export const termKey = (term: Pick<SpeciesTerm, 'formula' | 'phase'>): string => `${term.formula}${term.phase ? `(${term.phase})` : ''}`;

/** For each output time, the fraction of the limiting reactant that has reacted; `null` without a time course. */
export function extentFractions(result: ExperimentResult): Float64Array | null {
  const kinetics = result.kinetics;
  const equation = result.equation?.balanced;
  if (!kinetics || !equation || kinetics.times.length < 2) return null;
  let limiting: Float64Array | null = null;
  let least = Infinity;
  for (const term of equation.reactants) {
    const series = kinetics.concentrations[term.formula];
    if (!series) continue;
    const perEvent = series[0]! / term.coefficient;
    if (perEvent < least) {
      least = perEvent;
      limiting = series;
    }
  }
  if (!limiting || !(limiting[0]! > 0)) return null;
  const start = limiting[0]!;
  return Float64Array.from(limiting, (c) => Math.min(1, Math.max(0, (start - c) / start)));
}

/** How many of the chamber's reaction events have happened at the current position of the timeline. */
export function reactedGroups(s: Pick<ReactionState, 'result' | 'plan' | 'frame' | 'conversion'>): number {
  if (!s.plan || !s.result) return 0;
  const fractions = extentFractions(s.result);
  const fraction = fractions ? (fractions[Math.min(fractions.length - 1, s.frame)] ?? 0) : s.conversion;
  return Math.round(fraction * s.plan.groups);
}

async function prepareChamber(result: ExperimentResult): Promise<void> {
  const equation = result.equation?.balanced;
  if (!equation) {
    set({ plan: null, structures: {}, structuresLoading: false, highlight: null });
    return;
  }
  set({ structuresLoading: true, plan: null, highlight: null });
  const nameOf = (formula: string) => result.input.species.find((s) => s.formula === formula)?.name ?? result.kineticModel?.speciesNames?.[formula];
  const terms = [...equation.reactants.map((term) => ({ term, side: 'reactant' as const })), ...equation.products.map((term) => ({ term, side: 'product' as const }))];
  const lookups = await Promise.all(
    terms.map(({ term }) =>
      resolveStructure({ formula: term.formula, phase: term.phase, name: nameOf(term.formula) }).catch(
        (error: unknown): StructureLookup => ({ ok: false, reason: error instanceof Error ? error.message : 'The structure could not be loaded.' }),
      ),
    ),
  );
  // A newer run may have replaced this result while structures were being fetched.
  if (get().result !== result) return;

  const structures: Record<string, StructureLookup> = {};
  const species: ChamberSpecies[] = terms.map(({ term, side }, i) => {
    const lookup = lookups[i]!;
    structures[termKey(term)] = lookup;
    return { key: termKey(term), side, coefficient: term.coefficient, structure: lookup.ok ? lookup.structure : null };
  });

  // Molecules present beyond what the reaction events account for: excess reactants and initial products.
  const extra: Record<string, number> = {};
  const kinetics = result.kinetics;
  if (kinetics && extentFractions(result)) {
    const perEvent = Math.min(...equation.reactants.flatMap((t) => (kinetics.concentrations[t.formula] ? [kinetics.concentrations[t.formula]![0]! / t.coefficient] : [])));
    for (const { term, side } of terms) {
      const start = kinetics.concentrations[term.formula]?.[0];
      if (start === undefined || !(perEvent > 0)) continue;
      extra[termKey(term)] = Math.max(0, start / perEvent - (side === 'reactant' ? term.coefficient : 0));
    }
  }
  set({ structures, structuresLoading: false, plan: planChamber(species, extra) });
}

/** Draws the chamber for the current position of the timeline on the 3D stage. */
export function syncStage(fit: boolean): void {
  if (lab.get().workspace !== 'reactions') return;
  const s = get();
  if (!s.plan) {
    showOnStage(EMPTY_SCENE, { fit });
    return;
  }
  const chamber = buildChamber(s.plan, reactedGroups(s));
  showOnStage(chamber.scene, { fit });
  if (s.highlight) {
    const atoms: AtomId[] = [];
    for (const [id, key] of chamber.speciesOfAtom) if (key === s.highlight) atoms.push(id);
    selectOnly(atoms);
  }
}

/** Picks out the molecules of one species in the chamber, or stops doing so. */
export function toggleHighlight(key: string): void {
  set((s) => ({ highlight: s.highlight === key ? null : key }));
}

// ---------- the timeline ----------

export function frameCount(s: Pick<ReactionState, 'result'>): number {
  return s.result?.kinetics && s.result.kinetics.times.length > 1 ? s.result.kinetics.times.length : 0;
}

export function seek(frame: number): void {
  const count = frameCount(get());
  if (count === 0) return;
  set({ frame: Math.min(count - 1, Math.max(0, Math.round(frame))) });
}

export function seekTime(seconds: number): void {
  const times = get().result?.kinetics?.times;
  if (!times || times.length < 2) return;
  const span = times[times.length - 1]! - times[0]!;
  seek(span > 0 ? ((seconds - times[0]!) / span) * (times.length - 1) : 0);
}

export function step(delta: number): void {
  set({ playing: false });
  seek(get().frame + delta);
}

export function setPlaying(playing: boolean): void {
  const s = get();
  const count = frameCount(s);
  if (count === 0) return;
  // Playing from the last frame starts over.
  set({ playing, ...(playing && s.frame >= count - 1 ? { frame: 0 } : {}) });
}

export function setSpeed(speed: number): void {
  set({ speed });
}

export function setConversion(conversion: number): void {
  set({ conversion: Math.min(1, Math.max(0, conversion)) });
}

export function setTab(tab: ResultTab): void {
  set({ tab });
}

// ---------- the experiment library ----------

function summarise(id: string, result: ExperimentResult, savedAt: string): ExperimentSummary {
  return {
    id,
    title: result.input.title?.trim() || 'Untitled experiment',
    savedAt,
    status: result.status,
    equation: result.equation?.text ?? null,
    inputHash: result.inputHash,
    temperatureK: result.input.conditions.temperatureK,
    deltaH: result.thermo?.deltaH?.value ?? null,
    deltaG: result.thermo?.deltaG?.value ?? null,
    log10K: result.thermo?.log10K ?? null,
    rateConstant: result.rateConstant && Number.isFinite(result.rateConstant.k.value) ? result.rateConstant.k.value : null,
    rateConstantUnit: result.rateConstant?.k.unit ?? null,
    halfLifeSeconds: result.kinetics?.halfLifeSeconds ?? null,
  };
}

export async function refreshSaved(): Promise<void> {
  try {
    const records = await getAll<ExperimentRecord>('experiments');
    set({
      saved: records
        .map(({ json: _json, ...summary }) => summary)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    });
  } catch (error) {
    notify('error', 'The experiment library could not be read', error instanceof Error ? error.message : undefined);
  }
}

export async function saveExperiment(): Promise<void> {
  const { result, resultJson, savedId } = get();
  if (!result || !resultJson) return;
  try {
    const id = savedId ?? crypto.randomUUID();
    const record: ExperimentRecord = { ...summarise(id, result, new Date().toISOString()), json: resultJson };
    await putOne('experiments', record);
    set({ savedId: id });
    await refreshSaved();
    notify('success', `Saved “${record.title}”`, 'Inputs, settings and results are stored in the experiment library on this device.');
  } catch (error) {
    notify('error', 'The experiment could not be saved', error instanceof Error ? error.message : undefined);
  }
}

function openResult(json: string, savedId: string | null): void {
  const result = parseExperimentResult(json);
  set({
    draft: result.input,
    presetId: null,
    result,
    resultJson: json,
    ranDraft: result.input,
    error: null,
    frame: 0,
    conversion: 0,
    playing: false,
    savedId,
    reproduction: null,
    tab: 'result',
  });
  void prepareChamber(result);
}

export async function openExperiment(id: string): Promise<void> {
  try {
    const record = await getOne<ExperimentRecord>('experiments', id);
    if (!record) throw new Error('That experiment is no longer in the library.');
    openResult(record.json, id);
  } catch (error) {
    notify('error', 'The experiment could not be opened', error instanceof Error ? error.message : undefined);
  }
}

export async function deleteExperiment(id: string): Promise<void> {
  await deleteOne('experiments', id);
  set((s) => ({ savedId: s.savedId === id ? null : s.savedId, compare: s.compare.filter((c) => c !== id) }));
  await refreshSaved();
}

export function exportExperiment(): void {
  const { result, resultJson } = get();
  if (!result || !resultJson) return;
  const name = (result.input.title?.trim() || 'experiment').replace(/[^\w.\- ()]+/g, '_').slice(0, 80);
  downloadText(`${name}.experiment.json`, resultJson, 'application/json');
  notify('success', 'Experiment record downloaded', 'The file holds every input, setting and result, and can be opened again here.');
}

export async function importExperimentFile(file: File): Promise<void> {
  try {
    openResult(await file.text(), null);
    notify('success', `Opened “${file.name}”`);
  } catch (error) {
    notify('error', `“${file.name}” is not an experiment record`, error instanceof Error ? error.message : undefined);
  }
}

/**
 * Runs the recorded inputs again and compares the outcome, byte for byte, with the record. The
 * engine is deterministic, so anything but an identical result means the engine or its data changed.
 */
export async function reproduce(): Promise<void> {
  const { result, resultJson, running } = get();
  if (!result || !resultJson || running) return;
  set({ reproduction: { status: 'running' } });
  try {
    const json = await compute(result.input, 'Reproducing experiment');
    if (get().resultJson !== resultJson) return;
    if (json === resultJson) {
      set({ reproduction: { status: 'identical', detail: `Input hash ${result.inputHash.slice(0, 12)}…; every number of the record was reproduced exactly.` } });
    } else {
      const again = parseExperimentResult(json);
      const changed = [
        again.reproducibility.engineVersion !== result.reproducibility.engineVersion ? `engine ${result.reproducibility.engineVersion} → ${again.reproducibility.engineVersion}` : '',
        again.status !== result.status ? `status ${result.status} → ${again.status}` : '',
      ].filter(Boolean);
      set({ reproduction: { status: 'different', detail: changed.length > 0 ? `Differences: ${changed.join('; ')}.` : 'The numbers differ from the record although engine version and status agree.' } });
    }
  } catch (error) {
    if (error instanceof JobCancelledError) set({ reproduction: null });
    else set({ reproduction: { status: 'failed', detail: error instanceof Error ? error.message : String(error) } });
  }
}

export function toggleCompare(id: string): void {
  set((s) => ({ compare: s.compare.includes(id) ? s.compare.filter((c) => c !== id) : [...s.compare, id].slice(-4) }));
}

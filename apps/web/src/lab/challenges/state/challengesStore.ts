/**
 * Orchestration store for the four game modes. Mirrors the conventions of `apps/web/src/reaction/store.ts`:
 * a zustand store plus imperative `set`/`get` and exported action functions. This is the one place
 * that decides *which* `ExperimentRuntimeSource` is live and recomputes everything downstream of it
 * (goal evaluation, hints, score, notebook) whenever that source changes.
 */

import { create } from 'zustand';
import { downloadText } from '../../../state/commands';
import type { ExperimentRuntimeSource, LabEventRecord, Observation, SolverClient, UUID } from '../contracts';
import { NOT_CONNECTED_SOURCE } from '../contracts';
import { deriveTrialsFromLog, evaluateObjective, withInterpretations } from '../goals';
import type { EvaluationContext, GameMode, Objective, ObjectiveEvaluation } from '../goals';
import { EMPTY_CONTEXT } from '../goals';
import { buildChecklist, deriveHint } from '../hints';
import type { ChecklistItem, HintDescriptor } from '../hints';
import { createRealEngineSource, RealEngineRuntimeSource } from '../integration/realEngineSource';
import { buildNotebook } from '../notebook';
import type { NotebookData } from '../notebook';
import { createIndexedDbAttemptRepository, deriveAchievements, summarise } from '../persistence';
import type { Achievement, ChallengeAttempt, ChallengeAttemptRepository, ChallengeAttemptSummary } from '../persistence';
import { compareAttempts } from '../replay';
import type { AttemptComparison } from '../replay';
import { scoreAttempt } from '../scoring';
import type { ScoreBreakdown } from '../scoring';
import { buildTemplateFromScene, serializeTemplate } from '../templates';
import { CHALLENGE_TITRATION_OBJECTIVE, FREE_EXPLORATION_OBJECTIVE, GUIDED_TITRATION_OBJECTIVE, PRECISION_TITRATION_OBJECTIVE } from '../titrationObjective';

export const OBJECTIVES_BY_MODE: Readonly<Record<GameMode, Objective>> = {
  guided: GUIDED_TITRATION_OBJECTIVE,
  challenge: CHALLENGE_TITRATION_OBJECTIVE,
  free: FREE_EXPLORATION_OBJECTIVE,
  precision: PRECISION_TITRATION_OBJECTIVE,
};

export type DataSourceKind = 'live' | 'real-engine';
export type InterpretationAnswer = { readonly reportedAnalyteMolarity?: number; readonly interpretation?: string };

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function latestSimulationTime(events: readonly LabEventRecord[], observations: readonly Observation[]): number {
  let latest = 0;
  for (const record of events) if (record.action.atSimulationS > latest) latest = record.action.atSimulationS;
  for (const observation of observations) if (observation.timeS > latest) latest = observation.timeS;
  return latest;
}

interface ChallengesState {
  readonly dataSourceKind: DataSourceKind;
  readonly source: ExperimentRuntimeSource;
  readonly engineSource: RealEngineRuntimeSource | null;
  readonly mode: GameMode;
  readonly objective: Objective;
  readonly hintsEnabled: boolean;
  readonly reducedMotion: boolean;
  readonly interpretationAnswers: ReadonlyMap<UUID, InterpretationAnswer>;
  readonly ctx: EvaluationContext;
  readonly evaluation: ObjectiveEvaluation;
  readonly hint: HintDescriptor | null;
  readonly checklist: readonly ChecklistItem[];
  readonly score: ScoreBreakdown | null;
  readonly notebook: NotebookData | null;
  readonly repository: ChallengeAttemptRepository;
  readonly attempts: readonly ChallengeAttemptSummary[];
  readonly achievements: readonly Achievement[];
  readonly compareIds: readonly UUID[];
  readonly comparison: AttemptComparison | null;
  readonly lastSavedAttemptId: UUID | null;
  readonly startedAt: string;
}

function initialState(): ChallengesState {
  const objective = OBJECTIVES_BY_MODE.guided;
  const evaluation = evaluateObjective(objective, EMPTY_CONTEXT);
  return {
    dataSourceKind: 'live',
    source: NOT_CONNECTED_SOURCE,
    engineSource: null,
    mode: 'guided',
    objective,
    hintsEnabled: true,
    reducedMotion: prefersReducedMotion(),
    interpretationAnswers: new Map(),
    ctx: EMPTY_CONTEXT,
    evaluation,
    hint: deriveHint(objective, EMPTY_CONTEXT),
    checklist: buildChecklist(objective, EMPTY_CONTEXT),
    score: null,
    notebook: null,
    repository: createIndexedDbAttemptRepository(),
    attempts: [],
    achievements: [],
    compareIds: [],
    comparison: null,
    lastSavedAttemptId: null,
    startedAt: new Date().toISOString(),
  };
}

export const useChallenges = create<ChallengesState>()(initialState);
const set = useChallenges.setState;
const get = useChallenges.getState;

let unsubscribeSource: (() => void) | null = null;

/** Rebuilds `ctx`, `evaluation`, `hint`, `checklist`, `score` and `notebook` from the current source. Call after any source/mode/answer change. */
export function refreshFromSource(): void {
  const s = get();
  const scene = s.source.getScene();
  if (!scene) {
    const evaluation = evaluateObjective(s.objective, EMPTY_CONTEXT);
    set({ ctx: EMPTY_CONTEXT, evaluation, hint: deriveHint(s.objective, EMPTY_CONTEXT), checklist: buildChecklist(s.objective, EMPTY_CONTEXT), score: null, notebook: null });
    return;
  }
  const events = s.source.getEventLog();
  const observations = s.source.getObservations();
  const trials = withInterpretations(deriveTrialsFromLog(events, observations), s.interpretationAnswers);
  const ctx: EvaluationContext = { scene, events, observations, trials, nowSimulationS: latestSimulationTime(events, observations) };
  const evaluation = evaluateObjective(s.objective, ctx);
  const score = s.mode === 'free' ? null : scoreAttempt(s.objective, ctx);
  const notebook = s.mode === 'free' ? null : buildNotebook(s.objective, ctx);
  set({ ctx, evaluation, hint: deriveHint(s.objective, ctx), checklist: buildChecklist(s.objective, ctx), score, notebook });
}

function attachSource(source: ExperimentRuntimeSource, dataSourceKind: DataSourceKind, engineSource: RealEngineRuntimeSource | null): void {
  unsubscribeSource?.();
  set({ source, dataSourceKind, engineSource, interpretationAnswers: new Map(), compareIds: [], comparison: null, startedAt: new Date().toISOString() });
  unsubscribeSource = source.subscribe(refreshFromSource);
  refreshFromSource();
}

/** Connects the honest "nothing real yet" source: used before any real engine has been started. */
export function useLiveSource(): void {
  attachSource(NOT_CONNECTED_SOURCE, 'live', null);
}

/**
 * Connects a fresh real `ExperimentEngine` station (Agent 07's actual runtime, Agent 07's own
 * vertical-slice apparatus registry and titration plugin) driven by `solver` — a real `SolverClient`
 * reaching Agent 06's actual titration solver (see `integration/pythonSolverClient.ts` for
 * Node/tests, `integration/httpSolverClient.ts` for the browser dev route). Replaces the old
 * labelled fixture demo: every number downstream of this now comes from the real engine and the
 * real solver, not a scripted formula.
 */
export function useRealEngineSource(solver: SolverClient): RealEngineRuntimeSource {
  const runtime = createRealEngineSource(solver);
  attachSource(runtime, 'real-engine', runtime);
  return runtime;
}

export function setMode(mode: GameMode): void {
  if (get().mode === mode) return;
  set({ mode, objective: OBJECTIVES_BY_MODE[mode] });
  // A new mode starts a fresh attempt against a clean bench, whichever source is behind it.
  get().engineSource?.resetAll();
  refreshFromSource();
}

export function toggleHints(): void {
  set((s) => ({ hintsEnabled: !s.hintsEnabled }));
}

export function setReducedMotion(reducedMotion: boolean): void {
  set({ reducedMotion });
}

export function setInterpretation(trialId: UUID, answer: InterpretationAnswer): void {
  set((s) => {
    const next = new Map(s.interpretationAnswers);
    next.set(trialId, answer);
    return { interpretationAnswers: next };
  });
  refreshFromSource();
}

export async function refreshAttempts(): Promise<void> {
  const repository = get().repository;
  const summaries = await repository.list();
  const full = (await Promise.all(summaries.map((sm) => repository.get(sm.id)))).filter((a): a is ChallengeAttempt => a !== undefined);
  set({ attempts: summaries, achievements: deriveAchievements(full) });
}

/** Saves the current attempt (score + notebook + the exact trial data they were computed from). */
export async function finishAttempt(): Promise<ChallengeAttemptSummary | null> {
  const s = get();
  if (!s.score || !s.notebook || s.ctx.trials.length === 0) return null;
  const attempt: ChallengeAttempt = {
    id: crypto.randomUUID(),
    objectiveId: s.objective.id,
    objectiveTitle: s.objective.title,
    mode: s.mode,
    startedAt: s.startedAt,
    savedAt: new Date().toISOString(),
    trials: s.ctx.trials,
    score: s.score,
    notebook: s.notebook,
  };
  await s.repository.save(attempt);
  set({ lastSavedAttemptId: attempt.id });
  await refreshAttempts();
  return summarise(attempt);
}

export async function deleteAttempt(id: UUID): Promise<void> {
  await get().repository.remove(id);
  set((s) => ({ compareIds: s.compareIds.filter((c) => c !== id) }));
  await refreshAttempts();
}

export function toggleCompare(id: UUID): void {
  set((s) => {
    const already = s.compareIds.includes(id);
    const compareIds = already ? s.compareIds.filter((c) => c !== id) : [...s.compareIds, id].slice(-2);
    return { compareIds, comparison: null };
  });
  void loadComparison();
}

async function loadComparison(): Promise<void> {
  const s = get();
  if (s.compareIds.length !== 2) return;
  const [a, b] = await Promise.all(s.compareIds.map((id) => s.repository.get(id)));
  if (a && b) set({ comparison: compareAttempts(a, b, 'First attempt', 'Second attempt') });
}

export function exportNotebookJson(): void {
  const s = get();
  if (!s.notebook) return;
  downloadText(`${s.objective.id}.notebook.json`, JSON.stringify(s.notebook, null, 2), 'application/json');
}

export function exportTemplate(name: string, description: string): void {
  const s = get();
  if (!s.ctx.scene) return;
  const template = buildTemplateFromScene(s.ctx.scene, { name, description, objectiveId: s.objective.id });
  downloadText(`${name.replace(/[^\w.\- ()]+/g, '_').slice(0, 80) || 'lab-template'}.template.json`, serializeTemplate(template), 'application/json');
}

/** Swaps the attempt repository (used by tests and, later, by an HTTP-backed Agent 09 implementation). */
export function setAttemptRepository(repository: ChallengeAttemptRepository): void {
  set({ repository, attempts: [], achievements: [] });
}

/**
 * Declarative, data-driven goal definitions. A `GoalPredicate` is plain JSON (serializable, so
 * objectives can be authored, saved as templates, or sent from a future backend) and is evaluated
 * by a pure function against an `EvaluationContext` built only from Agent 07's event stream and
 * Agent 06's scientific results. Nothing here inspects render/animation state.
 */

import type { ApparatusKind, Capability, ConnectionKind, ExperimentScene, LabEventRecord, Observation, ObservationType, UUID } from '../contracts';

/** Named slots resolved to concrete instance ids as the user places apparatus, e.g. `stand` -> some UUID. */
export type GoalRoleBindings = Readonly<Record<string, UUID>>;

export type RelativeRelation = 'below' | 'above' | 'leftOf' | 'rightOf';

export type GoalPredicate =
  | { readonly kind: 'apparatusPlaced'; readonly role: string; readonly apparatusKind: ApparatusKind }
  | { readonly kind: 'hasConnection'; readonly fromRole: string; readonly toRole: string; readonly connectionKind?: ConnectionKind }
  | { readonly kind: 'capabilityPresent'; readonly role: string; readonly capability: Capability }
  | { readonly kind: 'relativePosition'; readonly role: string; readonly relativeToRole: string; readonly relation: RelativeRelation; readonly toleranceM?: number }
  | { readonly kind: 'containerSpecies'; readonly role: string; readonly speciesId: string; readonly minMolarity?: number; readonly maxMolarity?: number }
  | { readonly kind: 'valveOperated'; readonly role: string; readonly minOpenings?: number }
  | { readonly kind: 'deliveredVolumeWithin'; readonly sourceRole: string; readonly receiverRole?: string; readonly minL: number; readonly maxL: number }
  | { readonly kind: 'observationRecorded'; readonly type: ObservationType; readonly count?: number }
  | { readonly kind: 'endpointCaptured'; readonly analyteRole?: string; readonly titrantRole?: string; readonly tolerancePctOfEquivalence?: number; readonly absoluteFloorL?: number }
  | { readonly kind: 'repeatTrialsAtLeast'; readonly count: number }
  | { readonly kind: 'runSucceeded'; readonly type?: ObservationType }
  | { readonly kind: 'all'; readonly of: readonly GoalPredicate[] }
  | { readonly kind: 'any'; readonly of: readonly GoalPredicate[] }
  | { readonly kind: 'not'; readonly of: GoalPredicate };

export interface PredicateResult {
  readonly met: boolean;
  /** One readable sentence, suitable for a tooltip or a non-visual accessible caption. */
  readonly detail: string;
  /** Bindings after evaluation: unchanged unless this predicate resolved a new role. */
  readonly bindings: GoalRoleBindings;
}

/** One endpoint mark the user made during a trial. */
export interface EndpointMark {
  readonly deliveredVolumeL: number;
  readonly markedAtSimulationS: number;
  readonly indicatorColorNote?: string;
}

/** One completed pass through an objective: its own event slice, the observations recorded during it, and an endpoint mark. */
export interface TrialRecord {
  readonly trialId: UUID;
  readonly startedAtSimulationS: number;
  readonly completedAtSimulationS: number;
  readonly events: readonly LabEventRecord[];
  readonly observations: readonly Observation[];
  readonly endpoint: EndpointMark | null;
  /** Free-text conclusion the learner wrote for this trial; shown in the notebook, not auto-graded. */
  readonly interpretation?: string;
  /** The learner's calculated analyte concentration (mol/L), checked against the measured equivalence volume. */
  readonly reportedAnalyteMolarity?: number;
}

/** Everything the goal evaluator and scoring rubric are allowed to look at. Nothing else exists to them. */
export interface EvaluationContext {
  readonly scene: ExperimentScene | null;
  readonly events: readonly LabEventRecord[];
  readonly observations: readonly Observation[];
  readonly trials: readonly TrialRecord[];
  readonly nowSimulationS: number;
}

export const EMPTY_CONTEXT: EvaluationContext = { scene: null, events: [], observations: [], trials: [], nowSimulationS: 0 };

export interface GoalStep {
  readonly id: string;
  readonly title: string;
  /** Readable instruction shown in the hint caption and the non-3D accessible checklist. */
  readonly instructions: string;
  readonly predicate: GoalPredicate;
  /** Roles (already bound or about to be bound by this step) that a 3D highlight should point at. */
  readonly highlightRoles: readonly string[];
  /** Said instead of/along with the visual highlight; never relies on color alone. */
  readonly accessibleHint: string;
}

export type GameMode = 'guided' | 'challenge' | 'free' | 'precision';

export interface Objective {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly mode: GameMode;
  /**
   * Guided mode walks these in order with a hint overlay. Challenge/Precision mode evaluate the
   * same list as a flat set of success criteria with no step-by-step overlay.
   */
  readonly steps: readonly GoalStep[];
  /** Minimum trials required before the objective can be scored as complete (Precision mode). */
  readonly requiredTrials: number;
}

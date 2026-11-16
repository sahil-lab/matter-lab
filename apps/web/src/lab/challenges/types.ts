import type {
  ApparatusDefinition, ApparatusDefinitionReader, ApparatusKind, Capability, ConnectionKind,
  ContainerContents, Evidence, LabActionType, LabRuntimeEvent, LabRuntimeReader, ModelSupport,
  ObservationRecord, Quantity, RuntimeSnapshot, UUID,
} from '@matterlab/contracts';

export type ChallengeMode = 'guided' | 'challenge' | 'free' | 'precision';
export type RoleId = string;
export type RoleBindings = Readonly<Record<RoleId, UUID>>;
export type ScoreCategory = 'setup' | 'operation' | 'endpoint' | 'repeatability' | 'interpretation';
export interface TrialScope {
  readonly runId: UUID;
  readonly stationId: UUID;
  readonly epoch: number;
}
export interface ApparatusSelector {
  readonly kind?: ApparatusKind;
  readonly definitionId?: string;
  readonly capabilities: readonly Capability[];
  readonly label: string;
}
export type GoalPredicate =
  | { readonly kind: 'all' | 'any'; readonly predicates: readonly GoalPredicate[] }
  | { readonly kind: 'capability'; readonly role: RoleId; readonly capabilities: readonly Capability[] }
  | { readonly kind: 'connection'; readonly from: RoleId; readonly to: RoleId; readonly connectionKind: ConnectionKind }
  | { readonly kind: 'mounted'; readonly chain: readonly RoleId[] }
  | { readonly kind: 'receiverAligned'; readonly source: RoleId; readonly receiver: RoleId }
  | { readonly kind: 'prepared'; readonly role: RoleId }
  | { readonly kind: 'sensorUsed'; readonly sensor: RoleId; readonly receiver: RoleId }
  | { readonly kind: 'instrumentRead'; readonly source: RoleId; readonly receiver: RoleId }
  | { readonly kind: 'actionApplied'; readonly role: RoleId; readonly actionType: LabActionType; readonly setting?: 'positive' | 'zero' }
  | { readonly kind: 'deliveredVolumeWithin'; readonly target: 'equivalence' | 'endpoint' }
  | { readonly kind: 'endpointCaptured' }
  | { readonly kind: 'repeatTrials'; readonly minimum: number }
  | { readonly kind: 'repeatabilityWithin' }
  | { readonly kind: 'interpretation' };

export interface GoalDefinition {
  readonly id: string;
  readonly label: string;
  readonly category: ScoreCategory;
  readonly predicate: GoalPredicate;
  readonly modes: readonly Exclude<ChallengeMode, 'free'>[];
  readonly requires: readonly string[];
  readonly hint: string;
  readonly highlightRoles: readonly RoleId[];
  readonly controlId?: string;
}
export interface GuideInstruction {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly goalIds: readonly string[];
  readonly actionKind?: LearningActionRequest['kind'];
}
export interface ScoringRubric {
  readonly id: string;
  readonly version: string;
  readonly weights: Readonly<Record<ScoreCategory, number>>;
  readonly endpointToleranceL: number;
  readonly readingToleranceL: number;
  readonly repeatabilityToleranceL: number;
  readonly concentrationToleranceMolL: number;
  readonly minimumTrials: number;
  readonly toleranceMeaning: 'PEDAGOGICAL_NOT_EXPERIMENTAL_UNCERTAINTY';
}
export interface ChallengeDefinition {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly roles: Readonly<Record<RoleId, ApparatusSelector>>;
  readonly sourceRole: RoleId;
  readonly receiverRole: RoleId;
  readonly sensorRole: RoleId;
  readonly captureRequires: readonly string[];
  readonly goals: readonly GoalDefinition[];
  readonly instructions: readonly GuideInstruction[];
  readonly rubric: ScoringRubric;
}
export interface PreparationTarget {
  readonly role: RoleId;
  readonly label: string;
  readonly sourceId: string;
  /** Copied from Agent06's successful preparation result, never calculated here. */
  readonly contents: ContainerContents;
}
interface ReferenceMetadata {
  readonly id: string;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly sourceIds: readonly string[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
}
export type LearningReference = ReferenceMetadata & (
  | {
    readonly status: 'SUPPORTED';
    readonly evidence: 'MODEL_CALCULATED' | 'REFERENCE_MEASURED';
    readonly preparations: readonly PreparationTarget[];
    readonly equivalenceVolume: Quantity<'L'>;
    readonly equivalencePH?: Quantity<'pH'>;
    readonly initialConcentration?: Quantity<'mol/L'>;
    readonly indicatorEndpoint?: {
      readonly indicatorId: string;
      readonly volume: Quantity<'L'>;
      readonly criterion: string;
      readonly interpretation: string;
    };
  }
  | { readonly status: 'UNSUPPORTED' | 'FAILED'; readonly evidence: 'UNSUPPORTED' | 'UNVERIFIED'; readonly reasons: readonly string[] }
);

export type AppliedActionEvent = Extract<LabRuntimeEvent, { type: 'ACTION' }> & {
  readonly receipt: Extract<Extract<LabRuntimeEvent, { type: 'ACTION' }>['receipt'], { status: 'APPLIED' }>;
};
/** Exact runtime fields, with observations stored once in TrialEvidence.observations. */
export type RuntimeEvidenceFrame = Omit<RuntimeSnapshot, 'observations'>;
export interface InstrumentReading {
  readonly observationId: UUID;
  readonly recordedAtSequence: number;
  /** Learner transcription of the delivered scale, not an authoritative measurement. */
  readonly enteredDeliveredVolume: Quantity<'L'>;
}
export interface EndpointCapture {
  readonly observationId: UUID;
  readonly capturedAtSequence: number;
  readonly basis: 'instrument-reading' | 'indicator-change';
  readonly deliveredVolume: Quantity<'L'>;
  readonly evidence: Evidence;
  readonly note: string;
}
export interface ScientificConclusion {
  readonly text: string;
  readonly citedObservationIds: readonly UUID[];
  readonly equivalenceAndEndpoint: 'distinct' | 'same' | 'unsure';
  readonly endpointPosition: 'before' | 'within' | 'after' | 'unsure';
  readonly concentration?: Quantity<'mol/L'>;
  readonly acknowledgesModelLimits: boolean;
}
export interface TrialEvidence {
  readonly id: UUID;
  readonly scope: TrialScope;
  readonly status: 'active' | 'captured' | 'interrupted';
  readonly startedAt: string;
  readonly startedAtSequence: number;
  readonly cursorSequence: number;
  readonly bindings: RoleBindings;
  readonly initialContainerStates: Readonly<Record<UUID, ContainerContents>>;
  readonly initialTransferVolumeL: number;
  readonly frame: RuntimeEvidenceFrame;
  readonly definitions: readonly ApparatusDefinition[];
  readonly support: ModelSupport;
  readonly reference: LearningReference;
  readonly appliedEvents: readonly AppliedActionEvent[];
  readonly observations: readonly ObservationRecord[];
  readonly readings: readonly InstrumentReading[];
  readonly endpoint: EndpointCapture | null;
  readonly conclusion: ScientificConclusion | null;
  readonly notes: string;
  readonly interruptionReason?: string;
}
export interface ChallengeAttempt {
  readonly schemaVersion: 1;
  readonly kind: 'MATTERLAB_CHALLENGE_ATTEMPT';
  readonly id: UUID;
  /** The rubric and instructions are pinned, so a newer catalog cannot rescore a saved attempt. */
  readonly definition: ChallengeDefinition;
  readonly mode: ChallengeMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeTrialId: UUID;
  readonly requestedBindings: RoleBindings;
  readonly progression: {
    readonly instructionIndex: number;
    readonly dismissed: boolean;
    readonly hintsRequested: readonly string[];
  };
  readonly trials: readonly TrialEvidence[];
}
export interface LearningState {
  readonly schemaVersion: 1;
  readonly kind: 'MATTERLAB_LEARNING_STATE';
  readonly attempts: readonly ChallengeAttempt[];
}
export interface GoalResult {
  readonly id: string;
  readonly label: string;
  readonly category: ScoreCategory;
  readonly state: 'complete' | 'pending' | 'unsupported';
  readonly reasons: readonly string[];
  readonly observationIds: readonly UUID[];
  readonly actionIds: readonly UUID[];
}
export interface TrialStatistics {
  readonly trialIds: readonly UUID[];
  readonly count: number;
  readonly meanVolumeL: number | null;
  readonly sampleStandardDeviationL: number | null;
  readonly rangeL: number | null;
  readonly meanDeviationFromReferenceL: number | null;
  readonly uncertaintyStatement: string;
}
export interface ScoreBreakdown {
  readonly total: number;
  readonly maximum: number;
  readonly categories: readonly {
    readonly category: ScoreCategory;
    readonly points: number;
    readonly maximum: number;
    readonly explanation: string;
  }[];
  readonly eligible: boolean;
  readonly complete: boolean;
  readonly label: 'Draft learning score — not a certified experimental result';
}
export interface TrialEvaluation {
  readonly goals: readonly GoalResult[];
  readonly score: ScoreBreakdown;
  readonly statistics: TrialStatistics;
  readonly endpointPosition: 'before' | 'within' | 'after' | 'unavailable';
  readonly eligibleObservationIds: readonly UUID[];
  readonly issues: readonly string[];
}
export interface LearningHighlight {
  readonly instanceIds: readonly UUID[];
  readonly controlId?: string;
  readonly caption: string;
  readonly focus: boolean;
  readonly reducedMotion: boolean;
}
export interface LearningActionRequest {
  readonly kind: 'place' | 'connect' | 'prepare' | 'read' | 'operate' | 'reset';
  readonly goalId?: string;
  readonly instanceIds: readonly UUID[];
  readonly role?: RoleId;
  readonly controlId?: string;
}
export interface LearningCommandResult {
  readonly ok: boolean;
  readonly reason?: string;
}
export interface ChallengeView {
  readonly attempt: ChallengeAttempt;
  readonly trial: TrialEvidence;
  readonly evaluation: TrialEvaluation;
  readonly lastMessage: string | null;
}
export interface ChallengeController {
  getSnapshot(): ChallengeView;
  subscribe(listener: () => void): () => void;
  setMode(mode: ChallengeMode): void;
  setInstructionIndex(index: number): void;
  dismissGuide(dismissed: boolean): void;
  requestHint(goalId: string): void;
  recordReading(observationId: UUID, enteredDeliveredVolumeL: number): LearningCommandResult;
  captureEndpoint(input: { readonly observationId: UUID; readonly basis: EndpointCapture['basis']; readonly note?: string }): LearningCommandResult;
  recordConclusion(conclusion: ScientificConclusion, trialId?: UUID): LearningCommandResult;
  setNotes(notes: string, trialId?: UUID): LearningCommandResult;
  beginTrial(): LearningCommandResult;
  exportAttempt(): ChallengeAttempt;
  dispose(): void;
}
export interface ChallengeControllerOptions {
  readonly reader: LabRuntimeReader;
  readonly definitions: ApparatusDefinitionReader;
  readonly definition: ChallengeDefinition;
  readonly stationId: UUID;
  readonly reference: LearningReference;
  readonly bindings?: RoleBindings;
  readonly mode?: ChallengeMode;
  readonly attempt?: ChallengeAttempt;
  /** Delegate runtime/plugin support; absent support remains explicitly unsupported. */
  readonly getSupport: (snapshot: RuntimeSnapshot, stationId: UUID) => ModelSupport;
  readonly createId?: () => UUID;
  readonly now?: () => string;
}

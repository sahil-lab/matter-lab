import type {
  ApparatusDefinition, ExperimentScene, JsonObject, NodeRunRequest, Observation, RunResult, RunStatus, RuntimeCheckpoint,
} from '@matterlab/contracts';
import type { Page } from '../../services/science-client';
import type { ReagentDefinition } from '@matterlab/lab-science';
import type { LearningState } from '../challenges/types';

export interface SceneDraft {
  readonly title: string;
  readonly scene: ExperimentScene;
  readonly runtimeCheckpoint: RuntimeCheckpoint | null;
  readonly learningState?: LearningState | null;
}

export interface SceneResource extends SceneDraft {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SceneSummary {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface LabCapabilities {
  readonly schemaVersion: 1;
  readonly contractVersion: string;
  readonly runtimeVersion: string;
  readonly methodVersion: string;
  readonly ownerId: string;
  readonly scopes: readonly ('lab:read' | 'lab:write' | 'lab:run' | 'lab:export')[];
  readonly runnerBundlePresent: boolean;
  readonly validatorBundlePresent: boolean;
  readonly schemaPresent: boolean;
  readonly unitsPolicy: JsonObject;
  readonly maxRequestBytes: number;
  readonly catalogStatus: 'CURATED';
}

export interface RunResource {
  readonly runId: string;
  readonly sceneId: string;
  readonly sceneRevision: number;
  readonly status: RunStatus;
  readonly inputHash: string;
  readonly inputSnapshot: NodeRunRequest;
  readonly runtimeCheckpoint: RuntimeCheckpoint | null;
  readonly result: RunResult | null;
  readonly failureCode: string | null;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly unitsPolicy: JsonObject;
  readonly catalogSnapshot: JsonObject;
  readonly runnerSha256: string | null;
  readonly artifacts: readonly JsonObject[];
  readonly learningState?: LearningState | null;
}

export interface RunEvent {
  readonly sequence: number;
  readonly status: RunStatus | 'CANCELLING';
  readonly runId?: string;
  readonly failureCode?: string | null;
  readonly observationCount?: number;
}

export interface TemplateResource {
  readonly id: string;
  readonly title: string;
  readonly kind: 'SCENE' | 'ASSEMBLY';
  readonly scene: ExperimentScene;
  readonly catalogSnapshot: JsonObject;
  readonly createdAt: string;
}

export interface CataloguePage<T> extends Page<T> { readonly catalogStatus: 'CURATED' }
export type EquipmentPage = CataloguePage<ApparatusDefinition>;
export type ReagentPage = CataloguePage<ReagentDefinition> & {
  readonly catalogueLinks: Readonly<Record<string, {
    readonly elements: readonly string[];
    readonly compoundSearch: string | null;
    readonly relationship: string;
  }>>;
};
export type ObservationPage = Page<Observation>;
export type { ReagentDefinition } from '@matterlab/lab-science';

export interface DraftRecord extends SceneDraft {
  readonly format: 'matterlab-local-draft';
  readonly schemaVersion: 1;
  readonly remoteSave: 'UNCONFIRMED';
  readonly baseRevision: number | null;
  readonly savedLocallyAt: string;
}

import type {
  ActionReceipt, ApparatusDefinitionReader, ApparatusInstance, Connection, ExperimentScene,
  LabAction, LabActionOf, LabActionType, LabRuntimeAdapter, ProblemDetails, SocketEndpoint, Transform, UUID, Vec3M,
} from '@matterlab/contracts/lab';
import type { LabCameraController } from '../environment/CameraController';
import type { PlacementSurface } from '../environment/types';

export type EditorMode = 'select' | 'translate' | 'rotate' | 'connect' | 'operate' | 'place';
export type EditorAxis = 'X' | 'Y' | 'Z';
export type EditIntent = {
  [Type in LabActionType]: Pick<LabActionOf<Type>, 'type' | 'targetInstanceId' | 'payload'>;
}[LabActionType];

export interface EditorFeedback {
  readonly kind: 'info' | 'valid' | 'warning' | 'invalid';
  readonly message: string;
  readonly code?: string;
}
export interface EditorGroup {
  readonly id: UUID;
  readonly name: string;
  readonly stationId: UUID;
  readonly instanceIds: readonly UUID[];
}
export interface EditorState {
  readonly mode: EditorMode;
  readonly activeStationId: UUID;
  readonly selectedIds: readonly UUID[];
  readonly lockedIds: readonly UUID[];
  readonly groups: readonly EditorGroup[];
  readonly snapM: number;
  readonly angleStepDeg: number;
  readonly busy: boolean;
  readonly pointerCaptured: boolean;
  readonly placementDefinitionId: string | null;
  readonly connectionSource: SocketEndpoint | null;
  readonly feedback: EditorFeedback;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly contextMenu: { readonly clientX: number; readonly clientY: number } | null;
  readonly tutorialIds: readonly UUID[];
}
export interface PlacementCheck {
  readonly valid: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly surfaceId?: string;
  readonly collidingIds: readonly UUID[];
}
export interface SocketCandidate {
  readonly source: SocketEndpoint;
  readonly target: SocketEndpoint;
  readonly connection: Connection;
  readonly valid: boolean;
  readonly reasons: readonly string[];
  readonly distanceM: number;
  readonly snappedTransform?: Transform;
}
export interface EditorPreview {
  readonly kind: 'placement' | 'transform' | 'valve' | 'connection' | 'transfer';
  readonly instances: readonly ApparatusInstance[];
  readonly valid: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly socketCandidate?: SocketCandidate;
  readonly valveOpeningFraction?: number;
  readonly transfer?: LabActionOf<'TRANSFER'>['payload'];
}
export type ConnectionValidator = (
  scene: ExperimentScene, connection: Connection, definitions: ApparatusDefinitionReader, checkAlignment?: boolean,
) => ProblemDetails | null;
export type EditorCommandRelease = () => void | Promise<void>;
export type BeforeEditorCommand = () => void | EditorCommandRelease | Promise<void | EditorCommandRelease>;
export interface EditorOptions {
  readonly runtime: LabRuntimeAdapter;
  readonly definitions: ApparatusDefinitionReader;
  readonly camera: LabCameraController;
  readonly surfaces: readonly PlacementSurface[];
  readonly dispatchBatch?: (actions: readonly LabAction[]) => Promise<readonly ActionReceipt[]>;
  /** Agent07's pure validator makes previews match its functional capability/model rules. */
  readonly validateConnection?: ConnectionValidator;
  /** Drain/hold the simulation clock before action IDs/timestamps/revisions are created. */
  readonly beforeCommand?: BeforeEditorCommand;
  /** A new-run proposal, never a mutation of the active run or its inventory. */
  readonly onDuplicateStation?: (scene: ExperimentScene) => Promise<void> | void;
  /** The runtime owner restores/replays its ledger; the editor never rewinds inventory. */
  readonly onReplay?: (stationId: UUID) => Promise<void> | void;
  readonly idFactory?: () => UUID;
}
export interface EditorSerializedState {
  readonly schemaVersion: 1;
  readonly sceneId: UUID;
  readonly activeStationId: UUID;
  readonly selectedIds: readonly UUID[];
  readonly lockedIds: readonly UUID[];
  readonly groups: readonly EditorGroup[];
  readonly mode: Exclude<EditorMode, 'place'>;
  readonly snapM: number;
  readonly angleStepDeg: number;
  readonly initialTransforms: Readonly<Record<UUID, Transform>>;
}
export interface EditorSaveTicket {
  readonly id: UUID;
  readonly scene: ExperimentScene;
  readonly editor: EditorSerializedState;
  /** Durable scene revision, not RuntimeSnapshot.revision. */
  readonly ifMatch: number;
  readonly runtimeRevision: number;
  readonly editorRevision: number;
}
export interface EditorSaveStatus {
  readonly durableRevision: number;
  readonly dirty: boolean;
  readonly conflict: boolean;
}
export interface PointerCaptureTarget {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
}
export interface TransformGesture {
  readonly instances: readonly ApparatusInstance[];
  readonly pivotM: Vec3M;
}

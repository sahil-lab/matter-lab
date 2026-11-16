import { Euler, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { LAB_LIMITS, parseExperimentScene, parseLabAction, parseLabContract } from '@matterlab/contracts/lab';
import type {
  ApparatusInstance, Connection, ContainerContents, ExperimentScene, LabAction, LabRuntimeEvent,
  RuntimeSnapshot, SocketEndpoint, Transform, Vec3M,
} from '@matterlab/contracts/lab';
import { createWorkbenchSurface, surfaceLocalToWorld, surfaceWorldToLocal } from '../environment/coordinates';
import type { PlacementSurface, WorldRayM } from '../environment/types';
import { EditorPointerCapture } from './capture';
import { ApparatusSpatialIndex, IDENTITY_TRANSFORM, matrixOf, sameTransform, transformOf, worldBounds } from './geometry';
import { PreparationHistory } from './history';
import type { EditorMetadata, PreparationCommand } from './history';
import { checkPlacement, placementFromRay, transformOnSurface, transformSubtree } from './placement';
import { deserializeEditorState, parseEditorState } from './serialization';
import { mechanicalDescendants, resolveSocket, socketCandidate, validateSocketConnection } from './sockets';
import type {
  EditIntent, EditorAxis, EditorFeedback, EditorMode, EditorOptions, EditorPreview, EditorSaveStatus,
  EditorSaveTicket, EditorSerializedState, EditorState, PointerCaptureTarget, SocketCandidate, TransformGesture,
} from './types';

const REMOVE_PLUGIN = 'matterlab:editor-v1';
const AXES = ['X', 'Y', 'Z'] as const;
const removeIntent = (id: string): EditIntent => ({
  type: 'CUSTOM', targetInstanceId: id,
  payload: { pluginId: REMOVE_PLUGIN, actionType: 'REMOVE_EMPTY_APPARATUS', data: {} },
});
const moveIntent = (instance: ApparatusInstance): EditIntent => ({
  type: 'MOVE', targetInstanceId: instance.id, payload: { transform: instance.transform },
});
const placeIntent = (instance: ApparatusInstance): EditIntent => ({
  type: 'PLACE', targetInstanceId: instance.id, payload: { instance: { ...instance, revision: 0 } },
});
const attachIntent = (connection: Connection): EditIntent => ({
  type: 'ATTACH', targetInstanceId: connection.from.instanceId, payload: { connection },
});
const detachIntent = (connection: Connection): EditIntent => ({
  type: 'DETACH', targetInstanceId: connection.from.instanceId, payload: { connectionId: connection.id },
});
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The runtime could not accept this request.';

export class LabEditorController {
  private options: EditorOptions;
  private state: EditorState;
  private preview: EditorPreview | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly previewListeners = new Set<() => void>();
  private readonly history = new PreparationHistory();
  private readonly capture: EditorPointerCapture;
  readonly spatialIndex = new ApparatusSpatialIndex();
  private readonly indexed = new Map<string, ApparatusInstance>();
  private readonly initialTransforms = new Map<string, Transform>();
  private readonly pendingActions = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private gesture: TransformGesture | null = null;
  private clipboard: { instances: readonly ApparatusInstance[]; connections: readonly Connection[] } | null = null;
  private disposed = false;
  private editorRevision = 0;
  private savedEditorRevision = 0;
  private savedRuntimeRevision: number;
  private durableRevision: number;
  private saveConflict = false;
  private readonly pendingSaves = new Map<string, EditorSaveTicket>();

  constructor(options: EditorOptions, autoConnect = true) {
    this.options = options;
    this.capture = new EditorPointerCapture(options.camera);
    const snapshot = options.runtime.reader.getSnapshot();
    this.durableRevision = snapshot.scene.revision;
    this.savedRuntimeRevision = snapshot.revision;
    this.state = Object.freeze<EditorState>({
      mode: 'select', activeStationId: snapshot.scene.stations[0]?.id ?? '',
      selectedIds: [], lockedIds: [], groups: [], snapM: 0.01, angleStepDeg: 15,
      busy: false, pointerCaptured: false, placementDefinitionId: null, connectionSource: null,
      feedback: { kind: 'info', message: 'Choose apparatus, or drag equipment onto the workbench.' },
      canUndo: false, canRedo: false, contextMenu: null, tutorialIds: [],
    });
    this.synchronize(snapshot);
    if (autoConnect) this.connectRuntime();
  }
  get definitions() { return this.options.definitions; }
  get runtime() { return this.options.runtime; }
  get camera() { return this.options.camera; }
  get supportsAtomicEdits(): boolean { return !!this.options.dispatchBatch; }
  get supportsStationDuplication(): boolean { return !!this.options.onDuplicateStation; }
  get supportsReplay(): boolean { return !!this.options.onReplay; }
  get capturedPointerId(): number | null { return this.capture.pointerId; }
  getSnapshot = (): EditorState => this.state;
  getPreview = (): EditorPreview | null => this.preview;
  getRuntimeSnapshot = (): RuntimeSnapshot => this.options.runtime.reader.getSnapshot();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribePreview = (listener: () => void): (() => void) => {
    this.previewListeners.add(listener);
    return () => { this.previewListeners.delete(listener); };
  };
  updateOptions(options: EditorOptions): void {
    if (options.runtime !== this.options.runtime || options.camera !== this.options.camera) {
      throw new Error('Create a new editor when changing the authoritative runtime or camera.');
    }
    const changedDefinitions = this.options.definitions !== options.definitions;
    this.options = options;
    if (changedDefinitions) {
      this.indexed.clear();
      this.spatialIndex.clear();
      this.synchronize(this.getRuntimeSnapshot());
    }
  }
  connectRuntime(): void {
    if (this.disposed || this.unsubscribe) return;
    this.synchronize(this.getRuntimeSnapshot());
    this.unsubscribe = this.runtime.reader.subscribe((next, event) => this.onRuntime(next, event));
  }
  disconnectRuntime(): void {
    this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disconnectRuntime();
    this.listeners.clear();
    this.previewListeners.clear();
    this.spatialIndex.clear();
    this.disposed = true;
  }
  private id(): string { return (this.options.idFactory ?? (() => crypto.randomUUID()))(); }
  private publish(update: Partial<EditorState>, persistent = false): void {
    if (this.disposed) return;
    if (Object.entries(update).every(([key, value]) => Object.is(this.state[key as keyof EditorState], value))) return;
    this.state = Object.freeze({ ...this.state, ...update });
    if (persistent) this.editorRevision++;
    this.listeners.forEach((listener) => listener());
  }
  private feedback(kind: EditorFeedback['kind'], message: string, code?: string): void {
    if (this.state.feedback.kind === kind && this.state.feedback.message === message && this.state.feedback.code === code) return;
    this.publish({ feedback: { kind, message, ...(code ? { code } : {}) } });
  }
  announce(message: string): void { this.feedback('info', message); }
  private fail(message: string, code?: string): false { this.feedback('invalid', message, code); return false; }
  invalidatePreview(message: string): false {
    if (this.preview) this.showPreview({ ...this.preview, valid: false, reasons: [message] });
    return this.fail(message);
  }
  private showPreview(preview: EditorPreview | null): void {
    this.preview = preview;
    this.previewListeners.forEach((listener) => listener());
    if (preview) this.feedback(preview.valid ? (preview.warnings.length ? 'warning' : 'valid') : 'invalid',
      preview.reasons[0] ?? preview.warnings[0] ?? 'Valid placement. Release or press Enter to commit.');
  }
  private synchronize(snapshot: RuntimeSnapshot): void {
    const existing = new Set(snapshot.scene.apparatus.map((instance) => instance.id));
    for (const id of this.indexed.keys()) if (!existing.has(id)) {
      this.indexed.delete(id);
      this.spatialIndex.remove(id);
    }
    for (const instance of snapshot.scene.apparatus) {
      if (!this.initialTransforms.has(instance.id)) this.initialTransforms.set(instance.id, instance.transform);
      const previous = this.indexed.get(instance.id);
      if (!previous || previous.definitionId !== instance.definitionId || !sameTransform(previous.transform, instance.transform)) {
        const definition = this.definitions.getDefinition(instance.definitionId);
        if (definition) this.spatialIndex.upsert(instance.id, worldBounds(definition, instance.transform));
      }
      this.indexed.set(instance.id, instance);
    }
    if (this.state.selectedIds.some((id) => !existing.has(id)) || this.state.lockedIds.some((id) => !existing.has(id))) {
      this.publish({
        selectedIds: this.state.selectedIds.filter((id) => existing.has(id)),
        lockedIds: this.state.lockedIds.filter((id) => existing.has(id)),
        groups: this.state.groups.map((group) => ({ ...group, instanceIds: group.instanceIds.filter((id) => existing.has(id)) }))
          .filter((group) => group.instanceIds.length > 0),
      }, true);
    }
  }
  private onRuntime(snapshot: RuntimeSnapshot, event: LabRuntimeEvent): void {
    this.synchronize(snapshot);
    const ownBatch = event.type === 'ACTION' && event.action.type === 'CUSTOM' &&
      event.action.payload.pluginId === REMOVE_PLUGIN && event.action.payload.actionType === 'BATCH' &&
      Array.isArray(event.action.payload.data.actions) && event.action.payload.data.actions.length > 0 &&
      event.action.payload.data.actions.every((action) => !!action && typeof action === 'object' && !Array.isArray(action) &&
        typeof action.actionId === 'string' && this.pendingActions.has(action.actionId));
    const externalGraphEdit = event.type === 'ACTION' && event.receipt.status === 'APPLIED' &&
      ['PLACE', 'MOVE', 'ATTACH', 'DETACH', 'CUSTOM'].includes(event.action.type) && !this.pendingActions.has(event.action.actionId) && !ownBatch;
    const inventoryBarrier = event.type === 'ACTION' && event.receipt.status === 'APPLIED' &&
      ['FILL', 'TRANSFER', 'RESET'].includes(event.action.type);
    const experimentBarrier = Object.values(snapshot.stationStates).some((station) =>
      station.status !== 'PREPARING' && (this.history.undoCommand?.epochs[station.stationId] !== undefined ||
        this.history.redoCommand?.epochs[station.stationId] !== undefined));
    if (externalGraphEdit || inventoryBarrier || experimentBarrier) {
      this.history.clear();
      if (externalGraphEdit || event.type === 'ACTION' && event.action.type === 'RESET') this.cancel();
    }
    if (this.state.pointerCaptured && snapshot.stationStates[this.state.activeStationId]?.status === 'RUNNING' &&
        this.preview?.kind !== 'valve' && this.preview?.kind !== 'transfer') this.cancel();
    this.refreshHistory();
  }
  private refreshHistory(): void {
    this.publish({
      canUndo: !this.state.busy && !!this.history.undoCommand && this.commandUsable(this.history.undoCommand),
      canRedo: !this.state.busy && !!this.history.redoCommand && this.commandUsable(this.history.redoCommand),
    });
  }
  private commandUsable(command: PreparationCommand): boolean {
    const states = this.getRuntimeSnapshot().stationStates;
    return Object.entries(command.epochs).every(([id, epoch]) => states[id]?.epoch === epoch && states[id]?.status === 'PREPARING');
  }
  getSurfaces(scene = this.getRuntimeSnapshot().scene): readonly PlacementSurface[] {
    const benchIds = new Set(scene.apparatus.filter((instance) => instance.kind === 'BENCH').map((instance) => instance.id));
    const existingIds = new Set(scene.apparatus.map((instance) => instance.id));
    return [
      ...this.options.surfaces.filter((surface) => !surface.instanceId || existingIds.has(surface.instanceId) && !benchIds.has(surface.instanceId)),
      ...scene.apparatus.filter((instance) => instance.kind === 'BENCH').map((instance) => createWorkbenchSurface({
        id: instance.id, stationId: instance.stationId, transform: instance.transform,
      })),
    ];
  }
  setMode(mode: EditorMode): void {
    this.cancel();
    this.publish({ mode, connectionSource: null, contextMenu: null }, true);
  }
  setActiveStation(stationId: string): void {
    if (!this.getRuntimeSnapshot().scene.stations.some((station) => station.id === stationId)) return;
    this.cancel();
    this.publish({ activeStationId: stationId, selectedIds: [] }, true);
  }
  select(ids: readonly string[], options: { extend?: boolean; toggle?: boolean } = {}): void {
    const scene = this.getRuntimeSnapshot().scene;
    const first = scene.apparatus.find((instance) => instance.id === ids[0]);
    const stationId = first?.stationId ?? this.state.activeStationId;
    const existing = new Set(scene.apparatus.filter((instance) => instance.stationId === stationId).map((instance) => instance.id));
    const expanded = new Set(ids.filter((id) => existing.has(id)));
    for (const group of this.state.groups) if (group.instanceIds.some((id) => expanded.has(id))) {
      group.instanceIds.forEach((id) => expanded.add(id));
    }
    const next = new Set(options.extend || options.toggle ? this.state.selectedIds.filter((id) => existing.has(id)) : []);
    for (const id of expanded) {
      if (options.toggle && next.has(id)) next.delete(id); else next.add(id);
    }
    this.publish({ selectedIds: [...next], activeStationId: stationId, contextMenu: null }, true);
  }
  selectStation(stationId = this.state.activeStationId): void {
    this.select(this.getRuntimeSnapshot().scene.apparatus.filter((instance) => instance.stationId === stationId).map((instance) => instance.id));
  }
  setTutorialHighlight(instanceIds: readonly string[]): void {
    const existing = new Set(this.getRuntimeSnapshot().scene.apparatus.map((instance) => instance.id));
    this.publish({ tutorialIds: [...new Set(instanceIds)].filter((id) => existing.has(id)) });
  }
  setPrecision(snapM: number, angleStepDeg = this.state.angleStepDeg): void {
    if (!Number.isFinite(snapM) || snapM < 0 || snapM > 0.25 ||
        !Number.isFinite(angleStepDeg) || angleStepDeg < 1 || angleStepDeg > 90) {
      this.fail('Choose a grid from 0 to 0.25 m and rotation step from 1 to 90 degrees.');
      return;
    }
    this.publish({ snapM, angleStepDeg }, true);
  }
  contextMenu(clientX: number, clientY: number): void {
    this.publish({ contextMenu: { clientX, clientY } });
  }
  closeContextMenu(): void { this.publish({ contextMenu: null }); }
  focusSelection(): boolean {
    const selected = this.selectedInstances();
    if (!selected.length) return this.camera.focusStation(this.state.activeStationId);
    const boxes = selected.flatMap((instance) => {
      const definition = this.definitions.getDefinition(instance.definitionId);
      return definition ? [worldBounds(definition, instance.transform)] : [];
    });
    if (!boxes.length) return false;
    return this.camera.focusBounds({
      minM: [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.minM[axis]))) as unknown as Vec3M,
      maxM: [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.maxM[axis]))) as unknown as Vec3M,
    });
  }
  selectedInstances(includeDependents = false): readonly ApparatusInstance[] {
    const scene = this.getRuntimeSnapshot().scene;
    let ids = [...this.state.selectedIds];
    if (includeDependents) {
      for (const instance of scene.apparatus) if (ids.includes(instance.id) && instance.kind === 'BENCH') {
        ids.push(...scene.apparatus.filter((item) => item.stationId === instance.stationId).map((item) => item.id));
      }
      ids = mechanicalDescendants(scene, ids);
    }
    const selected = new Set(ids);
    return scene.apparatus.filter((instance) => selected.has(instance.id));
  }
  beginCapture(target: PointerCaptureTarget, pointerId: number, reason: string): boolean {
    if (this.disposed || this.state.busy || this.capture.pointerId !== null) return false;
    try {
      this.capture.begin(target, pointerId, reason);
      this.publish({ pointerCaptured: true, contextMenu: null });
      return true;
    } catch (error) { return this.fail(messageOf(error)); }
  }
  finishCapture(): void { this.capture.finish(); this.publish({ pointerCaptured: false }); }
  cancel(): void {
    this.finishCapture();
    this.gesture = null;
    this.showPreview(null);
    this.publish({
      mode: this.state.mode === 'place' ? 'select' : this.state.mode,
      placementDefinitionId: null, connectionSource: null, contextMenu: null,
    });
  }
  beginPlacement(definitionId: string): boolean {
    if (this.state.busy || this.disposed) return false;
    const definition = this.definitions.getDefinition(definitionId);
    if (!definition) return this.fail('This apparatus definition is unavailable.');
    const snapshot = this.getRuntimeSnapshot();
    if (!snapshot.stationStates[this.state.activeStationId] || snapshot.stationStates[this.state.activeStationId].status === 'RUNNING') {
      return this.fail('Pause the station before editing its apparatus.');
    }
    if (snapshot.scene.apparatus.length >= LAB_LIMITS.maxApparatus) return this.fail('The scene apparatus limit has been reached.');
    this.cancel();
    const instance = parseLabContract('ApparatusInstance', {
      id: this.id(), kind: definition.kind, definitionId, stationId: this.state.activeStationId,
      revision: 0, config: definition.defaultConfig, capabilities: definition.capabilities, transform: IDENTITY_TRANSFORM,
    });
    this.publish({ mode: 'place', placementDefinitionId: definitionId }, true);
    this.showPreview({ kind: 'placement', instances: [instance], valid: false, reasons: ['Choose a supported surface or a compatible mount.'], warnings: [] });
    return true;
  }
  previewPlacement(transform: Transform, candidate?: SocketCandidate): boolean {
    const draft = this.preview?.kind === 'placement' ? this.preview.instances[0] : undefined;
    if (!draft) return this.fail('Choose apparatus from the palette first.');
    try {
      const instance = parseLabContract('ApparatusInstance', { ...draft, transform });
      const originalScene = this.getRuntimeSnapshot().scene;
      const scene: ExperimentScene = {
        ...originalScene, apparatus: [...originalScene.apparatus, instance],
        connections: candidate ? [...originalScene.connections, candidate.connection] : originalScene.connections,
      };
      const check = checkPlacement({ scene, definitions: this.definitions, instance, surfaces: this.getSurfaces(scene), index: this.spatialIndex });
      const reasons = [...(candidate?.reasons ?? []), ...check.reasons];
      this.showPreview({ kind: 'placement', instances: [instance], valid: reasons.length === 0,
        reasons, warnings: check.warnings, ...(candidate ? { socketCandidate: candidate } : {}) });
      return reasons.length === 0;
    } catch (error) { return this.invalidatePreview(messageOf(error)); }
  }
  previewPlacementOnSurface(surfaceId: string, xM: number, zM: number, yawDeg = 0): boolean {
    const instance = this.preview?.kind === 'placement' ? this.preview.instances[0] : undefined;
    const definition = instance && this.definitions.getDefinition(instance.definitionId);
    const surface = this.getSurfaces().find((item) => item.id === surfaceId);
    if (!definition || !surface || ![xM, zM, yawDeg].every(Number.isFinite)) return this.invalidatePreview('Choose a valid surface and finite meter coordinates.');
    const quaternion = new Quaternion(...surface.transform.quaternion)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * Math.PI / 180)).toArray();
    return this.previewPlacement(transformOnSurface(definition, surface, surfaceLocalToWorld(surface, [xM, 0, zM]), quaternion));
  }
  previewPlacementOnSocket(target: SocketEndpoint, sourceSocketId?: string): boolean {
    const draft = this.preview?.kind === 'placement' ? this.preview.instances[0] : undefined;
    const definition = draft && this.definitions.getDefinition(draft.definitionId);
    if (!draft || !definition) return this.fail('Choose apparatus from the palette first.');
    const scene = { ...this.getRuntimeSnapshot().scene, apparatus: [...this.getRuntimeSnapshot().scene.apparatus, draft] };
    const candidates = definition.sockets.filter((socket) => socket.kind === 'MECHANICAL' && socket.direction !== 'OUT' &&
      (!sourceSocketId || sourceSocketId === socket.id)).map((socket) => socketCandidate(
        scene, this.definitions, { instanceId: draft.id, socketId: socket.id }, target, this.id(),
      ));
    const candidate = candidates.find((item) => item.valid) ?? candidates[0];
    if (!candidate?.snappedTransform) return this.invalidatePreview('This apparatus has no matching mechanical mounting socket.');
    return this.previewPlacement(candidate.snappedTransform, candidate);
  }
  hoverPlacement(ray: WorldRayM, precision = false): void {
    const instance = this.preview?.kind === 'placement' ? this.preview.instances[0] : undefined;
    const definition = instance && this.definitions.getDefinition(instance.definitionId);
    if (!instance || !definition) return;
    const worldRay = new Ray(new Vector3(...ray.originM), new Vector3(...ray.direction).normalize());
    const possible = this.getRuntimeSnapshot().scene.apparatus
      .filter((item) => item.stationId === instance.stationId)
      .flatMap((item) => this.definitions.getDefinition(item.definitionId)?.sockets
        .filter((socket) => socket.kind === 'MECHANICAL' && socket.direction !== 'IN')
        .map((socket) => {
          const endpoint = { instanceId: item.id, socketId: socket.id };
          const resolved = resolveSocket(this.getRuntimeSnapshot().scene, this.definitions, endpoint)!;
          const point = new Vector3(...resolved.worldTransform.positionM);
          return { endpoint, distance: worldRay.distanceSqToPoint(point) };
        }) ?? [])
      .filter((item) => item.distance < 0.07 ** 2).sort((a, b) => a.distance - b.distance);
    if (possible[0] && definition.sockets.some((socket) => socket.kind === 'MECHANICAL' && socket.direction === 'IN')) {
      this.previewPlacementOnSocket(possible[0].endpoint);
      return;
    }
    const placement = placementFromRay(definition, instance, ray, this.getSurfaces(), precision ? 0.001 : this.state.snapM);
    if (placement) this.previewPlacement(placement.transform);
    else this.showPreview({ ...this.preview!, valid: false, reasons: ['Point inside a supported surface or at a compatible mount.'] });
  }
  private metadata(): EditorMetadata {
    return { selectedIds: this.state.selectedIds, lockedIds: this.state.lockedIds, groups: this.state.groups };
  }
  private editable(instances: readonly ApparatusInstance[]): boolean {
    if (this.state.busy || this.disposed) return false;
    if (!instances.length) return this.fail('Select apparatus first.');
    if (instances.some((instance) => this.state.lockedIds.includes(instance.id))) return this.fail('Unlock the selected apparatus and its dependents before editing.');
    if (instances.some((instance) => this.getRuntimeSnapshot().stationStates[instance.stationId]?.status === 'RUNNING')) {
      return this.fail('Pause the station before editing. Running experiments use explicit reset/replay, not preparation undo.');
    }
    return true;
  }
  private actionStation(intent: EditIntent, scene: ExperimentScene, intents: readonly EditIntent[]): string {
    if (intent.type === 'PLACE') return intent.payload.instance.stationId;
    const instance = scene.apparatus.find((item) => item.id === intent.targetInstanceId) ??
      intents.flatMap((item) => item.type === 'PLACE' ? [item.payload.instance] : []).find((item) => item.id === intent.targetInstanceId);
    if (!instance) throw new Error('The target apparatus no longer exists.');
    return instance.stationId;
  }
  private freshActions(intents: readonly EditIntent[], optimistic: boolean): readonly LabAction[] {
    const snapshot = this.getRuntimeSnapshot();
    return intents.map((intent, index) => {
      const station = snapshot.stationStates[this.actionStation(intent, snapshot.scene, intents)];
      if (!station) throw new Error('The target station no longer exists.');
      return parseLabAction({
        ...intent, actionId: this.id(), atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch,
        ...(optimistic && index === 0 ? { expectedRevision: snapshot.revision } : {}),
      });
    });
  }
  private async dispatchIntents(intents: readonly EditIntent[], optimistic = true): Promise<boolean> {
    if (this.disposed || this.state.busy) return false;
    if (!intents.length) return true;
    if (intents.length > 64) return this.fail('This atomic edit exceeds the runtime limit of 64 actions; select a smaller assembly.');
    if (intents.length > 1 && !this.options.dispatchBatch) return this.fail('Atomic graph editing is unavailable. Connect the runtime dispatchBatch adapter.');
    this.publish({ busy: true, canUndo: false, canRedo: false });
    let actions: readonly LabAction[] = [];
    try {
      actions = this.freshActions(intents, optimistic);
      actions.forEach((action) => this.pendingActions.add(action.actionId));
      const receipts = actions.length === 1
        ? [await this.runtime.actions.dispatch(actions[0])]
        : await this.options.dispatchBatch!(actions);
      if (receipts.length !== actions.length || receipts.some((receipt, index) => receipt.actionId !== actions[index].actionId)) {
        return this.fail('The runtime returned an invalid atomic action receipt.');
      }
      const rejection = receipts.find((receipt) => receipt.status === 'REJECTED');
      if (rejection?.status === 'REJECTED') return this.fail(rejection.error.detail, rejection.error.code);
      return true;
    } catch (error) { return this.fail(messageOf(error)); }
    finally {
      actions.forEach((action) => this.pendingActions.delete(action.actionId));
      this.publish({ busy: false });
      this.refreshHistory();
    }
  }
  private async edit(
    label: string, forward: readonly EditIntent[], inverse: readonly EditIntent[],
    after = this.metadata(),
  ): Promise<boolean> {
    const before = this.metadata();
    const snapshot = this.getRuntimeSnapshot();
    const epochs: Record<string, number> = {};
    for (const intent of forward) {
      const id = this.actionStation(intent, snapshot.scene, forward);
      epochs[id] = snapshot.stationStates[id].epoch;
    }
    if (!Object.keys(epochs).length) epochs[this.state.activeStationId] = snapshot.stationStates[this.state.activeStationId]?.epoch ?? 0;
    if (!await this.dispatchIntents(forward)) return false;
    this.publish(after, true);
    const command: PreparationCommand = { label, forward, inverse, before, after, epochs };
    if (this.commandUsable(command)) this.history.record(command);
    this.refreshHistory();
    this.feedback('info', `${label}. ${!forward.length ? 'Editor-only metadata updated.'
      : this.commandUsable(command) ? 'Preparation edit recorded.' : 'Recorded in the experiment ledger; use reset/replay instead of undo.'}`);
    return true;
  }
  async commitPreview(): Promise<boolean> {
    const preview = this.preview;
    if (!preview) return false;
    if (!preview.valid) return this.fail(preview.reasons[0] ?? 'Invalid placement.');
    if (preview.kind === 'valve') {
      const accepted = await this.setValve(preview.instances[0].id, preview.valveOpeningFraction ?? 0);
      this.showPreview(null);
      return accepted;
    }
    if (preview.kind === 'transfer') {
      const transfer = preview.transfer;
      const accepted = transfer ? await this.transfer(
        transfer.sourceInstanceId, transfer.targetInstanceId, transfer.volumeL, transfer.connectionId,
      ) : false;
      this.showPreview(null);
      return accepted;
    }
    if (preview.kind === 'connection') {
      const candidate = preview.socketCandidate;
      this.showPreview(null);
      return candidate ? this.connect(candidate.source, candidate.target) : false;
    }
    let accepted = false;
    if (preview.kind === 'placement') {
      const instance = preview.instances[0];
      const edge = preview.socketCandidate?.connection;
      accepted = await this.edit('Placed apparatus',
        [placeIntent(instance), ...(edge ? [attachIntent(edge)] : [])],
        [...(edge ? [detachIntent(edge)] : []), removeIntent(instance.id)],
        { ...this.metadata(), selectedIds: [instance.id] });
    } else {
      const original = preview.instances.map((instance) => this.getRuntimeSnapshot().scene.apparatus.find((item) => item.id === instance.id)!);
      if (original.some((instance) => !instance)) return this.fail('Apparatus changed during the gesture. Try again.');
      const changed = preview.instances.filter((instance, index) => !sameTransform(instance.transform, original[index].transform));
      const previous = original.filter((instance) => changed.some((next) => next.id === instance.id));
      accepted = !changed.length || await this.edit('Transformed apparatus', changed.map(moveIntent), previous.map(moveIntent));
    }
    this.gesture = null;
    if (!accepted && preview.kind === 'placement') this.showPreview({ ...preview, valid: false, reasons: [this.state.feedback.message] });
    else this.showPreview(null);
    if (accepted && preview.kind === 'placement') this.publish({ mode: 'select', placementDefinitionId: null }, true);
    return accepted;
  }
  beginTransformGesture(): boolean {
    const instances = this.selectedInstances(true);
    if (!this.editable(instances)) return false;
    const roots = new Set(instances.map((instance) => instance.id));
    if (this.getRuntimeSnapshot().scene.connections.some((edge) => edge.enabled && edge.kind === 'MECHANICAL' &&
      roots.has(edge.to.instanceId) && !roots.has(edge.from.instanceId))) {
      return this.fail('Detach the apparatus from its mechanical parent, or select its parent to move the assembly.');
    }
    const primary = instances.find((instance) => instance.id === this.state.selectedIds[0]) ?? instances[0];
    this.showPreview(null);
    this.gesture = { instances, pivotM: primary.transform.positionM };
    return true;
  }
  private previewTransforms(instances: readonly ApparatusInstance[]): boolean {
    const current = this.getRuntimeSnapshot().scene;
    const replacements = new Map(instances.map((instance) => [instance.id, instance]));
    const scene: ExperimentScene = { ...current, apparatus: current.apparatus.map((instance) => replacements.get(instance.id) ?? instance) };
    const reasons: string[] = [];
    const warnings: string[] = [];
    for (const instance of instances) {
      const original = current.apparatus.find((item) => item.id === instance.id);
      const definition = this.definitions.getDefinition(instance.definitionId);
      if (!original || !definition) { reasons.push('Apparatus definition or instance no longer exists.'); continue; }
      if (instance.transform.positionM.some((value, axis) => Math.abs(value - original.transform.positionM[axis]) > 1e-8 &&
          !definition.permittedTransforms.translation.includes(AXES[axis]))) reasons.push(`${definition.label} does not permit translation on that axis.`);
      const delta = new Quaternion(...instance.transform.quaternion).multiply(new Quaternion(...original.transform.quaternion).invert());
      const angles = new Euler().setFromQuaternion(delta, 'YXZ');
      const components = definition.permittedTransforms.rotation.length <= 1 ? [delta.x, delta.y, delta.z] : [angles.x, angles.y, angles.z];
      if (components.some((value, axis) => Math.abs(value) > 1e-8 && !definition.permittedTransforms.rotation.includes(AXES[axis]))) {
        reasons.push(`${definition.label} does not permit rotation on that axis.`);
      }
      const check = checkPlacement({ scene, definitions: this.definitions, instance, surfaces: this.getSurfaces(scene) });
      reasons.push(...check.reasons);
      warnings.push(...check.warnings);
    }
    for (const edge of scene.connections) if (edge.enabled && (replacements.has(edge.from.instanceId) || replacements.has(edge.to.instanceId))) {
      reasons.push(...validateSocketConnection(scene, this.definitions, edge, { ignoreConnectionId: edge.id }));
    }
    this.showPreview({ kind: 'transform', instances, valid: reasons.length === 0, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)] });
    return reasons.length === 0;
  }
  previewTranslation(deltaM: Vec3M): boolean {
    if (!this.gesture || !deltaM.every(Number.isFinite)) return false;
    return this.previewTransforms(this.gesture.instances.map((instance) => ({
      ...instance, transform: { ...instance.transform, positionM: new Vector3(...instance.transform.positionM).add(new Vector3(...deltaM)).toArray() },
    })));
  }
  previewRotation(axis: EditorAxis, degrees: number): boolean {
    if (!this.gesture || !Number.isFinite(degrees)) return false;
    const pivot = new Vector3(...this.gesture.pivotM);
    const direction = new Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
    const delta = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new Matrix4().makeRotationAxis(direction, degrees * Math.PI / 180))
      .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    return this.previewTransforms(this.gesture.instances.map((instance) => ({
      ...instance, transform: transformOf(delta.clone().multiply(matrixOf(instance.transform))),
    })));
  }
  async translateSelection(deltaM: Vec3M): Promise<boolean> {
    if (!this.beginTransformGesture()) return false;
    if (!this.previewTranslation(deltaM)) { this.gesture = null; return false; }
    return this.commitPreview();
  }
  async rotateSelection(axis: EditorAxis, degrees: number): Promise<boolean> {
    if (!this.beginTransformGesture()) return false;
    if (!this.previewRotation(axis, degrees)) { this.gesture = null; return false; }
    return this.commitPreview();
  }
  async setSelectionTransform(transform: Transform): Promise<boolean> {
    if (!this.beginTransformGesture()) return false;
    const instances = this.gesture!.instances;
    const root = instances.find((instance) => instance.id === this.state.selectedIds[0]) ?? instances[0];
    try {
      const validated = parseLabContract('ApparatusInstance', { ...root, transform }).transform;
      if (!this.previewTransforms(transformSubtree(instances, root.transform, validated))) return false;
    } catch (error) { return this.invalidatePreview(messageOf(error)); }
    return this.commitPreview();
  }
  async resetTransforms(): Promise<boolean> {
    if (!this.beginTransformGesture()) return false;
    const instances = this.gesture!.instances.map((instance) => ({ ...instance, transform: this.initialTransforms.get(instance.id) ?? instance.transform }));
    if (!this.previewTransforms(instances)) return false;
    return this.commitPreview();
  }
  async alignSelection(axis: EditorAxis, alignment: 'min' | 'center' | 'max' = 'center'): Promise<boolean> {
    const selected = this.selectedInstances();
    if (selected.length < 2) return this.fail('Select at least two apparatus to align.');
    if (!this.beginTransformGesture()) return false;
    const index = AXES.indexOf(axis);
    const coordinate = (instance: ApparatusInstance) => {
      const bounds = worldBounds(this.definitions.getDefinition(instance.definitionId)!, instance.transform);
      return alignment === 'min' ? bounds.minM[index] : alignment === 'max' ? bounds.maxM[index] : (bounds.minM[index] + bounds.maxM[index]) / 2;
    };
    const target = coordinate(selected.at(-1)!);
    const moved = new Map<string, ApparatusInstance>();
    const scene = this.getRuntimeSnapshot().scene;
    for (const root of selected.slice(0, -1)) {
      const amount = target - coordinate(root);
      for (const id of mechanicalDescendants(scene, [root.id])) {
        const instance = scene.apparatus.find((item) => item.id === id)!;
        const position = [...instance.transform.positionM] as [number, number, number];
        position[index] += amount;
        moved.set(id, { ...instance, transform: { ...instance.transform, positionM: position } });
      }
    }
    if (!this.previewTransforms([...moved.values()])) return false;
    return this.commitPreview();
  }
  beginConnection(source: SocketEndpoint): boolean {
    if (!resolveSocket(this.getRuntimeSnapshot().scene, this.definitions, source)) return this.fail('The source socket no longer exists.');
    this.cancel();
    this.publish({ mode: 'connect', connectionSource: source }, true);
    this.feedback('info', 'Choose a compatible socket in this station. Mechanical attachments snap; other connections never teleport apparatus.');
    return true;
  }
  connectionCandidates(source = this.state.connectionSource): readonly SocketCandidate[] {
    if (!source) return [];
    const scene = this.getRuntimeSnapshot().scene;
    return scene.apparatus.flatMap((instance) => this.definitions.getDefinition(instance.definitionId)?.sockets.map((socket) =>
      socketCandidate(scene, this.definitions, source, { instanceId: instance.id, socketId: socket.id }, this.id())) ?? []);
  }
  previewConnection(target: SocketEndpoint | null): void {
    if (!this.state.connectionSource) return;
    if (!target) {
      this.showPreview(null);
      this.announce('Choose a compatible target socket.');
      return;
    }
    const candidate = socketCandidate(this.getRuntimeSnapshot().scene, this.definitions, this.state.connectionSource, target, this.id());
    const reasons = candidate.connection.kind === 'MECHANICAL' ? candidate.reasons
      : validateSocketConnection(this.getRuntimeSnapshot().scene, this.definitions, candidate.connection);
    this.showPreview({ kind: 'connection', instances: [], socketCandidate: candidate,
      valid: reasons.length === 0, reasons, warnings: [] });
  }
  async connect(source: SocketEndpoint, target: SocketEndpoint): Promise<boolean> {
    const scene = this.getRuntimeSnapshot().scene;
    const candidate = socketCandidate(scene, this.definitions, source, target, this.id());
    if (!candidate.valid) return this.fail(candidate.reasons[0]);
    const involved = scene.apparatus.filter((instance) => [candidate.connection.from.instanceId, candidate.connection.to.instanceId].includes(instance.id));
    if (!this.editable(involved)) return false;
    const forward: EditIntent[] = [];
    const inverse: EditIntent[] = [detachIntent(candidate.connection)];
    if (candidate.snappedTransform) {
      const root = scene.apparatus.find((instance) => instance.id === candidate.connection.to.instanceId)!;
      const ids = mechanicalDescendants(scene, [root.id]);
      const originals = scene.apparatus.filter((instance) => ids.includes(instance.id));
      if (!this.editable(originals)) return false;
      const transformed = transformSubtree(originals, root.transform, candidate.snappedTransform);
      const next: ExperimentScene = {
        ...scene, apparatus: scene.apparatus.map((instance) => transformed.find((item) => item.id === instance.id) ?? instance),
        connections: [...scene.connections, candidate.connection],
      };
      for (const instance of transformed) {
        const check = checkPlacement({ scene: next, definitions: this.definitions, instance, surfaces: this.getSurfaces(next) });
        if (!check.valid) return this.fail(check.reasons[0]);
      }
      forward.push(...transformed.filter((item, index) => !sameTransform(item.transform, originals[index].transform)).map(moveIntent));
      inverse.push(...originals.map(moveIntent));
    } else {
      const reasons = validateSocketConnection(scene, this.definitions, candidate.connection);
      if (reasons.length) return this.fail(reasons[0]);
    }
    forward.push(attachIntent(candidate.connection));
    const accepted = await this.edit('Connected apparatus', forward, inverse);
    if (accepted) this.cancel();
    return accepted;
  }
  async detach(connectionId: string, placeChildOnSurfaceId?: string): Promise<boolean> {
    const scene = this.getRuntimeSnapshot().scene;
    const edge = scene.connections.find((connection) => connection.id === connectionId);
    if (!edge) return this.fail('The connection no longer exists.');
    const involved = scene.apparatus.filter((instance) => [edge.from.instanceId, edge.to.instanceId].includes(instance.id));
    if (!this.editable(involved)) return false;
    const forward: EditIntent[] = [detachIntent(edge)];
    const inverse: EditIntent[] = [];
    if (placeChildOnSurfaceId && edge.kind === 'MECHANICAL') {
      const child = scene.apparatus.find((instance) => instance.id === edge.to.instanceId)!;
      const surface = this.getSurfaces().find((item) => item.id === placeChildOnSurfaceId);
      const definition = this.definitions.getDefinition(child.definitionId)!;
      if (!surface || definition.tags?.includes('requires-mount')) return this.fail('This apparatus needs a mount. Reparent it directly to a compatible socket.');
      const local = surfaceWorldToLocal(surface, child.transform.positionM);
      const nextTransform = transformOnSurface(definition, surface, surfaceLocalToWorld(surface, [local[0], 0, local[2]]), child.transform.quaternion);
      const ids = mechanicalDescendants(scene, [child.id]);
      const originals = scene.apparatus.filter((instance) => ids.includes(instance.id));
      const transformed = transformSubtree(originals, child.transform, nextTransform);
      const proposed = { ...scene, connections: scene.connections.filter((item) => item.id !== edge.id),
        apparatus: scene.apparatus.map((instance) => transformed.find((item) => item.id === instance.id) ?? instance) };
      for (const instance of transformed) {
        const check = checkPlacement({ scene: proposed, definitions: this.definitions, instance, surfaces: this.getSurfaces(proposed) });
        if (!check.valid) return this.fail(check.reasons[0]);
      }
      forward.push(...transformed.map(moveIntent));
      inverse.push(...originals.map(moveIntent));
    } else if (edge.kind === 'MECHANICAL') {
      return this.fail('Choose a supporting surface when detaching, or reparent directly. Floating apparatus is not permitted.');
    }
    inverse.push(attachIntent(edge));
    return this.edit('Detached apparatus', forward, inverse);
  }
  async reparent(connectionId: string, target: SocketEndpoint): Promise<boolean> {
    const scene = this.getRuntimeSnapshot().scene;
    const old = scene.connections.find((edge) => edge.id === connectionId && edge.kind === 'MECHANICAL');
    if (!old) return this.fail('Select an existing mechanical attachment to reparent.');
    const without = { ...scene, connections: scene.connections.filter((edge) => edge.id !== connectionId) };
    const candidate = socketCandidate(without, this.definitions, old.to, target, this.id());
    if (!candidate.valid || !candidate.snappedTransform) return this.fail(candidate.reasons[0] ?? 'Choose a compatible mechanical parent.');
    const child = scene.apparatus.find((instance) => instance.id === old.to.instanceId)!;
    const ids = mechanicalDescendants(scene, [child.id]);
    const originals = scene.apparatus.filter((instance) => ids.includes(instance.id));
    if (!this.editable(originals)) return false;
    const transformed = transformSubtree(originals, child.transform, candidate.snappedTransform);
    const proposed = { ...without, connections: [...without.connections, candidate.connection],
      apparatus: scene.apparatus.map((instance) => transformed.find((item) => item.id === instance.id) ?? instance) };
    for (const instance of transformed) {
      const check = checkPlacement({ scene: proposed, definitions: this.definitions, instance, surfaces: this.getSurfaces(proposed) });
      if (!check.valid) return this.fail(check.reasons[0]);
    }
    return this.edit('Reparented apparatus',
      [detachIntent(old), ...transformed.map(moveIntent), attachIntent(candidate.connection)],
      [detachIntent(candidate.connection), ...originals.map(moveIntent), attachIntent(old)]);
  }
  previewValve(instanceId: string, openingFraction: number): void {
    const instance = this.getRuntimeSnapshot().scene.apparatus.find((item) => item.id === instanceId);
    if (!instance) return;
    const value = Math.max(0, Math.min(1, openingFraction));
    this.showPreview({ kind: 'valve', instances: [instance], valid: Number.isFinite(value),
      reasons: [], warnings: [], valveOpeningFraction: value });
    this.feedback('info', 'Drag the stopcock to preview opening; Shift is precise. Release to send SET_VALVE to the runtime.');
  }
  previewTransfer(sourceInstanceId: string, targetInstanceId: string | null, volumeL: number): void {
    const snapshot = this.getRuntimeSnapshot();
    const source = snapshot.scene.apparatus.find((instance) => instance.id === sourceInstanceId);
    const edge = snapshot.scene.connections.find((connection) => connection.enabled && connection.kind === 'FLUID' &&
      connection.from.instanceId === sourceInstanceId && connection.to.instanceId === targetInstanceId);
    const reasons: string[] = [];
    if (!edge) reasons.push('Drag onto a receiver already connected through compatible fluid sockets. Connect and align it first.');
    if (!Number.isFinite(volumeL) || volumeL <= 0) reasons.push('Choose a positive metered transfer volume in liters.');
    if (volumeL > (snapshot.scene.containerStates[sourceInstanceId]?.volumeL ?? 0)) reasons.push('The source does not contain the requested liquid volume.');
    this.showPreview({ kind: 'transfer', instances: source ? [source] : [], valid: reasons.length === 0,
      reasons, warnings: [], ...(edge ? { transfer: {
        sourceInstanceId, targetInstanceId: edge.to.instanceId, volumeL, connectionId: edge.id,
      } } : {}) });
    if (!reasons.length) this.feedback('valid', `Release to request a ${(volumeL * 1000).toPrecision(3)} mL metered transfer. The runtime validates inventory and capacity.`);
  }
  private async operation(intent: EditIntent): Promise<boolean> {
    const instance = this.getRuntimeSnapshot().scene.apparatus.find((item) => item.id === intent.targetInstanceId);
    if (!instance) return this.fail('The apparatus no longer exists.');
    if (this.state.lockedIds.includes(instance.id)) return this.fail('Unlock this apparatus before operating it.');
    const definition = this.definitions.getDefinition(instance.definitionId);
    if (!definition?.controls.some((control) => control.actionType === intent.type)) return this.fail('This operation is not declared by the apparatus definition.');
    const accepted = await this.dispatchIntents([intent], false);
    if (accepted) this.feedback('info', `${intent.type} accepted by the authoritative runtime.`);
    return accepted;
  }
  setValve(instanceId: string, openingFraction: number): Promise<boolean> {
    return this.operation({ type: 'SET_VALVE', targetInstanceId: instanceId, payload: { openingFraction } });
  }
  startStirrer(instanceId: string, enabled: boolean, frequencyHz: number): Promise<boolean> {
    return this.operation({ type: 'START_STIRRER', targetInstanceId: instanceId, payload: { enabled, frequencyHz } });
  }
  setProbe(instanceId: string, containerInstanceId: string | null): Promise<boolean> {
    return this.operation({ type: 'SET_PROBE', targetInstanceId: instanceId, payload: { containerInstanceId } });
  }
  fill(instanceId: string, contents: ContainerContents, sourceId: string): Promise<boolean> {
    return this.operation({ type: 'FILL', targetInstanceId: instanceId,
      payload: { contents, preparation: { kind: 'INITIAL', sourceId } } });
  }
  transfer(sourceInstanceId: string, targetInstanceId: string, volumeL: number, connectionId: string): Promise<boolean> {
    return this.operation({ type: 'TRANSFER', targetInstanceId: sourceInstanceId,
      payload: { sourceInstanceId, targetInstanceId, volumeL, connectionId } });
  }
  async controlStation(type: 'PAUSE' | 'RESUME' | 'SET_SPEED', speed = 1): Promise<boolean> {
    const state = this.getRuntimeSnapshot().stationStates[this.state.activeStationId];
    if (!state || this.state.busy) return false;
    this.cancel();
    try {
      const base = { controlId: this.id(), stationId: state.stationId, atSimulationS: state.simulationTimeS, expectedEpoch: state.epoch };
      const receipt = await this.runtime.actions.control(type === 'SET_SPEED'
        ? { ...base, type, payload: { speed } } : { ...base, type, payload: {} });
      return receipt.status === 'APPLIED' || this.fail(receipt.error.detail, receipt.error.code);
    } catch (error) { return this.fail(messageOf(error)); }
  }
  async resetStation(): Promise<boolean> {
    const instance = this.getRuntimeSnapshot().scene.apparatus.find((item) => item.stationId === this.state.activeStationId);
    if (!instance) return this.fail('There is no apparatus in this station to target for reset.');
    this.cancel();
    const accepted = await this.dispatchIntents([{ type: 'RESET', targetInstanceId: instance.id, payload: { scope: 'STATION' } }], false);
    if (accepted) {
      this.history.clear();
      this.refreshHistory();
      this.feedback('info', 'Runtime reset requested a new station epoch. Preparation undo never reverses conserved inventories.');
    }
    return accepted;
  }
  async replayStation(): Promise<boolean> {
    if (!this.options.onReplay) return this.fail('Replay requires the runtime owner’s checkpoint/ledger adapter.');
    this.cancel();
    try { await this.options.onReplay(this.state.activeStationId); return true; }
    catch (error) { return this.fail(messageOf(error)); }
  }
  async undo(): Promise<boolean> {
    const command = this.history.undoCommand;
    if (!command || !this.commandUsable(command)) return this.fail('No preparation edit can be undone. Use explicit experiment reset/replay after a run starts.');
    this.cancel();
    if (!await this.dispatchIntents(command.inverse)) return false;
    this.publish(command.before, true);
    this.history.didUndo();
    this.refreshHistory();
    this.feedback('info', `Undid ${command.label.toLowerCase()} with new inverse actions.`);
    return true;
  }
  async redo(): Promise<boolean> {
    const command = this.history.redoCommand;
    if (!command || !this.commandUsable(command)) return this.fail('No preparation edit can be redone.');
    this.cancel();
    if (!await this.dispatchIntents(command.forward)) return false;
    this.publish(command.after, true);
    this.history.didRedo();
    this.refreshHistory();
    this.feedback('info', `Redid ${command.label.toLowerCase()} with new action IDs.`);
    return true;
  }
  async deleteSelection(): Promise<boolean> {
    const instances = this.selectedInstances(true);
    if (!this.editable(instances)) return false;
    const snapshot = this.getRuntimeSnapshot();
    if (instances.some((instance) => snapshot.stationStates[instance.stationId]?.status !== 'PREPARING')) {
      return this.fail('Removal is restricted to never-started preparation. Reset/replay or create a new run instead.');
    }
    if (instances.some((instance) => {
      const contents = snapshot.scene.containerStates[instance.id];
      return contents && (contents.volumeL > 0 || contents.species.some((species) => species.moles > 0));
    })) return this.fail('Cannot delete a nonempty vessel. The editor never discards conserved liquid or species.');
    const ids = new Set(instances.map((instance) => instance.id));
    const edges = snapshot.scene.connections.filter((edge) => ids.has(edge.from.instanceId) || ids.has(edge.to.instanceId));
    const removed = [...instances].sort((a, b) =>
      mechanicalDescendants(snapshot.scene, [a.id]).length - mechanicalDescendants(snapshot.scene, [b.id]).length);
    return this.edit('Deleted empty apparatus',
      [...edges.map(detachIntent), ...removed.map((instance) => removeIntent(instance.id))],
      [...instances.map(placeIntent), ...edges.map(attachIntent)],
      { selectedIds: [], lockedIds: this.state.lockedIds.filter((id) => !ids.has(id)),
        groups: this.state.groups.map((group) => ({ ...group, instanceIds: group.instanceIds.filter((id) => !ids.has(id)) }))
          .filter((group) => group.instanceIds.length > 0) });
  }
  async groupSelection(name = 'Apparatus group'): Promise<boolean> {
    const selected = this.selectedInstances(true);
    if (selected.length < 2) return this.fail('Select at least two apparatus to group.');
    if (new Set(selected.map((instance) => instance.stationId)).size !== 1) return this.fail('Groups cannot cross workstations.');
    const ids = selected.map((instance) => instance.id);
    return this.edit('Grouped apparatus', [], [], {
      ...this.metadata(), selectedIds: ids,
      groups: [
        ...this.state.groups.filter((group) => !group.instanceIds.some((id) => ids.includes(id))),
        { id: this.id(), name: name.trim().slice(0, 80) || 'Apparatus group', stationId: selected[0].stationId, instanceIds: ids },
      ],
    });
  }
  async ungroupSelection(): Promise<boolean> {
    return this.edit('Ungrouped apparatus', [], [], {
      ...this.metadata(), groups: this.state.groups.filter((group) => !group.instanceIds.some((id) => this.state.selectedIds.includes(id))),
    });
  }
  async lockSelection(locked: boolean): Promise<boolean> {
    const selected = this.selectedInstances(true);
    if (!selected.length) return this.fail('Select apparatus first.');
    const ids = new Set(this.state.lockedIds);
    selected.forEach((instance) => { if (locked) ids.add(instance.id); else ids.delete(instance.id); });
    return this.edit(locked ? 'Locked apparatus' : 'Unlocked apparatus', [], [], { ...this.metadata(), lockedIds: [...ids] });
  }
  copySelection(): boolean {
    const instances = this.selectedInstances(true);
    if (!instances.length) return this.fail('Select apparatus to copy.');
    const ids = new Set(instances.map((instance) => instance.id));
    this.clipboard = {
      instances: instances.map((instance) => parseLabContract('ApparatusInstance', instance)),
      connections: this.getRuntimeSnapshot().scene.connections.filter((edge) => ids.has(edge.from.instanceId) && ids.has(edge.to.instanceId)),
    };
    this.feedback('info', 'Copied apparatus geometry and internal connections only. Inventories and observations are never copied.');
    return true;
  }
  private clonedAssembly(
    instances: readonly ApparatusInstance[], connections: readonly Connection[], stationId: string, offsetM: Vec3M,
  ): { instances: readonly ApparatusInstance[]; connections: readonly Connection[] } {
    const ids = new Map(instances.map((instance) => [instance.id, this.id()]));
    return {
      instances: instances.map((instance) => ({ ...instance, id: ids.get(instance.id)!, stationId, revision: 0,
        transform: { ...instance.transform, positionM: new Vector3(...instance.transform.positionM).add(new Vector3(...offsetM)).toArray() } })),
      connections: connections.filter((edge) => ids.has(edge.from.instanceId) && ids.has(edge.to.instanceId)).map((edge) => ({
        ...edge, id: this.id(), from: { ...edge.from, instanceId: ids.get(edge.from.instanceId)! },
        to: { ...edge.to, instanceId: ids.get(edge.to.instanceId)! },
      })),
    };
  }
  async paste(offsetM?: Vec3M): Promise<boolean> {
    if (!this.clipboard) return this.fail('Copy an apparatus selection first.');
    if (this.state.busy) return false;
    const scene = this.getRuntimeSnapshot().scene;
    if (scene.apparatus.length + this.clipboard.instances.length > LAB_LIMITS.maxApparatus) return this.fail('The scene apparatus limit would be exceeded.');
    const sourceStation = this.clipboard.instances[0].stationId;
    const sourceBench = scene.apparatus.find((instance) => instance.stationId === sourceStation && instance.kind === 'BENCH');
    const targetBench = scene.apparatus.find((instance) => instance.stationId === this.state.activeStationId && instance.kind === 'BENCH');
    const stationOffset = sourceBench && targetBench
      ? new Vector3(...targetBench.transform.positionM).sub(new Vector3(...sourceBench.transform.positionM)) : new Vector3();
    const offsets: Vec3M[] = offsetM ? [offsetM] : [];
    if (!offsetM) for (let ring = 1; ring <= 5; ring++) {
      for (const [x, z] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, -ring], [-ring, ring], [ring, -ring]]) {
        offsets.push(stationOffset.clone().add(new Vector3(x * 0.15, 0, z * 0.15)).toArray());
      }
    }
    let lastReason = 'There is no supported free space for this copied assembly.';
    for (const offset of offsets) {
      const cloned = this.clonedAssembly(this.clipboard.instances, this.clipboard.connections, this.state.activeStationId, offset);
      const proposed: ExperimentScene = {
        ...scene, apparatus: [...scene.apparatus, ...cloned.instances], connections: [...scene.connections, ...cloned.connections],
      };
      const checks = cloned.instances.map((instance) => checkPlacement({
        scene: proposed, definitions: this.definitions, instance, surfaces: this.getSurfaces(proposed),
      }));
      const invalid = checks.find((check) => !check.valid);
      if (invalid) { lastReason = invalid.reasons[0]; continue; }
      return this.edit('Pasted empty apparatus',
        [...cloned.instances.map(placeIntent), ...cloned.connections.map(attachIntent)],
        [...cloned.connections.map(detachIntent), ...[...cloned.instances].reverse().map((instance) => removeIntent(instance.id))],
        { ...this.metadata(), selectedIds: cloned.instances.map((instance) => instance.id) });
    }
    return this.fail(lastReason);
  }
  async duplicateSelection(offsetM?: Vec3M): Promise<boolean> {
    return this.copySelection() ? this.paste(offsetM) : false;
  }
  async duplicateStation(): Promise<boolean> {
    if (!this.options.onDuplicateStation) return this.fail('Station duplication requires the runtime owner’s new-run adapter.');
    const scene = this.getRuntimeSnapshot().scene;
    if (scene.stations.length >= LAB_LIMITS.maxStations) return this.fail('The workstation limit has been reached.');
    const originals = scene.apparatus.filter((instance) => instance.stationId === this.state.activeStationId);
    if (!originals.length) return this.fail('The workstation has no apparatus to duplicate.');
    const bounds = scene.apparatus.flatMap((instance) => {
      const definition = this.definitions.getDefinition(instance.definitionId);
      return definition ? [worldBounds(definition, instance.transform)] : [];
    });
    const left = Math.min(...originals.map((instance) => worldBounds(this.definitions.getDefinition(instance.definitionId)!, instance.transform).minM[0]));
    const offset: Vec3M = [Math.max(...bounds.map((box) => box.maxM[0])) - left + 0.5, 0, 0];
    const stationId = this.id();
    const cloned = this.clonedAssembly(originals, scene.connections, stationId, offset);
    try {
      const proposal = parseExperimentScene({
        ...scene, id: this.id(), revision: 0,
        stations: [...scene.stations, { id: stationId, name: `${scene.stations.find((station) => station.id === this.state.activeStationId)!.name} copy` }],
        apparatus: [...scene.apparatus, ...cloned.instances], connections: [...scene.connections, ...cloned.connections],
      });
      await this.options.onDuplicateStation(proposal);
      this.feedback('info', 'Proposed an independent, empty station in a new scene/run. The current run was not mutated.');
      return true;
    } catch (error) { return this.fail(messageOf(error)); }
  }
  serialize(): EditorSerializedState {
    const scene = this.getRuntimeSnapshot().scene;
    return parseEditorState({
      schemaVersion: 1, sceneId: scene.id, activeStationId: this.state.activeStationId,
      selectedIds: this.state.selectedIds, lockedIds: this.state.lockedIds, groups: this.state.groups,
      mode: this.state.mode === 'place' ? 'select' : this.state.mode, snapM: this.state.snapM, angleStepDeg: this.state.angleStepDeg,
      initialTransforms: Object.fromEntries(scene.apparatus.map((instance) => [instance.id, this.initialTransforms.get(instance.id) ?? instance.transform])),
    }, scene);
  }
  restore(input: unknown): boolean {
    try {
      const scene = this.getRuntimeSnapshot().scene;
      const parsed = typeof input === 'string' ? deserializeEditorState(input, scene) : parseEditorState(input, scene);
      this.cancel();
      this.history.clear();
      this.initialTransforms.clear();
      Object.entries(parsed.initialTransforms).forEach(([id, transform]) => this.initialTransforms.set(id, transform));
      this.publish({ activeStationId: parsed.activeStationId, selectedIds: parsed.selectedIds, lockedIds: parsed.lockedIds,
        groups: parsed.groups, mode: parsed.mode, snapM: parsed.snapM, angleStepDeg: parsed.angleStepDeg }, true);
      this.refreshHistory();
      return true;
    } catch (error) { return this.fail(messageOf(error)); }
  }
  prepareSave(): EditorSaveTicket {
    const snapshot = this.getRuntimeSnapshot();
    const ticket: EditorSaveTicket = {
      id: this.id(), scene: snapshot.scene, editor: this.serialize(), ifMatch: this.durableRevision,
      runtimeRevision: snapshot.revision, editorRevision: this.editorRevision,
    };
    this.pendingSaves.set(ticket.id, ticket);
    if (this.pendingSaves.size > 16) this.pendingSaves.delete(this.pendingSaves.keys().next().value!);
    return ticket;
  }
  acknowledgeSave(ticket: EditorSaveTicket, durableRevision: number): boolean {
    const pending = this.pendingSaves.get(ticket.id);
    this.pendingSaves.delete(ticket.id);
    if (pending !== ticket || ticket.scene.id !== this.getRuntimeSnapshot().scene.id ||
        ticket.ifMatch !== this.durableRevision || !Number.isSafeInteger(durableRevision) || durableRevision <= ticket.ifMatch) {
      return this.fail('A stale or conflicting save response was ignored. Reload or resolve the server revision before saving again.', 'REVISION_CONFLICT');
    }
    this.durableRevision = durableRevision;
    this.savedRuntimeRevision = ticket.runtimeRevision;
    this.savedEditorRevision = ticket.editorRevision;
    this.saveConflict = false;
    return true;
  }
  markSaveConflict(): void {
    this.saveConflict = true;
    this.pendingSaves.clear();
    this.fail('The saved scene changed on the server. Resolve the revision conflict; this editor will not silently overwrite it.', 'REVISION_CONFLICT');
  }
  getSaveStatus(): EditorSaveStatus {
    return { durableRevision: this.durableRevision, conflict: this.saveConflict,
      dirty: this.savedRuntimeRevision !== this.getRuntimeSnapshot().revision || this.savedEditorRevision !== this.editorRevision };
  }
}

export function createLabEditorController(options: EditorOptions): LabEditorController {
  return new LabEditorController(options);
}

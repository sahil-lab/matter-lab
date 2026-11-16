/**
 * DEMO-ONLY RUNTIME — not a contract, not shipped as science, not Agent 07's reducer.
 *
 * Agents 02 (3D environment), 03 (apparatus), 04 (interaction) and 07 (experiment runtime) do not
 * exist in this worktree yet, so there is no real pointer-drag-and-drop 3D lab to operate. This
 * module is a small, honestly-labeled stand-in that lets a person actually place apparatus, fill
 * reagents, operate a stopcock and mark an endpoint through real choices (not a scripted replay),
 * so the goal evaluator / hint engine / scoring rubric / notebook in this surface can be exercised
 * end-to-end today. It uses the same textbook strong-acid/strong-base formula as
 * `fixtures/strongAcidStrongBaseFixture.ts` (see that file for the derivation) purely to compute a
 * plausible pH readout for the demo. It must be deleted or replaced once Agent 07 publishes the
 * real `ExperimentRuntimeSource` implementation — every place it is used in the UI says so.
 */

import type { ApparatusInstance, ApparatusKind, Connection, ContainerContents, ExperimentRuntimeSource, ExperimentScene, LabActionType, LabEvent, Observation, RunResult, UUID } from '../contracts';
import { strongAcidStrongBasePh } from '../fixtures/strongAcidStrongBaseFixture';
import { HCL_SPECIES_ID, NAOH_SPECIES_ID, TITRATION_BENCHMARK } from '../titrationObjective';

export const DEMO_STATION_ID: UUID = 'demo-station-1';

type DemoRole = 'stand' | 'clamp' | 'burette' | 'flask';

const ROLE_KIND: Readonly<Record<DemoRole, ApparatusKind>> = { stand: 'STAND', clamp: 'CLAMP', burette: 'BURETTE', flask: 'FLASK' };
const ROLE_POSITION: Readonly<Record<DemoRole, readonly [number, number, number]>> = {
  stand: [0, 0, 0],
  clamp: [0, 0.6, 0],
  burette: [0, 0.6, 0],
  flask: [0, 0.08, 0],
};
const ROLE_CAPABILITIES: Readonly<Record<DemoRole, ApparatusInstance['capabilities']>> = {
  stand: ['MOUNT'],
  clamp: ['MOUNT', 'MOUNTABLE'],
  burette: ['FLOW_SOURCE', 'CONTAINER', 'MOUNTABLE'],
  flask: ['FLOW_RECEIVER', 'CONTAINER'],
};

export interface DemoRuntimeSnapshot {
  readonly scene: ExperimentScene;
  readonly events: readonly LabEvent[];
  readonly runResults: readonly RunResult[];
  readonly simulationS: number;
  readonly deliveredSinceTrialStartL: number;
  readonly latestPh: number | null;
}

/** The interactive controller the demo UI drives; also readable as a plain `ExperimentRuntimeSource`. */
export class FixtureDemoRuntime implements ExperimentRuntimeSource {
  readonly connectionStatus = 'connected' as const;

  private apparatus: ApparatusInstance[] = [];
  private connections: Connection[] = [];
  private containerStates: Record<UUID, ContainerContents> = {};
  private events: LabEvent[] = [];
  private runResultsByRunId = new Map<UUID, RunResult>();
  private currentObservations: Observation[] = [];
  private sequence = 0;
  private simulationS = 0;
  private trialIndex = 0;
  private deliveredSinceTrialStartL = 0;
  private latestPh: number | null = null;
  private listeners = new Set<() => void>();
  /**
   * `useSyncExternalStore` (used by `DemoControls`) requires `getSnapshot` to return the same
   * reference until something actually changes, or React re-renders forever. Cached here and
   * invalidated by `notify()`, the one place every mutator funnels through.
   */
  private cachedSnapshot: DemoRuntimeSnapshot | null = null;

  private currentRunId(): UUID {
    return `demo-run-${this.trialIndex + 1}`;
  }

  getScene(stationId: UUID): ExperimentScene | null {
    if (stationId !== DEMO_STATION_ID || this.apparatus.length === 0) return null;
    return {
      id: 'demo-scene',
      revision: this.sequence,
      schemaVersion: 1,
      stations: [{ id: DEMO_STATION_ID, name: 'Demo station' }],
      apparatus: this.apparatus,
      connections: this.connections,
      containerStates: this.containerStates,
      simulationConfig: { methodId: 'demo.strong-acid-strong-base-ideal', timeStepS: 0.1 },
    };
  }

  getEvents(stationId: UUID): readonly LabEvent[] {
    return stationId === DEMO_STATION_ID ? this.events : [];
  }

  getRunResults(stationId: UUID): readonly RunResult[] {
    return stationId === DEMO_STATION_ID ? [...this.runResultsByRunId.values()] : [];
  }

  listStations(): readonly UUID[] {
    return this.apparatus.length > 0 ? [DEMO_STATION_ID] : [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DemoRuntimeSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      scene: this.getScene(DEMO_STATION_ID) ?? {
        id: 'demo-scene',
        revision: 0,
        schemaVersion: 1,
        stations: [{ id: DEMO_STATION_ID, name: 'Demo station' }],
        apparatus: [],
        connections: [],
        containerStates: {},
        simulationConfig: { methodId: 'demo.strong-acid-strong-base-ideal', timeStepS: 0.1 },
      },
      events: this.events,
      runResults: this.getRunResults(DEMO_STATION_ID),
      simulationS: this.simulationS,
      deliveredSinceTrialStartL: this.deliveredSinceTrialStartL,
      latestPh: this.latestPh,
    };
    return this.cachedSnapshot;
  }

  private notify(): void {
    this.cachedSnapshot = null;
    for (const listener of this.listeners) listener();
  }

  private pushAction(targetInstanceId: UUID, type: LabActionType, payload: Record<string, unknown>): void {
    this.simulationS += 1;
    this.events.push({
      kind: 'ACTION_APPLIED',
      sequence: this.sequence++,
      stationId: DEMO_STATION_ID,
      action: { actionId: `demo-action-${this.sequence}`, atSimulationS: this.simulationS, targetInstanceId, type, payload },
      resultingSceneRevision: this.sequence,
    });
  }

  placeApparatus(role: DemoRole): void {
    if (this.apparatus.some((a) => a.id === role)) return;
    const instance: ApparatusInstance = {
      id: role,
      kind: ROLE_KIND[role],
      definitionId: `demo.${role}`,
      transform: { positionM: ROLE_POSITION[role], quaternion: [0, 0, 0, 1] },
      revision: 1,
      config: {},
      capabilities: ROLE_CAPABILITIES[role],
      stationId: DEMO_STATION_ID,
    };
    this.apparatus = [...this.apparatus, instance];
    this.pushAction(role, 'PLACE', {});
    this.notify();
  }

  attach(fromRole: DemoRole, toRole: DemoRole): void {
    if (this.connections.some((c) => c.from.instanceId === fromRole && c.to.instanceId === toRole)) return;
    this.connections = [...this.connections, { id: `demo-conn-${fromRole}-${toRole}`, from: { instanceId: fromRole, socketId: 'default' }, to: { instanceId: toRole, socketId: 'default' }, kind: 'MECHANICAL', enabled: true }];
    this.pushAction(fromRole, 'ATTACH', { toInstanceId: toRole });
    this.notify();
  }

  fillHcl(): void {
    this.fill('flask', HCL_SPECIES_ID, TITRATION_BENCHMARK.aliquotVolumeL, TITRATION_BENCHMARK.aliquotMolarity);
  }

  fillNaoh(): void {
    this.fill('burette', NAOH_SPECIES_ID, 0.05, TITRATION_BENCHMARK.titrantMolarity);
  }

  private fill(role: DemoRole, speciesId: string, volumeL: number, molarityMolPerL: number): void {
    this.containerStates = { ...this.containerStates, [role]: { volumeL, species: [{ speciesId, moles: molarityMolPerL * volumeL }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'demo.ideal' } };
    this.pushAction(role, 'FILL', { speciesId, volumeL, molarity: molarityMolPerL });
    this.notify();
  }

  openStopcock(opening = 0.3): void {
    this.pushAction('burette', 'SET_VALVE', { opening });
    this.notify();
  }

  /** Moves the titrant delivered-so-far to `volumeL` (never backwards), recording the increment and a fresh pH reading. */
  deliverTo(volumeL: number): void {
    const target = Math.max(this.deliveredSinceTrialStartL, volumeL);
    const incrementL = target - this.deliveredSinceTrialStartL;
    if (incrementL <= 1e-9) return;
    this.deliveredSinceTrialStartL = target;
    this.pushAction('burette', 'TRANSFER', { sourceInstanceId: 'burette', receiverInstanceId: 'flask', volumeL: incrementL });

    const analyteVolumeL = TITRATION_BENCHMARK.aliquotVolumeL;
    const analyteMolarity = TITRATION_BENCHMARK.aliquotMolarity;
    const titrantMolarity = TITRATION_BENCHMARK.titrantMolarity;
    const totalVolumeL = analyteVolumeL + this.deliveredSinceTrialStartL;
    const ph = strongAcidStrongBasePh(analyteMolarity * analyteVolumeL, titrantMolarity, this.deliveredSinceTrialStartL, totalVolumeL);
    this.latestPh = Number(ph.toFixed(3));
    const runId = this.currentRunId();
    const observation: Observation = {
      type: 'PH',
      apparatusId: 'flask',
      timeS: this.simulationS,
      quantity: { value: this.latestPh, unit: 'pH' },
      evidence: 'MODEL_CALCULATED',
      methodId: 'demo.strong-acid-strong-base-ideal',
      sourceIds: ['demo:strong-acid-strong-base'],
    };
    this.currentObservations = [...this.currentObservations, observation];
    const observationEvent: LabEvent = { kind: 'OBSERVATION_RECORDED', sequence: this.sequence++, stationId: DEMO_STATION_ID, runId, observation };
    this.events.push(observationEvent);

    const equivalenceVolumeL = (analyteMolarity * analyteVolumeL) / titrantMolarity;
    const runResult: RunResult = {
      runId,
      status: 'SUCCEEDED',
      methodId: 'demo.strong-acid-strong-base-ideal',
      methodVersion: 'demo-0.1',
      inputHash: `demo-hash-${this.trialIndex}`,
      observations: this.currentObservations,
      warnings: [],
      assumptions: ['Ideal dilute solution.', 'Well-mixed, isothermal at 298.15 K.', 'Water autoionization included (Kw = 1.0e-14).'],
      solverDiagnostics: { equivalenceVolumeL, titrantMolarityMolPerL: titrantMolarity, analyteVolumeL, analyteMolarityMolPerL: analyteMolarity },
    };
    this.runResultsByRunId.set(runId, runResult);
    this.notify();
  }

  /** Delivers an additional increment from the runtime's own live state (robust against stale UI snapshots across rapid clicks). */
  deliverIncrement(incrementL: number): void {
    this.deliverTo(this.deliveredSinceTrialStartL + incrementL);
  }

  /** Appends the `MARK_ENDPOINT` action that `goals/trials.ts` uses to cut a trial boundary. */
  markEndpoint(): void {
    this.pushAction('flask', 'CUSTOM', { kind: 'MARK_ENDPOINT', deliveredVolumeL: this.deliveredSinceTrialStartL, runId: this.currentRunId() });
    this.notify();
  }

  /** Starts a new repeat trial on the same physical setup (apparatus/reagents stay; delivered volume resets). */
  startNewTrial(): void {
    this.trialIndex += 1;
    this.deliveredSinceTrialStartL = 0;
    this.latestPh = null;
    this.currentObservations = [];
    this.notify();
  }

  resetAll(): void {
    this.apparatus = [];
    this.connections = [];
    this.containerStates = {};
    this.events = [];
    this.runResultsByRunId.clear();
    this.currentObservations = [];
    this.sequence = 0;
    this.simulationS = 0;
    this.trialIndex = 0;
    this.deliveredSinceTrialStartL = 0;
    this.latestPh = null;
    this.notify();
  }
}

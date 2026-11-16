import type { LabRuntimeEvent, LabRuntimeReader, RuntimeSnapshot, UUID, Vec3M } from '@matterlab/contracts';
import { resolveFluidSettings } from './quality';
import { fluidScope, sameFluidScope } from './types';
import type { FluidScope, FluidVisualSettings } from './types';

const MAX_LINKS = 64;
const MAX_DROPS_PER_LINK = 48;
const DROP_QUANTUM_L = 0.00001;
const DROP_LIFETIME_S = 0.22;
const MAX_BURST_AGE_S = 0.35;
const keyOf = (source: UUID, receiver: UUID) => `${source}\0${receiver}`;

interface Drop {
  readonly startsS: number;
  readonly radiusM: number;
}
interface Burst {
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly connectionId: UUID;
  scope: FluidScope;
  sequence: number;
  acceptedAtS: number;
  acceptedVolumeL: number;
  flowLPerS: number;
  remainderL: number;
  drops: Drop[];
}

export interface TransferSampleQuery {
  readonly scope: FluidScope;
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly connectionId?: UUID;
  readonly settings?: FluidVisualSettings;
  readonly nowS?: number;
}
export interface TransferVisualSample {
  readonly drops: readonly { readonly fraction: number; readonly radiusM: number }[];
  readonly pouring: boolean;
  readonly acceptedVolumeL: number;
  readonly acceptedFlowLPerS: number;
  readonly evidence: 'ILLUSTRATIVE';
}
const NO_TRANSFER: TransferVisualSample = Object.freeze({
  drops: [], pouring: false, acceptedVolumeL: 0, acceptedFlowLPerS: 0, evidence: 'ILLUSTRATIVE',
});

export interface TransferPresentation {
  /** Adopt a run/checkpoint without playing any historical transfers. */
  sync(snapshot: RuntimeSnapshot): void;
  /** Call for EVERY reader event, in order, including rejected actions and controls. */
  ingest(snapshot: RuntimeSnapshot, event: LabRuntimeEvent): void;
  sample(query: TransferSampleQuery): TransferVisualSample;
  clearLink(sourceInstanceId: UUID, receiverInstanceId: UUID): void;
  setMotionEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createTransferPresentation(
  initialSnapshot?: RuntimeSnapshot,
  options: { readonly nowS?: () => number; readonly motionEnabled?: boolean } = {},
): TransferPresentation {
  const clock = options.nowS ?? (() => performance.now() / 1000);
  let current: RuntimeSnapshot | undefined;
  let lastEventSequence = -1;
  let totals = new Map<string, number>();
  let unclaimed = new Map<string, number>();
  const bursts = new Map<string, Burst>();
  let motionEnabled = options.motionEnabled !== false;
  let disposed = false;

  const readTotals = (snapshot: RuntimeSnapshot) => new Map(snapshot.transferTotals.map((total) =>
    [keyOf(total.sourceInstanceId, total.receiverInstanceId), total.deliveredVolumeL] as const));
  const clearStation = (stationId: UUID) => {
    for (const [key, burst] of bursts) if (burst.scope.stationId === stationId) bursts.delete(key);
  };
  const clearApparatus = (instanceId: UUID) => {
    for (const [key, burst] of bursts) {
      if (burst.sourceInstanceId === instanceId || burst.receiverInstanceId === instanceId) bursts.delete(key);
    }
  };

  const presentation: TransferPresentation = {
    sync(snapshot) {
      if (disposed) return;
      current = snapshot;
      totals = readTotals(snapshot);
      unclaimed.clear();
      bursts.clear();
      lastEventSequence = snapshot.lastSequence;
    },
    ingest(snapshot, event) {
      if (disposed) return;
      if (!current || snapshot.runId !== current.runId) {
        presentation.sync(snapshot);
        return;
      }
      if (event.runId !== snapshot.runId || event.sequence <= lastEventSequence ||
          event.sequence > snapshot.lastSequence || snapshot.lastSequence < current.lastSequence ||
          snapshot.revision < current.revision) return;
      lastEventSequence = event.sequence;
      if (snapshot.lastSequence !== current.lastSequence || snapshot.revision !== current.revision) {
        const nextTotals = readTotals(snapshot);
        const nextUnclaimed = new Map<string, number>();
        for (const transfer of snapshot.transferTotals) {
          const source = snapshot.scene.apparatus.find((instance) => instance.id === transfer.sourceInstanceId);
          const receiver = snapshot.scene.apparatus.find((instance) => instance.id === transfer.receiverInstanceId);
          if (!source || !receiver || source.stationId !== receiver.stationId) continue;
          const before = current.stationStates[source.stationId];
          const after = snapshot.stationStates[source.stationId];
          if (!before || !after || before.epoch !== after.epoch || after.status !== 'RUNNING' ||
              after.simulationTimeS < before.simulationTimeS) continue;
          const key = keyOf(source.id, receiver.id);
          const delta = transfer.deliveredVolumeL - (totals.get(key) ?? 0);
          if (Number.isFinite(delta) && delta > 0) nextUnclaimed.set(key, delta);
        }
        for (const [key, burst] of bursts) {
          const station = snapshot.stationStates[burst.scope.stationId];
          if (!station || station.epoch !== burst.scope.epoch || station.status !== 'RUNNING' ||
              station.simulationTimeS < burst.scope.simulationTimeS ||
              (nextTotals.get(key) ?? 0) < (totals.get(key) ?? 0)) bursts.delete(key);
        }
        totals = nextTotals;
        unclaimed = nextUnclaimed;
        current = snapshot;
      }
      const scope = fluidScope(snapshot, event.stationId);
      if (!scope || scope.epoch !== event.epoch) return;
      if (scope.status !== 'RUNNING' || !motionEnabled) {
        clearStation(scope.stationId);
        return;
      }
      if (event.type === 'ADVANCE') {
        const hasAcceptedDelta = snapshot.scene.apparatus.some((instance) =>
          instance.stationId === scope.stationId && snapshot.transferTotals.some((transfer) =>
            transfer.sourceInstanceId === instance.id &&
            (unclaimed.get(keyOf(transfer.sourceInstanceId, transfer.receiverInstanceId)) ?? 0) > 0));
        if (!hasAcceptedDelta) clearStation(scope.stationId);
        return;
      }
      if (event.type === 'CONTROL') {
        if (event.receipt.status === 'APPLIED') clearStation(scope.stationId);
        return;
      }
      if (event.type !== 'ACTION') return;
      if (event.action.type !== 'TRANSFER') {
        if (event.receipt.status === 'APPLIED') {
          if (event.action.type === 'RESET') clearStation(scope.stationId);
          else clearApparatus(event.action.targetInstanceId);
        }
        return;
      }
      const { sourceInstanceId, targetInstanceId: receiverInstanceId, connectionId, volumeL } = event.action.payload;
      const key = keyOf(sourceInstanceId, receiverInstanceId);
      if (event.receipt.status !== 'APPLIED' || event.receipt.actionId !== event.action.actionId ||
          event.receipt.sequence !== event.sequence || event.receipt.stationId !== scope.stationId ||
          event.receipt.epoch !== scope.epoch || !Number.isFinite(volumeL) || volumeL <= 0) {
        bursts.delete(key);
        return;
      }
      const edge = snapshot.scene.connections.find((connection) => connection.id === connectionId);
      const source = snapshot.scene.apparatus.find((instance) => instance.id === sourceInstanceId);
      const receiver = snapshot.scene.apparatus.find((instance) => instance.id === receiverInstanceId);
      if (!edge?.enabled || edge.kind !== 'FLUID' || edge.from.instanceId !== sourceInstanceId ||
          edge.to.instanceId !== receiverInstanceId || source?.stationId !== scope.stationId ||
          receiver?.stationId !== scope.stationId) {
        bursts.delete(key);
        return;
      }
      const availableL = unclaimed.get(key) ?? 0;
      const acceptedL = availableL <= volumeL + 1e-12 ? availableL : volumeL;
      if (!Number.isFinite(acceptedL) || acceptedL <= 0) {
        bursts.delete(key);
        return;
      }
      unclaimed.set(key, Math.max(0, availableL - acceptedL));
      const nowS = clock();
      if (!Number.isFinite(nowS)) return;
      const station = snapshot.stationStates[scope.stationId]!;
      const tickS = snapshot.scene.simulationConfig.timeStepS;
      if (!Number.isFinite(tickS) || tickS <= 0 || !Number.isFinite(station.speed) || station.speed <= 0) return;
      const intervalS = Math.max(0.015, Math.min(0.1, tickS / station.speed));
      let burst = bursts.get(key);
      if (!burst || !sameFluidScope(burst.scope, scope) || burst.connectionId !== connectionId ||
          nowS < burst.acceptedAtS || nowS - burst.acceptedAtS > MAX_BURST_AGE_S) {
        burst = {
          sourceInstanceId, receiverInstanceId, connectionId, scope, sequence: event.sequence,
          acceptedAtS: nowS, acceptedVolumeL: 0, flowLPerS: 0, remainderL: 0, drops: [],
        };
      }
      burst.scope = scope;
      burst.sequence = event.sequence;
      burst.acceptedAtS = nowS;
      burst.acceptedVolumeL = acceptedL;
      burst.flowLPerS = acceptedL / tickS;
      const visualVolumeL = burst.remainderL + acceptedL;
      const quanta = Math.floor(visualVolumeL / DROP_QUANTUM_L + 1e-10);
      const count = Math.min(MAX_DROPS_PER_LINK, quanta);
      burst.remainderL = Math.max(0, visualVolumeL - quanta * DROP_QUANTUM_L);
      burst.drops = burst.drops.filter((drop) => nowS - drop.startsS < DROP_LIFETIME_S);
      const radiusM = 0.0008 + 0.0012 * Math.min(1, Math.sqrt(burst.flowLPerS / 0.001));
      for (let i = 0; i < count; i++) {
        burst.drops.push({ startsS: nowS + i / Math.max(1, count) * intervalS, radiusM });
      }
      if (burst.drops.length > MAX_DROPS_PER_LINK) burst.drops.splice(0, burst.drops.length - MAX_DROPS_PER_LINK);
      if (!bursts.has(key) && bursts.size >= MAX_LINKS) bursts.delete(bursts.keys().next().value!);
      bursts.set(key, burst);
    },
    sample(query) {
      const key = keyOf(query.sourceInstanceId, query.receiverInstanceId);
      const settings = resolveFluidSettings(query.settings);
      if (disposed || !motionEnabled || !settings.enabled || settings.reducedMotion) {
        bursts.delete(key);
        return NO_TRANSFER;
      }
      const burst = bursts.get(key);
      if (!burst) return NO_TRANSFER;
      const nowS = query.nowS ?? clock();
      const currentScope = current && fluidScope(current, burst.scope.stationId);
      if (!currentScope || !sameFluidScope(currentScope, burst.scope) || currentScope.status !== 'RUNNING' ||
          Math.abs(currentScope.simulationTimeS - burst.scope.simulationTimeS) > 1e-9 ||
          !Number.isFinite(nowS) || nowS < burst.acceptedAtS || nowS - burst.acceptedAtS > MAX_BURST_AGE_S) {
        bursts.delete(key);
        return NO_TRANSFER;
      }
      if (!sameFluidScope(currentScope, query.scope) || query.scope.status !== 'RUNNING' ||
          burst.sequence > query.scope.lastSequence || query.scope.lastSequence > current!.lastSequence ||
          Math.abs(query.scope.simulationTimeS - burst.scope.simulationTimeS) > 1e-9 ||
          (query.connectionId !== undefined && query.connectionId !== burst.connectionId)) return NO_TRANSFER;
      const drops = burst.drops.filter((drop) => nowS >= drop.startsS && nowS < drop.startsS + DROP_LIFETIME_S)
        .slice(-settings.maxDroplets)
        .map((drop) => ({ fraction: (nowS - drop.startsS) / DROP_LIFETIME_S, radiusM: drop.radiusM }));
      return {
        drops,
        pouring: !settings.lowPower && settings.quality !== 'low' &&
          burst.flowLPerS >= 0.0004 && nowS - burst.acceptedAtS <= 0.1,
        acceptedVolumeL: burst.acceptedVolumeL, acceptedFlowLPerS: burst.flowLPerS,
        evidence: 'ILLUSTRATIVE',
      };
    },
    clearLink(source, receiver) { bursts.delete(keyOf(source, receiver)); },
    setMotionEnabled(enabled) {
      if (motionEnabled === enabled) return;
      motionEnabled = enabled;
      bursts.clear();
      unclaimed.clear();
    },
    dispose() {
      disposed = true;
      bursts.clear();
      totals.clear();
      unclaimed.clear();
      current = undefined;
    },
  };
  if (initialSnapshot) presentation.sync(initialSnapshot);
  return presentation;
}

export function connectTransferPresentation(reader: LabRuntimeReader, presentation: TransferPresentation): () => void {
  presentation.sync(reader.getSnapshot());
  return reader.subscribe((snapshot, event) => presentation.ingest(snapshot, event));
}

export function transferPathSupported(sourceM: Vec3M, receiverM: Vec3M): boolean {
  if ([...sourceM, ...receiverM].some((value) => !Number.isFinite(value))) return false;
  const dropM = sourceM[1] - receiverM[1];
  return dropM > 0.001 && Math.hypot(sourceM[0] - receiverM[0], dropM, sourceM[2] - receiverM[2]) <= 2;
}

export function transferPointM(sourceM: Vec3M, receiverM: Vec3M, fraction: number): Vec3M {
  const t = Math.max(0, Math.min(1, fraction));
  return [
    sourceM[0] + (receiverM[0] - sourceM[0]) * t,
    sourceM[1] + (receiverM[1] - sourceM[1]) * t * t,
    sourceM[2] + (receiverM[2] - sourceM[2]) * t,
  ];
}

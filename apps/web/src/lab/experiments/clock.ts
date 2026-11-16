import type { LabRuntimeReader, ProblemDetails, RuntimeSnapshot, UUID } from '@matterlab/contracts';
import { asProblem } from '@matterlab/lab-runtime';

export interface ClockRuntime {
  readonly reader: LabRuntimeReader;
  advanceStation(stationId: UUID, ticks: number): Promise<RuntimeSnapshot>;
}
export interface SimulationClock {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
}
export function createSimulationClock(
  runtime: ClockRuntime, onError: (problem: ProblemDetails) => void, maxTicksPerFrame = 4,
): SimulationClock {
  if (!Number.isSafeInteger(maxTicksPerFrame) || maxTicksPerFrame < 1 || maxTicksPerFrame > 16) throw new Error('Clock tick batch must be 1–16.');
  const accumulated = new Map<UUID, number>();
  let running = false;
  let frame: number | undefined;
  let previousTime: number | undefined;
  let pending: Promise<void> = Promise.resolve();
  const schedule = (): void => { if (running) frame = requestAnimationFrame(update); };
  const update = (now: number): void => {
    if (!running) return;
    const elapsedS = previousTime === undefined ? 0 : Math.min(0.25, Math.max(0, (now - previousTime) / 1000));
    previousTime = now;
    pending = (async () => {
      const snapshot = runtime.reader.getSnapshot();
      const dt = snapshot.scene.simulationConfig.timeStepS;
      for (const station of Object.values(snapshot.stationStates)) {
        if (!running) break;
        if (station.status !== 'RUNNING') { accumulated.delete(station.stationId); continue; }
        const elapsed = Math.min((accumulated.get(station.stationId) ?? 0) + elapsedS * station.speed, dt * maxTicksPerFrame);
        const ticks = Math.min(maxTicksPerFrame, Math.floor((elapsed + 1e-12) / dt));
        accumulated.set(station.stationId, elapsed - ticks * dt);
        if (ticks > 0) await runtime.advanceStation(station.stationId, ticks);
      }
    })().catch((error: unknown) => { running = false; onError(asProblem(error)); }).finally(schedule);
  };
  return Object.freeze({
    start() { if (!running) { running = true; previousTime = undefined; schedule(); } },
    async stop() {
      running = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      previousTime = undefined;
      await pending;
    },
    isRunning: () => running,
  });
}

# Laboratory browser adapter

`createBrowserLabRuntime(options):Promise<BrowserLabRuntime>` creates one dedicated worker with the same `@matterlab/lab-runtime` and `@matterlab/lab-science` used by the Node runner. Options are `{initialScene,runId,definitions:readonly ApparatusDefinition[],limits?,checkpoint?}`. Restoring a checkpoint verifies/replays it; initial state is never replaced inside an existing worker.

The result provides canonical `reader`/`actions`, `dispatchBatch(actions)`, `advanceStation(id,ticks)`, `getCheckpoint()`, asynchronous `getModelSupport(id)`, and `dispose()`. Disposal terminates that owned worker and rejects its outstanding requests. Camera/editor rendering never waits on chemistry in the main thread.

`useLabRuntimeSnapshot(reader)` uses React external-store subscriptions. `createLabRuntimeStore(reader)` exposes only Zustand getters/subscriptions (no public `setState`) plus `dispose()` for subscription cleanup.

`createSimulationClock(runtime,onError,maxTicksPerFrame=4)` schedules bounded per-station fixed-tick batches through requestAnimationFrame. It does not change chemistry, fabricate elapsed offline time, or write inventory. `start()` begins scheduling; `await stop()` cancels the frame and waits for the current request. Stop the clock before issuing pause/operation commands stamped from a fresh snapshot. On transport/runtime failure it stops and reports the error; it never repeatedly retries failed transfers.

The worker returns one final immutable snapshot plus ordered events for each request. Event listeners may receive that same final snapshot repeatedly for its constituent events. For colors/readings use container/run/station/epoch **and the scientific observation batch sequence**; PH and its indicators share a sequence. Do not use global lastSequence, valve opening, viewport frames or receiver-total subtraction as scientific evidence.

No UI components, apparatus registry, Three.js scene, HTTP client or persistence implementation is supplied here. Parent composition passes the canonical definition list, connects editor batching and learning/fluids readers, and owns worker/clock disposal when changing runs or unmounting.

Targeted typecheck from worktree root:

```powershell
.\env.ps1 -Quiet
tsc --noEmit -p .\apps\web\src\lab\experiments\tsconfig.json
```

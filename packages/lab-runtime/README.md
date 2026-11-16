# Laboratory runtime 1.0.0

The sole live inventory writer. Uses **contracts 1.1.0 / schemaVersion 1**, the parent-owned pure apparatus registry and Agent 06's **same** aqueous equilibrium implementation in browsers and Node. No apparatus catalog, GUI, Python solver or molecular-app replacement is defined here.

## Entry points

```ts
createLabRuntime(options: LabRuntimeOptions): Promise<LabRuntime>
createStandardLabRuntime({
  initialScene, runId, definitions, limits?
}): Promise<LabRuntime>
restoreLabRuntime(checkpoint: RuntimeCheckpoint, dependencies: RuntimeDependencies): Promise<LabRuntime>
standardRuntimeDependencies(definitions: ApparatusDefinitionReader): RuntimeDependencies
executeNodeRun(request: NodeRunRequest, dependencies: RuntimeDependencies): Promise<NodeRunResponse>
```

`LabRuntimeOptions` injects immutable initial scene/run ID, a definition reader, `{solve,methodId,methodVersion,assumptions}` science adapter, optional experiment/capability plugins and limits. Standard entry points inject `@matterlab/lab-science`, never a second chemistry implementation.

The returned object exposes:

- `reader.getSnapshot():RuntimeSnapshot`, `reader.subscribe((snapshot,event)=>void):()=>void`.
- `actions.dispatch(LabAction):Promise<ActionReceipt>`, `actions.control(RuntimeControl):Promise<ControlReceipt>`.
- `dispatchBatch(readonly LabAction[]):Promise<readonly ActionReceipt[]>`.
- `advanceStation(stationId:UUID,ticks:number):Promise<RuntimeSnapshot>`.
- `getCheckpoint():Promise<RuntimeCheckpoint>`, `getModelSupport(stationId):ModelSupport`, `getDiagnostics():JsonObject`, `dispose():void`.

Commands serialize through one queue. Observers cannot mutate frozen snapshots or veto a committed action. Domain-invalid, attributable commands produce immutable rejected receipts; malformed payloads, conflicting IDs and exhausted hard limits throw `LabRuntimeError`/`ContractValidationError`. An identical accepted/rejected command ID always returns its original receipt, including after reset/restore.

## Inventory and time

`FILL` is explicit **preparation-only replacement** with a recorded INITIAL/EXTERNAL source. It cannot refill running/paused/previously started epochs. Initial-scene contents are also explicit preparation. `TRANSFER` is the only internal liquid movement: source and receiver updates are atomic and conserve analytical components and volume.

Transfers require an enabled same-station directed fluid edge, sufficient source, receiver capacity, a well-mixed source, matching inventory models and equal specified temperatures (empty receivers inherit source temperature). No thermal mixing, density, reaction/speciation, evaporation, spill or arbitrary-product model is invented. Volume tolerance is `1e-12 L`; component checks use `1e-12` absolute/relative tolerance. Manual requests clip only within that numerical tolerance.

The supported flow ID is **`flow:linear-valve-v1`**:
`transferL = openingFraction × definition.maxFlowLPerS × timeStepS`.
Automatic transfers are explicitly clipped to remaining source/headroom and emitted as ordinary accepted `ACTION/TRANSFER` events with actual volume. Depletion/full capacity closes the valve through a deterministic action. Multiple receivers per open source and unknown flow models are unsupported, not improvised hydrodynamics.

Each station has its own fixed tick, seconds, speed, epoch and status. Pause suspends movement. Display speed affects scheduling, not a tick's chemistry. `ADVANCE` batches are transactional; failed cap checks never publish or retain partially advanced inventory. Default limits are 100,000 total ticks, 50,000 commands, 100,000 observations, 3600 simulation seconds, plus contract JSON/graph caps. Logs are never silently truncated to fit a save.

`RESET` restores the immutable initial scene/station preparation, increments affected epochs and resets clocks/current delivery tallies/controls, while retaining all action IDs, receipts and observations. The reset event/receipt belongs to the **old** epoch; restored observations belong to the new one. Runtime revision stays separate from durable scene revision. A seed with no contents resets to no contents, not to a secretly inferred filled baseline.

## Editor and graph

Pure `validateConnection`, `stationGraphProblems`, `validateInstance`, `validateMove`, `socketWorldPosition` and `isProbeImmersed` are exported. Mechanical edges point **parent `from` → child `to`**. Checks include definition/config/capability agreement, directions/genders/compatibility, socket capacity, station isolation, mechanical cycles/parents and declared alignment tolerances. Definitions tagged `requires-mount` cannot operate without a mechanical parent. Unknown apparatus may be edited but cannot acquire invented behavior.

Atomic editor batches allow PLACE/MOVE/ATTACH/DETACH plus:

```ts
{ type:'CUSTOM', payload:{
  pluginId:'matterlab:editor-v1', actionType:'REMOVE_EMPTY_APPARATUS', data:{}
}}
```

Removal is restricted to empty, never-started preparation. Filled apparatus cannot be deleted as an undo shortcut. Use fresh IDs for inverse editor commands; never rewind physical history. A subtree batch checks final, not intermediate, alignment and rolls back all child effects on rejection. It persists as one registered CUSTOM `BATCH` action containing validated children; child ACTION events and the wrapper receipt remain auditable and replay with the same atomic semantics. Nested batches and inventory/run operations are forbidden inside it.

Container config uses registered CUSTOM `matterlab:container-config-v1 / SET_CONFIG`; patches must satisfy the authoritative definition's config schema. `indicatorId` is passed to Agent 06 only when the catalog declares that config field. Runtime never bypasses an empty config schema.

`duplicateExperimentScene` remaps every scene/station/apparatus/connection ID and preserves exact explicitly prepared contents, without copying a live checkpoint. `addStationToDraft` constructs a validated new draft. Both start a **new runtime/run**, not a replacement of a live immutable initial state.

## Science, sensors and event ordering

After accepted inventory changes: ACTION → inventory observations → pure solver → immutable scientific observations. A tick precedes these with ADVANCE. Subscribers receive the final immutable snapshot only after the operation/batch finishes.

Every nonempty vessel's solver request is explicitly bound to its apparatus ID and checked against authoritative contents/station. Copied-but-equal inputs are allowed with IDs; legacy ambiguous inputs are unsupported. Failed/unsupported solves produce status/error events, never numeric substitute pH. Existing observations remain history.

PH and all CONCENTRATION/INDICATOR records from **one solve share the same observation/event sequence, run, station, epoch and time**. Other vessels have different solve sequences. `snapshot.lastSequence` is **not** a vessel's solve cursor. All changed inventory observations precede that vessel's solve; inactive advances add no inventory observations. Specified unchanged temperature conditions need not be resampled.

PH apparatus IDs identify containers, not probes. `SET_PROBE` requires a valid sensor edge and a tip inside the calibrated liquid profile; no ambient reading is invented. A probe leaving the liquid loses its binding. `selectProbeObservation` returns the bound container's actual current PH record or nothing.

`selectCurrentObservation`, `selectTitrationObservations` and render-only `interpolatedVolumeL` support consumers. Titration metadata records cumulative **accepted** source/receiver delivery in the current epoch; ambiguity omits it. Source VOLUME records include zero at depletion. Indicator payloads copy Agent 06's exact fraction/color/source evidence. UI/fluids/gameplay must not calculate pH or inventory.

Current scientific selectors also require the latest solve to be newer than that vessel's inventory observations. Indicator/concentration records must belong to the latest PH cohort; a same-time refill or removal of an indicator cannot retain a stale tint.

## Replay and Node

Checkpoints retain the initial scene, ordered external steps (including atomic editor wrappers), contiguous event/receipt history, current state, versions and input hash. Restore verifies the hash, replays the completed prefix with the pinned solver/registry, and compares state/events before returning a runtime. Forged client inventory/results are not restored. Old contract/runtime/science versions fail explicitly, never silently migrate.

```powershell
.\env.ps1 -Quiet
npm run build --workspace @matterlab/lab-runtime
# Fixed argv: node packages\lab-runtime\dist\cli.mjs
# Supply one bounded NodeRunRequest on stdin; receive one canonical NodeRunResponse on stdout.
```

The package-local Vite SSR build emits `dist/cli.mjs`, any shared chunks, and `dist/equipment-definitions.json` directly from the parent registry. **Copy/hash the entire dist tree**, not just the entry file. Reagent/source catalogs remain Agent-06-owned; backend packaging may copy those artifacts alongside it.

Exit 0 means a valid terminal response was emitted, **not necessarily scientific success**: inspect SUCCEEDED/FAILED/UNSUPPORTED/CANCELLED. Malformed input/transport/serialization failure emits Problem Details to stderr and exits 64 with no fabricated response. Backend cancellation kills its owned process; the backend owns durable cancellation/timeout status and must not overwrite it with late success. InputHash remains canonical request SHA-256, separate from the backend's release-tree digest.

## Validation and integration

`npm run typecheck --workspace @matterlab/lab-runtime` and `npm run test --workspace @matterlab/lab-runtime` cover real 250-tick equivalence/conservation, pause/preparation guards, reset/idempotent save/replay, invalid graphs and atomic subtree edits, copied/forged solver attribution, hard caps, empty-source observations, Node byte parity and a browser-only worker bundle. Transport tests build this package, not the application or a server.

Frontend adapters live in `apps/web/src/lab/experiments`. Parent/root integration must add `@matterlab/lab-runtime:"*"` to the web dependency manifest and install its workspace link. The package declares only existing contracts/science workspaces and the already installed Vite tool. No root scripts, lockfiles or shared dependencies are modified here. Full application/GPU/visual/performance validation remains the parent's integration gate.

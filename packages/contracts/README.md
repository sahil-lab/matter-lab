# Laboratory contracts 1.1.0 (scene schema v1)

Import **`@matterlab/contracts`** (root export). This additive package does not re-export, replace or change `@matterlab/core`: its molecular IDs, angstrom coordinates, lowercase evidence values and native scene format remain separate.

This milestone supplies DTOs, validation, serialization, hashing and interfaces, **not** an apparatus registry, inventory reducer, scientific solver, worker, UI or CLI implementation. Agent 09 approves persistence; Agent 10 reviews integration before dependent runtime execution is implemented.

## Wire policy

- Entity IDs are canonical lowercase UUIDs, versions 1–8 with RFC variant bits. Catalog `definitionId`, `speciesId`, `modelId`, `methodId` and `sourceId` are nonempty keys, not necessarily UUIDs.
- Scene/schema version is exactly `1`; contract version is `1.1.0`. UTC timestamp schemas require ISO 8601 with `Z`. Runtime restores must explicitly reject incompatible version pins, not silently upgrade old `1.0.0` checkpoints.
- Coordinates/bounds/calibration heights use meters; volume L; amount mol; concentration mol/L; temperature K; time s; mass kg; flow L/s; stirring frequency Hz. `PH` observations use unit `pH`; indicator fractions use `1`. No implicit conversions/defaults.
- A `SpeciesAmount` is **conserved analytical inventory**, not a transient equilibrium species. Only Agent 06 defines reagent composition, species/family keys, equilibria and indicator calculations. For example, its aqueous acid/base model uses `ion:chloride`, `ion:sodium`, `family:acetate`, and `family:ammonia`; the contracts do not interpret those keys.
- Evidence: `REFERENCE_MEASURED | MODEL_CALCULATED | ILLUSTRATIVE | UNVERIFIED | UNSUPPORTED`. Run statuses: `QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED | UNSUPPORTED`. Failed/unsupported solver variants cannot contain pH, speciation, indicator results or prepared contents.
- Parsers reject unknown declared fields, coercion, nonfinite numbers, sparse/cyclic/non-JSON data, accessors, reserved object keys, unpaired Unicode surrogates and duplicate keys in JSON text. They return detached, recursively frozen DTOs.
- `LAB_LIMITS` declares byte/depth/node/collection caps (8 MiB, depth 32, 1,000,000 JSON nodes, 32 stations, 512 apparatus, 2048 connections, 128 inventory components per vessel). The node budget covers a normal 250-tick titration response with both result observations and its complete checkpoint; the 8 MiB byte limit still applies. Numeric schema sanity caps include 10,000 L, 1,000,000 mol/component, 10,000 K and ±10,000 m. These are serialization/resource limits, **not scientific applicability claims**.

## Public functions

```ts
validateLabContract<N extends LabContractName>(
  name: N, input: unknown
): ValidationResult<LabContractTypes[N]>
parseLabContract<N extends LabContractName>(name: N, input: unknown): LabContractTypes[N]
parseLabJson<N extends LabContractName>(name: N, json: string): LabContractTypes[N]
serializeLabContract<N extends LabContractName>(name: N, value: LabContractTypes[N]): string

validateExperimentScene(input: unknown): ValidationResult<ExperimentScene>
parseExperimentScene(input: unknown): ExperimentScene
serializeExperimentScene(scene: ExperimentScene): string
deserializeExperimentScene(json: string): ExperimentScene
validateLabAction(input: unknown): ValidationResult<LabAction>
parseLabAction(input: unknown): LabAction
validateApparatusDefinition(input: unknown): ValidationResult<ApparatusDefinition>
parseApparatusDefinition(input: unknown): ApparatusDefinition

getLabJsonSchema(name?: LabSchemaName): LabJsonSchemaDocument
canonicalizeNodeRunInput(input: NodeRunRequest): string
hashNodeRunInput(input: NodeRunRequest): Promise<string>
```

`ValidationResult<T>` is `{ok:true,value:T} | {ok:false,errors:readonly ValidationIssue[]}`. Throwing parsers use `ContractValidationError.problem`, an RFC 9457 `ProblemDetails` with stable `code`, status, detail and JSON-Pointer-addressed errors. No validation function executes chemistry or applies an action.

`schemas/lab-v1.schema.json` is generated from `lab/json-schema.ts`, the **same structural schema** used by TypeScript validation. Its draft-2020-12 `$defs` include the complete apparatus, scene, action, observation, solver, runtime/checkpoint and Node request/response boundaries. Python must reject nonfinite JSON tokens/duplicate keys before schema validation. JSON Schema alone cannot express normalized quaternions, cross-references, calibration monotonicity or ledger consistency; TypeScript parsers additionally enforce those refinements. Validation is not authorization or proof that client-provided results were computed.

## Actions and lifecycle agreement

Every `LabAction` has `{actionId,atSimulationS,targetInstanceId,type,payload,actorId?,expectedRevision?,expectedEpoch?}`. `atSimulationS` is the target station's time in its current epoch. `expectedRevision` means **local `RuntimeSnapshot.revision`**, not durable `ExperimentScene.revision` / HTTP `If-Match`.

| Type | Exact payload |
|---|---|
| `PLACE` | `{instance:ApparatusInstance}`; envelope targets that new ID |
| `MOVE` | `{transform:Transform}` |
| `ATTACH` | `{connection:Connection}`; envelope targets either endpoint |
| `DETACH` | `{connectionId:UUID}` |
| `FILL` | `{contents:ContainerContents,preparation:{kind:'INITIAL'\|'EXTERNAL',sourceId:string}}` |
| `SET_VALVE` | `{openingFraction:number}` in `[0,1]` |
| `TRANSFER` | `{sourceInstanceId:UUID,targetInstanceId:UUID,volumeL:number,connectionId:UUID}`; envelope targets source |
| `START_STIRRER` | `{enabled:boolean,frequencyHz:number}` |
| `SET_PROBE` | `{containerInstanceId:UUID\|null}` |
| `RESET` | `{scope:'STATION'\|'SCENE'}`; station inferred from envelope target |
| `CUSTOM` | `{pluginId:string,actionType:string,data:JsonObject}`; runtime must reject unregistered/unsupported plugins |

Agreed runtime semantics, **to be implemented after contract review**:

- `FILL` explicitly replaces preparation state only in `PREPARING`, recording its source; it is rejected while running or paused. Preparation is never an invisible mass source. Initial contents are also explicitly captured in `initialScene`.
- Internal movement uses one atomic `TRANSFER`, conserving source/receiver volume and component moles. Empty/capacity/graph/phase checks happen before any write. Renderers, solvers and plugins never mutate inventory.
- Action IDs are scoped to the entire run, including resets. An identical retry returns its original receipt and appends no event; conflicting reuse is `ACTION_ID_CONFLICT`. Idempotency lookup precedes stale-time/revision checks.
- Events have contiguous, monotonically increasing sequence numbers. `RESET` restores initial scene/station state and controls, increments affected station epochs, and resets their clocks/current delivery tallies; it **does not truncate** events, receipts or historical observations. Runtime revision remains monotonic.
- Pause/resume/speed are typed `RuntimeControl` commands with independent control IDs. `ADVANCE` specifies integer fixed ticks for one station; display speed cannot change chemistry per tick. Editor undo is not physical time reversal.

## Apparatus, solver and observer seams

Full exact declarations are in `lab/apparatus.ts`, `lab/science.ts` and `lab/runtime.ts`.

- `ApparatusDefinition` declares local-meter dimensions/bounds, permitted translation/rotation axes, capabilities, typed config/control descriptors, sockets, capacity, optional calibration/flow/asset provenance. No definition registry is included.
- `SocketDefinition` declares local transform, connection kind, `IN | OUT | BIDIRECTIONAL`, gender, key/tag/kind/capability compatibility, connection cap and optional highlight/alignment anchors. Runtime topology/plugin support is separate from shape validation.
- `VesselCalibration` includes interior `{yM,radiusM}` profile and an explicit monotonic `{volumeL,heightM}` curve covering zero through declared capacity; graduation direction/reading and meniscus are separate. Visual calibration consumes inventory; it never creates inventory.
- `EquilibriumSolver = (input:EquilibriumInput) => EquilibriumResult`; `AsyncEquilibriumSolver = (input:EquilibriumInput) => Promise<EquilibriumResult>`. Input is `{contents,methodId,assumptions,indicatorIds?}`. `PreparationInput/Result` are the reagent-to-analytical-inventory boundary owned by Agent 06.
- `LabRuntimeReader.getSnapshot():RuntimeSnapshot`; `subscribe(listener:(snapshot,event)=>void):()=>void`. `LabActionAdapter.dispatch(action):Promise<ActionReceipt>`; `control(command):Promise<ControlReceipt>`. `LabRuntimeAdapter` exposes `{reader,actions}` separately. Snapshots and observations are readonly.
- `ObservationRecord` adds immutable UUID/run/station/epoch/sequence identity around `Observation`. Optional `Observation.titration:{sourceInstanceId,receiverInstanceId,deliveredVolumeL}` is stamped only from cumulative accepted transfers for that pair in that epoch. If association is unavailable, omit it; do not infer delivered volume from receiver total volume.
- `ExperimentPlugin` checks model support and requests solver inputs. `ApparatusCapabilityPlugin` validates/proposes actions only; the eventual authoritative runtime remains the sole inventory writer.

### Reviewed 1.1.0 additions

Agent 09 and Agent 10 approved two additive authority/attribution fixes. `INDICATOR` observations may contain `indicatorState:IndicatorResult`, copying Agent 06's exact fractions, color, source IDs and `ILLUSTRATIVE` color evidence. Outer indicator ID, fraction (`unit:'1'`) and source IDs must match. Other observation types reject this field; old indicator observations remain valid.

`RuntimeSolverRequest={apparatusId:UUID,input:EquilibriumInput}` and optional `ExperimentPlugin.getSolverRequests(snapshot,stationId)` bind outputs explicitly to a vessel. Runtime uses this method exclusively when present, validates same-station container ownership and equality with authoritative contents, and permits copied-but-equal contents. Legacy `getSolverInputs` requires an unambiguous authoritative-container association; otherwise calculation is explicitly unsupported. These checks never change the Agent-06-owned pure solver API.

## Persistence and Node replay

```ts
NodeRunRequest = {
  schemaVersion:1; runId:UUID; contractVersion:string;
  runtimeVersion:string; methodVersion:string; initialScene:ExperimentScene;
  steps:readonly ReplayStep[]; limits?:RunLimits;
}
ReplayStep =
  | {kind:'ACTION'; action:LabAction}
  | {kind:'ADVANCE'; stationId:UUID; ticks:number}
  | {kind:'CONTROL'; control:RuntimeControl}
NodeRunResponse = {
  schemaVersion:1; result:TerminalRunResult; checkpoint?:RuntimeCheckpoint;
}
NodeRunExecutor = (request:NodeRunRequest) => Promise<NodeRunResponse>
```

Hash: lowercase SHA-256 of RFC 8785/JCS UTF-8 request bytes with **only root `runId` removed**. Keys are emitted in UTF-16 lexicographic order (including integer-like keys), arrays keep their order, numbers use ECMAScript JSON serialization. Explicit limits, initial conditions, catalog keys, ordered steps and all version pins participate. `hashNodeRunInput` uses browser/Node WebCrypto. Agent 09 agreed to Python `rfc8785` rather than divergent `json.dumps` hashing.

`RuntimeCheckpoint` preserves `{schemaVersion,contractVersion,runtimeVersion,methodVersion,inputHash,initialScene,snapshot,steps,completedStepCount,limits?,events}`. `steps` is the full frozen input; `completedStepCount` identifies its executed prefix. A browser checkpoint records completed commands, so its count equals its step length. `snapshot` includes separate runtime revision, station clocks/epochs, controls, current source/receiver `transferTotals`, immutable observation ledger and last sequence. Events retain receipts for reconstructing dedupe indexes after restore.

Agent 09's scene resource stores `runtimeCheckpoint` as a sidecar, not a competing scene type. Saving a post-transfer scene plus its original steps must **not** cause those steps to be applied again to that final inventory. Enqueue freezes `checkpoint.initialScene + checkpoint.steps + new request steps`; without a checkpoint, it freezes the saved scene. Server runs recompute observations; client checkpoint observations are untrusted drafts. REST run-create `expectedRevision` means the durable saved scene revision, unlike `LabAction.expectedRevision`.

Approved path adaptation, not yet implemented: pure runtime in `packages/lab-runtime`, browser/React/Zustand/worker adapter in `apps/web/src/lab/experiments`, one Agent-06-owned `packages/lab-science` solver. Planned package-local Vite SSR runtime build emits `dist/cli.mjs`: one bounded stdin JSON request and one stdout JSON response, diagnostic text only on stderr. Domain failures use terminal `FAILED`/`UNSUPPORTED`; process/parse failure is nonzero and never success; backend cancellation terminates only its owned subprocess and records `CANCELLED`. Exact runtime process implementation/build script awaits review and the next milestone.

## Package-local validation

From the isolated worktree, run `.\env.ps1 -Quiet` before Node/npm:

```powershell
npm run schema:export --workspace @matterlab/contracts
npm run typecheck --workspace @matterlab/contracts
npm run test --workspace @matterlab/contracts
npm run build --workspace @matterlab/contracts
```

Tests cover malformed/non-JSON inputs, typed actions, two-station round trips, calibration/config errors, scientific failure shapes, checkpoint ledger loss and canonical hashing. Dependencies are the existing root TypeScript/Vitest tools; there are **no new external dependencies**. Agent 10/parent owns root lock/workspace-link integration and consumer manifests. No shared `node_modules` changes are required by this package's tests.

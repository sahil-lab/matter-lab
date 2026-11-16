# `apps/web/src/lab/experiments` — Agent 07: experiment graph, state & simulation runtime

Owner: **Agent 07**. This is the single authoritative writer of experiment/apparatus state
(`00_SHARED_INTEGRATION_CONTRACT.md` Section 4). Nothing outside this folder may mutate an
`ExperimentScene`, change a vessel's volume or species inventory, or compute a pH/concentration —
every other agent reads from `ExperimentEngine` or dispatches a `LabAction` into it.

```
lab/experiments/
  registry/     Apparatus definition registry + stub P0 definitions (reconciliation candidate
                for Agent 03's real instrument library).
  runtime/      The reducer, inventory ledger, flow model, simulation clock, event log,
                observation ledger and the ExperimentEngine that orchestrates them.
  plugins/      ExperimentPlugin implementations (acid-base titration, the only template in
                Agent 06's v1 scientific scope).
  testFixtures/ A test-only solver double and rig-assembly helper. Not production code.
```

Read `packages/contracts/lab/**` first — every type named below (`ExperimentScene`, `LabAction`,
`ApparatusDefinition`, `SolverClient`, `ExperimentPlugin`, `LabEventRecord`, `ExperimentSnapshot`)
is defined and documented there, jointly owned by Agent 07 and Agent 09.

## Data flow

```
LabAction ──dispatch──> reducer (pure) ──> new ExperimentScene
                                        └─> affected container ids
                                              │
                                   ExperimentPlugin.detectSupport / buildSolverRequest
                                              │
                                        SolverClient.evaluate (async, Agent 06)
                                              │
                                   ObservationLedger (stale responses rejected)
                                              │
                                   EngineEvent stream (subscribe)
```

A fixed-tick **station clock** (`clock.ts`) drives the only form of "time passing": while
`RUNNING`, each `tick()` computes `flowRate(valveOpening) * timeStepS` for every open, connected
`FLOW_SOURCE` and dispatches a synthetic `TRANSFER` with a **deterministic action id**
(`tick:<stationId>:<connectionId>:<tickIndex>`), so replaying the same tick sequence reproduces the
same ids, the same scene and the same observations. Pausing a station's clock makes `tick()` a
no-op; it never generates a `TRANSFER`.

**Interpolation**: the authoritative state only changes on whole ticks. A renderer that wants
smooth motion between two ticks (e.g. a falling meniscus) should read `getClock(stationId)` for
`timeStepS`/`simulationS` and interpolate itself between the previous and current
`containerStates`/`ApparatusInstance` snapshots it has observed — this module deliberately does not
do that interpolation itself, to keep "authoritative state" and "how it looks between frames"
separate (brief item 5; Section 4: "fixed simulation ticks for apparatus changes and smooth
interpolated display frames").

**Editor undo vs. lab time**: this engine has no "undo" of a `LabAction`. `RESET` (scene or
station) and replaying from a saved `ExperimentSnapshot` are the only ways lab state moves
backward, and both are themselves ordinary logged actions / explicit operations, not stack-based
undo. Agent 04 owns undo/redo of *editing* gestures (e.g. an in-progress `PLACE`/`MOVE` before it is
committed) using the same reversible-patch discipline as `packages/core`'s `editScene`; once an
action has been dispatched into this engine and may have triggered a conserved `TRANSFER` or a
solver call, undoing it is a new, explicit action (e.g. a future `CUSTOM` "undo last transfer"),
not a hidden pop of a history stack.

## The `LabAction` catalogue

| type | `targetInstanceId` means | payload | notes |
| --- | --- | --- | --- |
| `PLACE` | the new instance's id (minted by the caller) | `{ definitionId, stationId, transform, config? }` | rejects a reused id |
| `MOVE` | the instance to move | `{ transform }` | |
| `ATTACH` | the "from" instance | `{ socketId, toInstanceId, toSocketId }` | validated against `canSocketsConnect` + occupancy; same station only |
| `DETACH` | either endpoint (sanity-checked) | `{ connectionId }` | |
| `FILL` | the `CONTAINER` to fill | `{ volumeL, species: SpeciesAmount[], temperatureK, modelId }` | **sets absolute contents** from an external, unconserved source — see `inventory.ts` doc comment |
| `SET_VALVE` | the `FLOW_SOURCE` | `{ valveOpening }` (0..1, clamped) | requires a declared `flowModel` |
| `TRANSFER` | the source `CONTAINER` | `{ toInstanceId, volumeL }` | **the only action that moves conserved inventory**; requires an enabled `FLUID` connection between the two; clamps to available volume / receiver headroom with a `warnings` entry, never silently loses or fabricates volume |
| `START_STIRRER` | the `STIRRING` instance | `{ running, rpm }` | rpm clamped to the control's declared max |
| `SET_PROBE` | the `PH_SENSOR` instance | `{ targetApparatusId, depthM? }` | probe and target must share a station |
| `RESET` | a station id (`STATION` scope) or `''` (`SCENE` scope) | `{ scope, stationId?, clearConnections? }` | `STATION` clears chemistry, keeps the rig (equipment survives) unless `clearConnections: true`; `SCENE` wipes every station's apparatus/connections/contents |
| `CUSTOM` | subject-defined | `{ kind: 'CREATE_STATION', name }` today; anything else is logged but a no-op | the forward-compatible extension point (brief item 9) |

Every payload is parsed and validated in `runtime/actionPayloads.ts`; a malformed payload is
rejected with a specific reason, never thrown as an exception into a caller.

## Example payloads

A `PLACE` action (minted client-side, dispatched once):

```json
{
  "actionId": "8f1c2e2a-...-uuid",
  "atSimulationS": 0,
  "targetInstanceId": "flask-1b3e...",
  "type": "PLACE",
  "payload": {
    "definitionId": "flask.conical.250ml",
    "stationId": "station-1a2b...",
    "transform": { "positionM": [0.3, 0.9, 0.1], "quaternion": [0, 0, 0, 1] }
  }
}
```

The resulting append-only log entry (`LabEventRecord`, `packages/contracts/lab/events.ts`):

```json
{
  "sequence": 7,
  "action": { "...": "the LabAction above" },
  "receivedAt": "2025-01-01T12:00:00.000Z",
  "sceneRevisionBefore": 6,
  "sceneRevisionAfter": 7,
  "outcome": "APPLIED"
}
```

A synthetic tick-generated `TRANSFER` (note the deterministic `actionId`):

```json
{
  "actionId": "tick:station-1a2b...:conn-9f0e...:12",
  "atSimulationS": 1.3,
  "targetInstanceId": "burette-1",
  "type": "TRANSFER",
  "payload": { "toInstanceId": "flask-1", "volumeL": 0.0005 }
}
```

An `Observation` the solver seam produces, as recorded in the ledger (`getObservations`):

```json
{
  "type": "PH",
  "apparatusId": "flask-1",
  "timeS": 1.3,
  "quantity": { "value": 6.98, "unit": "pH" },
  "evidence": "UNVERIFIED",
  "methodId": "strong-acid-strong-base-v1",
  "sourceIds": ["test-fixture:strong-acid-strong-base-charge-balance"]
}
```

(`evidence` will read `MODEL_CALCULATED` once Agent 06's real solver is wired in, in place of
`testFixtures/fakeSolverClient.ts`.)

## Integration points

- **Agent 03** (apparatus): reconcile `registry/verticalSliceDefinitions.ts` field-for-field with
  the real `ApparatusDefinition`s. Keep the same `id`s where the shape matches so already-saved
  scenes do not need a migration. Every stub is marked `isPlaceholder: true`.
- **Agent 04** (editor): dispatch user gestures via `runtime/actions.ts`'s builders
  (`buildPlaceAction`, `buildAttachAction`, ...) into `ExperimentEngine.dispatch`. Use
  `getStationSupport(stationId)` to show "unsupported" states, and `canSocketsConnect` (re-exported
  from `@matterlab/contracts`) for live drag/hover feedback — it is the exact same check
  `ATTACH` is validated against, so "shows valid" and "actually accepts" cannot drift apart.
- **Agent 05** (fluid/glass visuals): read `engine.getScene().containerStates` and
  `engine.getClock(stationId)` only; never write. Interpolate between ticks yourself (see above).
- **Agent 06** (chemistry): implement `SolverClient` (`packages/contracts/lab/solver.ts`) and hand
  it to `new ExperimentEngine(scene, { registry, solver, plugins })` in place of
  `createUnavailableSolverClient()`. `species[].speciesId` values this engine ever sends you are
  whatever the `FILL` caller supplied (e.g. `"HCl"`, `"NaOH"`) — agree the exact resolved species
  vocabulary with Agent 07/09 before shipping.
- **Agent 08** (gameplay): subscribe to `engine.subscribe(listener)` for
  `ACTION_RECORDED`/`OBSERVATION_RECORDED`/`SOLVER_REQUEST_FAILED` events to drive scoring/goals
  without re-deriving state.
- **Agent 09** (persistence): `engine.createSnapshot()` returns a JSON-serialisable
  `EngineSnapshot` (`runtime/snapshot.ts`) — verified round-trippable through `JSON.stringify` /
  `JSON.parse` in `engine.test.ts`. `ExperimentEngine.replay(snapshot, deps)` reopens it. Persist the
  whole snapshot; do not try to reconstruct it from `scene` alone (replay needs `baseScene` + the
  full `events` array).
- **Agent 10** (integration/QA): acceptance-test coverage lives in `runtime/engine.test.ts`; run
  `npm run typecheck` and `npx vitest run --project web apps/web/src/lab/experiments` from the repo
  root.

## Known stubs / reconciliation flags

- `registry/verticalSliceDefinitions.ts` is Agent 07's best-effort reconstruction of Agent 03's
  brief, not Agent 03's actual shipped definitions.
- `testFixtures/fakeSolverClient.ts` is a non-production strong-acid/strong-base solver double
  (evidence `UNVERIFIED`), used only by this package's own tests. Production wiring must use
  `createUnavailableSolverClient()` until Agent 06's real client is reconciled in — it always
  reports `UNSUPPORTED` rather than fabricating a result.
- Only one `ExperimentPlugin` (acid-base titration) exists; buffer/conductivity/calorimetry
  templates are future work per Agent 06's v1 scientific scope.
- Reagent bottles are not modelled as finite, depletable containers in P0 — `FILL` is the
  explicit, declared-unconserved "poured from an external source" action; only `TRANSFER` between
  two already-filled vessels conserves (see `inventory.ts`'s doc comment).

# MATTER LAB — Shared Integration Contract (READ FIRST)

**Applies to all ten agents.** Version 1.0. This extension adds an Awwwards-caliber 3D laboratory and modular experiment/game engine to the existing MATTER LAB v1 application. It must **reuse** the existing atom/molecule editor, scientific calculation pipeline, backend and data models where appropriate. Agents may propose changes to these contracts, but Agent 10 integrates only versioned, reviewed changes approved by Agent 9 for persistence and Agent 7 for simulation semantics.

## 1. Mission and non-negotiable principles

- Build a **working** immersive lab: arbitrary apparatus arrangements (subject to runtime limits), functional connections, real interactive instruments, safe supported experiments, and scientifically meaningful outputs. No static showroom, landing-page-only build, or scripted pH animation.
- Design bar: distinctive **Awwwards-level** art direction, editorial typography, polished motion, premium PBR glass, restrained effects; **do not copy another site's assets or identity**.
- Scientific truth: clearly label outputs `REFERENCE_MEASURED`, `MODEL_CALCULATED`, `ILLUSTRATIVE`, `UNVERIFIED`, or `UNSUPPORTED`. Visual effects are not evidence. Never infer products for arbitrary mixes unless an appropriate validated model exists.
- Safe scope: educational acid/base titration, buffer, dilution, solubility, conductivity and simple calorimetry where models are validated. Do not create unrestricted operational instructions/simulators for dangerous chemical, pharmaceutical, or nuclear processes.
- Responsiveness: all input/camera/drag operations remain interactive during calculations, autosave and asset streaming. Provide reduced-motion and keyboard-supported non-3D alternatives.

## 2. Repo and ownership (adapt paths to real repo before writing)

```text
apps/web/src/
  design-system/           Agent 01: tokens, typography, UI shells, interactions
  lab/environment/         Agent 02: 3D room/benches/cameras/lighting
  lab/apparatus/           Agent 03: apparatus definitions/assets/sockets
  lab/editor/              Agent 04: placement, selection, snapping, undo/redo
  lab/fluids/              Agent 05: glass/liquid/droplet visuals
  lab/experiments/         Agent 07: experiment graph, event simulation, controls
  lab/challenges/          Agent 08: guided/challenge/free modes, UI
  scientific/              Agent 06: chemistry client and scientific displays
services/science/          Agent 06: titration solver and benchmarks
apps/api/                  Agent 09: APIs, auth, persistence, export
packages/contracts/        Agent 07 + 09 jointly, reviewed by Agent 10
infra/                     Agent 09 + 10: dev environment / release
qa/ and benchmarks/        Agent 10: E2E, visuals, performance, integration
```

Do not silently replace a shared module. Integrate via PRs/branches/worktrees, with Agent 10 owning final merge verification.

## 3. Shared domain model (canonical proposal)

All IDs are stable UUID strings; all timestamps UTC ISO 8601; all numeric quantities carry units at API boundaries. Scene coordinates are in **meters**; chemical volume in **liters** and concentration in **mol/L**; temperature in **kelvin**; time in **seconds**. Never use a pixel or world-unit measurement as a chemical unit. Instrument geometry is visual and calibrated separately.

```ts
type UUID = string;
type Evidence = 'REFERENCE_MEASURED'|'MODEL_CALCULATED'|'ILLUSTRATIVE'|'UNVERIFIED'|'UNSUPPORTED';
type Quantity = { value: number; unit: string; uncertainty?: number };
type Transform = { positionM:[number,number,number]; quaternion:[number,number,number,number] };
type ApparatusKind = 'BENCH'|'STAND'|'CLAMP'|'BURETTE'|'FLASK'|'BEAKER'|'PIPETTE'|'STIRRER'|'PH_PROBE'|'BALANCE'|'OTHER';
type Capability = 'CONTAINER'|'FLOW_SOURCE'|'FLOW_RECEIVER'|'MOUNT'|'MOUNTABLE'|'HEATING'|'STIRRING'|'PH_SENSOR'|'MEASUREMENT';
type ApparatusInstance = { id:UUID; kind:ApparatusKind; definitionId:string; transform:Transform;
  revision:number; config:Record<string,unknown>; capabilities:Capability[]; stationId:UUID };
type Connection = { id:UUID; from:{instanceId:UUID; socketId:string}; to:{instanceId:UUID; socketId:string};
  kind:'MECHANICAL'|'FLUID'|'SENSOR'|'CONTROL'; enabled:boolean };
type SpeciesAmount = { speciesId:string; moles:number; sourceId?:string };
type ContainerContents = { volumeL:number; species:SpeciesAmount[]; temperatureK:number; mixing:'WELL_MIXED'|'UNMIXED'; modelId:string };
type ExperimentScene = { id:UUID; revision:number; schemaVersion:1; stations:{id:UUID; name:string}[];
  apparatus:ApparatusInstance[]; connections:Connection[];
  containerStates:Record<UUID,ContainerContents>; simulationConfig:{methodId:string; timeStepS:number};
  viewport?:Record<string,unknown> };
type LabAction = { actionId:UUID; atSimulationS:number; targetInstanceId:UUID;
  type:'PLACE'|'MOVE'|'ATTACH'|'DETACH'|'FILL'|'SET_VALVE'|'TRANSFER'|'START_STIRRER'|'SET_PROBE'|'RESET'|'CUSTOM';
  payload:Record<string,unknown>; actorId?:UUID };
type Observation = { type:'PH'|'TEMPERATURE'|'VOLUME'|'CONCENTRATION'|'INDICATOR'|'MASS';
  apparatusId?:UUID; timeS:number; quantity:Quantity; evidence:Evidence; methodId:string; sourceIds:string[] };
type RunResult = {runId:UUID; status:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'UNSUPPORTED';
  methodId:string; methodVersion:string; inputHash:string; observations:Observation[];
  warnings:string[]; assumptions:string[]; solverDiagnostics?:Record<string,unknown>};
```

For strong/weak acid-base chemistry, `speciesId` must use resolved chemical species and conditions. Avoid mixing visual reagent names with chemical speciation. Do not assume all substances are supported or harmless.

## 4. Simulation authority and data flow

**User action → Editor validates interaction → Agent 7 authoritative apparatus reducer → Agent 6 chemistry solver (only when required) → Observation ledger → Agent 5 visuals + Agent 8 goals + Agent 1 UI + Agent 9 persistence.** No other agent may independently invent a pH value or change species inventory. Agent 7 is single writer for local experiment state; Agent 9 owns persistence and versioned snapshots. Agent 10 owns integration checks.

- Apparatus definitions expose sockets, capacities, capabilities, control actions, dimensions, load behavior, validation rules and serialization schema (Agent 3).
- `TRANSFER` is the only event that changes conserved liquid inventory. Each accepted transfer updates source and receiver atomically; volume/species moles must be conserved within declared numerical tolerance, except explicitly modeled losses.
- The chemistry solver is a pure, deterministic function of **validated** chemical state + method/conditions, with result provenance and errors. No UI component calculates authoritative pH independently.
- Fluid rendering interpolates state and never writes back simulated chemical inventories.
- A custom apparatus graph is accepted only if connections are compatible and the requested model supports the configured experiment. Otherwise show unsupported conditions clearly.
- Use fixed simulation ticks for apparatus changes and smooth interpolated display frames. Timestamp, sequence and idempotency must prevent duplicate actions when reconnecting.

## 5. Core API / events (Agent 9 implements; Agent 7 validates payloads)

```text
GET    /api/v1/lab/equipment-definitions
GET    /api/v1/lab/scenes/{id}
POST   /api/v1/lab/scenes
PATCH  /api/v1/lab/scenes/{id}            (If-Match revision required)
POST   /api/v1/lab/scenes/{id}/duplicate
POST   /api/v1/lab/scenes/{id}/runs       (202 + runId)
GET    /api/v1/lab/runs/{runId}
GET    /api/v1/lab/runs/{runId}/events    (SSE progress)
POST   /api/v1/lab/runs/{runId}/cancel
GET    /api/v1/lab/runs/{runId}/observations
GET    /api/v1/lab/scenes/{id}/export?format=xlsx|json
POST   /api/v1/lab/templates
GET    /api/v1/lab/templates
```

API errors use RFC 9457 Problem Details with stable error codes; unsupported calculations are explicit `UNSUPPORTED` results, not HTTP 200 with fake values. Do not expose unvalidated chemistry jobs as unrestricted automated lab protocols.

## 6. First shared end-to-end vertical slice

1. Place `BENCH`, `STAND`, `CLAMP`, `BURETTE`, `FLASK`, optionally `STIRRER` and `PH_PROBE` in the 3D environment.
2. Snap clamp to stand; attach burette; align receiving flask. Show valid/invalid socket feedback.
3. Configure a 25.00 mL, 0.100 mol/L HCl aliquot in flask and 0.100 mol/L NaOH titrant in burette (virtual educational chemicals).
4. Open stopcock; run precisely metered transfers at variable flow; show drops, meniscus and matching readout.
5. Update receiver inventory; calculate pH using strong acid/base equilibrium with water dissociation and appropriate finite-volume assumptions; plot pH vs delivered mL.
6. Reach theoretical equivalence at 25.00 mL and pH approximately 7 at 25°C under the specified ideal model. Visually identify endpoint separately from equivalence point.
7. Pause, resume, reset, save, reopen and replay; create and independently run a second station.
8. Show an explanation panel with method, units, assumptions, limitations, provenance and any uncertainty.

**No fake scientific trajectories, no hardcoded pH curve, no number generated by a shader.**

## 7. Quality gates / review

- Baseline: working scene + scene editing. Scientific gate: representative acid-base cases, mass/charge/volume conservation, validated units, repeatability and solver diagnostics.
- Visual gate: polished at 1920x1080 and 1366x768; keyboard focus, reduced motion, readable labels; transparent-glass depth sorting assessed visually.
- Interaction gate: place, snap, rotate, reparent, connect, operate, undo/redo, save/open and two independent stations.
- Performance gate: target stable 60 FPS in ordinary scenes; measure actual frame times/draw calls/memory on target hardware. Never promise unmeasured FPS.
- Operational gate: isolated scientific workers, meaningful error/empty/offline states, no shared schema drift, automated CI and documented start commands.

## 8. Sequence and collaboration

**Phase A:** Agent 1 tokens/layout; Agent 2 environment shell; Agent 3 apparatus definitions; Agent 6 solver contract; Agent 7 reducer/event contract; Agent 9 data/API schemas; Agent 10 CI/benchmark harness.

**Phase B:** Agent 4 placement/connect; Agent 5 liquid renderer; Agent 8 tutorials/challenges; integrate through Agent 10.

**Phase C:** Complete titration vertical slice; cross-team QA; then multi-station, custom templates, advanced art direction and additional bounded experiments.

Status report from each agent: `implemented files`, `tests run + results`, `interfaces changed`, `integration blockers`, `remaining work`, `screenshots or logs`.

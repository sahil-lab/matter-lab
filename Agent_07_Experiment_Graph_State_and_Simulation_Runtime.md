# MATTER LAB — AGENT 07: EXPERIMENT GRAPH, STATE AND SIMULATION RUNTIME

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 07 — Experiment Graph Engineer**. Build the authoritative runtime that lets users arrange any number of apparatus instances into custom stations and simulate **supported** experiments. You own state transitions and inventory conservation—not shaders or chemistry formulas.

## Owned surfaces
`apps/web/src/lab/experiments/**`, `packages/contracts/lab/**` jointly with Agent 09, simulation reducer, experiment graph, apparatus capability runtime, event log, transfer/instrument protocols, station management, replay and reset.

## Required implementation
1. Represent an experiment as a graph of versioned apparatus nodes and compatible socket connections, with multiple independent station IDs and reusable assemblies.
2. Build a plugin-based apparatus capability registry: `CONTAINER`, `FLOW_SOURCE`, `FLOW_RECEIVER`, `MOUNT`, `MOUNTABLE`, `PH_SENSOR`, `STIRRING`, etc. Definitions and sockets come from Agent 03; validate capabilities and connection topology.
3. Implement deterministic typed `LabAction` processing: `PLACE`, `MOVE`, `ATTACH`, `DETACH`, `FILL`, `SET_VALVE`, `TRANSFER`, `START_STIRRER`, `SET_PROBE`, `RESET`; maintain append-only event log and versioned snapshots.
4. Use one authoritative inventory ledger for each vessel. Transfer volume and species moles with conservation rules. No one else may independently increment burette or flask volumes.
5. Implement configurable fixed simulation ticks and render interpolation. Flow rate may be a validated simple model with declared assumptions; map valve opening to flow under an explicit supported model. Avoid claiming detailed fluid hydrodynamics.
6. Recompute scientific observations by invoking Agent 06 solver when relevant state changes. Sensor models read solver results, not ambient invented readings. Publish event stream for graph, indicator, 3D renderer, UI and Agent 08 challenges.
7. Support pause, resume, replay, simulation speed, reset, independent stations, duplicating a setup and scene serialization. Distinguish editor undo from lab time reversal.
8. Declare model support per experiment template; when unsupported equipment combinations are assembled, permit editing but label calculations unsupported.
9. Define a `ExperimentPlugin` contract so validated future buffer/calorimetry/conductivity templates can be introduced without hardcoding all setups.

## Integration interfaces
- Agent 03 provides apparatus definitions; Agent 04 dispatches edit/operation actions; Agent 05 draws from authoritative state; Agent 06 returns scientific quantities; Agent 08 consumes action/observation events; Agent 09 persists snapshots and immutable run logs.
- Coordinate schema changes with Agent 09; publish full event payload examples to all agents.

## Acceptance tests
- Full titration action chain: fill, open valve, meter transfer, compute pH, update sensor and plot. Every component receives the *same* data.
- Source volume decrease == receiver volume increase (within declared tolerance), and transferred species molar inventory conserves exactly within numerical tolerance.
- Pausing suspends transfer; replay produces identical observations; duplicate commands with same ID are idempotent.
- Two stations can run independently, and a saved scene reopens without losing connection graph or contents.
- Invalid attachments and unsupported calculation paths fail transparently without corrupting scene state.

## Deliverables
Graph runtime, reducer/event definitions, apparatus plugin contract, test fixtures, deterministic replay tests, integration examples and handoff to Agent 10.

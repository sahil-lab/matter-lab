# @matterlab/contracts

Shared types for the MATTER LAB Astra 3D-laboratory expansion
(`00_SHARED_INTEGRATION_CONTRACT.md`). This package holds **only types, string/number
constants and tiny pure helpers** — no apparatus meshes, no reducer logic, no chemistry. Everything
here is safe for every one of the ten agents' packages to depend on without pulling in the web app,
Three.js or the Python service.

Owned jointly by **Agent 07** (experiment graph / simulation semantics) and **Agent 09**
(persistence). Changes here are contract changes: coordinate them with both before editing a shape
that other agents already code against.

## Layout

```
lab/
  types.ts        Section 3 domain model, reproduced verbatim: UUID, Evidence, Quantity, Transform,
                   ApparatusKind, Capability, ApparatusInstance, Connection, SpeciesAmount,
                   ContainerContents, ExperimentScene, LabAction, Observation, RunResult.
  apparatus.ts     ApparatusDefinition / Socket contract (Agent 03 authors instances of this shape;
                   Agent 07 validates connection topology against it).
  solver.ts        SolverClient contract: the one typed seam between Agent 07 (apparatus/inventory
                   state) and Agent 06 (chemistry). Agent 07 never computes pH; it only calls this.
  events.ts        Append-only event log record and versioned snapshot shapes for Agent 09 persistence.
  plugin.ts        ExperimentPlugin contract so new experiment templates (buffer, conductivity,
                   calorimetry, ...) can declare model support without hardcoding into the reducer.
  constants.ts     Shared numeric tolerances and schema version numbers referenced by name elsewhere
                   (so "the conservation tolerance" is one number, not one per agent).
```

## Status

This is the **canonical starting point** agreed in `00_SHARED_INTEGRATION_CONTRACT.md` Section 3-5,
written by Agent 07 while Agent 03 (apparatus), Agent 06 (chemistry) and Agent 09 (persistence) were
developing on sibling branches and unavailable to import directly. Everything in `apparatus.ts` and
`solver.ts` is therefore a **reconciliation candidate**: it defines the shape Agent 07's reducer
needs and tests against, but the human orchestrator must diff it against Agent 03's and Agent 06's
actual delivered contracts and merge field-for-field, not replace wholesale (both sides may have
independently added compatible optional fields).

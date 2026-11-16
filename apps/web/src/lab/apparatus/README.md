# Apparatus registry and calibrated geometry

The original Agent 03 failed before writing files. The orchestrator is implementing this
ownership directly, using the reviewed `@matterlab/contracts` version 1.1.0.

## Pure runtime/backend entry points

`registry.ts` has no React, Three.js or browser imports:

- `APPARATUS_DEFINITIONS`: validated, frozen definitions for the P0/P1 equipment.
- `apparatusRegistry`: the canonical `ApparatusDefinitionReader`, exposing
  `getDefinition(id)` and `listDefinitions()`.
- `ApparatusRegistry`: validates extensions and refuses replacement of an existing ID.
- `APPARATUS_CATALOG_VERSION`: version of the original definitions.
- `LINEAR_FLOW_METHOD_ID`: `flow:linear-valve-v1`, an explicitly simplified metered-flow model.

`seeds.ts` exports `createTitrationSetup(methodId, createId?)`, returning `{scene, ids}`.
The caller supplies the actual scientific method ID. It creates an **unfilled** assembled
titration station and a separate blank workbench; it creates no pH, indicator results,
observations or chemical inventory. Preparation uses Agent 06's real preparation function
and Agent 07's recorded `FILL` actions.

The seed contains stand-to-clamp, clamp-to-burette, stirrer-to-flask, stir control and
burette-to-flask connections. The probe starts on the bench, not falsely immersed or connected.
All IDs are generated once and survive serialization. Tests can inject a deterministic UUID factory.

## Coordinate and calibration policy

Coordinates are meters. Bench geometry delegates to the environment's `Workbench` exactly once:
2.4 m wide, 1.05 m deep, tabletop at 0.9 m, floor pivot at zero. Other assets are rendered inside
their instance transform. Clamp and support-ring pivots are their pole attachment, not their
bounding-box center.

Vessel interiors are original piecewise-conical profiles. `profileVolumeL` integrates their
actual geometry, converting cubic meters to liters. `createVesselCalibration` scales that
profile to the nominal capacity and records a monotonic volume-to-height curve. It is a visual
model, not manufacturer-certified glassware. Films, thermal expansion and outlet dead volume
are explicitly omitted. Only upright liquid calibration is defined.

The burette has a 50 mL calibrated barrel from local Y=0.10 to 0.54 m. Its graduations descend:
40 mL remaining and 10 mL delivered designate the same meniscus. The nominal maximum flow is
1 mL/s; opening fraction scales it linearly. This is not a claim to model pressure-head dynamics.

## Verification and remaining integration

Five focused tests pass for physical interior volume, the 10 mL burette mark, invalid profiles,
registration and the two-station connection/serialization fixture. Web typechecking passes.
These checks do not certify GPU rendering or operation through the final editor.

The registry is usable by the authoritative runtime and backend now. Procedural meshes and
their measured geometry/resource metadata are the next part of this recovery; no unfinished
mesh is claimed as a completed asset. Unsupported conductivity, heating or other instrument
models must remain explicit rather than acquiring fabricated readouts.

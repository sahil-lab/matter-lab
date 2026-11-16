# MATTER LAB — AGENT 03: APPARATUS ASSETS AND CAPABILITY DEFINITIONS

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 03 — Apparatus Modeling Engineer**. Create the reusable, physically scaled, functional instrument library for arbitrary user-built laboratory setups. An apparatus is both a rendered 3D object and a typed scientific capability—not a decorative prop.

## Owned surfaces
`apps/web/src/lab/apparatus/**`, apparatus definition registry, sockets/capabilities, asset manifests, optimized glTF/GLB assets, procedural geometry where useful. Jointly own schema proposals with Agent 07; Agent 07 approves simulation semantics.

## Required equipment
**P0 vertical slice:** workbench, retort stand, burette clamp, graduated burette with stopcock and meniscus reference, conical flask, reagent bottle, magnetic stirrer and optional pH probe.
**P1 library:** beakers, test tubes, volumetric flasks, pipettes, droppers, graduates, funnels, support rings, lab jack, thermometer, conductivity meter, balance, temperature sensor. P2 may add spectrophotometer and safe extension slots.

## Required implementation
1. Define an `ApparatusDefinition` for each instrument: stable type ID, display label, category, capabilities, permitted transforms, real-world dimensions in meters, mass/visual metadata, sockets, collision bounds, capacity, operation controls, compatibility rules and serializable config.
2. Define sockets as local transforms with connection types (mechanical/fluid/sensor/control), gender/compatibility or matching rule, safety/geometry checks and highlight anchors. Example: burette clamp socket accepts a compatible burette barrel; stand pole accepts clamp.
3. Build beautiful photorealistic-but-performant 3D models with correct graduated glass marks, practical scale, clean pivots, appropriate material splits and transparency-friendly meshes.
4. Expose actionable controls (`SET_VALVE` range 0..1, `FILL`, `START_STIRRER`, probe position) with declared ranges. Agent 07 receives actions; this agent must not independently update inventory or pH.
5. Supply metadata for palette thumbnails, previews, inspector forms, focus points and guided-mode highlights.
6. Implement an asset loading registry supporting future plugins (new definitions, sockets, mesh references, config schema, constraints) without modifying editor core.
7. Validate versioned asset metadata and offer a procedural placeholder only when necessary, visibly marked as incomplete for development—not a shipping feature.

## Collaboration
Agent 02 owns environmental lighting and coordinate space; Agent 04 owns drag/snap and object graph mutations; Agent 05 owns glass/liquid shaders; Agent 07 owns behavior and state; Agent 09 persists definitions/instances. Provide formal capability fixtures for all teams.

## Acceptance tests
- Users can assemble stand → clamp → burette and place a flask beneath; invalid socket pair rejects attachment with clear reason.
- Burette capacity and markings support the visual liquid level readout (volumes from simulation engine).
- Materials look premium from close-up and mid-distance without mis-sorted glass artifacts.
- All instruments serialize, deserialize and preserve functional sockets and configuration.
- Asset bundles have documented poly count, texture memory and licensing/provenance.

## Deliverables
Reusable models/definitions, socket compatibility matrix, assets/attributions, component demos, automated metadata tests, handoff samples.

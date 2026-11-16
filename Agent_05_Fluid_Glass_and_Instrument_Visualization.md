# MATTER LAB — AGENT 05: FLUID, GLASS AND INSTRUMENT VISUALIZATION

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 05 — Fluid and Visualization Engineer**. Own the photorealistic, performant look of apparatus glass, liquids, droplets, pouring, stirring and instrument feedback. Your visuals must track authoritative state—not invent chemistry.

## Owned surfaces
`apps/web/src/lab/fluids/**`: PBR glass materials, fluid surfaces, fill-level geometry, droplet emitter, meniscus shader, mixing appearance, indicator-color interpolation, instrument display adapters, related TSL/WebGPU/WebGL render paths.

## Required implementation
1. Create beautiful, physically credible glass materials for burettes, conical flasks, beakers and reagent bottles. Verify transmission, thickness, reflection/refraction, render ordering and depth interactions with dark backgrounds and colored liquids.
2. Render liquid volume precisely from `ContainerContents.volumeL` and each vessel's calibrated capacity/geometry. A changing meniscus level must agree with the textual burette reading and remaining volume.
3. Render a visually convincing stopcock-to-flask drip stream with variable drop frequency/size derived from Agent 07 flow events. Respect pauses and resets; never drip when authoritative flow is zero.
4. Implement cheap procedural mixing, surface oscillation, swirling and magnetic stirring visual effects; keep expensive fluid dynamics optional. Clearly decouple decorative fluid motion from conservation of volume and moles.
5. Support indicator colors derived from the scientific species/indicator state issued by Agent 06/07; smooth visual transitions when appropriate but do not fake a threshold pH.
6. Implement readable markings, volumes, probe state and sensor overlays; keep their displayed quantities bound to shared Observation data.
7. Offer adaptive quality settings, low-power GPU mode, shader compile fallbacks, reduced-motion support and resource release on scene teardown.
8. Develop regression scenes for clear/colorless liquid, tinted liquid, near-empty/full burette, multiple transparent vessels, swirling and endpoint transitions.

## Interfaces
- Read `ExperimentScene`, container states and timed transfer event stream from Agent 07; read validated indicator/pH and instrument observations from Agent 06.
- Use Agent 03 vessel shape metadata and Agent 02 scene/lighting setup; do not own apparatus geometry transforms.
- Agent 10 owns performance budget and platform comparison; provide shader and render metrics.

## Acceptance tests
- At 10 mL delivered, burette remaining volume and visible meniscus agree within graphical resolution; source+receiver volumes agree with solver state.
- Droplet count and flow behavior visually track 0 flow and several valve openings; pause/reset produce no ghost droplets.
- Strong acid/base titration near endpoint shows chemistry-driven indicator change and synced curve values.
- Transparency remains legible from close, mid and rotating viewpoints without severe sorting failure; integrated-GPU fallback exists.
- Supply real running screenshots (not pre-rendered concept shots) and GPU timing comparisons.

## Deliverables
Working visuals and adapters, shaders/material docs, test scenes, fallback path, benchmark data and notes for Agents 02/07/10.

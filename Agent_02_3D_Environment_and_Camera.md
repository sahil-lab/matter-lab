# MATTER LAB — AGENT 02: 3D ENVIRONMENT AND CAMERA

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 02 — 3D Environment Engineer**. Own the immersive, optimally rendered environment in which the laboratory actually operates. Make a remarkable Awwwards-level space while prioritizing precise experiment placement and smooth navigation.

## Owned surfaces
`apps/web/src/lab/environment/**`: `LabWorld`, `Workbench`, `EnvironmentLighting`, `CameraDirector`, `CameraModes`, `ViewportGrid`, `RoomConfig`, `SceneQuality`, `SceneResourceManager`. Coordinate scene-level APIs with Agents 03–05 and 10.

## Required implementation
1. Build two modes sharing the same apparatus state: a premium furnished laboratory room and a clean infinite workbench/studio space. Both must support multiple independently identifiable workstations.
2. Implement orbit, first-person, orthographic top-down, inspection camera, focus/fit and camera bookmarks; precise navigation controls and predictable smoothing. Pause camera controls when Agent 04 captures pointer for an apparatus drag.
3. Expose stable world coordinate and placement surfaces, with meters as canonical units and a clear scene scale. A flat tabletop must be collidable/selectable, with stable heights for stands, flasks and clamps.
4. Implement high-quality PBR illumination, HDR environment maps with appropriate licensing, soft contact shadow strategy, subtle reflections and restrained postprocessing. Make glass readable against dark environments without unrealistic levels of glow.
5. Support multi-station isolation, room/workbench presets, stationary camera anchors and camera movement between stations.
6. Build scene LOD, shadow-quality presets, adaptive resolution hooks, GPU resource lifecycle cleanup, visibility culling where appropriate, on-demand loading of assets and optional cinematic mode.
7. Define environment serialization (layout, bench transforms, view settings, lighting preset); **do not serialize simulation truth into render-only components**.
8. Make cinematic first-run camera traversal skippable; respect reduced-motion and focus accessibility.

## Interfaces to other agents
- Agent 03 supplies apparatus bounding volumes, snap sockets, optimized glTF content and required scene metrics.
- Agent 04 owns interactions, translation/rotation transforms and selection; you provide camera and coordinate conversion services.
- Agent 05 owns fluid and glass material specifics, but you provide lighting/reflection test rigs.
- Agent 10 measures actual frame times, draw calls and memory; provide meaningful render-mode instrumentation.

## Acceptance tests
- A stand, clamp, burette and flask appear at calibrated relative sizes; camera can approach, inspect, move away and change modes without breaking control ownership.
- Multiple workbenches can exist; objects stay at consistent positions when the camera changes.
- 60 FPS is a target for ordinary scenes on a supported desktop, not an unverified promise. Deliver measured profiles.
- No broken transparency/lighting on sample vessels; no camera jumps during active dragging.
- Provide screenshots of empty lab, assembled titration station, top-down station layout, close-up of glassware, and a quality comparison.

## Deliverables
Working 3D environment, documented camera/coordinate API, scene-quality settings, profiling hooks, visual test scenes and integration notes.

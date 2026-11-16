# MATTER LAB — AGENT 04: INTERACTION AND LABORATORY EDITOR

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 04 — Interaction Engineer**. Make the laboratory as editable as a polished 3D modeling tool while keeping its interactions discoverable to beginners.

## Owned surfaces
`apps/web/src/lab/editor/**`: drag/drop, raycasting/picking, snapping, transforms, grouping, selection, cursor modes, command stack, scene editing, keyboard shortcuts, zoom-precision controls and editor state adapters.

## Required implementation
1. Drag equipment from Agent 01 apparatus browser into Agent 02 3D scene. Implement placement previews, surface snapping and collision/capacity warnings before commit.
2. Implement multi-select, transform gizmos, rotate/move, delete, duplicate, copy/paste, group/ungroup, lock/unlock, align and reset transforms, workstation grouping, context menus and shortcuts.
3. Implement robust snap/attach flow based solely on Agent 03 socket metadata and Agent 07 connection validation. Show valid sockets while hovering and explicit rejection reasons.
4. Implement operational interactions: click/drag burette stopcock, operate stirrer, place pH probe, pick pipette and pour/transfer where supported. Convert raw pointer gestures to typed `LabAction` events. Never update chemical inventory in editor state directly.
5. Separate **editing commands** (placement/transform, undoable) from **experiment events** (volume transfer, observations; reproducible replay). Treat undo/redo of a running experiment as reset/replay rather than magic inventory reversal.
6. Keep camera control and equipment editing mutually exclusive: pointer capture, explicit gesture state, touch/trackpad semantics, focus management and accessible keyboard alternatives.
7. Provide state serialization/deserialization for editor-only aspects, and optimistic scene revision handling during saves.
8. Maintain fast selection for large apparatus counts using spatial indexing, efficient raycasting and no component-wide React updates every frame.

## Collaboration
- Consume stable coordinate and camera APIs from Agent 02, sockets from Agent 03, action dispatch from Agent 07 and scene persistence from Agent 09.
- UI should use Agent 01 tokens, tooltips and cursor feedback; Agent 08 can drive guided highlights through a non-mutating tutorial API.

## Acceptance tests
- Fully assemble titration setup from empty workbench with mouse + keyboard; duplicate entire station and edit duplicate independently.
- Invalid snaps, floating unsupported placement and overlapping equipment give predictable user feedback.
- Opening the stopcock updates Agent 07 authoritative state, reflected in Agent 05 fluid views and Agent 06 pH display.
- Undo/redo and save/reopen preserve scene graph and stable IDs. Camera never rotates unexpectedly while dragging apparatus.
- 100+ object manipulation remains usable; measured times supplied to Agent 10.

## Deliverables
Editor controls, documented action dispatch contract, command history tests, accessibility interactions, screen recordings/screenshots, handoff notes.

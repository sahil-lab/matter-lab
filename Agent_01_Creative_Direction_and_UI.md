# MATTER LAB — AGENT 01: CREATIVE DIRECTION AND UI

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 01 — Creative Director / UI Engineer**. Own the Awwwards-caliber MATTER LAB design language and application-level UI. Deliver a distinctive, beautiful, usable interface around a genuinely functional 3D lab. Do not build the scene geometry, laboratory physics, or titration solver; Agents 02–07 own those.

## Owned surfaces
`apps/web/src/design-system/**`, the global app shell, top navigation, laboratory sidebars, contextual UI overlays, modal flows, onboarding entry, scientific panel presentation, responsive design tokens, motion system, typography. Work directly with Agent 02 on viewport space allocation and Agent 08 on tutorial surfaces.

## Required implementation
1. Define an original art-direction system: midnight-navy depth, warm/cool lighting contrasts, precision scientific typography, subtle glass elevation, readable scientific legends. Publish token variables for colors, spacing, typography, radii, motion and depth.
2. Build a full-screen lab shell where 75–85% of the usable area can be a 3D viewport. Provide collapsible apparatus library (left), scientific inspector (right), experiment timeline/plots (bottom), unobstructed scene interaction and immersive fullscreen.
3. Implement premium, skippable first-run cinematic entry and a no-delay returning-user entry; smooth scene transitions through a shared motion API, not DOM gimmicks.
4. Create responsive, accessible UI for equipment search, equipment detail cards, selected apparatus properties, play/pause/reset, save/duplicate, lab-mode switcher (orbit/first-person/top-down), quality presets, status and long-running job progress.
5. Design adaptable titration HUD: delivery volume, burette remaining volume, pH, indicator color legend, equivalence/endpoint status and source/evidence status. Data must come from Agent 07/06 only.
6. Create a scientific explanation panel for equations, methods, limitations, references, diagnostics, user-friendly and advanced explanation views. Never invent numbers.
7. Deliver a consistent interaction language: contextual cursor, focus ring, valid/invalid connect feedback, purposeful hover transitions, tasteful shadows and motion; include reduced-motion alternatives.
8. Provide a scene-agnostic component gallery / Storybook or equivalent with representative populated, loading, warning, unsupported, empty and error states.

## Collaboration contract
- Consume read-only `ExperimentScene`, `RunResult` and `Observation` selectors from Agent 07/09; never mutate inventories, graphs or solver state.
- Obtain apparatus thumbnails and display labels from Agent 03; obtain view mode changes via Agent 02; pointer capture and active drag status from Agent 04.
- Agent 08 owns challenge logic and progression; you style the user-facing components and expose UI slots.

## Acceptance tests
- Real app shows the full interface at 1920×1080 and 1366×768 without clipping essential controls; remains usable at 1280×800.
- Keyboard can access major actions; focus visible; reduced-motion toggles suppress nonessential camera/UI theatrics.
- No persistent overlay interferes with drag, clamp placement or burette interaction.
- No fake readouts: an unsupported simulation shows explicit unsupported status and source limitations.
- Supply screenshots from the running app, a visual regression baseline, and design-token usage examples.

## Deliverables
Working components + design tokens, design rationale, component usage docs, visual snapshots, test results, and a handoff to Agent 10. Prioritize polish of the **working titration vertical slice**, not an unrelated marketing page.

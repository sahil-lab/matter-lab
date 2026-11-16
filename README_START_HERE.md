# MATTER LAB — Astra 10-Agent Pack

This pack divides the **Awwwards-level interactive 3D laboratory builder and titration game** extension into ten actionable coding-agent briefs. It is a build extension to the existing MATTER LAB chemistry/molecular editor, not a replacement for it.

## How to use

1. Upload this ZIP into the same repository/workspace Astra can access (or extract into `docs/astra-agent-briefs/`).
2. Give Astra **only** the short text in `00_ASTRA_COMMON_PROMPT.md`.
3. Astra reads `00_SHARED_INTEGRATION_CONTRACT.md` and `REFERENCE_MATTER_LAB_v1_Technical_Specification.md` first, then dispatches the ten individual files without changing their ownership boundaries.
4. Start with shared contracts and a runnable **titration vertical slice**. Have Agent 10 perform end-to-end integration, scientific checks and visual/performance verification.
5. When adding more apparatus/experiments, enforce the same contract and mark unsupported chemistry instead of fabricating results.

## Agent assignments

| Agent | Specialty | File |
|---|---|---|
| 01 | Creative Direction and UI | `Agent_01_Creative_Direction_and_UI.md` |
| 02 | 3D Environment and Camera | `Agent_02_3D_Environment_and_Camera.md` |
| 03 | Apparatus Assets and Capability Definitions | `Agent_03_Apparatus_Assets_and_Capability_Definitions.md` |
| 04 | Interaction and Laboratory Editor | `Agent_04_Interaction_and_Laboratory_Editor.md` |
| 05 | Fluid, Glass and Instrument Visualization | `Agent_05_Fluid_Glass_and_Instrument_Visualization.md` |
| 06 | Scientific Chemistry and Titration Engine | `Agent_06_Scientific_Chemistry_and_Titration_Engine.md` |
| 07 | Experiment Graph, State and Simulation Runtime | `Agent_07_Experiment_Graph_State_and_Simulation_Runtime.md` |
| 08 | Gameplay, Guided Experiments and Learning | `Agent_08_Gameplay_Guided_Experiments_and_Learning.md` |
| 09 | Backend, Persistence, Catalogs and Exports | `Agent_09_Backend_Persistence_Catalogs_and_Exports.md` |
| 10 | Integration, Performance and Quality Assurance | `Agent_10_Integration_Performance_and_Quality_Assurance.md` |

## Cross-agent boundaries

- Agent 01 owns interface; Agent 02 environment; Agent 03 equipment definitions; Agent 04 editing and pointer controls; Agent 05 fluid/glass graphics.
- Agent 06 is **the sole authoritative source of chemistry calculations**; Agent 07 is **the sole authoritative writer of experiment/apparatus state**; Agent 09 owns durable persistence; Agent 08 consumes events for game scoring; Agent 10 owns integration and QA.
- The canonical data flow is **Action → apparatus reducer → scientific solver → observation ledger → UI/visuals/gameplay/persistence**.
- Contract changes require agreement among relevant agents before implementation; retain IDs, SI units and reproducibility.

## Required completion evidence

Running application; demonstrable 3D titration assembly and operation; reliable calibrated pH computations; two independent experiment stations; save/reopen; tests passing; actual running screenshots; science limitations; measured rendering benchmarks. Static mockups, invented pH curves and standalone showpieces do **not** count as completion.

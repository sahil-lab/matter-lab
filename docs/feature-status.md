# What is implemented, what is partial, what is not

Measured against the build specification, part by part. "Implemented" means the feature works in
the running application and automated tests cover it. "Partial" says exactly what is there and what
is missing. "Not implemented" means there is nothing, and nothing pretends otherwise.

Where a test suite is named, its last result is in [development-notes.md](development-notes.md).

## The workspace (Part 2)

| Feature | State | Notes |
| --- | --- | --- |
| Full-screen 3D workspace with floating glass panels, the specified palette, three typefaces | Implemented | Panels collapse; the layout is tested geometrically at five window sizes (`layout.spec.ts`) |
| Physically based materials, lighting from a generated environment, ambient occlusion, restrained bloom, tone mapping | Implemented | The environment is built from light shapes at start-up, not from an HDR photograph |
| Volumetric atmosphere | Partial | A shaded backdrop, depth fog and a vignette. No volumetric lighting |
| Orbit, zoom, pan, focus on the selection, fit all, reset, standard views | Implemented | "Reset view" (views menu, Shift Home) returns to the opening direction with everything in view. Standard views and the reset turn by the short way however often the camera has been orbited (`editor.spec.ts`) |
| Camera bookmarks, orthographic and perspective projection, eased camera moves | Implemented | |
| Transition between workspaces | Partial | The Architect's document, undo history and camera are set aside and come back exactly as they were (`reactions.spec.ts`). The switch itself is a cut: neither the camera nor the content of the stage is animated |
| Dragging an atom never turns the camera | Implemented | Tested with real mouse input (`editor.spec.ts`) |

## Atomic Forge (Part 3)

| Feature | State | Notes |
| --- | --- | --- |
| All 118 elements, chosen from a periodic table | Implemented | |
| Create, select, inspect, move, duplicate and remove atoms; undo and redo | Implemented | |
| Change proton, neutron and electron counts; element, isotope and charge follow | Implemented | Any combination can be entered |
| Warnings for unstable, hypothetical or inconsistent atoms | Implemented | From the evaluated nuclear data (3,383 nuclides) and simple rules |
| Creative and Physics modes | Implemented | Creative draws anything. Physics marks on the stage every atom the checks object to. Neither blocks editing |
| Saving atomic configurations | Implemented | As part of a project or a structure file |
| Nucleus drawn as spheres, each proton and neutron selectable | Implemented | Illustrative and labelled so; positions are arbitrary (`nucleus.spec.ts`) |
| Zoom between atom and nucleus, scale indicator | Partial | The nucleus view opens with a zoom through the five powers of ten between atom and nucleus, with a scale bar that is tested against the picture. It is a separate view, not a continuous zoom of the main stage |
| Particle labels | Partial | A legend, and the identity of a particle when it is picked. No text label on every sphere |
| Electron configurations | Implemented | Reference data for neutral atoms, rule-based for ions |
| Computed electron density and orbitals of an atom | Partial | Only where Hartree-Fock applies: closed-shell atoms and ions of H to Ar (He, Ne, Ar, Na+, F- and the like). Open-shell atoms are refused with the reason |
| Classical orbiting electrons | Deliberately absent | |

## Molecular Architect (Part 4)

| Feature | State | Notes |
| --- | --- | --- |
| Place atoms in 3D, grow a structure atom by atom, automatic hydrogens | Implemented | |
| Single, double, triple and aromatic bonds; select, delete and change bonds | Implemented | |
| Select groups (box, whole molecule), move and rotate them, with axis constraints and typed values | Implemented | |
| Set bond lengths, angles and dihedrals | Implemented | The movable side of the molecule follows |
| Measure distances, angles and dihedrals | Implemented | |
| Copy, cut, paste, duplicate | Implemented | |
| Undo and redo of every edit | Implemented | Exact, from reversible patches |
| Import and export: native JSON, XYZ, MDL molfile, SD file, PDB | Implemented | Each format states what it keeps and loses |
| Import from SMILES | Implemented | A 3D model is built and its stereochemistry checked against the string; a model that cannot be given the stated configuration is withheld (`find.spec.ts`) |
| Export of SMILES and InChI | Partial | Shown and copied from the inspector; not written as files |
| Look up a compound by name | Implemented | PubChem, on request |
| Substructure and similarity search | Partial | Over the 63 structures built into the application. The catalogue of the science service is not reachable from the interface |
| Geometry optimisation, comparison with the starting geometry, replay of the optimiser's path | Implemented | Universal Force Field, in a background thread, cancellable (`optimize.spec.ts`) |
| Ball and stick, space-filling, sticks, wireframe | Implemented | Changes of representation are eased |
| Skeletal representation | Partial | The sticks view stands in for it. Hydrogens on carbon are not hidden and there is no line-angle drawing |
| Molecular surfaces | Implemented | Van der Waals and solvent-accessible (1.4 Å probe), with area and volume |
| Electron density, orbital isosurfaces, electrostatic potential | Implemented | See Part 6 |
| GPU instancing, direct buffer updates, no per-atom React rendering | Implemented | |

## Reaction Laboratory (Part 5)

| Feature | State | Notes |
| --- | --- | --- |
| Several species with roles (reactant, product, catalyst, solvent) | Implemented | |
| Temperature, pressure, concentrations, duration, environment, method | Implemented | Catalyst, solvent and pressure are recorded but change no number, and every result says so |
| Validation of inputs and of conservation, exact balancing | Implemented | |
| Thermodynamics | Implemented | 175 species at 298.15 K; other temperatures by a constant-enthalpy approximation, labelled |
| Kinetics | Partial | Eight sourced gas-phase reactions. No solution kinetics, catalysis, mechanisms or combustion kinetics |
| Organic reactions | Partial | Combustion and formation of small organic molecules from the thermodynamic table. No organic reaction mechanisms |
| Asynchronous execution with progress and cancellation | Implemented | |
| Convergence, warnings and limitations with every result | Implemented | |
| Saving, reopening, reproducing (byte for byte), comparing and exporting experiments | Implemented | In the browser's storage and as files (`reactions.spec.ts`) |
| Timeline with play, pause, frame stepping, scrubbing and speed | Implemented | Where a rate law gives a time course. Without one, a before/after slider steps through the equation |
| Concentration curves, rate curves, energy diagrams | Implemented | An energy barrier is drawn only where a sourced activation energy is positive |
| Temperature graphs | Partial | The rate constant is plotted against temperature for the kinetic models. There is no graph of temperature against time, because every run is isothermal |
| The 3D chamber | Partial | Illustrative, and labelled so: molecules in the proportions of the equation, changing with the computed conversion. No positions or motions are computed |
| Computed reaction trajectories, bond-change highlighting | Not implemented | No engine here computes reactive trajectories, so none is shown |
| Predicting whether substances react, or the products | Deliberately absent | |

## Quantum visualisation (Part 6)

| Feature | State | Notes |
| --- | --- | --- |
| Molecular energy, orbitals, density, electrostatic potential | Implemented | Restricted Hartree-Fock, STO-3G, closed-shell molecules of H to Ar up to 96 basis functions, in the browser (`quantum.spec.ts`) |
| Orbital isosurfaces with both phases, adjustable isovalue and opacity | Implemented | |
| Density isosurface, potential mapped on a density surface | Implemented | |
| Quantitative colour legends with units | Implemented | Legend colours are tested against the pixels drawn |
| Cutting plane with contours, able to cut surfaces open | Implemented | |
| Volumetric rendering | Partial | Dot clouds sampled from the field, and cutting planes. No ray-marched volume |
| Stepping through orbitals | Implemented | |
| Comparing two states or two calculations side by side | Not implemented | |
| Geometry optimisation at the quantum level, atomic forces | Not implemented in the application | Optimisation is by force field. The science service offers GFN-xTB optimisation, but the interface does not call it |
| Open-shell systems, elements beyond argon, larger basis sets | Not implemented | Refused with the reason |

## Computation architecture (Part 7)

| Item | State | Notes |
| --- | --- | --- |
| React, TypeScript, Vite, Three.js, React Three Fiber, drei, zustand, d3 | Used | |
| WebGPU | Not implemented | WebGL 2 only |
| WebAssembly | Partial | RDKit runs as WebAssembly. The force-field, quantum and reaction engines are TypeScript in Web Workers |
| Transferable typed arrays | Used | For field and mesh data. SharedArrayBuffer is not used |
| Rust, C++, Tauri desktop packaging | Not implemented | The application is a web application |
| RDKit, PySCF, xTB (tblite), ASE, NumPy, SciPy | Used | RDKit in the browser and in the service; the others in the service only |
| Psi4, OpenMM, Cantera | Not used | |
| Backend | Partial | A Python FastAPI service with worker processes, not Rust Axum. Typed HTTP API with an OpenAPI description |
| Jobs with status, cancellation, recorded inputs, reproducibility data and failure states | Implemented | In the browser (workers) and in the service (processes) |
| PostgreSQL, migrations | Implemented | In the service |
| Parquet, DuckDB, object storage | Not implemented | |

## Database and Excel (Part 8)

| Feature | State | Notes |
| --- | --- | --- |
| 118 elements, 3,383 nuclides, with sources | Implemented | In the application and seeded into the database |
| Compound catalogue | Partial | 296 compounds, 48 solvents, 33 catalysts and 176 functional groups in the service; 63 structures in the application |
| Data from IUPAC, PubChem, NIST, evaluated isotope data | Implemented | With citations, retrieval dates and licence notes |
| Open Reaction Database | Not implemented | No reaction data are imported |
| Excel workbook with the ten named sheets, export and import | Partial | Implemented and tested in the science service. There is no button for it in the interface |
| Schema migrations, validation, provenance fields, units, source versions | Implemented | Five SQL migrations |
| Substructure and similarity search | Partial | With RDKit, in memory. Not a database index, so it does not scale to millions of records |
| **The interface talking to the service** | **Not implemented** | The service is complete behind its documented API and has its own tests, but the web application stores everything in the browser and never calls it |

## Discovery Vault (Part 9)

| Feature | State | Notes |
| --- | --- | --- |
| Normalise and validate a structure, derive identifiers | Implemented | RDKit |
| Search for the identical structure and for similar ones | Partial | Two catalogues: the built-in library and, on request, PubChem. Nothing else is searched, and the Vault says so |
| The six statuses, climbed one rung at a time, each on its own evidence | Implemented | The first three are set by the application and cannot be claimed |
| Never describing a missing match as novelty | Implemented | Tested against the text on screen and in every report (`vault.spec.ts`) |
| Plausibility by calculation | Implemented | Force-field optimisation and Hartree-Fock; an engine that cannot treat the structure attaches nothing |
| Evidence trail, append-only | Implemented | |
| Persistent identifier | Implemented | A UUID |
| Report | Implemented | A readable report (Markdown) and the complete record (JSON) |
| Importing a record | Implemented | Identifiers are derived again and the status is cut back to what the evidence in the file carries |
| Structural comparison | Implemented | Recorded against optimised geometry |
| Storage | Partial | In the browser (IndexedDB), on one device. Not in PostgreSQL |

## Explanations (Part 10)

| Feature | State | Notes |
| --- | --- | --- |
| Explanation of the selected atom, bond or structure, at two depths | Implemented | |
| Explanation of a geometry optimisation and of a Hartree-Fock calculation | Implemented | Objective, starting point, method, model with its equation, assumptions, result, convergence, confidence, why reality may differ, sources. It follows the selected atom and what is drawn |
| Explanation of a reaction experiment | Implemented | Written by the experiment engine, at two depths |
| Graphs | Partial | Convergence and energy-path graphs are on the Compute tab and reaction graphs in the results panel, not inside the explanation |
| Following the timeline frame | Not implemented | The explanation of an experiment does not change with the frame |
| Confidence and uncertainty | Partial | Stated in words with a worked example against measured values, and as propagated uncertainties for thermodynamics. Force field and Hartree-Fock give no error bar for the molecule at hand, and the text says so |
| Explanations of Vault calculations | Partial | The evidence entry states method and result; there is no structured explanation |

## MatterRender (Part 11)

| Feature | State | Notes |
| --- | --- | --- |
| Instanced atoms and bonds, PBR materials, antialiasing, environment lighting | Implemented | |
| Ambient occlusion, selective bloom, selection outlines | Implemented | |
| Molecular surfaces and isosurfaces | Implemented | |
| Volumetric field rendering | Partial | Dot clouds and cutting planes |
| Trajectories | Partial | The optimiser's path is replayed by buffer updates. There are no molecular-dynamics trajectories |
| Picking | Implemented | Analytic ray tests; every atom is tested, without a spatial index |
| Adaptive level of detail, dynamic resolution | Implemented | |
| Sphere impostors | Not implemented | Atoms are meshes; very large scenes therefore carry millions of triangles |
| Device detection, three quality presets, resource disposal | Implemented | |

## Performance (Part 12)

Measured, not asserted: see [benchmarks/render-benchmark.md](benchmarks/render-benchmark.md) and
the reading of it in [benchmarks/README.md](benchmarks/README.md), which also shows how far a busy
or battery-powered machine moves the numbers. On the integrated GPU of the development machine:

- Efficient holds 60 fps for a typical molecule.
- **Balanced comes close but does not hold it**: 49 to 59 fps in the undisturbed runs. Its
  post-processing alone uses about 10 of the 16.7 ms a frame may take on this GPU, and Balanced is
  the preset the application chooses there by default. The target of a stable 60 fps in Balanced is
  not met on this hardware.
- Scenes of 100,000 atoms stay usable (34 to 44 fps in Efficient).
- Dragging and committing a move stay within a few frames at every size; adding or deleting an atom
  takes 60 to 330 ms in scenes of 50,000 atoms and more, which misses the target of one or two
  frames. Validation, cached search and reopening a scene are far inside their budgets.
- Calculations run in background threads and do not freeze the view, but the frame rate drops
  while one runs (26 to 51 fps, with single frame gaps of up to 184 ms).

No other hardware was measured, and the machine was never idle during a run.

## Quality assurance (Part 16)

Where each item of the list is tested. The browser tests (`apps/web/e2e`) drive the real application
with real mouse and keyboard input; the service tests need Docker.

| Item | Where |
| --- | --- |
| Element identity after proton-count changes, isotope bookkeeping, electron count and charge | `packages/core/test/atom.test.ts`, `isotopes.test.ts`; `e2e/editor.spec.ts` (atomic forge) |
| Atom and bond editing, undo and redo | `packages/core/test/scene.test.ts`; `e2e/editor.spec.ts` |
| Scene serialisation | `packages/core/test/io.test.ts`; `e2e/editor.spec.ts` (persistence and files) |
| RDKit structural validation | `e2e/chemistry.spec.ts`; `services/science/tests/test_chem.py` |
| Stoichiometric conservation | `packages/reactions/test/balance.test.ts`, `equation.test.ts` |
| Thermodynamic units and sign conventions | `packages/reactions/test/thermo.test.ts` |
| Kinetics solver outputs | `packages/reactions/test/kinetics.test.ts`, `ode.test.ts`; `e2e/reactions.spec.ts` (closed-form check) |
| Quantum solver convergence reporting | `packages/quantum/test/scf.test.ts`, `challenging.test.ts`, `stability.test.ts` |
| Known small-molecule reference geometries and energies | `packages/forcefield/test/optimize.test.ts` (against RDKit's own numbers); `packages/quantum/test/pyscf.test.ts`, `crawford.test.ts` (energies and integrals against PySCF and published reference files) |
| Scientific data provenance | `packages/reactions/test/provenance.test.ts` (every number can be read in the saved source); `packages/core/test/elements.test.ts`, `isotopes.test.ts`; `services/science/tests/test_provenance.py` |
| Failed computation handling | `e2e/optimize.spec.ts`, `quantum.spec.ts`, `reactions.spec.ts` (honest limits); `packages/forcefield/test/robustness.test.ts`; `packages/quantum/test/support.test.ts`; `packages/reactions/test/experiment.test.ts` |
| Molecular search | `e2e/chemistry.spec.ts`, `find.spec.ts`; `services/science/tests/test_catalogue.py` |
| Excel import and export | `services/science/tests/test_excel.py` |
| API contracts | `services/science/tests/test_api_contract.py`; `packages/forcefield/test/api.test.ts`, `packages/quantum/test/api.test.ts` |
| Database migrations | `services/science/tests/test_migrations.py` |
| Browser interactions | all of `apps/web/e2e/*.spec.ts` |
| GPU performance | `apps/web/e2e/render.bench.ts`. It measures and writes a report; it asserts only that frames were drawn, so it cannot fail on a slow machine |
| Long-running job cancellation | `e2e/optimize.spec.ts`, `quantum.spec.ts` (cancelled while running, with the view still moving); `packages/forcefield/test/robustness.test.ts`, `packages/quantum/test/scf.test.ts`, `packages/reactions/test/experiment.test.ts`; `services/science/tests/test_jobs.py` (the worker process is terminated) |

## Process (Part 13)

Not as specified. See [development-notes.md](development-notes.md).

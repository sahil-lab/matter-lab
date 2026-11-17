# Architecture

MATTER LAB is an npm-workspaces monorepo. The molecular editor and instrument laboratory run in
one web application, also packaged by the Windows Tauri shell. A connected Python/PostgreSQL
service provides heavier engines and shared storage. Local work remains available without it;
remote operations display their availability and failures explicitly.

```
project/
  apps/web/               the application (React, Three.js, Vite)
  apps/desktop/           Windows Tauri shell for the same application
  packages/contracts/     validated, versioned laboratory DTOs
  packages/lab-science/   authoritative ideal aqueous acid-base solver and sources
  packages/lab-runtime/   authoritative inventory, apparatus graph and deterministic replay
  packages/core/          shared model: scene, elements, isotopes, validation, file formats
  packages/forcefield/    Universal Force Field (port of RDKit's implementation)
  packages/quantum/       restricted Hartree-Fock in the STO-3G basis, fields, isosurfaces
  packages/reactions/     stoichiometry, thermodynamics, kinetics, the experiment pipeline
  services/science/       Python service (FastAPI): RDKit, xTB, PySCF jobs, catalogue, Excel
  db/migrations/          PostgreSQL schema, as numbered SQL migrations
  tools/data/             scripts that build the reference data from source snapshots
  docs/                   documentation, screenshots, benchmark reports, example experiments
```

## The rule everything follows

Every number on screen has one of six evidence levels, defined once in `packages/core`
(`provenance.ts`): `reference` (taken from a cited source), `computed` (the result of a stated
method), `rule-based` (a simple rule, such as a sum of covalent radii), `illustrative` (a picture
that is not data), `user-input` and `unsupported`. Engines return a `Provenance` record with their
results; the interface shows the level as a badge beside the value. A calculation that cannot treat
a system says so with a reason; it never returns a stand-in.

## The shared model (`packages/core`)

- A `Scene` is an immutable pair of maps, atoms and bonds. An atom is its proton, neutron and
  electron counts and a position in ångström; `neutrons: null` means the natural isotope mixture.
  A bond has an order of 1, 1.5 (aromatic), 2 or 3.
- Every change goes through `editScene`, which returns a new scene and a `ScenePatch`. A patch can be
  inverted, so undo and redo are exact and the history stores patches, not copies.
- Chemistry on top of the scene: element identity from the proton count, electron configurations,
  the valence model (it mirrors RDKit's), bond perception, hydrogen placement, formulae and masses,
  rule-based validation, and geometry edits (distances, angles, dihedrals).
- File formats: the native JSON scene, XYZ, MDL molfile and SD file (V2000 and V3000), PDB.
- Data: 118 elements and 3,383 nuclides with their sources, and sixteen example molecules.

The other packages and the web application depend on `core`; `core` depends on nothing.

## The engines

| Package | What it computes | Verified against |
| --- | --- | --- |
| `forcefield` | UFF energy, analytic gradient and geometry optimisation, with a check that the result is a minimum and not a saddle point | RDKit on 194 molecules |
| `quantum` | RHF/STO-3G for closed-shell molecules of H to Ar: energy, orbitals, density matrix, Mulliken charges, dipole; density, orbitals and electrostatic potential on grids; marching-cubes isosurfaces | PySCF on 48 systems, published values |
| `reactions` | Formula and equation parsing, exact balancing, conservation checks, reaction thermodynamics from 175 tabulated species, eight sourced gas-phase rate laws, an ODE integrator, and the seven-step experiment pipeline | CODATA and NIST values, IUPAC evaluations |
| `lab-science` | Ideal monoprotic strong/weak acid-base equilibria, titration references and indicator fractions at 298.15 K | Electroneutrality/mass-balance residuals, analytical limits, source constants and endpoint cases |
| `lab-runtime` | Fixed-tick transfers, conservation, capacity, graph validation, independent stations and deterministic replay | Shared browser/Node execution and checkpoint tests |

Each package has a README that states its method, its validation and its limits, with the numbers.

## The web application (`apps/web`)

```
src/
  state/        the store (zustand), every undoable action, autosave, the project library
  render/       MatterRender: instanced atoms and bonds, picking, camera, effects, fields, labels
  interaction/  pointer and keyboard handling: build, select, erase, measure, drag, modal transforms
  science/      bridges to the workers: RDKit, force field, quantum; PubChem client; 3D from SMILES
  workers/      four Web Workers: RDKit (WebAssembly), force field, quantum, reactions
  compute/      stores for calculations on the document: optimisation, Hartree-Fock, fields
  reaction/     the Reaction Laboratory
  vault/        the Discovery Vault
  nucleus/      the nucleus view
  lab/          meter-scale apparatus, environment, editor, fluids, challenges and persistence
  services/     connected backend client, memory-only credentials and workbench archive
  ui/           top bar, tool rail, inspector, dialogs, charts, explanations
```

**State.** One zustand store holds the document (scene, history, selection), the view settings and
the interface state. Code outside React uses the same store imperatively. Scene changes only happen
in `runEdit`, which records the patch for undo. The three workspaces (Architect, Reactions, Vault)
share the 3D stage: entering another workspace parks the Architect's document and camera untouched
and restores them on return; the other workspaces only display.

**Rendering.** `SceneView` is an imperative class that owns GPU-instanced meshes for atoms, bonds
and selection outlines and writes their instance buffers directly. React does not render per atom.
A patch that does not change the bonding updates only the affected instances; dragging moves
instances without touching the scene and commits one edit on release. There are two pipelines:
*direct* (Efficient preset: MSAA, AgX tone mapping in the renderer) and *composer* (Balanced and
Quality: ambient occlusion, restrained bloom, AgX, SMAA or MSAA, vignette). Frames are drawn on
demand. Sphere and cylinder detail drops with the number of atoms, and the pixel ratio drops when
frames run long. Picking is analytic (ray against spheres and cylinders over typed arrays), not
GPU-based. This molecular renderer is **WebGL 2**. The separately lazy-loaded instrument room has
its own Three WebGPU path with WebGL 2 fallback; renderer selection never changes scientific state.
Ray-marched molecular volumes use the same computed grid as other field displays and a separate
opaque depth pass; pinned comparisons own isolated render resources and calculation snapshots.

**Calculations.** Anything that can take more than a frame runs in a Web Worker behind a small
typed RPC layer (`science/rpc.ts`). Calls report progress; cancelling terminates the worker, which is
the only reliable way to stop a synchronous numerical engine, and a new worker is started on the
next call. Jobs are listed in the top bar with their state (running, done, failed, cancelled,
unsupported). Results are tied to the exact scene they were computed for: when the structure is
edited, the result, its surfaces and its explanation are withdrawn.

**Persistence.** The session is saved to `localStorage`; projects, saved experiments and vault
candidates live in IndexedDB. Projects, experiments and candidates can be exported as JSON files and
imported again. Explicit connected actions send calculations or documents to the configured
science service. Bearer credentials remain in memory, never document exports or local snapshots.
Laboratory local drafts are labeled unconfirmed; PostgreSQL saves require acknowledgement of an
exact revision. Replays always start from recorded initial conditions, not final state plus history.

**Test hook.** In development builds, and in the special build used by `npm run test:e2e:build`, the
application exposes `window.__MATTERLAB__` and `window.__MATTERLAB_LAB__` for the browser tests.
A normal production build does not.

## Instrument laboratory boundary

The original molecular document uses numeric atom IDs and angstroms. The instrument scene uses
UUIDs, meters, liters, moles, kelvin and seconds; neither store is reused for the other. Navigation
disposes the inactive canvas and keeps the molecular document intact.

`contracts` validates scene/runtime/replay DTOs. `lab-science` alone calculates pH, supported
equilibrium quantities and indicator fractions. `lab-runtime` alone writes inventories and records
accepted actions. Browser workers and the backend Node subprocess import those same packages.
Renderers consume current observation cohorts, never estimates derived from animation.

The editor drains fixed-step simulation work before reading a revision or constructing a command.
Multi-object attachment is atomic. Filling is preparation, not arbitrary mid-run replenishment;
paused stations cannot transfer. Learning goals consume actual accepted actions and observations,
and their persisted scores are re-derived rather than trusted.

## The science service (`services/science`, `db/`)

A FastAPI application with PostgreSQL 17 as the authoritative database, started with Docker
Compose. It provides structure validation and descriptors (RDKit), asynchronous jobs in worker
processes with cancellation and time-outs (RDKit embedding and force fields, GFN-xTB through tblite,
PySCF), a compound catalogue with exact, substructure and similarity search, experiments,
discovery candidates with the same status ladder as the Vault, and an Excel workbook with the ten
sheets of the specification. Its HTTP API is documented in [api/science-api.md](api/science-api.md).

The UI calls the service for catalogue/Excel, immutable workbench archives and xTB/PySCF jobs.
Applying an optimized geometry requires a converged, finite, atom-matched result whose source scene
still matches the open document. It becomes one undoable edit.

The additive `/api/v1/lab` API has scoped bearer authentication, owner isolation, revision checks,
immutable run/result storage and bounded Node replay. Legacy `/v1` APIs remain local shared APIs.
See [the laboratory service contract](../services/science/LABORATORY.md).

## How the pieces meet

```
 React UI ── zustand store ──┬── MatterRender (WebGL 2, instanced)
                             ├── interaction controller
                             └── science bridges ── Web Workers ── core / forcefield / quantum / reactions
                                                └── RDKit.js (WebAssembly)
                                                └── PubChem (HTTPS, on request)

 Laboratory UI ── editor ── worker ── lab-runtime ── lab-science
                          └── renderer/learning consume accepted snapshots

 Connected UI ── typed HTTP client ── FastAPI ── PostgreSQL
                                           ├── scientific Python workers
                                           └── Node replay ── same lab-runtime / lab-science
```

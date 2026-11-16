# Architecture

MATTER LAB is an npm-workspaces monorepo. One web application and four TypeScript packages run in
the browser; a Python service with a PostgreSQL database runs beside it for the heavier engines and
for shared storage. The web application does not need the service: everything it shows today is
computed in the browser.

```
project/
  apps/web/               the application (React, Three.js, Vite)
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
GPU-based. The renderer is **WebGL 2**; there is no WebGPU path.

**Calculations.** Anything that can take more than a frame runs in a Web Worker behind a small
typed RPC layer (`science/rpc.ts`). Calls report progress; cancelling terminates the worker, which is
the only reliable way to stop a synchronous numerical engine, and a new worker is started on the
next call. Jobs are listed in the top bar with their state (running, done, failed, cancelled,
unsupported). Results are tied to the exact scene they were computed for: when the structure is
edited, the result, its surfaces and its explanation are withdrawn.

**Persistence.** The session is saved to `localStorage`; projects, saved experiments and vault
candidates live in IndexedDB. Projects, experiments and candidates can be exported as JSON files and
imported again. Nothing is sent anywhere except the PubChem lookups the user asks for.

**Test hook.** In development builds, and in the special build used by `npm run test:e2e:build`, the
application exposes `window.__MATTERLAB__` for the browser tests. A normal production build does not.

## The science service (`services/science`, `db/`)

A FastAPI application with PostgreSQL 17 as the authoritative database, started with Docker
Compose. It provides structure validation and descriptors (RDKit), asynchronous jobs in worker
processes with cancellation and time-outs (RDKit embedding and force fields, GFN-xTB through tblite,
PySCF), a compound catalogue with exact, substructure and similarity search, experiments,
discovery candidates with the same status ladder as the Vault, and an Excel workbook with the ten
sheets of the specification. Its HTTP API is documented in [api/science-api.md](api/science-api.md).

**The web application does not call the service.** The two were built against the same contracts
but are not connected: the Vault and the Reaction Laboratory store their records in the browser.
See [feature-status.md](feature-status.md).

## How the pieces meet

```
 React UI ── zustand store ──┬── MatterRender (WebGL 2, instanced)
                             ├── interaction controller
                             └── science bridges ── Web Workers ── core / forcefield / quantum / reactions
                                                └── RDKit.js (WebAssembly)
                                                └── PubChem (HTTPS, on request)

 science service (FastAPI) ── PostgreSQL        not connected to the UI; documented HTTP API
```

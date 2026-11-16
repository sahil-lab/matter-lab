# APIs

MATTER LAB has three kinds of interface: the HTTP API of the science service, the TypeScript APIs of
the four packages, and the file formats the application reads and writes. This page says where each
is documented and what holds for all of them.

## What holds everywhere

- **Units are part of the contract.** Positions are in ångström, masses in unified atomic mass
  units, energies in the unit named beside them (hartree for electronic energies, kcal/mol for the
  force field, kJ/mol for thermodynamics). The service carries the unit in the field name
  (`energy_hartree`) or in a `unit` field.
- **Evidence levels.** `reference`, `computed`, `rule-based`, `illustrative`, `user-input`,
  `unsupported`: defined once in `packages/core` (`provenance.ts`) and used with the same meaning by
  every package and by the service.
- **Provenance.** Results carry the `Provenance` shape of `packages/core`: source, version,
  citations, URL, retrieval date, licence, notes.
- **Jobs.** One life cycle for every asynchronous calculation, in the browser and in the service:
  `queued`, `running`, `succeeded`, `failed`, `cancelled`, `unsupported`.
- **No stand-ins.** A calculation that cannot be done ends as `unsupported` or `failed` with the
  reason and without a result.

## HTTP API of the science service

| Document | Content |
| --- | --- |
| [science-api.md](science-api.md) | Reference for all 49 operations, with parameters, status codes and a real request and response for each, captured from the running service on 14 November 2026 |
| [openapi.json](openapi.json) | The OpenAPI schema the reference was generated from. The running service serves it at `/openapi.json` and interactive documentation at `/docs` |
| [services/science/README.md](../../services/science/README.md) | Commands, configuration, engines, data, tests, limitations |

Base URL of the development stack: `http://127.0.0.1:8787`. Areas: service information and health,
chemistry (validate, 3D coordinates, descriptors, functional groups), jobs (submit, list, read,
cancel), reference data (elements, isotopes, functional groups, solvents, catalysts, sources),
compound catalogue and search (exact, substructure, similarity), reactions, experiments, discovery
candidates, and the Excel workbook. Every error has one shape:
`{"error": {"code", "message", "details"}}`. There is no authentication.

Both documents are generated (`services/science/scripts/build_api_reference.py` and the
`export-openapi` command; the service README gives the commands). `tests/test_api_contract.py`
validates every operation and every documented response against the schema.

The web application does not call this API. See [feature-status.md](../feature-status.md).

## Package APIs

Each package exports from `src/index.ts`; the READMEs document the exports with their units, their
failure modes and worked examples.

| Package | Where | In one line |
| --- | --- | --- |
| `@matterlab/core` | [README](../../packages/core/README.md) | `Scene`, `editScene` and patches, history, elements and nuclides, validation, geometry, file formats, evidence and provenance types |
| `@matterlab/forcefield` | [README, "Public API"](../../packages/forcefield/README.md#public-api) | `optimizeUff(molecule, options)` and the energy and gradient of a typed system; reports convergence, the kind of stationary point, warnings and what it cannot type |
| `@matterlab/quantum` | [README, "Public API"](../../packages/quantum/README.md#public-api) | `checkSupport`, `runRhf`, fields on grids (density, orbitals, electrostatic potential), marching-cubes isosurfaces |
| `@matterlab/reactions` | [README, "Public API"](../../packages/reactions/README.md#public-api) | Formula and equation parsing, `balanceEquation`, `reactionThermodynamics`, `rateConstant`, `simulateKinetics`, `runExperiment`, records and presets |

The force-field package pins its exact export list in `test/api.test.ts`, so an export cannot
appear or disappear unnoticed; the quantum package tests the specified functions, their signatures
and the example of its README there.

## Calculations in the browser

The application runs the engines in four Web Workers behind a small typed layer
(`apps/web/src/science/rpc.ts`): `WorkerClient.call(method, params, options)` returns a promise,
reports progress through a callback, and is cancelled by an `AbortSignal`, which terminates the
worker (a `JobCancelledError` is thrown; the next call starts a fresh worker). Large arrays are
transferred, not copied.

| Worker | Methods |
| --- | --- |
| `rdkit.worker.ts` (RDKit as WebAssembly) | `version`, `analyse`, `fromSmiles`, `stereo`, `depict`, `search` |
| `forcefield.worker.ts` | `optimize` |
| `quantum.worker.ts` | `scf`, `surface`, `espSurface`, `slice`, `cloud`, `molecularSurface` |
| `reaction.worker.ts` | `run` |

The types of the methods are exported from each worker file (`RdkitMethods` and so on).

## File formats

All four are JSON with a format name and a version, and each is refused with the reason when it
does not validate.

| Format | Written by | Content |
| --- | --- | --- |
| `matterlab.scene`, version 1 | `serializeScene` in `packages/core` | Atoms (protons, neutrons, electrons, position) and bonds |
| `matterlab.project`, version 1 | File menu, "Export…", "Project file (.matterlab.json)" | A scene with its name, view settings, measurements and camera bookmarks |
| `matterlab.experiment-result`, version 1 | Reactions, "Export record" (`.experiment.json`) | Inputs, input hash, steps, equation, results with units and sources, explanation, warnings, limitations, reproducibility data. Examples: [../examples/experiments](../examples/experiments) |
| `matterlab.candidate`, version 1 | Vault, "Export data" (`.candidate.json`) | A candidate with its structure, identifiers, searches and evidence trail. On import the identifiers are derived again and the status is cut back to what the file's evidence carries. "Export report" writes the same content as readable Markdown, which is not read back |

Structures are also exchanged as XYZ, MDL molfile, SD file and PDB; the core README states what
each keeps and loses.

## The test hook

Development builds, and the build made by `npm run test:e2e:build`, expose `window.__MATTERLAB__`
(`apps/web/src/testApi.ts`) so that the browser tests can read the state and call actions. It is
not an API for anything else, and a normal production build does not contain it.

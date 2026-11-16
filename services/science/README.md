# MATTER LAB science service

The scientific backend of MATTER LAB: a FastAPI service that wraps validated scientific libraries
(RDKit, tblite/xTB, PySCF), runs calculations as asynchronous jobs in worker processes, keeps
reference data with provenance in PostgreSQL, and imports and exports Excel workbooks.

Governing rule: **nothing is fabricated.** Every stored record names its source, every number has a
unit, every computed result names the engine, version, method and settings that produced it and
whether it converged, and what cannot be computed is reported as `unsupported` or `failed` with the
reason.

- API reference with real request/response examples: [`docs/api/science-api.md`](../../docs/api/science-api.md)
- OpenAPI schema: [`docs/api/openapi.json`](../../docs/api/openapi.json); interactive docs at `http://127.0.0.1:8787/docs`
- Base URL of the development stack: `http://127.0.0.1:8787` (also `http://localhost:8787`)

## Commands

All commands are run from the repository root. They are written for PowerShell and work the same
in any other shell. Compose project name: `matterlab`.

```powershell
# Build the service image (matterlab-science:dev; about 1.1 GB with the optional engines)
docker compose -p matterlab build science

# Start PostgreSQL and the service. On start the service waits for the database, applies pending
# migrations, loads the seed data (idempotent) and detects the engines.
docker compose -p matterlab up -d

# Check
curl.exe http://127.0.0.1:8787/health
curl.exe http://127.0.0.1:8787/v1/engines
docker compose -p matterlab logs science

# Migrate and seed by hand (both are idempotent; neither is needed after a normal start)
docker compose -p matterlab run --rm science python -m matterlab_science migrate
docker compose -p matterlab run --rm science python -m matterlab_science migration-status
docker compose -p matterlab run --rm science python -m matterlab_science seed

# Run the tests inside the service image, against the real PostgreSQL and the real libraries.
# The suite creates its own databases (matterlab_test_*) and drops them; it never touches the
# development database. About 7 minutes.
docker compose -p matterlab run --rm science pytest

# Stop. The named volume matterlab_pgdata (the database) is kept.
docker compose -p matterlab down

# Remove the database as well (destroys all stored data of this stack)
docker compose -p matterlab down -v
```

Other CLI commands (`docker compose -p matterlab run --rm science python -m matterlab_science <command>`):
`engines` (detect and print the engines), `export-openapi <file|->`, `export-excel <file>`,
`import-excel <file> [--dry-run] [--atomic]`, `serve`.

Host ports are bound to the loopback interface only: PostgreSQL on **55432**, the API on **8787**.

### Developing without rebuilding

The image contains a copy of the source. To run the tests (or anything else) against the working
tree, mount it over `/app`:

```powershell
$src = (Resolve-Path 'services\science').Path
docker compose -p matterlab run --rm -v "${src}:/app" science pytest tests/test_chem.py -q
```

### Regenerating the API documents

```powershell
$src = (Resolve-Path 'services\science').Path
$out = (Resolve-Path 'docs\api').Path
docker compose -p matterlab run --rm -v "${src}:/app" -v "${out}:/docs-out" science python -m matterlab_science export-openapi /docs-out/openapi.json
docker compose -p matterlab run --rm -v "${src}:/app" -v "${out}:/docs-out" science python scripts/build_api_reference.py /docs-out/science-api.md
```

`build_api_reference.py` starts a temporary instance of the service on a temporary database, sends
every example request over HTTP, writes the responses into the reference and drops the database.

## Layout

| Path | Content |
|---|---|
| `docker-compose.yml` (repository root) | The stack: `db` (postgres:17-alpine) and `science` |
| `.dockerignore` (repository root) | Keeps the build context to `services/science`, `db/migrations` and `tools/data/generated`. Another image built from the repository root needs its paths added there. |
| `db/migrations/NNNN_name.sql` | Forward-only, plain SQL migrations, applied in order and recorded in `schema_migrations` with a checksum |
| `services/science/matterlab_science/` | The service: `api/` (routers), `chem/` (RDKit), `jobs/` (supervisor, worker, job kinds), `catalogue/`, `seeding/`, `excel/` |
| `services/science/seed/pubchem/` | `names.json` (the hand-written list of names) and `snapshot.json` (what PubChem returned, with URLs and retrieval time) |
| `services/science/tests/` | The test suite |
| `services/science/scripts/` | `build_api_reference.py` |
| `docs/api/` | `science-api.md`, `openapi.json` |

A migration that has been applied must not be edited: the runner compares checksums and refuses to
continue. Add a new numbered file instead.

## Engines

Engines are detected when the service starts, by importing them and running a small real
calculation each. `GET /v1/engines` reports what was found, with the versions read from the
installed libraries. A job kind whose engine is missing is stored with status `unsupported`.

| Engine | In this image | Version | Used for |
|---|---|---|---|
| RDKit | installed and verified | 2026.09.2 (InChI software 1.07.3) | validation, identifiers, descriptors, fingerprints, searches, ETKDGv3 embedding, MMFF94/UFF, conformer search |
| xTB via tblite, with ASE for optimisation | installed and verified | tblite 0.8.0, ASE 3.29.0 | GFN2-xTB and GFN1-xTB single points and geometry optimisation |
| PySCF | installed and verified | 2.15.0 (libxc 7.1.2) | RHF/UHF and Kohn-Sham DFT single-point SCF with a selectable basis and functional |

Job kinds: `rdkit.geometry_optimization`, `rdkit.conformer_search`, `xtb.single_point`,
`xtb.geometry_optimization`, `pyscf.single_point`.

The optional engines can be left out of the image (`MATTERLAB_OPTIONAL_ENGINES=0` at build time) or
switched off at run time (`MATTERLAB_DISABLED_ENGINES=xtb,pyscf`); the service then reports them as
unavailable and their job kinds answer `unsupported`.

Not implemented: no other engines (no periodic DFT, no molecular dynamics, no excited states, no
frequencies or thermochemistry), and no PySCF geometry optimisation.

## Data

Seeded on first start, idempotently (a seed is re-applied only when its input changes):

| Table | Records | Source |
|---|---|---|
| `elements` | 118 | `tools/data/generated/elements.json`: PubChem Periodic Table, RDKit periodic table (radii, valences, isotope masses), Jmol colour for erbium. Field-level attribution is kept in `element_sources`. |
| `isotopes` | 3,383 | `tools/data/generated/isotopes.json`: IAEA Nuclear Data Section, Live Chart of Nuclides (ground states) |
| `functional_groups` | 176 | RDKit's own data files, read from `RDConfig.RDDataDir` at seed time: `FragmentDescriptors.csv` (85), `Functional_Group_Hierarchy.txt` (52), `FunctionalGroups.txt` (39) |
| `compounds` | 296 | PubChem PUG REST, snapshot in `seed/pubchem/snapshot.json` (retrieved 2026-11-13). Canonical SMILES, InChI, InChIKey, formula, masses and fingerprints are computed by RDKit from the PubChem structure; for all records the RDKit InChIKey equals PubChem's. |
| `solvents` | 48 | The same snapshot: name, identifiers, structure, and the molecular weight PubChem returned (with its source) |
| `catalysts` | 33 | The same snapshot, same fields |
| `reactions`, `experiments`, `discoveries`, `calculations` | 0 | Created by users and jobs |

Not sourced, and therefore not stored: physical properties of solvents and catalysts (boiling
points, polarity, and so on) and any reaction data. Two names of the list were not resolved by
PubChem and are skipped with a warning at seed time: "butylated hydroxytoluene" and
"ruthenium(III) chloride".

To refresh the PubChem snapshot (network access needed; sequential requests, at most 3 per second by
default, PubChem's limit being 5):

```powershell
$src = (Resolve-Path 'services\science').Path
docker compose -p matterlab run --rm -v "${src}:/app" science python -m matterlab_science.seeding.pubchem_fetch
```

Only names go into `names.json`. Every identifier and number comes from the snapshot.

## How things work

- **Jobs.** `POST /v1/jobs` stores a row in `calculations` (status `queued`). A supervisor thread in
  the API process claims queued rows (`FOR UPDATE SKIP LOCKED`) and gives each to a worker process
  of its own (`python -m matterlab_science.jobs.worker`), at most `MATTERLAB_JOB_WORKERS` at a time.
  The worker has no database access; it reports progress and its result over a pipe and the
  supervisor validates and stores them. Cancellation and time-outs terminate the worker's process
  group (SIGTERM, then SIGKILL after 3 s). A worker that dies leaves the job `failed` with
  `worker_crashed`; jobs of a service instance that disappeared are marked `failed` (`worker_lost`)
  after `MATTERLAB_JOB_STALE_AFTER_SECONDS`. `MATTERLAB_JOB_WARM_WORKERS` idle workers are kept
  with the libraries already imported, so a job starts in a fraction of a second instead of a few
  seconds.
- **Input hash.** SHA-256 of the canonical JSON of `{kind, input, settings}` with defaults applied.
- **Trajectories of RDKit optimisations.** RDKit does not expose intermediate geometries or the
  iteration count, so `record_trajectory` replays the deterministic minimisation once per frame.
  The answer is identical to a plain run, but the cost is roughly `trajectory_max_frames / 2` times
  higher.
- **Searches.** Exact lookups are SQL on stored columns. Substructure and similarity searches run in
  the service with RDKit on catalogue rows loaded from PostgreSQL (structures and stored Morgan and
  pattern fingerprints). There is no chemistry cartridge in PostgreSQL. The in-memory index reloads
  when the catalogue changes.
- **Discovery candidates.** Status ladder: `user-created`, `structurally-validated`,
  `no-match-in-searched-catalogs`, `computationally-plausible`, `experimentally-observed`,
  `independently-validated`. Responses always list the catalogues searched, the number of records
  and the time, and never describe a candidate as new: a missing match in a 296-record catalogue
  means only that.
- **Excel.** Ten worksheets, PostgreSQL authoritative. See the Excel section of the API reference
  for the import rules.
- **Database outages.** Pooled connections are checked when handed out. While PostgreSQL cannot be
  reached, endpoints that need it answer `503 database_unavailable` and `/health` answers 503.

## Configuration

Environment variables of the service (defaults in parentheses). `docker-compose.yml` passes the
ones that matter for the stack and sets `MATTERLAB_DB_HOST=db`, `MATTERLAB_DB_PORT=5432`.

| Variable | Meaning |
|---|---|
| `MATTERLAB_DATABASE_URL` | Full connection string or URL; overrides the five variables below |
| `MATTERLAB_DB_HOST` (`127.0.0.1`), `MATTERLAB_DB_PORT` (`55432`), `MATTERLAB_DB_USER` (`matterlab`), `MATTERLAB_DB_PASSWORD` (`matterlab_local_dev`), `MATTERLAB_DB_NAME` (`matterlab`) | Database connection. The password is a local-development default, not a secret. |
| `MATTERLAB_CORS_ORIGINS` (`http://127.0.0.1:5273,http://localhost:5273,http://127.0.0.1:4273,http://localhost:4273`) | Allowed browser origins, comma-separated |
| `MATTERLAB_AUTO_MIGRATE` (`true`), `MATTERLAB_AUTO_SEED` (`true`) | Apply migrations / load seeds at start. With `AUTO_MIGRATE=false` the service refuses to start on an outdated schema. |
| `MATTERLAB_MIGRATIONS_DIR` (`/db/migrations`), `MATTERLAB_GENERATED_DATA_DIR` (`/data/generated`), `MATTERLAB_SEED_DIR` (`/app/seed`) | Where migrations, the generated element and isotope files, and the PubChem snapshot are read from |
| `MATTERLAB_DB_CONNECT_TIMEOUT_SECONDS` (`60`) | How long to wait for PostgreSQL at start |
| `MATTERLAB_DB_POOL_MAX_SIZE` (`10`), `MATTERLAB_DB_POOL_TIMEOUT_SECONDS` (`10`) | Connection pool size; how long a request waits for a working connection before answering 503 |
| `MATTERLAB_JOBS_ENABLED` (`true`) | Run the job supervisor in this process |
| `MATTERLAB_JOB_WORKERS` (`2`) | Jobs running at the same time (one process each) |
| `MATTERLAB_JOB_WARM_WORKERS` (`1`) | Idle, pre-loaded worker processes kept ready |
| `MATTERLAB_JOB_THREADS` (`2`) | Numerical threads per worker (OpenMP/BLAS) |
| `MATTERLAB_JOB_TIMEOUT_SECONDS` (`600`), `MATTERLAB_JOB_MAX_TIMEOUT_SECONDS` (`3600`) | Default and maximum time limit of a job |
| `MATTERLAB_JOB_POLL_INTERVAL_SECONDS` (`0.2`), `MATTERLAB_JOB_STALE_AFTER_SECONDS` (`30`) | Supervisor polling interval; when a job without heartbeat counts as lost |
| `MATTERLAB_DISABLED_ENGINES` (empty) | Comma-separated engine ids to switch off: `xtb`, `pyscf` |
| `MATTERLAB_MAX_ATOMS_SYNC` (`300`), `MATTERLAB_MAX_ATOMS_FORCE_FIELD` (`2000`), `MATTERLAB_MAX_ATOMS_XTB` (`300`), `MATTERLAB_MAX_ATOMS_PYSCF` (`60`), `MATTERLAB_MAX_BASIS_FUNCTIONS_PYSCF` (`600`) | Size limits; larger inputs are refused with an explicit message |
| `MATTERLAB_EXTERNAL_LOOKUPS_ENABLED` (`true`) | Allow the PubChem lookup that a discovery request may ask for (`query_pubchem: true`). Nothing is sent to PubChem unless a request asks for it. |
| `MATTERLAB_PUBCHEM_BASE_URL` (`https://pubchem.ncbi.nlm.nih.gov/rest/pug`), `MATTERLAB_PUBCHEM_TIMEOUT_SECONDS` (`15`) | PubChem PUG REST endpoint and time-out |
| `MATTERLAB_MAX_UPLOAD_BYTES` (`52428800`) | Largest workbook accepted by the import |
| `MATTERLAB_HOST` (`0.0.0.0`), `MATTERLAB_PORT` (`8787`), `MATTERLAB_LOG_LEVEL` (`INFO`) | HTTP server |

Compose-only variables: `MATTERLAB_BIND_ADDRESS` (`127.0.0.1`), `MATTERLAB_DB_HOST_PORT` (`55432`),
`MATTERLAB_API_HOST_PORT` (`8787`), and the build argument `MATTERLAB_OPTIONAL_ENGINES` (`1`).

## Tests

`docker compose -p matterlab run --rm science pytest` runs 156 tests against the real database, the
real libraries and real worker processes. Nothing scientific is mocked. Where a test needs a
PubChem answer without the network it replays a recorded real response
(`tests/data/pubchem_recorded.json`); one test queries PubChem live and is skipped, with the reason,
when PubChem cannot be reached.

| File | Covers |
|---|---|
| `test_migrations.py` | Migrations on an empty database, idempotence, checksum protection |
| `test_seeds.py` | 118 elements, 3,383 isotopes, functional groups, catalogue, registered sources, idempotent re-seed |
| `test_chem.py` | Validation with RDKit's messages, 3D generation, descriptors, functional groups |
| `test_jobs.py` | Job lifecycle, deterministic hashing, real cancellation of a running and of a queued job, time-out, killed worker, lost supervisor, trajectories, xTB and PySCF results and failure states, missing engine |
| `test_catalogue.py`, `test_reference.py`, `test_reactions.py` | Exact, substructure and similarity search; reference data; reactions |
| `test_experiments.py` | Save, reopen, change, reproduce |
| `test_discoveries.py` | Workflow, wording, status ladder, evidence rules, PubChem lookup |
| `test_excel.py` | Ten sheets, headers and row counts, round trip, rejected rows, dry run, atomic mode, immutability, import into a second database |
| `test_api_contract.py` | Every operation and every documented response, validated against the OpenAPI schema; database outage |
| `test_errors_cors.py` | CORS for the four frontend origins, the error shape, UTC timestamps |
| `test_provenance.py` | Sources, units, and engine/version/method/settings/convergence of computed results |

## Limitations

- One API process is assumed. Several processes on one database work for jobs (each runs its own
  supervisor), but the in-memory catalogue index and the PubChem rate limiter are per process.
- There is no authentication and no per-user data separation; the stack is for local development.
- The catalogue is a small starter set (296 compounds). Substructure and similarity search scan it
  in memory, which is fine at this size and will not scale to millions of records.
- Jobs are not retried and queued jobs have no priority. A job that was running when the service
  stopped is marked `failed` (`service_shutdown` or `worker_lost`) and has to be submitted again.
- Excel: a value longer than 32,767 characters cannot be stored in a cell and is left out of the
  export (named in `Omitted fields`), so such a record cannot be moved to another instance through a
  workbook. Compound rows are imported from SMILES; a molblock in a workbook is not read.
- Running the service outside Docker (for example in a Windows virtual environment) is not tested.

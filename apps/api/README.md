# MATTER LAB lab API (`apps/api`)

Agent 09's backend for the Astra 3D-laboratory/titration extension: scene and run persistence,
equipment/reagent catalogs, reusable templates and Excel/JSON export, behind the
`/api/v1/lab/**` REST contract in `00_SHARED_INTEGRATION_CONTRACT.md`. It is a **separate Node.js
service** from `services/science` (Python/FastAPI), but shares the **same PostgreSQL database**
and the **same `db/migrations` directory and runner** (the Python migration runner in
`services/science` applies `0006`-`0010` the same way it applies `0001`-`0005`; this service does
not run its own migrations).

Governing rule, same as the rest of MATTER LAB: **nothing is fabricated.** Every observation a run
produces names its method and is labelled `MODEL_CALCULATED`; a scenario the registered method
cannot handle is a durable `UNSUPPORTED`/`FAILED` run, never a guessed number.

- API reference with real request/response examples: [`docs/api/lab-api.md`](../../docs/api/lab-api.md)
- Base URL of the development stack: `http://127.0.0.1:8788`

## Commands

All commands are run from the repository root.

```powershell
# Start PostgreSQL, the science service (applies db/migrations 0001-0010 and seeds reference
# data) and the lab API. First run builds both images.
docker compose -p matterlab up -d --build

# Check
curl.exe http://127.0.0.1:8788/health
curl.exe http://127.0.0.1:8788/api/v1/lab/equipment-definitions -H "Authorization: Bearer matterlab-dev-key"

# Seed the lab equipment/reagent catalogs and the two sample scenes (idempotent)
docker compose -p matterlab run --rm api node node_modules/tsx/dist/cli.mjs apps/api/src/seed/cli.ts

# Run the integration tests (vitest + supertest) against the real stack's database
$env:MATTERLAB_DB_HOST='127.0.0.1'; $env:MATTERLAB_DB_PORT='55432'
npx vitest run --project api

# Stop. The named volume matterlab_pgdata (the database) is kept.
docker compose -p matterlab down
```

### Developing without Docker

```powershell
# Node >=22.12 or >=24 (see root package.json "engines"); npm install at the repo root first.
$env:MATTERLAB_DB_HOST='127.0.0.1'; $env:MATTERLAB_DB_PORT='55432'   # point at a migrated PostgreSQL
npm run dev --workspace @matterlab/api     # tsx watch
npm run seed --workspace @matterlab/api    # equipment/reagent catalogs + sample scenes
```

There is no build step: `tsx` runs the TypeScript source directly, the same way Vite and vitest
already consume the other workspace packages as source. `tsx` is listed in `dependencies`, not
`devDependencies`, because this architecture makes it a runtime requirement, not a dev-only tool;
the Docker image must not set `NODE_ENV=production` before `npm ci`, or it is skipped.

## Layout

| Path | Content |
|---|---|
| `docker-compose.yml` (repository root), `Dockerfile` | The `api` service; depends on `science` being healthy (so lab_* migrations have run) |
| `db/migrations/0006`-`0010` (repository root) | Lab schema: apparatus definitions, scenes/stations/apparatus/connections/containers, runs/observations/events, idempotency keys, reagents, apparatus ordering |
| `packages/contracts/lab/` | Shared zod schemas + TS types (`ExperimentScene`, `Observation`, `RunResult`, equipment/reagent definitions, API request/response envelopes), co-owned with Agent 07 |
| `src/scenes/`, `src/runs/`, `src/templates/`, `src/equipment/` | Persistence (`repository.ts`), DB-row mapping, and (for runs) the method registry/executor |
| `src/runs/methods/strongAcidStrongBase.ts` | The one registered run method: exact charge-balance/water-equilibrium solution for a strong acid vs. strong base - see its file comment for why this exists and what must replace it |
| `src/excel/` | Workbook export (`workbook.ts`) and the formula-injection guard (`sanitize.ts`) |
| `src/seed/` | Provisional equipment catalog, curated reagent list, the two sample scenes, and the seed CLI |
| `test/` | Integration tests against a real PostgreSQL (vitest + supertest) |

## Persistence model

Normalised PostgreSQL tables (not one JSONB blob per scene), so every id is independently indexed
and foreign keys enforce that an apparatus/connection/container always belongs to the scene it
claims to: `lab_scene`, `lab_station`, `apparatus_instance`, `apparatus_connection`,
`container_state`, `apparatus_definition_version`, `lab_reagent`, `lab_template`, `lab_run`,
`lab_action_event`, `lab_run_event`, `lab_observation`, `challenge_attempt`,
`api_idempotency_key`. `lab_scene.revision` is the optimistic-concurrency counter the API's
`ETag`/`If-Match` precondition is checked against. A `lab_run` is immutable once finished: it
carries its own snapshot of the scene (`scene_snapshot`) and the action log it replayed, so a
later edit to the live scene can never change what an already-computed run reports.

## The provisional run method

`services/science` and the rest of this worktree do not contain Agent 06's authoritative chemistry
solver or Agent 07's authoritative apparatus reducer (each is developed in its own worktree in this
multi-agent build). So that the run-lifecycle/persistence layer in this file has a real,
deterministic calculation to exercise end to end - not a stub that always returns the same
number - `src/runs/methods/strongAcidStrongBase.ts` implements the textbook strong-acid/strong-base
titration curve (charge balance plus water autoionisation, Kw = 1.0x10^-14 at 298.15 K) exactly as
named in the shared contract's vertical slice. It is registered under one `methodId`
(`titration.strong_acid_strong_base.charge_balance.v1`) in `src/runs/methodRegistry.ts`, a small
registry designed so Agent 06/07's real implementation can be substituted (or added alongside, for
other experiment templates) without changing the database schema or the REST contract. **This must
be reconciled by the orchestrator** against Agent 06's actual solver and Agent 07's actual action
schema before this is a shared production path.

## Authentication and authorization (placeholder)

There is no real identity provider, matching the rest of the stack (`services/science` has none
either). `MATTERLAB_API_KEYS` (`key1:scope_a,scope_b;key2:scope_a`) configures a static key→scopes
map; the default development key `matterlab-dev-key` grants both `lab:read` and `lab:write`. Every
route declares the scope it needs; see `src/auth.ts`. `X-MatterLab-Owner: <uuid>` is an
unverified, caller-asserted owner id used only to scope `?owner=me` listings - a placeholder for
a real session/identity system.

## Configuration

Environment variables (defaults in parentheses); the five database variables are deliberately
named and defaulted the same as `services/science/matterlab_science/config.py`, so both services
point at the same database without extra configuration.

| Variable | Meaning |
|---|---|
| `MATTERLAB_DATABASE_URL` | Full connection string; overrides the five variables below |
| `MATTERLAB_DB_HOST` (`127.0.0.1`), `MATTERLAB_DB_PORT` (`55432`), `MATTERLAB_DB_USER` (`matterlab`), `MATTERLAB_DB_PASSWORD` (`matterlab_local_dev`), `MATTERLAB_DB_NAME` (`matterlab`) | Database connection |
| `MATTERLAB_API_HOST` (`0.0.0.0`), `MATTERLAB_API_PORT` (`8788`) | HTTP server |
| `MATTERLAB_CORS_ORIGINS` | Allowed browser origins, comma-separated (same default as the science service) |
| `MATTERLAB_API_KEYS` (`matterlab-dev-key:lab:read,lab:write`) | API keys and their scopes |
| `MATTERLAB_DB_POOL_MAX_SIZE` (`10`), `MATTERLAB_DB_POOL_IDLE_TIMEOUT_MS` (`30000`), `MATTERLAB_DB_CONNECT_TIMEOUT_MS` (`10000`) | Connection pool |
| `MATTERLAB_API_MAX_JSON_BODY_BYTES` (`2000000`) | Largest accepted JSON request body |
| `MATTERLAB_API_MAX_EXPORT_ROWS` (`50000`) | Declared safety limit for exports (not yet enforced per-sheet; see "Known limitations") |
| `MATTERLAB_API_RUN_START_DELAY_MS` (`20`) | Delay before a run starts computing, so `POST .../cancel` has a real window to take effect; raised in tests, not meant to be raised in production |

## Tests

```powershell
$env:MATTERLAB_DB_HOST='127.0.0.1'; $env:MATTERLAB_DB_PORT='<a migrated PostgreSQL port>'
npx vitest run --project api
```

Integration tests against a real, already-migrated PostgreSQL (they do not apply migrations
themselves; point them at a database with `db/migrations` 0001-0010 applied, e.g. via
`docker compose run --rm science python -m matterlab_science migrate`).

| File | Covers |
|---|---|
| `test/scenes.test.ts` | Save/reopen exact state, `If-Match` revision conflicts (two concurrent editors), duplicate isolation, pagination, 404s |
| `test/runs.test.ts` | The real computed titration curve (pH 1 -> ~7 at equivalence -> strongly basic), durable `UNSUPPORTED`/`FAILED` (no fake results), idempotency keys, cancellation |
| `test/excel.test.ts` | JSON round trip, the eight required sheets, correct numeric types, and that no cell is ever a real formula (verified against the exported workbook's cell types) |
| `test/catalogAndSeed.test.ts` | Equipment/reagent catalog filtering and cross-linking, templates, idempotent seeding with no observations/runs shipped |

## Known limitations

- The strong-acid/strong-base method is provisional (see above) and recognises only a small,
  explicitly listed set of strong acids/bases; anything else is `UNSUPPORTED`, never guessed.
- A run executes in-process as soon as it is queued (after `MATTERLAB_API_RUN_START_DELAY_MS`),
  not in a separate worker process/pool the way `services/science`'s jobs do; there is no
  per-instance job supervisor or crash recovery for a run that was mid-flight when the process
  stopped.
- `MATTERLAB_API_MAX_EXPORT_ROWS` is declared but not yet enforced; a very large scene's export is
  not currently capped.
- No authentication beyond the static API-key/scope placeholder described above.

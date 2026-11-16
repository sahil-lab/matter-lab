# Laboratory persistence, catalogues and exports

This is an **additive extension of the existing FastAPI/PostgreSQL service**, not a second API.
Existing `/v1` endpoints, data and error responses remain unchanged. New endpoints are under
`/api/v1/lab`. Migration `0006_laboratory_persistence.sql` adds private scenes/templates,
immutable runs and append-only ledgers without rewriting migrations `0001`–`0005`.
Forward migration `0007` adds nullable learning draft metadata; it does not rewrite `0006`.
Forward migration `0008` adds Agent04's nullable editor-only metadata; neither prior migration changes.

## Authority and reproducibility

- `@matterlab/contracts` is the only scene/action/runtime schema, currently contract **1.1.0**,
  scene schema **1**. Python validates its generated JSON Schema and invokes a small bundled
  adapter around the **same TypeScript semantic validators**. It does not maintain another scene model.
- `@matterlab/lab-runtime` is the sole apparatus/action writer; `@matterlab/lab-science` is the
  sole chemistry implementation. A backend run invokes the bundled Node replay entry point, not
  a Python titration implementation. No client-supplied observation is accepted as a server result.
- Position is **m**, volume **L**, inventory **mol**, concentration **mol/L**, temperature **K**,
  time **s**. Visual calibration is not experimental evidence.
- `inputHash` is lowercase SHA-256 of RFC 8785/JCS canonical `NodeRunRequest`, omitting **only**
  `runId`. Versions, initial scene, ordered steps and explicit limits remain in the hash.
- `runnerSha256` separately pins the entire installed executable release: entry filename, sorted
  relative `.mjs/.js/.cjs/.json` filenames and their SHA-256 digests. Shared chunks/catalogues
  cannot change silently after enqueue.
- PostgreSQL guards run input immutability and terminal result immutability; run events, action
  receipts and observations are append-only. Cancellation cannot overwrite a terminal result,
  and late worker results cannot overwrite cancellation. Stale workers become `FAILED/WORKER_LOST`.

### The two revisions and checkpoint rule

`ExperimentScene.revision` is the **durable save revision** returned in a strong ETag.
`LabAction.expectedRevision` refers instead to **RuntimeSnapshot.revision**.

Scene metadata includes a nullable `runtimeCheckpoint` sidecar. It retains the initial scene,
ordered steps, completed-step count, limits, snapshot and full sequence/epoch/deduplication history.
The checkpoint snapshot must equal the submitted current scene, ignoring **only** durable revision.
Saved browser checkpoints are drafts, not trusted calculations.

The optional `learningState` sidecar uses Agent08's exact
`{schemaVersion:1,kind:'MATTERLAB_LEARNING_STATE',attempts:[...]}` format and pure parser/schema.
It is limited to 4 MiB, preserved atomically under the scene revision and in JSON exports/cache,
and frozen separately at run enqueue. It is **CLIENT/DRAFT** data, not trusted scores or server
observations, and is deliberately excluded from the scientific input hash. Duplicate/template
instantiation clears it. A PATCH that omits it preserves it.

Optional `editorState` uses Agent04's pure `parseEditorState` and exact JSON Schema (256 KiB).
It stores scene-bound selection, locks, groups, precision and original transforms separately,
never by injecting save-only data into `scene.viewport` or rewriting a runtime checkpoint.
Call `editor.prepareSave()`, persist its `editor` as `editorState`, then call
`editor.acknowledgeSave(theSameTicket, resource.scene.revision)`. Do not overwrite newer edits.
Scene duplication and template instantiation clear this sidecar too.

When a checkpoint exists, run enqueue freezes:

```
checkpoint.initialScene + checkpoint.steps + request.steps
```

`request.steps` means **additional NEW commands**, never the history again. For an exact replay,
send no additional steps. Saved checkpoint limits and version pins are retained. Without a
checkpoint, replay starts from the saved scene. A scene-changing PATCH must explicitly update
or clear an existing checkpoint. Duplicate/template instantiation creates new scene/station/
apparatus/connection IDs and clears checkpoint/history; it never links another scene's runs.

## Authentication and local setup

The lab API fails closed until bearer principals are configured. Configure
`MATTERLAB_LAB_AUTH_TOKENS_JSON` as an array of:

```
{ "sha256": "<SHA-256 of a high-entropy token>", "ownerId": "<UUID>",
  "scopes": ["lab:read", "lab:write", "lab:run", "lab:export"] }
```

Tokens themselves never go in source, URLs, logs, browser storage or exported notebooks. Generate
a local-development credential in the **current PowerShell process**, then start this project's
stack from the same process:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes)
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))).Replace('-', '').ToLowerInvariant()
$sha.Dispose()
$owner = [Guid]::NewGuid().ToString()
$env:MATTERLAB_LAB_AUTH_TOKENS_JSON = ConvertTo-Json -Compress -InputObject @(
  @{ sha256 = $hash; ownerId = $owner; scopes = @('lab:read','lab:write','lab:run','lab:export') }
)
# Read $token in this terminal and paste it into Connected science's memory-only password field.
# Do not save it to .env, source control, screenshots, notebooks or browser storage.
docker compose -p matterlab up -d --build db science
```

Compose keeps the existing `matterlab_pgdata` volume. **Do not remove it or restart Docker Desktop
as a recovery step.** If project network/container creation stalls, stop the owned command and
report that PostgreSQL/API verification is blocked; a browser cache is not a substitute database.

This bearer configuration is a deliberately explicit deployment credential mechanism, not an
OIDC provider. Legacy `/v1` remains a shared **local-development** API. Before internet exposure,
put the entire service behind an authenticated gateway, provision individual principal scopes,
TLS, rotation/retention policies, and OS/container resource/egress controls.

CORS defaults remain the four existing local web/preview origins. Desktop builds may explicitly
add `http://tauri.localhost` and/or `tauri://localhost` to `MATTERLAB_CORS_ORIGINS`; no wildcard or
credentialed-cookie policy is added. The client refuses remote plaintext HTTP and credentialed URLs.

## Build the shared release (no second catalogue)

In a normal checkout, dependencies must first be installed by the repository's package owner from
the committed manifests/lockfile. **Do not run npm install from junction-shared agent worktrees.**

From the repository root:

```powershell
npm run build --workspace @matterlab/lab-science
npm run build --workspace @matterlab/lab-runtime
npx vite build --config services\science\node\vite.config.ts
npx vite build --config services\science\node\vite.catalog.config.ts
node services\science\node\dist\export-catalog.mjs
```

Run the catalogue exporter **after** the runtime build, whose clean output step can remove the
old release directory. It reads the parent's pure `apparatusRegistry` and `createTitrationSetup`
and Agent06's real getters/preparation function. It produces:

- `packages/lab-runtime/dist/catalog/equipment-definitions.json`
- `packages/lab-runtime/dist/catalog/reagent-definitions.json`
- `packages/lab-runtime/dist/catalog/source-references.json`
- `packages/lab-runtime/dist/catalog/starter-scene.json`
- `packages/lab-runtime/dist/catalog/learning-state.schema.json` (generated from Agent08, not a second schema)
- `packages/lab-runtime/dist/catalog/editor-state.schema.json` (generated from Agent04)

The starter retains the parent's **unfilled** titration station plus independent blank bench.
Its suggested virtual HCl/NaOH FILL commands use `prepareSolution`; there are no precomputed pH
observations, manual species mappings or invented scientific results. Dispatch these commands
through the runtime; do not assign inventories directly.

### Configuration

| Variable | Default / purpose |
|---|---|
| `MATTERLAB_LAB_SCHEMA_PATH` | `packages/contracts/schemas/lab-v1.schema.json` |
| `MATTERLAB_LAB_VALIDATOR_PATH` | `services/science/node/dist/validate.mjs` |
| `MATTERLAB_LAB_RUNNER_PATH` | `packages/lab-runtime/dist/cli.mjs` |
| `MATTERLAB_LAB_CATALOG_DIR` | `packages/lab-runtime/dist/catalog` |
| `MATTERLAB_LAB_NODE_BINARY` | `node` (Node 22.12+/24 recommended) |
| `MATTERLAB_LAB_CONTRACT_VERSION` | `1.1.0`; explicit saved-version mismatch is rejected |
| `MATTERLAB_LAB_RUNTIME_VERSION` / `MATTERLAB_LAB_METHOD_VERSION` | `1.0.0` |
| `MATTERLAB_LAB_MAX_REQUEST_BYTES` | 8 MiB bounded JSON request/replay input |
| `MATTERLAB_LAB_MAX_OUTPUT_BYTES` | 16 MiB per Node result |
| `MATTERLAB_LAB_RUN_TIMEOUT_SECONDS` | 60 s, finite wall-clock deadline |
| `MATTERLAB_LAB_VALIDATION_TIMEOUT_SECONDS` | 5 s per shared semantic validator; tests explicitly allow slower shared-host startup |
| `MATTERLAB_LAB_MAX_ACTIVE_RUNS` | 4 per owner |
| `MATTERLAB_LAB_MAX_RUNS` | 1000 immutable runs per owner |
| `MATTERLAB_LAB_MAX_SCENES` | 200 scenes and 200 templates per owner |

The Node child receives no database/auth credentials, runs without a shell, has a bounded V8 heap,
read-only Node filesystem permissions, bounded stdin/stdout/stderr and a hard kill deadline.
This is not a claim of a separate OS network namespace. Production egress/resource isolation
belongs to deployment policy.

## HTTP surface

Interactive OpenAPI is still at `/docs`, with the complete document at `/openapi.json`. The document
includes the **actual shared schemas** under `components.schemas.Lab*`; field-level types are not
independently handwritten Python scene classes.

| Method/path below `/api/v1/lab` | Result / requirements |
|---|---|
| `GET /capabilities` | Own principal/scopes, version pins, installed bundle flags and units policy |
| `GET /equipment-definitions`, `GET /reagents` | Search `q`, `limit`, `offset`; explicitly curated, not all compounds |
| `GET /seed-scene` | Unpersisted draft plus suggested FILL steps, `saved:false`, freshly remapped IDs |
| `POST /scenes` | `{title,scene,runtimeCheckpoint?}`; `Idempotency-Key`; 201 + ETag |
| `GET /scenes` | Owner-only summaries; `q`, `limit`, `offset` |
| `GET /scenes/{id}` | `{scene,title,runtimeCheckpoint,createdAt,updatedAt}` + ETag |
| `PATCH /scenes/{id}` | `{title?,scene?,runtimeCheckpoint?}`; strong `If-Match` required |
| `POST /scenes/{id}/duplicate` | `{title?}` + `Idempotency-Key`; independent IDs/history |
| `POST /scenes/{id}/runs` | `{expectedRevision,steps?,limits?}` + `Idempotency-Key`; 202 frozen run |
| `GET /scenes/{id}/runs` | Paginated lightweight run summaries, not large result blobs |
| `GET /runs/{id}` | Immutable input/result/checkpoint, failure code, release hash, calibration/provenance |
| `GET /runs/{id}/events` | Authenticated SSE; reconnect with numeric `Last-Event-ID` |
| `POST /runs/{id}/cancel` | Idempotent terminal/pending-cancellation result |
| `GET /runs/{id}/observations` | Owner-only observation page, `limit`, `offset` |
| `GET /scenes/{id}/export?format=json\|xlsx&runId=...` | Owner-scoped snapshot, optional one-run scope |
| `POST /templates` | `{title,sceneId,expectedRevision,kind:'SCENE'\|'ASSEMBLY'}` + idempotency |
| `GET /templates` | Private reusable snapshots; `q`, `limit`, `offset` |
| `POST /templates/{id}/instantiate` | `{title?}` + idempotency; fresh independent scene |

Create/job idempotency is scoped by authenticated owner and route. Identical retries return the
original committed response; key reuse with another request returns `409 IDEMPOTENCY_CONFLICT`.
Missing If-Match is `428 REVISION_REQUIRED`; stale revisions are `409 REVISION_CONFLICT`.
Unauthorized resources deliberately appear not found. Action `actorId`, if supplied, must match
the authenticated owner. Error bodies on **new** routes are RFC 9457 Problem Details with stable
codes, trace IDs and `application/problem+json`.

## Export guarantees

Lab XLSX always contains **Equipment, Stations, Connections, Conditions, Trial Measurements,
Titration Curve, Observations, Sources**. Quantities remain numeric with explicit units; strings
are explicit Excel text cells, including `=`, `+`, `-`, `@` and whitespace-prefixed attacks.
There are no formulas, external links or code evaluation. Values too long for Excel cause an
explicit JSON-export recommendation instead of silent truncation; XML-illegal control characters
are replaced only in the readable workbook, not the exact JSON archive.

Titration delivered volume is exported **only** from the runtime's source/receiver-associated
accepted-transfer metadata. It is never inferred from total container volume. Ambiguous volume
cells stay blank with a warning. Sources retain distinct versions and their scene/run scopes.
Catalogues/calibrations already saved with a scene do not silently update after catalogue changes.

JSON keeps the exact scene, browser checkpoint, immutable run input/result/checkpoint, release
hash, units and source snapshots. Import returns only an unverified draft; it cannot create
trusted immutable server results. Limit: 100 runs / 100,000 observations / 64 MiB per export;
use `runId` to scope larger histories.

## Frontend integration

`apps/web/src/ui/backend/BackendPanel` handles existing service connection, legacy catalogues and
Excel preview/commit. `apps/web/src/lab/persistence` exports:

- `LabApiClient`, `ScenePersistenceCoordinator`
- `LabPersistencePanel` (controlled callbacks; no mutation of Agent07's runtime)
- `MemoryDraftCache`, opt-in `LocalDraftCache`, `importSceneDraft`

Pass a verified in-memory `ScienceClient` to `new LabApiClient(client)`. Query `capabilities()` for
the authenticated owner/scopes. A browser cache namespace should contain the **nonsecret**
owner ID and service URL, never a token. `onSaved` updates durable revision metadata only: **do not
replace a live, possibly newer runtime snapshot with the completed save response**. `onOpen`
is the explicit operation that replaces/restores the current draft. JSON import must clear any
claimed remote revision until a real server save or reopen confirms it.

The coordinator serializes writes, retains a failed draft, retries an ambiguous create with the
same key/payload, never silently resolves conflicts, and never labels newer in-flight edits saved.
SSE uses authenticated `fetch`, not tokens in EventSource URLs.

## Focused verification

```powershell
$env:PYTHONPATH = (Resolve-Path 'services\science').Path
python -m pytest services\science\tests\test_lab_contracts.py services\science\tests\test_lab_api.py -q
npx vitest run --config services\science\node\vitest.config.ts
npx tsc -p services\science\node\tsconfig.web.json --noEmit
```

The local Node build steps above are prerequisites. The API/migration module uses **real
PostgreSQL and disposable uniquely named test databases**. It explicitly skips if the project
database is unreachable; a skip is not an integration pass. The existing migration suite also
checks the new table set. On available infrastructure, additionally run `tests/test_migrations.py`
against a clean DB and the upgraded v1 fixture; never point destructive test setup at user data.

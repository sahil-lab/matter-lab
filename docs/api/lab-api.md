# MATTER LAB lab API (Astra extension)

Reference for the Astra 3D-laboratory backend (`apps/api`), version 0.1.0. This is a **separate**
service from `services/science`: it owns the new `lab_*` tables and the
`/api/v1/lab/**` endpoints described in `00_SHARED_INTEGRATION_CONTRACT.md` Section 5, on the
**same PostgreSQL database** as the existing science service. Base URL of the development stack:
`http://127.0.0.1:8788` (a different port from the science service's `8787`, so both can run at
once).

Every example below is a real HTTP exchange captured on 2026-11-16 from the service running
against a freshly migrated database (schema version 0010) seeded with `npm run seed --workspace
@matterlab/api`. Nothing was edited except to omit repeated boilerplate headers.

## Conventions

- **Problem Details (RFC 9457).** Every non-2xx response is `application/problem+json`:
  `{"type", "title", "status", "detail", "code", "errors"?}`. `code` is stable and
  machine-readable; `errors` (field path + message) is present for `code: "validation_error"`.
  This is a different, newer shape than the existing science service's
  `{"error": {code, message, details}}` - the two services are not required to share an error
  format, and this one follows the contract's explicit RFC 9457 requirement.
- **Units.** Scene coordinates are metres, volume litres, concentration mol/L, temperature kelvin,
  time seconds, exactly as fixed by the shared contract. Every `Quantity` carries its own `unit`.
- **Evidence.** `Observation.evidence` and `EquipmentDefinition.evidence` use
  `REFERENCE_MEASURED | MODEL_CALCULATED | ILLUSTRATIVE | UNVERIFIED | UNSUPPORTED` - the Astra
  vocabulary, not `@matterlab/core`'s `EvidenceLevel`.
- **Optimistic concurrency.** `GET`/`POST`/`PATCH`/duplicate on a scene return an `ETag: W/"rev-N"`
  header, where `N` is `revision`. `PATCH` requires `If-Match: W/"rev-N"`; a missing header is
  `428 Precondition Required`, a stale one is `409 Conflict` (`revision_conflict`) and the scene is
  **not** changed.
- **Idempotency.** `POST` endpoints that create a resource or queue a run accept an
  `Idempotency-Key` header. Retrying the same request with the same key and body returns the
  original response; reusing the key with a different body is `409`
  (`idempotency_key_reused`).
- **Authentication (placeholder).** `Authorization: Bearer <key>` or `X-MatterLab-Api-Key: <key>`
  is required on every `/api/v1/lab/**` request; missing/unknown key is `401`, a key without the
  needed scope is `403`. This is a development placeholder for a real identity provider - see
  "Authentication and authorization" in `apps/api/README.md`. Default development key:
  `matterlab-dev-key` (scopes `lab:read`, `lab:write`), set via `MATTERLAB_API_KEYS`.
- **Ownership.** An optional `X-MatterLab-Owner: <uuid>` header scopes `?owner=me` listings; scenes
  created without it have `ownerId: null`.
- **No invented results.** A run that cannot be computed ends `UNSUPPORTED` or `FAILED` with
  `failureCode`/`failureMessage` and no observations; nothing is guessed.
- **CORS.** Same allowed origins as the science service by default
  (`MATTERLAB_CORS_ORIGINS`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness and database reachability |
| `GET` | `/api/v1/lab/equipment-definitions` | Current version of every apparatus definition, optionally filtered by `kind`/`capability` |
| `GET` | `/api/v1/lab/equipment-definitions/{key}` | One definition (optionally a specific `?version=`) |
| `GET` | `/api/v1/lab/reagents` | Curated reagent catalog, optionally filtered by `role` |
| `GET` | `/api/v1/lab/reagents/{speciesId}` | One reagent, with its link into the existing compound catalogue |
| `GET` | `/api/v1/lab/scenes` | List scenes, paginated, optionally `?owner=me` |
| `POST` | `/api/v1/lab/scenes` | Create a scene |
| `GET` | `/api/v1/lab/scenes/{id}` | Reopen a scene |
| `PATCH` | `/api/v1/lab/scenes/{id}` | Change a scene (`If-Match` required) |
| `DELETE` | `/api/v1/lab/scenes/{id}` | Delete a scene |
| `POST` | `/api/v1/lab/scenes/{id}/duplicate` | Duplicate a scene with new ids, fully isolated from the original |
| `GET` | `/api/v1/lab/scenes/{id}/export?format=json\|xlsx` | Export the scene (exact JSON round trip, or the eight-sheet workbook) |
| `GET` | `/api/v1/lab/scenes/{id}/runs` | List runs of a scene, newest first |
| `POST` | `/api/v1/lab/scenes/{id}/runs` | Queue a run (`202` + `runId`) |
| `GET` | `/api/v1/lab/runs/{runId}` | Get a run: status, observations, warnings, assumptions, diagnostics |
| `GET` | `/api/v1/lab/runs/{runId}/observations` | Just the observations of a run |
| `GET` | `/api/v1/lab/runs/{runId}/events` | Server-Sent Events stream of run lifecycle/progress |
| `POST` | `/api/v1/lab/runs/{runId}/cancel` | Request cancellation |
| `GET` | `/api/v1/lab/templates` | List named reusable equipment assemblies |
| `POST` | `/api/v1/lab/templates` | Create a template |
| `GET` | `/api/v1/lab/templates/{id}` | Get a template |
| `DELETE` | `/api/v1/lab/templates/{id}` | Delete a template |

## Equipment definitions

### `GET /api/v1/lab/equipment-definitions?kind=BURETTE`

```json
{
  "items": [
    {
      "key": "burette-50ml",
      "version": 1,
      "kind": "BURETTE",
      "name": "50 mL burette",
      "description": "Class A 50.00 mL burette, 0.1 mL graduations.",
      "capabilities": ["CONTAINER", "FLOW_SOURCE", "MOUNTABLE"],
      "sockets": [
        { "id": "clamp-grip", "kind": "MECHANICAL", "label": "held by a clamp" },
        { "id": "tip", "kind": "FLUID", "label": "stopcock tip (delivers to a receiver)" }
      ],
      "capacity": { "unit": "L", "value": 0.05 },
      "dimensionsM": { "depth": 0.02, "width": 0.02, "height": 0.6 },
      "controlActions": ["FILL", "SET_VALVE", "TRANSFER", "RESET"],
      "defaultConfig": { "valveOpenFraction": 0 },
      "evidence": "UNVERIFIED",
      "notes": "50.00 mL capacity is the standard Class A burette specification, not a measurement of a specific physical item. Placeholder pending Agent 03 apparatus assets."
    }
  ],
  "total": 1,
  "limit": 1,
  "offset": 0
}
```

`evidence: "UNVERIFIED"` on every seeded definition is deliberate: these ten stock definitions
(`bench-standard`, `stand-standard`, `clamp-standard`, `burette-50ml`, `erlenmeyer-flask-250ml`,
`beaker-250ml`, `volumetric-pipette-25ml`, `magnetic-stirrer-standard`, `ph-probe-standard`,
`analytical-balance-standard`) are Agent 09's placeholder catalog, not Agent 03's authoritative
apparatus assets; they are never reported as measured.

## Reagents

### `GET /api/v1/lab/reagents`

Six curated entries, each cross-linked to the existing `compounds` catalogue (services/science) by
name at seed time:

```json
{
  "items": [
    { "speciesId": "HCl(aq)", "name": "Hydrochloric acid", "formula": "HCl", "roles": ["ANALYTE"],
      "scienceCompoundId": "8aa61b34-a38c-5a6d-8f70-99bdcebe7e3b",
      "recommendedConcentrationMolPerL": { "min": 0.01, "max": 1 },
      "hazardNotes": "Corrosive at laboratory concentrations above approximately 1 mol/L; dilute educational concentrations only.",
      "sourceKey": "matterlab-api-stub-equipment" },
    { "speciesId": "NaOH(aq)", "name": "Sodium hydroxide", "formula": "NaOH", "roles": ["TITRANT", "ANALYTE"],
      "scienceCompoundId": "35adfc67-ddb8-5c76-a7d3-6d2ff280fea4", "…": "…" },
    { "speciesId": "CH3COOH(aq)", "name": "Acetic acid", "roles": ["ANALYTE"],
      "hazardNotes": "Weak acid: not modeled by the strong-acid/strong-base run method currently registered; a run against this species reports UNSUPPORTED.", "…": "…" }
  ],
  "total": 6
}
```

## Scenes

### `POST /api/v1/lab/scenes` (`201`)

Request body (`SceneCreateRequest`): `title`, and the `ExperimentScene` fields the client already
holds (`stations`, `apparatus`, `connections`, `containerStates`, `simulationConfig`, `viewport?`).
IDs for stations/apparatus/connections are assigned by the caller (Agent 07's reducer owns live
apparatus ids) and stored verbatim. Response: the full `SceneRecord` with `id`, `revision: 1`,
`ETag: W/"rev-1"`, `Location`.

### `GET /api/v1/lab/scenes/{id}` (`200`)

```json
{
  "id": "e7e1b529-22fa-4095-92b9-945de00a000c",
  "revision": 1,
  "schemaVersion": 1,
  "title": "Titration Station (seed)",
  "ownerId": null,
  "stations": [{ "id": "e7ee9fe2-fa63-472f-895a-8caee3ebb184", "name": "Titration Station" }],
  "apparatus": [
    { "id": "…", "kind": "BENCH", "definitionId": "bench-standard", "transform": { "positionM": [0,0,0], "quaternion": [0,0,0,1] }, "revision": 0, "config": {}, "capabilities": ["MOUNT"], "stationId": "…" },
    { "id": "f05f9012-3871-4826-9417-665419c6451d", "kind": "FLASK", "definitionId": "erlenmeyer-flask-250ml", "capabilities": ["CONTAINER", "FLOW_RECEIVER"], "…": "…" },
    { "id": "69cc8a63-9a81-4b66-927f-240e5a502e9c", "kind": "BURETTE", "definitionId": "burette-50ml", "capabilities": ["CONTAINER", "FLOW_SOURCE"], "config": { "valveOpenFraction": 0 }, "…": "…" }
  ],
  "connections": [ "… 5 MECHANICAL/FLUID/SENSOR connections (bench-stand-clamp-burette, burette-flask, probe-flask) …" ],
  "containerStates": {
    "f05f9012-3871-4826-9417-665419c6451d": { "volumeL": 0.025, "species": [{ "speciesId": "HCl(aq)", "moles": 0.0025 }], "temperatureK": 298.15, "mixing": "WELL_MIXED", "modelId": "ideal-well-mixed-v1" },
    "69cc8a63-9a81-4b66-927f-240e5a502e9c": { "volumeL": 0.05, "species": [{ "speciesId": "NaOH(aq)", "moles": 0.005 }], "temperatureK": 298.15, "mixing": "WELL_MIXED", "modelId": "ideal-well-mixed-v1" }
  },
  "simulationConfig": { "methodId": "fixed-tick-v1", "timeStepS": 0.1 },
  "createdAt": "2026-11-16T18:54:50.806Z",
  "updatedAt": "2026-11-16T18:54:50.806Z"
}
```

(`ETag: W/"rev-1"` header; apparatus/connections truncated above for length - every field is
present in the real response.)

### `PATCH /api/v1/lab/scenes/{id}` - conflict handling

Without `If-Match`:

```
HTTP/1.1 428 Precondition Required
{"type":"about:blank","title":"Precondition required","status":428,
 "detail":"PATCH requires an If-Match header carrying the scene’s current ETag (see the Get response).",
 "code":"precondition_required"}
```

With a stale `If-Match: W/"rev-999"`:

```
HTTP/1.1 409 Conflict
{"type":"about:blank","title":"Conflict","status":409,
 "detail":"The resource is at revision 1, not 999; it was changed since you loaded it (If-Match did not match).",
 "code":"revision_conflict"}
```

Only `title`/`simulationConfig`/`viewport` can be changed independently; if the request includes
any of `stations`/`apparatus`/`connections`/`containerStates`, all four are replaced together
(omitted ones default to their current value) so the apparatus graph is never left in a
partially-updated, internally-inconsistent state.

### `POST /api/v1/lab/scenes/{id}/duplicate` (`201`)

Copies the scene with brand-new ids for every station, apparatus instance and connection (and
re-keys `containerStates` to match); `revision` restarts at 1; `duplicatedFromId` (database column,
not in the API response) records the origin for traceability only. Editing the duplicate never
changes the original, and vice versa.

## Runs

### `POST /api/v1/lab/scenes/{id}/runs` (`202`)

```json
// request
{
  "methodId": "titration.strong_acid_strong_base.charge_balance.v1",
  "actions": [
    { "actionId": "…", "atSimulationS": 1, "targetInstanceId": "f05f9012-…", "type": "TRANSFER", "payload": { "sourceInstanceId": "69cc8a63-…", "deliveredVolumeL": 0.005 } }
    // … one TRANSFER action per 5 mL increment delivered …
  ]
}
```

```json
// 202 response
{ "runId": "aa4c45a2-211b-4cd3-8542-e2c278e19194", "sceneId": "e7e1b529-…", "sceneRevision": 1,
  "status": "QUEUED", "methodId": "titration.strong_acid_strong_base.charge_balance.v1", "methodVersion": "1.0.0",
  "inputHash": "b55d48ed9940…", "observations": [], "warnings": [], "assumptions": [],
  "createdAt": "2026-11-16T19:24:48.432Z", "startedAt": null, "finishedAt": null }
```

### `GET /api/v1/lab/runs/{runId}` once finished - the real computed titration curve

25.00 mL of 0.100 mol/L HCl titrated with 0.100 mol/L NaOH in 5 mL steps, via the exact
charge-balance/water-equilibrium method (`titration.strong_acid_strong_base.charge_balance.v1`,
see `apps/api/src/runs/methods/strongAcidStrongBase.ts`):

| Delivered (mL) | pH (computed) |
|---|---|
| 0 | 1.0000 |
| 5 | 1.1761 |
| 10 | 1.3680 |
| 15 | 1.6021 |
| 20 | 1.9542 |
| 25 (equivalence) | **7.0000** |

```json
{
  "runId": "aa4c45a2-211b-4cd3-8542-e2c278e19194", "status": "SUCCEEDED",
  "methodId": "titration.strong_acid_strong_base.charge_balance.v1", "methodVersion": "1.0.0",
  "observations": [
    { "type": "VOLUME", "apparatusId": "69cc8a63-…", "timeS": 0, "quantity": { "value": 0, "unit": "L" }, "evidence": "MODEL_CALCULATED", "methodId": "titration.strong_acid_strong_base.charge_balance.v1", "sourceIds": ["titration.strong_acid_strong_base.charge_balance.v1"] },
    { "type": "PH", "apparatusId": "f05f9012-…", "timeS": 0, "quantity": { "value": 0.9999999999995657, "unit": "pH" }, "evidence": "MODEL_CALCULATED", "…": "…" },
    "… one VOLUME/PH pair per step …",
    { "type": "PH", "apparatusId": "f05f9012-…", "timeS": 5, "quantity": { "value": 7, "unit": "pH" }, "evidence": "MODEL_CALCULATED", "…": "…" }
  ],
  "warnings": [],
  "assumptions": [
    "Ideal strong-acid/strong-base charge-balance equilibrium with water autoionization (Kw = 1.0e-14 at 298.15 K).",
    "Complete dissociation of the strong acid and strong base; concentrations are used directly, not activities.",
    "Well-mixed, isothermal, negligible volume contraction on mixing (volumes add linearly).",
    "Only the single recognised strong-acid/strong-base pair is modeled; any other species present is excluded from the equilibrium (see warnings)."
  ],
  "solverDiagnostics": { "steps": 5, "flaskId": "f05f9012-…", "buretteId": "69cc8a63-…", "stationId": "e7ee9fe2-…" },
  "createdAt": "2026-11-16T19:24:48.432Z", "startedAt": "2026-11-16T19:24:48.510Z", "finishedAt": "2026-11-16T19:24:48.649Z"
}
```

### Unsupported and failed runs

- Analyte/titrant not in the method's recognised strong-acid/strong-base list (e.g. the catalogued
  but weak `CH3COOH(aq)`): `status: "UNSUPPORTED"`, `failureCode: "unrecognized_analyte"`, empty
  `observations`.
- An unregistered `methodId`: `status: "UNSUPPORTED"`, `failureCode: "unknown_method"`.
- A `TRANSFER` that would draw more than the burette's remaining volume:
  `status: "FAILED"`, `failureCode: "titrant_volume_exceeded"`.

None of these is an HTTP error: the request is accepted (`202`), the run is created, and the
unsupported/failed outcome is the durable, honestly labelled result (see
`apps/api/test/runs.test.ts`).

### `GET /api/v1/lab/runs/{runId}/events` (SSE)

`Content-Type: text/event-stream`; each event is `id: <sequence>`, `event: run-status`,
`data: {"sequence","at","status","message","observation"?}`. The stream replays every
`lab_run_event` row from `?after=`/`Last-Event-ID` onward and closes once a terminal status
(`SUCCEEDED`/`FAILED`/`CANCELLED`/`UNSUPPORTED`) is written.

## Export

### `GET /api/v1/lab/scenes/{id}/export?format=json`

Returns the same `SceneRecord` shape as `GET /scenes/{id}` (`X-MatterLab-Schema-Version: 1`
header). Feeding `stations`/`apparatus`/`connections`/`containerStates`/`simulationConfig` back
into `POST /scenes` (after remapping ids, since they are global primary keys - see
`apps/api/test/excel.test.ts`) reproduces an equivalent scene exactly.

### `GET /api/v1/lab/scenes/{id}/export?format=xlsx`

```
HTTP/1.1 200 OK
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="scene-e7e1b529-22fa-4095-92b9-945de00a000c.xlsx"
X-MatterLab-Exported-At: 2026-11-16T19:25:35.715Z
Content-Length: 15194
```

Eight sheets, in this fixed order: **Equipment, Stations, Connections, Conditions, Trial
Measurements, Titration Curve, Observations, Sources**. Every numeric column states its unit in the
header (`Volume (L)`, `Temperature (K)`, `Position x (m)`, …). No formula is ever written: every
cell is assigned a primitive string/number/boolean, which `exceljs` stores as a literal shared
string regardless of its content (verified by inspecting the underlying XML - see
`apps/api/src/excel/sanitize.ts`); free-text fields (station names, failure messages) are
additionally prefixed with `'` when they start with a formula-trigger character (`=+-@`, tab, CR)
as defence in depth. `apps/api/test/excel.test.ts` asserts no cell in a real exported workbook is
ever of exceljs's `Formula` type.

## Templates

### `POST /api/v1/lab/templates` (`201`)

```json
// request
{ "name": "Clamp stand assembly", "apparatus": [ /* ApparatusInstance[] */ ], "connections": [ /* Connection[] */ ] }
```

```json
// response
{ "id": "…", "name": "Clamp stand assembly", "apparatus": [ "…" ], "connections": [], "revision": 1,
  "createdAt": "…", "updatedAt": "…" }
```

Templates are a denormalised copy stamp (`apparatus`/`connections` stored as JSONB), not a live
link to any scene; stamping one into a scene (remapping ids) is a client-side concern today.

## Authentication and authorization (placeholder)

There is no real identity provider yet, matching the rest of the stack (`services/science` also
has none). `MATTERLAB_API_KEYS` (`key1:scope_a,scope_b;key2:scope_a`) configures a static map; the
default development key `matterlab-dev-key` grants both `lab:read` and `lab:write`. Every route
declares the scope it needs (`requireScope('lab:read' | 'lab:write')`); a missing/unknown key is
`401 unauthorized`, a valid key without the scope is `403 forbidden`. Swapping this for OAuth/Entra
later only touches `apps/api/src/auth.ts`.

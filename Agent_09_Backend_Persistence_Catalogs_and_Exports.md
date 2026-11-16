# MATTER LAB — AGENT 09: BACKEND, PERSISTENCE, CATALOGS AND EXPORTS

> Standalone assignment. **Before coding, read `00_SHARED_INTEGRATION_CONTRACT.md` and the existing MATTER LAB specification.** Never invent scientific results. Implement, run, test and integrate actual working code.

# Role and outcome
You are **Agent 09 — Backend and Persistence Engineer**. Own durable laboratory state, versioned APIs, data provenance, independent experiment runs, templates and Excel/JSON exports. Preserve existing MATTER LAB molecular and scientific storage; add lab functionality incrementally.

## Owned surfaces
`apps/api/**` laboratory endpoints, database migrations, model serialization, object-store linkage, auth/quotas, event/audit persistence, export jobs, `packages/contracts/lab/**` with Agent 07, `infra/` dependencies with Agent 10.

## Required implementation
1. Inspect existing database and API architecture; implement backwards-compatible lab extensions. Use PostgreSQL authoritative storage with indexed UUID IDs, ownership, timestamps, schema versions and optimistic `revision` checks.
2. Persist `ExperimentScene` including multi-station layouts, apparatus instances, socket connections, container inventories, simulation configuration, view state and named reusable equipment assemblies.
3. Persist immutable run snapshots and results: method/model version, time/conditions, action log, observations, scientific provenance, assumptions, warnings, failure codes and artifacts.
4. Implement lab REST contract from `00_SHARED_INTEGRATION_CONTRACT.md`, including create/get/patch/duplicate scenes, equipment definitions, templates, run lifecycle, progress SSE, cancel, observations and scoped exports.
5. Enforce version conflict handling (`If-Match`/ETag), idempotency keys on creates/jobs, rigorous input validation, pagination, auth scopes and safe limits on serialized data sizes.
6. Add Excel exports (readable workbook sheets: Equipment, Stations, Connections, Conditions, Trial Measurements, Titration Curve, Observations, Sources); provide JSON for exact round trips. Prevent spreadsheet formula injection on export and avoid arbitrary code evaluation on import.
7. Implement searchable catalogs for equipment and safe curated reagents; link to existing elements/compounds and source IDs. Do not claim completeness of all compounds.
8. Store the calibration/units policy, exact source identifiers, reproducibility metadata and machine-readable scientific run statuses.
9. Support local development stack and sample seed scene: one titration station and one blank station; do not ship fake scientific results in production seed data.

## Suggested tables
`lab_scene`, `lab_station`, `apparatus_instance`, `apparatus_connection`, `container_state`, `lab_template`, `lab_run`, `lab_action_event`, `lab_observation`, `challenge_attempt`, `apparatus_definition_version`, `data_source` with appropriate normalized constraints or versioned JSONB where better. Include indexes and migration tests.

## Acceptance tests
- Save, close app, reopen: placements, connections, inventories, instrument settings, evidence statuses and scene revision survive exactly.
- Duplicate scene produces new IDs without cross-linking or mutating original.
- Two concurrently edited revisions do not silently overwrite one another; failed writes return a clear conflict.
- Excel export opens with correct numeric types/units, scientific source metadata and no injected formulas; JSON round-trip reproduces state.
- Failed/unsupported simulations have durable status, diagnostic and no fake results.
- Test migrations against a clean DB and an upgraded existing v1 DB.

## Deliverables
Versioned schema/API implementation, OpenAPI docs, migrations, integration tests, seed data, export templates and setup instructions.

# Verification and release gates

Run from the repository root with Node 22.12 or 24+. On Windows, use `.\env.ps1` if necessary.
Dependencies are restored with `npm ci` against the committed lockfile. Do not install through a
worktree's shared `node_modules` junction while other agents are using it.

| Command | Gate |
| --- | --- |
| `npm run lint` | Existing-tool repository hygiene: JSON and JavaScript syntax, unresolved merge markers, changed-line whitespace. Not an ESLint claim. |
| `npm run typecheck` | All workspace TypeScript and the QA/browser configuration |
| `npm run test:qa` | Scheduling, failure propagation, complete suite partition and production-artifact guard regressions |
| `npm run test:partition` | Dynamically collect all parameterized Vitest cases; require correctness + performance to cover every case exactly once |
| `npm run test:unit` | Correctness and scientific tests, at most two workers; explicitly does **not** run CPU timing assertions |
| `npm run test:performance` | Existing absolute CPU timing assertions, **one worker and one file at a time**, unchanged thresholds |
| `npm test` | Both phases sequentially, including performance even if correctness fails; any failed phase fails the command |
| `npm run verify` | Hygiene, typechecking, QA regressions, suite partition, correctness, production build and artifact integrity |
| `npm run verify:build` | Inspect the existing normal production build; check referenced assets, WebAssembly and absent test hooks |
| `npm run test:smoke` | Build the normal production app and run actual browser smoke at 1920×1080, 1366×768 and reduced motion |
| `npm run release:web` | Build, inspect and SHA-256-manifest the static web artifact |
| `npm run desktop:check` | Report desktop prerequisites; nonzero when unavailable, never represented as a desktop build |

`npm run verify` alone is **not** the full performance/browser/service release sign-off. The named
gates remain visible in CI; no failed tests are quarantined or automatically retried. Diagnostic
selectors can be passed through `npm run test:unit -- --project core`, for example. Selected runs
are explicitly marked in their records and are not full acceptance evidence.

## CPU performance is not ordinary correctness

The six existing absolute-threshold test cases live in the force-field and quantum
`test/performance.test.ts` files. The files also contain the broader force-field reference timing
case. All seven remain in the explicit performance phase. Their numerical, convergence and timing
assertions are untouched. The quantum suite's dependence on its earlier benzene result remains
within its original serial file.

Concurrent scientific projects can starve timing tests on a busy or battery-powered computer.
The default `npm test` therefore finishes correctness first and runs the performance files
serially. A genuinely slow or overloaded machine can still fail: failures are **reported**, not
converted into passes. Coordinate an otherwise idle measurement window; do not change another
user's power settings or kill their processes.

`qa/results/` contains:

- `unit-tests.json`, `performance-tests.json`: actual Vitest outcomes;
- `unit-run.json`, `performance-run.json` or `all-run.json`: timestamps, selectors, exit codes,
  commit, dirty-worktree flag, Node, CPU, OS and memory;
- `performance/`: actual quantum and force-field measurements from their existing reporters;
- `inventory/`: complete dynamic test inventories and verified partition counts;
- `build.json`, `web-release-manifest.json`: production artifact inspection and file hashes.

The original reporter defaults still work. `QUANTUM_REPORT_DIR` and `UFF_REPORT_DIR` only redirect
the measurement artifacts; they do not alter the solvers, thresholds or test execution.

## Browser and rendering

The short smoke suite uses **port 6173**, refuses to reuse an existing server, and does not touch
the normal 5273 development or 4273 preview servers. It serves the production build without test
hooks. Screenshots and failure traces are saved under `qa/results/`.

By default it uses bundled Chromium and software WebGL:

```powershell
npx playwright install chromium
npm run test:smoke
```

For the coordinated real-hardware window on Windows:

```powershell
$env:PW_CHANNEL = 'msedge'
$env:MATTERLAB_SMOKE_RENDERER = 'hardware'
npm run test:smoke
```

Software-rendered CI is a loading/layout/interaction check, **not** an FPS or WebGPU result.
The existing `npm run test:e2e`, `test:e2e:build`, `screenshots` and `benchmark` commands remain
available. Browser, GPU, ten-station and 100-equipment performance results must name the actual
renderer, hardware, resolution, workload and frame-time distribution. Do not run simultaneous
GPU suites against the shared machine.

The laboratory's drag/attach/fill/valve/equivalence/save/replay acceptance tests are integrated only
after approved runtime, apparatus, interaction and persistence handoffs. A production-loading
smoke is not a substitute for that vertical slice.

## CI and supported-target evidence

`.github/workflows/verify.yml` defines:

1. Windows/Node 24 and Linux/Node 22.12 + 24 correctness and static-build gates.
2. A separately named serial CPU performance job; failures remain fatal and upload measurements.
3. A software-WebGL browser job with actual screenshots at both required resolutions.
4. A real FastAPI/PostgreSQL service-image job, repeated migrations and API/schema/Excel/science
   tests. Its Compose project and database volume are unique to that hosted CI run.

The service job explicitly excludes the `network` pytest marker (live public PubChem tests).
Network availability is not required for deterministic science, migrations or persistence tests.
Run the unfiltered service suite when verifying public-network integrations. No service test uses
a fake in-memory database as evidence for PostgreSQL behavior.

Hosted CI workflows are prepared, not claimed to have run until their actual job results exist.
The separate manual Windows desktop workflow is experimental; see
[desktop prerequisites and honest blockers](../apps/desktop/README.md). It publishes neither a
signed installer nor a remote release.

## Initial local evidence (2026-11-16)

- Five focused QA harness tests, nine selected real web tests through the new scheduler, and all
  existing workspace/QA typechecks passed. The full correctness suite is reserved for integration.
- Dynamic inventory identified all 2,377 cases: 2,370 correctness + seven explicit performance.
  Discovery uses one thread; Vitest worker/collection errors fail the inventory gate even if
  Vitest exits zero.
- Production Vite build and artifact inspection passed: 28 files, five JavaScript bundles,
  one actual WebAssembly asset, 22,720,089 total bytes including maps.
- Existing Vite warnings about RDKit's Node-only imports and large chunks remain visible.
- Browser/GPU runs are deliberately held for the parent's shared integration window.
- Desktop probe failed honestly: no `rustc`, `cargo` or `cargo-tauri`; no `Cargo.lock`.
- Agent09 reported Docker blocked creating the project network. Real local PostgreSQL/service
  acceptance remains blocked, not passed. Hosted service CI has not yet run.

This is an early harness milestone, not final laboratory release sign-off.

## Canonical contract review

Agent10 reviewed and approved the frozen `a00ddf6affb60f9921c3caaf6012eabc2e2d9dd7` contract
commit; Agent09 explicitly signed off its persistence semantics. The review covered all DTOs,
the shared structural schema builder, JSON/semantic validation, manual RFC8785 key emission and
hashing, scientific failure variants, calibration and checkpoint/receipt boundaries. No competing
contracts were written, and no unfinished branch was merged into this milestone.

The important persistence correction is explicit: a saved current scene carries a checkpoint
sidecar; replay starts from its **initial** scene and original steps, not from the already-mutated
current inventory. Durable save revision and runtime revision remain separate. Server jobs
recompute results and never trust browser checkpoint observations as authoritative output.

The pure package deliberately uses `.ts` import suffixes so Node's schema-export path can run
without another transpiler. The shared no-emit TypeScript configuration permits those suffixes
for its consumers. Workspace links and the root npm lockfile are integrated by the parent in
the coordinated installation; no install was performed through this worktree's junction.

Schema validation does not replace the pending authoritative runtime's version, registry/socket,
inventory, solver, cancellation and replay checks. This review approves the interface freeze,
not a runtime implementation or final scientific/UI release.

# Laboratory rendering measurements

Measured 2026-11-17T15:19:12.114Z with Edge/Chromium 157.0.4341.60.

Whole-page animation cadence, not isolated GPU execution time; empty assembled stations in studio. Viewport: 1366 x 768. CPU: Intel(R) Core(TM) Ultra 7 165H.

| Stations | Apparatus | Quality | Backend | FPS | Median ms | P95 ms | Draw calls | Triangles | DPR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 8 | balanced | webgpu | 59.8 | 16.7 | 16.8 | 80 | 10171 | 1.00 |
| 1 | 8 | low | webgpu | 60.0 | 16.7 | 16.8 | 42 | 2635 | 1.00 |
| 10 | 80 | balanced | webgpu | 55.4 | 16.7 | 16.8 | 782 | 101683 | 1.00 |
| 10 | 80 | low | webgpu | 59.9 | 16.7 | 16.8 | 402 | 26323 | 1.00 |
| 16 | 128 | balanced | webgpu | 57.5 | 16.7 | 16.8 | 1250 | 162691 | 1.00 |
| 16 | 128 | low | webgpu | 60.0 | 16.7 | 16.8 | 642 | 42115 | 1.00 |

## Interpretation

Target: 60 FPS for a single station and 30 FPS for large scenes. These are measurements, not guaranteed frame rates.
- 1 station(s), balanced: below the target.
- 1 station(s), low: meets the target.
- 10 station(s), balanced: meets the target.
- 10 station(s), low: meets the target.
- 16 station(s), balanced: meets the target.
- 16 station(s), low: meets the target.

- Shared machine; no claim of an isolated hardware laboratory.
- Load-to-first-metric includes worker/UI/renderer initialization, not just shader compilation.
- GPU allocation bytes are null when not reported by Three.js.
- The user kept the native MATTER LAB application open. These samples include shared GPU/CPU contention and are not an isolated FPS acceptance result.
- Separate CPU/GPU render timers and isolated shader compilation time were not available and are not invented.
- Raw frame samples, renderer/resource counters and load-to-first-metric times are in [laboratory.json](laboratory.json).

Reproduce: `playwright test --config playwright.laboratory-review.config.ts` from `apps/web` with the project environment loaded.

# Laboratory screenshots

Captured from the running production-preview application, not mockups. Chemistry readings are
actual shared-worker results. The gallery was regenerated after fixing the camera-control layout
and WebGPU post-render instrumentation.

| View | Capture |
| --- | --- |
| 1920 x 1080, prepared reference solutions | [Prepared station](desktop-prepared.png) |
| 1920 x 1080, 10 mL accepted delivery | [10 mL delivery](desktop-10ml.png) |
| 1920 x 1080, 25 mL equivalence and pH 7 | [Equivalence](desktop-equivalence.png) |
| 1366 x 768, equivalence | [Laptop](laptop-equivalence.png) |
| 1366 x 768, scientific explanation | [Science inspector](laptop-science.png) |
| 1366 x 768, studio/top-down controls | [Top-down](laptop-top-down.png) |
| 1366 x 768, forced WebGL 2 | [WebGL fallback](laptop-webgl.png) |
| 1366 x 768, offline notebook | [Notebook](laptop-notebook.png) |
| 1 station / 8 apparatus | [Balanced](1-stations-balanced.png), [efficient](1-stations-low.png) |
| 10 stations / 80 apparatus | [Balanced](10-stations-balanced.png), [efficient](10-stations-low.png) |
| 16 stations / 128 apparatus | [Balanced](16-stations-balanced.png), [efficient](16-stations-low.png) |

The multi-station captures contain empty assembled apparatus, not fabricated measurements.
[Measured frame timings and limitations](../../benchmarks/laboratory.md) accompany these images.

Reproduce from `apps/web`: `playwright test --config playwright.laboratory-review.config.ts`.

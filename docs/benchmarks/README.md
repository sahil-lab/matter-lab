# Reading the benchmark

[render-benchmark.md](render-benchmark.md) is written by `npm run benchmark`
(`apps/web/e2e/render.bench.ts`). It drives the real application in headless Edge, orbits the camera
and measures frame pacing, CPU and GPU time per frame, draw calls, triangles, memory, the cost of
changing the quality preset (new graphics context, shader compilation, first frame) and the time
from an edit to the frame that shows it. [render-benchmark.json](render-benchmark.json) holds the
raw numbers, including every repeat. A run takes about ten minutes.

## The conditions of the report on disk

Measured on 16 November 2026 between 02:12 and 02:22 local time (20:51 UTC in the report), on mains
power, with nothing else of this project running. **The machine was not idle**, and that cannot be
arranged from inside the project: it is shared, and during the run the editor and another browser
were using roughly a quarter to a third of the same integrated GPU and other work kept more than
half of the processor busy. The numbers are therefore somewhat low rather than high.

Every large-scene configuration is measured three times, in three passes over all scenes that lie
minutes apart, and the report lists all three values. In this run they agree to within about a
quarter in every configuration, which is what makes the run usable.

## How much conditions matter: four runs of one night

The benchmark was run four times that night. The first two were single-pass runs whose report
files were overwritten by the next run; their numbers are quoted from those reports. For the third
run the laptop had been on battery for an hour and the editor was busy on the same GPU.

| Frames per second | Run 1, 00:32, mains | Run 2, 01:40, battery | Run 3, 01:45, battery, editor busy | Run 4, 02:12, mains (the report on disk) |
| --- | --- | --- | --- | --- |
| Caffeine, Efficient | not measured | not measured | 60.0, 60.0, 60.0 | 60.0, 60.0, 60.0 |
| Caffeine, Balanced | 55.5 | 52.3, 55.3, 48.8 | 37.5, 53.5, 43.3 | 51.5, 59.3, 51.0 |
| Caffeine, Quality | not measured | not measured | 41.3, 45.0, 42.8 | 56.5, 56.8, 59.8 |
| Empty stage, Efficient / Balanced / Quality | 60.0 / 47.5 / 57.3 | 60.0 / 56.3 / 58.5 | 60.0 / 36.4 / 55.3 | 60.0 / 57.5 / 58.3 |
| 1,000 atoms, Efficient / Balanced / Quality | 58.0 / 55.0 / 48.1 | 56.8 / 58.8 / 47.9 | 40.3 / 18.8 / 42.5 | 53.0 / 53.5 / 45.5 |
| 10,000 atoms | 58.3 / 55.0 / 41.5 | 55.0 / 54.3 / 7.6 | 49.1 / 12.1 / 25.8 | 54.0 / 56.5 / 44.7 |
| 50,000 atoms | 47.3 / 41.5 / 29.6 | 11.4 / 30.3 / 22.3 | 19.5 / 6.5 / 14.0 | 43.5 / 41.3 / 28.0 |
| 100,000 atoms | 34.6 / 40.7 / 29.3 | 34.0 / 38.1 / 23.2 | 24.2 / 12.9 / 20.0 | 44.2 / 40.2 / 28.1 |
| Orbit during Hartree-Fock | 43.5 | 48.0, 26.3, 32.2 | 29.3, 31.8, 36.7 | 44.0, 50.6, 43.5 |

For runs 3 and 4 the large-scene values are the middle one of three. Two values of run 2 (7.6 and
11.4 fps) are plainly disturbances, since a scene ten times larger ran three times faster in the
same pass; they are why the benchmark now repeats every configuration. In run 3 the three values
of one configuration differed by up to a factor of eight (1,000 atoms in Quality: 49.0, 7.4, 42.5),
which no property of the scene can explain. A single run of this benchmark on a busy or
battery-powered machine can be wrong by that much, so look at the three values before trusting a
row.

## What the measurements say

- **The application's own work per frame is small.** Main-thread time is 0.8 to 4.8 ms per frame at
  every scene size up to 100,000 atoms, in all four runs. Frame time is decided by the GPU.
- **Efficient reaches 60 fps for a typical molecule on this integrated GPU**: 60.0 fps in all six
  measurements of two runs, at 1.6 to 3.2 ms of GPU time per frame.
- **Balanced comes close to 60 fps but does not hold it on this machine**: 49 to 59 fps in the three
  undisturbed runs, with single frame gaps of 33 to 67 ms. The post-processing chain (ambient
  occlusion, bloom, antialiasing) costs about 10 ms of GPU time per frame on the empty stage, which
  leaves little of the 16.7 ms a frame may take. The specification's target of a stable 60 fps in
  Balanced is therefore **not met on this hardware**, although Balanced is the preset the
  application chooses there by default. On integrated graphics Efficient is the preset that holds
  the frame rate, as its description says.
- **Quality** ran a typical molecule at 57 to 60 fps in run 4 and at 41 to 45 fps in the disturbed
  run 3; it falls off faster than the other presets as scenes grow, since it draws at full
  resolution with multisampling and never lowers it.
- **Large scenes stay usable.** 100,000 atoms (13 million triangles) ran at 34 to 44 fps in
  Efficient, 38 to 41 fps in Balanced and 23 to 29 fps in Quality in the undisturbed runs. Atoms are
  meshes, not impostors, which is what limits this.
- **Editing stays quick at every size.** Following the pointer while dragging takes 3 to 42 ms per
  step and committing a move 19 to 65 ms, up to 100,000 atoms. Adding an atom to a typical molecule
  takes 15 to 28 ms (one or two frames). In scenes of 50,000 atoms and more, adding or deleting an
  atom takes 60 to 330 ms, which misses the target of one or two frames.
- **The other budgets are met with a wide margin**: rule-based validation 0.1 to 0.4 ms, RDKit
  cross-check 4 to 9 ms, cached similarity search under 1 ms, reopening caffeine 60 to 91 ms and
  10,000 atoms 142 to 314 ms.
- **A running calculation does not freeze the view, but it is felt.** Orbiting during a
  Hartree-Fock run gave 26 to 51 fps, with single frame gaps of 50 to 184 ms.
- **Changing the quality preset costs 100 to 420 ms once**: a new graphics context when the
  pipeline changes, 9 shader programs in the direct pipeline and 23 to 25 in the post-processing one.

## What the numbers are not

- **Not a statement about other hardware.** One machine was measured: an Intel Arc Pro integrated
  GPU, headless Edge through ANGLE on Direct3D 11, a 1600 by 900 window at pixel ratio 1.
- **Not measured on an idle machine.** See the conditions above. A run on mains power with nothing
  else running would be the fair one; `npm run benchmark` makes it.
- **Not free of the frame-rate cap.** A browser draws at most one frame per display refresh. 60.0
  fps means the cap was reached; the CPU and GPU columns show what a frame costs.
- **Not at a fixed resolution.** The application lowers the pixel ratio by itself when frames run
  long (0.75 to 1.0 in these runs); the value in force is in each row. The Quality preset never goes
  below 1.
- **Memory is indicative only.** The JavaScript heap is read without forcing a collection. In the
  single-pass runs it was about 95 to 135 MB up to 10,000 atoms and 390 to 530 MB at 100,000. In the
  three-pass runs values of 640 to 740 MB appeared, also for small scenes measured after large ones.
  Whether that is garbage not yet collected or memory kept from earlier scenes was not investigated.
- **Not a pass or fail test.** The benchmark asserts only that the scenes were built and that frames
  were drawn. It cannot fail because a machine is slow.

## The engines

The force-field and quantum packages measure themselves separately, in Node, without a browser:
see "Performance" in [packages/forcefield/README.md](../../packages/forcefield/README.md) and
[packages/quantum/README.md](../../packages/quantum/README.md).

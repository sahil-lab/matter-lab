# Astra lab shell (Agent 01: Creative Direction and UI)

The Awwwards-caliber application shell for MATTER LAB's "Astra" 3D laboratory: full-screen layout,
top navigation, collapsible apparatus library, scientific inspector, titration HUD, explanation
panel, timeline/playback dock, onboarding cinematic and the component gallery. This is **UI only**
— no scene geometry, no apparatus physics, no chemistry. See the design language itself in
[`../../design-system/README.md`](../../design-system/README.md).

## Reaching it

`main.tsx` is a two-line router: paths starting with `/lab` dynamically import and boot this tree
(`bootAstraLab.tsx`); everything else dynamically imports and boots the existing v1 app
(`bootMatterLab.tsx`, moved out of `main.tsx` unchanged). Neither route's bundle pulls in the
other's — confirmed with `npm run build`: `bootAstraLab-*.js` is ~62 KB gzip vs. `bootMatterLab-*.js`
at ~2.3 MB (it carries the RDKit WASM/worker stack Astra does not need). A small "Astra lab" button
in the v1 `TopBar` (`ui/TopBar.tsx`) links to `/lab`; the Astra shell's top nav links back to `/`.

- `/lab` — the shell (`AstraLabRoot` → onboarding or `AstraLabShell`).
- `/lab/gallery` — the component gallery (`Gallery.tsx`), every key component in every state.

## The honest-default rule

**Nothing in this worktree computes or stores real chemistry or scene state.** Agents 02 (3D
environment), 03 (apparatus), 04 (interaction/editor), 06 (chemistry solver), 07 (experiment
runtime) and 09 (persistence) are not integrated here — they do not exist in this isolated
worktree. Rather than fake any of that, the shell's **true default state is "disconnected"**: the
titration HUD shows "No simulation connected", the inspector shows "Nothing selected", the
explanation panel shows "No run to explain yet", and the 3D viewport shows an explicit placeholder
card naming which agents' work is pending — never an invented reading.

A single, clearly-labeled toggle (`previewDemoData` in `store.ts`, surfaced as "Preview with
watermarked sample data") switches on `demoData.ts`'s illustrative sample scene/run/observations so
the populated HUD, chart and explanation states can be reviewed without a real backend. Every
number it shows carries `evidence: 'ILLUSTRATIVE'` and a persistent `SAMPLE DATA` watermark is
shown the whole time it's on (`astra-sample-watermark`, with an "Exit preview" button). Do not
repurpose this toggle or `demoData.ts` as a stand-in for real integration — it exists only so this
agent's own UI could be built, reviewed and tested in isolation.

## Files

| File | Role |
| --- | --- |
| `contracts.ts` | **Stub.** Mirrors `00_SHARED_INTEGRATION_CONTRACT.md` §3 field-for-field (`Evidence`, `ApparatusInstance`, `ExperimentScene`, `Observation`, `RunResult`, …). Authoritative ownership is Agent 07 + Agent 09's `packages/contracts/lab`. Also defines this agent's own additive, UI-facing shapes (`ApparatusSummary`, `TitrationHudData`, `IndicatorState`) and the two read-only selectors, `deriveTitrationHudData` and `pairVolumeAndPh`. |
| `demoData.ts` | Sample/illustrative data only (see above). Includes the P0 (and a slice of P1) apparatus catalog as placeholder display data. |
| `store.ts` | Shell-chrome UI state only (panel open/closed, active tabs, camera/quality mode, playback scrubber, demo jobs/toasts). Independent of the v1 app's `state/store.ts` and of Agent 07's runtime. |
| `AstraLabRoot.tsx` / `AstraLabShell.tsx` | Entry point and the full composition (top nav, HUD, library/inspector slots, dock, toasts, watermark). |
| `TopNav.tsx`, `ViewModeSwitcher.tsx`, `QualityMenu.tsx`, `SaveMenu.tsx`, `JobProgress.tsx` | Top chrome: back link, panel toggles, camera-mode switch, display settings + reduced-motion toggle + replay onboarding, save/duplicate/export (stubbed), job/toast indicators. |
| `ViewportFrame.tsx` | The 3D viewport slot. Renders `children` unchanged when supplied (Agent 02 mounts here); otherwise an honest placeholder. **Never put scene geometry in this file.** |
| `ApparatusLibraryPanel.tsx`, `ApparatusCard.tsx`, `apparatusIcons.ts` | The collapsible equipment library: search, category grouping, selection, detail strip. Thumbnails are `lucide-react` glyphs standing in for Agent 03's real renders. |
| `InspectorPanel.tsx`, `TitrationHud.tsx`, `ExplanationPanel.tsx` | The scientific presentation layer, entirely props-driven from `contracts.ts` shapes. |
| `TimelineDock.tsx`, `TitrationChart.tsx`, `PlaybackControls.tsx` | The bottom dock: a small purpose-built pH-vs-volume chart (not a generic charting library) plus play/pause/reset/step/speed. |
| `OnboardingIntro.tsx` | Skippable first-run cinematic; no-delay return via `localStorage` (`astra-lab:onboarding-seen`). |
| `Gallery.tsx` | The component gallery (`/lab/gallery`). |
| `bootAstraLab.tsx` | Boot/mount + the `window.__ASTRA_LAB__` test hook (dev/test builds only). |
| `shell.css` | Layout only: the floating-glass-panel technique over a full-bleed viewport (same idiom as the v1 app's `styles/app.css`, independently implemented with `--astra-*` tokens). Includes its own `box-sizing: border-box` reset, since this route does not load the v1 app's `app.css`. |

## The viewport share

The brief asks for "a full-screen lab shell where 75–85% of the usable area can be a 3D viewport".
With both side panels open at 1920×1080 the unoccluded viewport width is ~76%; collapsing either
panel only increases that share (panels fully leave the layout when closed, they don't dock to a
rail). Panels default open above 1700px width, the inspector defaults closed between 1280–1699px,
and both default closed below 1280px, so the share stays reasonable at every acceptance-test gate
resolution without the user doing anything — see the `--astra-library-w`/`--astra-inspector-w`
comment in `design-system/tokens.css` and the `3D viewport share` tests in `astra-lab.spec.ts`.

## Integration contract for other agents

None of the following exists yet in this worktree; this is what Agent 01's components expect to be
handed, so integration is a matter of wiring, not redesigning the UI.

- **Agent 02 (3D environment)**: render `LabWorld`/`CameraDirector` etc. as `children` of
  `<ViewportFrame cameraMode={...}>`. `ViewModeSwitcher` already reports `'orbit' | 'first-person' |
  'top-down'`; wire its `onChange` to your camera controller and feed the current mode back in.
- **Agent 03 (apparatus)**: replace `DEMO_APPARATUS_CATALOG` with a real registry feed shaped like
  `ApparatusSummary` (`contracts.ts`), and supply real thumbnails in place of
  `apparatusIcons.ts`'s glyph placeholders.
- **Agent 04 (editor)**: when a user selects a placed `ApparatusInstance` in the 3D view, call
  `astraLab.set({ selectedDefinitionId, inspectorTab: 'properties' })` (or extend `store.ts` with an
  `selectedInstanceId` alongside it) so `InspectorPanel` reflects live selection, not just the
  library catalog. Report active-drag state so the shell can avoid stealing pointer focus (it
  currently doesn't capture any pointer events over the viewport at all — verified by the "no
  persistent overlay" test).
- **Agent 06 (chemistry) / Agent 07 (runtime)**: replace this file's mirrored types with
  `packages/contracts/lab` once published, and provide the real `ExperimentScene` / `RunResult` /
  `Observation[]`. `deriveTitrationHudData` and `pairVolumeAndPh` in `contracts.ts` are reference
  implementations of the "read-only selector" the shared contract asks UI to use — adopt them
  as-is, replace them, or wrap them; either way, the HUD/chart components only need their output
  shape (`TitrationHudData`, `TitrationPoint[]`), not the raw scene.
- **Agent 08 (gameplay)**: `AstraLabMode` (`'guided' | 'challenge' | 'free' | 'precision'`) is
  reserved in `store.ts` but **no UI control for it exists yet** — this agent's brief explicitly
  scopes that switcher's *styling* to Agent 01 while the modes themselves are Agent 08's; build the
  mode UI against the design-system primitives and this store field.
- **Agent 09 (persistence)**: `SaveMenu.tsx`'s three actions currently only show a toast. Replace
  the three empty callbacks with `POST /api/v1/lab/scenes`, `.../duplicate` and
  `.../export?format=...`.
- **Agent 10 (integration/QA)**: the test hook is `window.__ASTRA_LAB__` (not `__MATTERLAB__` — the
  two apps are intentionally decoupled). See "Testing" below for commands.

## What is deliberately not here

- No 3D content, no apparatus placement/snapping, no camera implementation.
- No real save/export (persistence) and no real chemistry (everything scientific-looking is either
  `null`/"disconnected" or explicitly watermarked sample data).
- No guided/challenge/free/precision mode switcher UI (Agent 08's, per the brief).
- `ExplanationPanel`'s "References" tab is honest about a real gap: the mirrored `RunResult` has no
  citations field yet; it says so rather than inventing one.

## Testing

```powershell
# Unit tests (pure logic: contracts/demoData/motion/store), from the repo root
npm test

# Playwright, from apps/web (needs the dev server; playwright.config.ts starts one if none is running)
npx playwright test astra-lab.spec.ts

# Screenshots into docs/screenshots/astra/
npx playwright test -c playwright.shots.config.ts astra-lab.shots.ts
```

# Instrument room UI

## Design

The meter-scale laboratory is an instrument, not a dashboard. Midnight navy beds,
warm calibration marks, cool controls, hairline dividers and tabular observations
frame the working canvas. Existing Inter, Space Grotesk, JetBrains Mono, Lucide
and `ui/kit` primitives are reused. Nothing changes the molecular app's global
tokens, scene units or document store.

`design-system/lab/tokens.css` scopes every token to `.ml-lab`. Use
`--mlab-space-1` through `--mlab-space-7`, `--mlab-font` / `--mlab-display` /
`--mlab-mono`, the `--mlab-radius-*`, `--mlab-elevation-*`, `--mlab-depth-*`,
and `--mlab-motion-*` families. For example:

```css
.ml-lab .your-instrument-card {
  padding: var(--mlab-space-4);
  color: var(--mlab-ink);
  background: var(--mlab-surface);
  border: 1px solid var(--mlab-line);
  border-radius: var(--mlab-radius);
}
```

## Composition

Public imports: `apps/web/src/design-system/lab/index.ts`.

```tsx
<LabShell
  title={sceneTitle}
  stationLabel={activeStationName}
  onExit={onExit}
  viewport={meterCanvas}
  library={equipmentLibrary}
  inspector={readOnlyInspector}
  timeline={observationLedger}
  tutorial={guidedExperiment}
  hud={titrationReadouts}
  toolbar={<> {runtimeTransport} {persistenceControls} </>}
  status={connectionStatus}
  entry={<LabEntry onEnter={chooseEntryMode} onStageChange={moveEntryCamera} />}
  gallery={componentGallery}
  viewMode={cameraMode}
  onViewModeChange={changeCameraMode}
  quality={quality}
  onQualityChange={setQuality}
  onReducedMotionChange={setEnvironmentReducedMotion}
/>
```

Only `viewport` is required. Slots are `ReactNode`s, never a second scene DTO.
`LabShell` owns panel visibility/size unless `panels` and `onPanelsChange` are
supplied. `defaultPanels` merges with `{library:true, inspector:false,
timeline:false}`. Side panels and timeline support pointer and keyboard resize.
The initial 236px library plus two 36px rails leave about 77% of the usable width
at 1366px and 84% at 1920px. Collapse either side or enter immersive view for more
space. Below 1000px, one side drawer opens at a time. The viewport always remains
a real slot, never a placeholder scene.

`interaction` accepts `{mode, label?, detail?, pointerCaptured?}`; modes are
`idle | placing | dragging | connecting | valid | invalid`. Active manipulation
hides floating HUD/tutorial cards; their full-screen parents never capture
pointer input. Main controls are outside the canvas.

Camera modes: `orbit | first-person | top-down | inspection`. Render quality:
`low | balanced | high`. `motion` is `system | reduced | full`; an OS reduced-motion
preference always wins. `useLabMotion()` supplies the same zero-or-real transition
durations to UI and environment. The optional entry never disables Enter or Skip;
returning users render no introduction. It stores only a first-run preference,
not lab data. Native dialogs manage focus, Escape and restoration.

## Small surfaces

- `LabButton`: existing `ui/kit` button props, scoped instrument treatment.
- `LabStateNotice({status,title?,children?,action?,compact?})`: honest
  empty/loading/warning/offline/error/unsupported state. `action` is
  `{label,onPress,disabled?}` and is only rendered when supplied.
- `LabJobProgress({title,status,progress?,detail?,onCancel?})`: progress is a
  worker-reported fraction or indeterminate. Invalid fractions are indeterminate.
- `LabTransport({state,canPlay?,busy?,simulationTimeLabel?,disabledReason?,
  onPlay?,onPause?,onReset?})`: emits callbacks, never performs a simulation.
  Unsupported cannot Run. Reset requires confirmation and targets the station
  selected by the integration callback. Save/duplicate belong to Agent09.
- `LabTutorialCard({title,stepLabel,children,goals?,onPrevious?,onContinue?,
  continueDisabled?,disabledReason?,onDismiss?})`: displays Agent08's goal states
  without evaluating them. Goal `{id,label,state}` accepts
  `pending | current | complete | unsupported`.
- `LabDialog({open,title,description?,children,footer?,size?,onClose})`:
  native modal; sizes `small | medium | large`.
- `EquipmentLibrary({items,selectedId?,onSelect?,onPlace?,status?,
  statusMessage?,retry?,placementDisabled?})`: searches every term across labels,
  categories, capabilities and keywords. Selection is local unless controlled.
  A controlled selection without `onSelect` is read-only. Offline cached
  definitions can still be placed through an available runtime callback;
  loading, error and unsupported catalogs cannot place.
- `EquipmentDetail({item,onPlace?,onBack?,placementDisabled?})`: metadata,
  thumbnail, capability tags and an explicit place callback. Unavailable entries
  remain inspectable but cannot be placed.
- `EquipmentLibraryItem`: `{definitionId,label,category,description?,thumbnail?,
  capabilities?,keywords?,facts?:{label,value}[],unavailableReason?}`. This is a
  **display projection** of Agent03's catalog, not a competing apparatus or scene
  schema. Agent10 maps registry metadata and SVG thumbnails; no parallel catalog
  is maintained. Fact strings quote definition metadata.
- `LabInspector({title?,category?,instanceId?,properties?,controls?,observations?,
  explanation?,onFocus?,onExplain?,status?,statusMessage?,children?})`: presents a
  read-only selection with Agent04's controls. Property rows are
  `{label,value:ReactNode,unit?,description?}` for identity/geometry/metadata.
  Scientific quantities belong in the observation slot with provenance, not in
  unqualified property rows.
- `LabComponentGallery({scientificContent?})`: interactive, scene-independent
  gallery with tokens, type, catalog, empty/loading/warning/offline/error/
  unsupported states, inspector, tutorial and entry replay. The event monitor
  records UI requests without dispatching domain actions. Supply real read-only
  scientific panels through `scientificContent`; it fabricates no pH fixtures.

## Verification

Node/Vitest tests use React server rendering and pure UI transitions. They cover
unsupported Run disabling, indeterminate progress, collapsed panel semantics,
compact drawer exclusivity, keyboard resize, first-run storage failures and
reduced-motion precedence. They do **not** verify layout, pointer interaction or
real browser focus. Agent10 owns integrated 1920×1080 / 1366×768 / 1280×800
screenshots, visual regression, accessibility E2E and rendering performance.
No visual/GPU tests or dev server were started for this component work.

import { useEffect, useMemo } from 'react';
import { cx } from '../../design-system';
import { ApparatusLibraryPanel } from './ApparatusLibraryPanel';
import type { ApparatusSummary, Observation, RunResult } from './contracts';
import { deriveTitrationHudData, pairVolumeAndPh } from './contracts';
import { buildDemoObservations, buildDemoRunResult, buildDemoScene, DEMO_APPARATUS_CATALOG } from './demoData';
import { InspectorPanel } from './InspectorPanel';
import { ToastStack } from './JobProgress';
import { TimelineDock } from './TimelineDock';
import { TitrationHud } from './TitrationHud';
import { TopNav } from './TopNav';
import { ViewportFrame } from './ViewportFrame';
import { astraLab, useAstraLab } from './store';

const PLAYBACK_TICK_MS = 420;

/**
 * Composes the full-screen lab shell (brief §"Required implementation" 2): a full-bleed 3D
 * viewport slot with the apparatus library, scientific inspector and timeline dock floating over
 * it as collapsible glass panels, plus the top navigation. Everything scientific shown here is
 * either `null` (no connected runtime — the honest default) or the explicitly-watermarked sample
 * preview from `demoData.ts`; this component computes none of it.
 */
export function AstraLabShell() {
  const libraryOpen = useAstraLab((s) => s.libraryOpen);
  const inspectorOpen = useAstraLab((s) => s.inspectorOpen);
  const dockOpen = useAstraLab((s) => s.dockOpen);
  const librarySearch = useAstraLab((s) => s.librarySearch);
  const selectedDefinitionId = useAstraLab((s) => s.selectedDefinitionId);
  const inspectorTab = useAstraLab((s) => s.inspectorTab);
  const explainTab = useAstraLab((s) => s.explainTab);
  const explainLevel = useAstraLab((s) => s.explainLevel);
  const cameraMode = useAstraLab((s) => s.cameraMode);
  const quality = useAstraLab((s) => s.quality);
  const previewDemoData = useAstraLab((s) => s.previewDemoData);
  const playing = useAstraLab((s) => s.playing);
  const speed = useAstraLab((s) => s.speed);
  const scrubIndex = useAstraLab((s) => s.scrubIndex);

  const selected: ApparatusSummary | null = useMemo(() => DEMO_APPARATUS_CATALOG.find((i) => i.definitionId === selectedDefinitionId) ?? null, [selectedDefinitionId]);

  // Sample preview data only: the shell's true default (previewDemoData === false) has no scene,
  // run or observations at all, which is the honest "nothing connected yet" state.
  const observations: Observation[] | null = useMemo(() => (previewDemoData ? buildDemoObservations(30, 24) : null), [previewDemoData]);
  const run: RunResult | null = useMemo(() => (previewDemoData && observations ? buildDemoRunResult(observations) : null), [previewDemoData, observations]);
  const scene = useMemo(() => (previewDemoData ? buildDemoScene() : null), [previewDemoData]);
  const hudData = useMemo(() => deriveTitrationHudData(scene, run, observations), [scene, run, observations]);
  const allPoints = useMemo(() => pairVolumeAndPh(observations ?? []), [observations]);
  const visiblePoints = scrubIndex === null ? allPoints : allPoints.slice(0, scrubIndex + 1);
  const cursorVolumeL = scrubIndex === null ? null : (allPoints[scrubIndex]?.volumeL ?? null);

  // Replay loop: advances the scrubber while playing, stopping at the end of the available curve.
  useEffect(() => {
    if (!playing || allPoints.length === 0) return;
    const timer = window.setInterval(() => {
      const { scrubIndex: current } = astraLab.get();
      const next = (current ?? -1) + 1;
      if (next >= allPoints.length - 1) {
        astraLab.set({ scrubIndex: allPoints.length - 1, playing: false });
      } else {
        astraLab.set({ scrubIndex: next });
      }
    }, PLAYBACK_TICK_MS / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, allPoints.length]);

  const onPlayPause = () => {
    if (allPoints.length === 0) return;
    astraLab.set((s) => ({ playing: !s.playing, scrubIndex: s.scrubIndex === allPoints.length - 1 ? 0 : s.scrubIndex }));
  };
  const onReset = () => astraLab.set({ scrubIndex: allPoints.length > 0 ? 0 : null, playing: false });
  const onStepBack = () => astraLab.set((s) => ({ scrubIndex: Math.max(0, (s.scrubIndex ?? 0) - 1), playing: false }));
  const onStepForward = () => astraLab.set((s) => ({ scrubIndex: Math.min(allPoints.length - 1, (s.scrubIndex ?? -1) + 1), playing: false }));

  return (
    <div className="astra-shell" data-library={libraryOpen ? 'open' : 'closed'} data-inspector={inspectorOpen ? 'open' : 'closed'} data-dock={dockOpen ? 'open' : 'closed'}>
      <ViewportFrame cameraMode={cameraMode} />
      <div className="astra-overlay">
        <TopNav
          libraryOpen={libraryOpen}
          onToggleLibrary={() => astraLab.set((s) => ({ libraryOpen: !s.libraryOpen }))}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => astraLab.set((s) => ({ inspectorOpen: !s.inspectorOpen }))}
          cameraMode={cameraMode}
          onCameraModeChange={(mode) => astraLab.set({ cameraMode: mode })}
          quality={quality}
          onQualityChange={(q) => astraLab.set({ quality: q })}
          onBack={() => window.location.assign('/')}
        />

        <div className="astra-hud-slot">
          <TitrationHud data={hudData} onPreviewSampleData={() => astraLab.set({ previewDemoData: true })} />
        </div>

        <div className={cx('astra-library-slot')} data-open={libraryOpen} aria-hidden={!libraryOpen}>
          <ApparatusLibraryPanel catalog={DEMO_APPARATUS_CATALOG} search={librarySearch} onSearchChange={(v) => astraLab.set({ librarySearch: v })} selectedDefinitionId={selectedDefinitionId} onSelect={(id) => astraLab.set({ selectedDefinitionId: id })} />
        </div>

        <div className={cx('astra-inspector-slot')} data-open={inspectorOpen} aria-hidden={!inspectorOpen}>
          <InspectorPanel
            tab={inspectorTab}
            onTabChange={(t) => astraLab.set({ inspectorTab: t })}
            explainTab={explainTab}
            onExplainTabChange={(t) => astraLab.set({ explainTab: t })}
            explainLevel={explainLevel}
            onExplainLevelChange={(l) => astraLab.set({ explainLevel: l })}
            selected={selected}
            run={run}
          />
        </div>

        <div className="astra-dock-slot">
          <TimelineDock
            open={dockOpen}
            onToggle={() => astraLab.set((s) => ({ dockOpen: !s.dockOpen }))}
            points={visiblePoints}
            equivalenceVolumeL={hudData.equivalenceVolumeL}
            endpointVolumeL={hudData.endpointVolumeL}
            cursorVolumeL={cursorVolumeL}
            playing={playing}
            onPlayPause={onPlayPause}
            onReset={onReset}
            onStepBack={onStepBack}
            onStepForward={onStepForward}
            speed={speed}
            onSpeedChange={(v) => astraLab.set({ speed: v })}
            disabled={allPoints.length === 0}
          />
        </div>

        <ToastStack />
      </div>

      {previewDemoData && (
        <div className="astra-watermark" role="note" data-testid="astra-sample-watermark">
          SAMPLE DATA — illustrative preview, not a simulation result
          <button type="button" onClick={() => astraLab.set({ previewDemoData: false, playing: false, scrubIndex: null })} data-testid="astra-exit-preview">
            Exit preview
          </button>
        </div>
      )}
    </div>
  );
}

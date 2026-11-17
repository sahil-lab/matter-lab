import type { ReactNode } from 'react';
import { EvidenceBadge, Panel, PanelHeader, ProgressBar, StatePanel } from '../../design-system';
import type { AstraEvidence } from '../../design-system/tokens';
import { ASTRA_EVIDENCE_LEVELS } from '../../design-system/tokens';
import { ApparatusCard } from './ApparatusCard';
import { ApparatusLibraryPanel } from './ApparatusLibraryPanel';
import type { Observation, RunResult } from './contracts';
import { deriveTitrationHudData } from './contracts';
import { buildDemoObservations, buildDemoRunResult, buildDemoScene, DEMO_APPARATUS_CATALOG } from './demoData';
import { ExplanationPanel } from './ExplanationPanel';
import { JobRow } from './JobProgress';
import type { AstraJobPreview } from './store';
import { TitrationHud } from './TitrationHud';

function GallerySection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="astra-gallery__section">
      <h2>{title}</h2>
      {description && <p className="astra-gallery__section-desc">{description}</p>}
      <div className="astra-gallery__grid">{children}</div>
    </section>
  );
}

function Swatch({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel elevation="raised" className="astra-gallery__swatch">
      <div className="astra-eyebrow">{title}</div>
      {children}
    </Panel>
  );
}

const DEMO_JOBS: readonly AstraJobPreview[] = [
  { id: '1', title: 'Queued export', status: 'queued', progress: null, startedAt: Date.now() },
  { id: '2', title: 'Running titration solver', status: 'running', progress: 0.42, startedAt: Date.now() },
  { id: '3', title: 'Scene export (.xlsx)', status: 'succeeded', progress: 1, startedAt: Date.now() },
  { id: '4', title: 'Scene export (.xlsx)', status: 'failed', detail: 'The export service returned an error.', progress: null, startedAt: Date.now() },
  { id: '5', title: 'Titration run', status: 'cancelled', progress: null, startedAt: Date.now() },
  { id: '6', title: 'Polyprotic titration', status: 'unsupported', detail: 'No validated model covers this species mixture.', progress: null, startedAt: Date.now() },
];

/**
 * The scene-agnostic component gallery (brief §"Required implementation" 8 and acceptance tests):
 * every key lab-shell component in its populated, loading, warning, unsupported, empty and error
 * states, in one reachable page (`/lab/gallery`). All data here is sample/demo, watermarked as such
 * where it could otherwise be mistaken for a real reading.
 */
export function Gallery() {
  const observations: Observation[] = buildDemoObservations(30, 24);
  const run: RunResult = buildDemoRunResult(observations);
  const unsupportedRun: RunResult = { ...run, status: 'UNSUPPORTED', warnings: ['Sample unsupported state: mixed polyprotic species are outside the v1 validated models.'] };
  const scene = buildDemoScene();
  const populatedHud = deriveTitrationHudData(scene, run, observations);
  const partialHud = deriveTitrationHudData(scene, { ...run, observations: observations.slice(0, 2) }, observations.slice(0, 2));

  return (
    <div className="astra-gallery astra-scroll">
      <header className="astra-gallery__head">
        <p className="astra-eyebrow">MATTER LAB — Astra</p>
        <h1>Component gallery</h1>
        <p>
          Every state a reviewer should be able to see without assembling a scene: populated, loading, warning, unsupported, empty and error. All scientific-looking numbers on this page are
          sample data — see the watermark on populated examples.
        </p>
      </header>

      <GallerySection title="State panel" description="The one component every surface uses instead of a silently blank panel or an invented number.">
        <Swatch title="loading">
          <StatePanel kind="loading" title="Running the solver…" detail="This can take a few seconds for a fine simulation step." />
        </Swatch>
        <Swatch title="empty">
          <StatePanel kind="empty" title="Nothing selected" detail="Choose an item to see its properties here." />
        </Swatch>
        <Swatch title="warning">
          <StatePanel kind="warning" title="Delivered volume exceeds burette capacity" detail="Check the burette fill before continuing." />
        </Swatch>
        <Swatch title="unsupported">
          <StatePanel kind="unsupported" title="This configuration is not scientifically supported" detail="No validated model covers polyprotic mixtures in v1." />
        </Swatch>
        <Swatch title="error">
          <StatePanel kind="error" title="The solver could not be reached" detail="Retry, or continue editing the scene offline." />
        </Swatch>
      </GallerySection>

      <GallerySection title="Evidence badges" description="The shared contract's five-level vocabulary (§3 Evidence). Every scientific number in the lab UI carries one.">
        {(Object.keys(ASTRA_EVIDENCE_LEVELS) as AstraEvidence[]).map((level) => (
          <Swatch key={level} title={level}>
            <EvidenceBadge level={level} />
          </Swatch>
        ))}
      </GallerySection>

      <GallerySection title="Titration HUD">
        <Swatch title="disconnected (the shell's true default)">
          <TitrationHud data={deriveTitrationHudData(null, null, null)} />
        </Swatch>
        <Swatch title="unsupported">
          <TitrationHud data={deriveTitrationHudData(scene, unsupportedRun, null)} />
        </Swatch>
        <Swatch title="populated — sample data">
          <TitrationHud data={populatedHud} />
        </Swatch>
        <Swatch title="populated — partial run in progress">
          <TitrationHud data={partialHud} />
        </Swatch>
      </GallerySection>

      <GallerySection title="Explanation panel">
        <Swatch title="empty (no run)">
          <ExplanationPanel run={null} tab="method" onTabChange={() => {}} level="simple" onLevelChange={() => {}} />
        </Swatch>
        <Swatch title="unsupported">
          <ExplanationPanel run={unsupportedRun} tab="method" onTabChange={() => {}} level="simple" onLevelChange={() => {}} />
        </Swatch>
        <Swatch title="populated — assumptions">
          <ExplanationPanel run={run} tab="assumptions" onTabChange={() => {}} level="simple" onLevelChange={() => {}} />
        </Swatch>
        <Swatch title="populated — diagnostics (advanced)">
          <ExplanationPanel run={run} tab="diagnostics" onTabChange={() => {}} level="advanced" onLevelChange={() => {}} />
        </Swatch>
      </GallerySection>

      <GallerySection title="Apparatus cards" description="Placeholder catalog glyphs stand in for Agent 03's rendered thumbnails.">
        <Swatch title="unselected">
          <ApparatusCard item={DEMO_APPARATUS_CATALOG[3]!} onSelect={() => {}} />
        </Swatch>
        <Swatch title="selected">
          <ApparatusCard item={DEMO_APPARATUS_CATALOG[3]!} selected onSelect={() => {}} />
        </Swatch>
        <Swatch title="dense (library list row)">
          <ApparatusCard item={DEMO_APPARATUS_CATALOG[4]!} dense onSelect={() => {}} />
        </Swatch>
      </GallerySection>

      <GallerySection title="Apparatus library panel">
        <Swatch title="populated">
          <div style={{ height: 360, width: 240 }}>
            <ApparatusLibraryPanel catalog={DEMO_APPARATUS_CATALOG} search="" onSearchChange={() => {}} selectedDefinitionId={DEMO_APPARATUS_CATALOG[3]!.definitionId} onSelect={() => {}} />
          </div>
        </Swatch>
        <Swatch title="empty search">
          <div style={{ height: 240, width: 240 }}>
            <ApparatusLibraryPanel catalog={DEMO_APPARATUS_CATALOG} search="xyz-no-match" onSearchChange={() => {}} selectedDefinitionId={null} onSelect={() => {}} />
          </div>
        </Swatch>
      </GallerySection>

      <GallerySection title="Job progress rows" description="queued · running · succeeded · failed · cancelled · unsupported">
        {DEMO_JOBS.map((job) => (
          <Swatch key={job.id} title={job.status}>
            <JobRow job={job} />
          </Swatch>
        ))}
      </GallerySection>

      <GallerySection title="Progress bars">
        <Swatch title="30%">
          <ProgressBar progress={0.3} />
        </Swatch>
        <Swatch title="80%, warm">
          <ProgressBar progress={0.8} tone="warm" />
        </Swatch>
        <Swatch title="indeterminate">
          <ProgressBar progress={null} />
        </Swatch>
      </GallerySection>

      <GallerySection title="Panel header">
        <Swatch title="with eyebrow">
          <PanelHeader eyebrow="Inspect" title="Burette, 50 mL" />
        </Swatch>
      </GallerySection>
    </div>
  );
}

import { Panel, PanelHeader, StatePanel, TabPanel, Tabs } from '../../design-system';
import type { ApparatusSummary } from './contracts';
import { ExplanationPanel } from './ExplanationPanel';
import type { AstraExplainLevel, AstraExplainTab, AstraInspectorTab } from './store';
import type { RunResult } from './contracts';

function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="astra-proprow">
      <span className="astra-proprow__label">{label}</span>
      <span className="astra-proprow__value astra-mono">{value}</span>
    </div>
  );
}

function ApparatusProperties({ item }: { item: ApparatusSummary | null }) {
  if (!item) {
    return (
      <StatePanel
        kind="empty"
        title="Nothing selected"
        detail="Choose an item in the apparatus library, or select a placed instance in the 3D viewport, to see its properties here."
      />
    );
  }
  return (
    <div>
      <PropertyRow label="Label" value={item.label} />
      <PropertyRow label="Kind" value={item.kind} />
      <PropertyRow label="Category" value={item.category} />
      <PropertyRow label="Definition ID" value={item.definitionId} />
      {item.dimensionsM && <PropertyRow label="Dimensions (W×H×D)" value={`${item.dimensionsM.width} m × ${item.dimensionsM.height} m × ${item.dimensionsM.depth} m`} />}
      <p className="astra-inspector__note">
        This is catalog-level data for the selected definition, shown here until Agent 04's editor can select a placed `ApparatusInstance` and report its live transform, sockets and config.
      </p>
    </div>
  );
}

/**
 * The scientific inspector (brief §"Required implementation" 2, 6): selected-apparatus properties
 * plus the explanation panel, in two tabs. Nothing here computes a scientific value — the Explain
 * tab only renders whatever `RunResult` it is given.
 */
export function InspectorPanel({
  tab,
  onTabChange,
  explainTab,
  onExplainTabChange,
  explainLevel,
  onExplainLevelChange,
  selected,
  run,
}: {
  tab: AstraInspectorTab;
  onTabChange: (tab: AstraInspectorTab) => void;
  explainTab: AstraExplainTab;
  onExplainTabChange: (tab: AstraExplainTab) => void;
  explainLevel: AstraExplainLevel;
  onExplainLevelChange: (level: AstraExplainLevel) => void;
  selected: ApparatusSummary | null;
  run: RunResult | null;
}) {
  return (
    <Panel elevation="raised" padding="sm" className="astra-inspector" aria-label="Scientific inspector">
      <div style={{ padding: '2px 6px 0' }}>
        <PanelHeader eyebrow="Inspect" title="Inspector" />
      </div>
      <Tabs<AstraInspectorTab>
        idPrefix="astra-inspector"
        label="Inspector section"
        value={tab}
        onChange={onTabChange}
        items={[
          { value: 'properties', label: 'Properties' },
          { value: 'explain', label: 'Explain' },
        ]}
      />
      <div className="astra-scroll astra-inspector__body">
        <TabPanel id="astra-inspector-panel-properties" tabId="astra-inspector-tab-properties" active={tab === 'properties'}>
          <ApparatusProperties item={selected} />
        </TabPanel>
        <TabPanel id="astra-inspector-panel-explain" tabId="astra-inspector-tab-explain" active={tab === 'explain'}>
          <ExplanationPanel run={run} tab={explainTab} onTabChange={onExplainTabChange} level={explainLevel} onLevelChange={onExplainLevelChange} />
        </TabPanel>
      </div>
    </Panel>
  );
}

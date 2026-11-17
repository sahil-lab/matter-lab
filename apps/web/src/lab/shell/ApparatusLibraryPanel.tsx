import { useMemo, useState } from 'react';
import { CollapsibleSection, Panel, PanelHeader, SearchField, StatePanel } from '../../design-system';
import { ApparatusCard } from './ApparatusCard';
import type { ApparatusSummary } from './contracts';

function groupByCategory(items: readonly ApparatusSummary[]): Map<string, ApparatusSummary[]> {
  const groups = new Map<string, ApparatusSummary[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return groups;
}

/**
 * The collapsible apparatus library (brief §"Required implementation" 2 and 4): search plus a
 * categorised, placeholder equipment catalog. Thumbnails and labels are meant to come from Agent
 * 03's registry (`demoData.ts`'s `DEMO_APPARATUS_CATALOG` stands in until then). Selecting an item
 * only updates this shell's own `selectedDefinitionId`; placing it in the scene is Agent 04's.
 */
export function ApparatusLibraryPanel({
  catalog,
  search,
  onSearchChange,
  selectedDefinitionId,
  onSelect,
}: {
  catalog: readonly ApparatusSummary[];
  search: string;
  onSearchChange: (value: string) => void;
  selectedDefinitionId: string | null;
  onSelect: (definitionId: string) => void;
}) {
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({});
  const query = search.trim().toLowerCase();
  const filtered = useMemo(() => (query ? catalog.filter((item) => `${item.label} ${item.category} ${item.kind} ${item.shortDescription}`.toLowerCase().includes(query)) : catalog), [catalog, query]);
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);
  const selected = catalog.find((item) => item.definitionId === selectedDefinitionId) ?? null;

  return (
    <Panel elevation="raised" padding="sm" className="astra-library" aria-label="Apparatus library">
      <div style={{ padding: '2px 6px 8px' }}>
        <PanelHeader eyebrow="Build" title="Apparatus library" />
        <SearchField label="Search apparatus" placeholder="Search burette, flask, probe…" value={search} onChange={onSearchChange} />
      </div>
      <div className="astra-scroll astra-library__list">
        {groups.size === 0 ? (
          <StatePanel kind="empty" title="No apparatus matches that search" detail="Try a different term, or clear the search to see the full catalog." />
        ) : (
          [...groups.entries()].map(([category, items]) => (
            <CollapsibleSection key={category} title={`${category} (${items.length})`} open={openCategories[category] ?? true} onToggle={() => setOpenCategories((s) => ({ ...s, [category]: !(s[category] ?? true) }))}>
              <div className="astra-apparatus-list">
                {items.map((item) => (
                  <ApparatusCard key={item.definitionId} item={item} dense selected={item.definitionId === selectedDefinitionId} onSelect={() => onSelect(item.definitionId)} />
                ))}
              </div>
            </CollapsibleSection>
          ))
        )}
      </div>
      {selected && (
        <div className="astra-library__detail">
          <div className="astra-library__detail-title">{selected.label}</div>
          <p className="astra-library__detail-desc">{selected.shortDescription}</p>
          {selected.dimensionsM && (
            <p className="astra-library__detail-dims astra-mono">
              {(selected.dimensionsM.width * 100).toFixed(1)} × {(selected.dimensionsM.height * 100).toFixed(1)} × {(selected.dimensionsM.depth * 100).toFixed(1)} cm
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

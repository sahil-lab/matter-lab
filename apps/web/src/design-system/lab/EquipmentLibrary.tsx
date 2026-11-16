import { ArrowLeft, Box, Plus, Search, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LabButton, LabHelpHint, LabStateNotice, LabTag } from './primitives';
import type { LabSurfaceAction, LabSurfaceStatus } from './types';

/** A read-only catalog projection, not an apparatus instance or a scene serialization. */
export interface EquipmentLibraryItem {
  readonly definitionId: string;
  readonly label: string;
  readonly category: string;
  readonly description?: string;
  readonly thumbnail?: ReactNode;
  readonly capabilities?: readonly string[];
  readonly keywords?: readonly string[];
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
  readonly unavailableReason?: string;
}

export function filterEquipment(items: readonly EquipmentLibraryItem[], query: string, category = ''): EquipmentLibraryItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (category && item.category !== category) return false;
    const haystack = [item.label, item.description, item.category, ...(item.capabilities ?? []), ...(item.keywords ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface EquipmentDetailProps {
  readonly item: EquipmentLibraryItem;
  readonly onPlace?: (definitionId: string) => void;
  readonly onBack?: () => void;
  readonly placementDisabled?: boolean;
}

export function EquipmentDetail({ item, onPlace, onBack, placementDisabled }: EquipmentDetailProps) {
  return (
    <article className="mlab-equipment-detail" aria-label={`${item.label} details`}>
      {onBack && <LabButton size="sm" onClick={onBack}><ArrowLeft />All apparatus</LabButton>}
      <div className="mlab-equipment-detail__preview" aria-hidden="true">{item.thumbnail ?? <Box />}</div>
      <div className="mlab-eyebrow">{item.category}</div>
      <h3>{item.label}</h3>
      {item.description && <p className="mlab-prose">{item.description}</p>}
      <div className="mlab-capabilities">{item.capabilities?.map((capability) => <LabTag key={capability}>{capability.replaceAll('_', ' ')}</LabTag>)}</div>
      {item.facts && item.facts.length > 0 && <dl className="mlab-properties">{item.facts.map((fact, index) => <div key={`${fact.label}-${index}`}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
      <p className="mlab-caption mlab-definition-id">Definition / {item.definitionId}</p>
      {item.unavailableReason && <LabStateNotice status="unsupported" compact>{item.unavailableReason}</LabStateNotice>}
      <LabButton variant="primary" disabled={placementDisabled || Boolean(item.unavailableReason) || !onPlace} onClick={() => onPlace?.(item.definitionId)}><Plus />Place apparatus</LabButton>
      <LabHelpHint>Placement is validated by the editor. Dimensions and capacities come from the apparatus definition, not from its thumbnail.</LabHelpHint>
    </article>
  );
}

export interface EquipmentLibraryProps {
  readonly items: readonly EquipmentLibraryItem[];
  readonly selectedId?: string | null;
  readonly onSelect?: (definitionId: string | null) => void;
  readonly onPlace?: (definitionId: string) => void;
  readonly status?: 'ready' | LabSurfaceStatus;
  readonly statusMessage?: string;
  readonly retry?: LabSurfaceAction;
  readonly placementDisabled?: boolean;
}

export function EquipmentLibrary({ items, selectedId, onSelect, onPlace, status = 'ready', statusMessage, retry, placementDisabled = false }: EquipmentLibraryProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selected = selectedId === undefined ? localSelection : selectedId;
  const categories = useMemo(() => [...new Set(items.map((item) => item.category))].sort(), [items]);
  const visible = useMemo(() => filterEquipment(items, query, category), [items, query, category]);
  const detail = items.find((item) => item.definitionId === selected);
  const canSelect = selectedId === undefined || Boolean(onSelect);
  const choose = (next: string | null) => { if (selectedId === undefined) setLocalSelection(next); onSelect?.(next); };
  const blocked = placementDisabled || status === 'loading' || status === 'error' || status === 'unsupported';
  const notice = status !== 'ready' ? <LabStateNotice status={status} compact action={retry}>{statusMessage ?? (status === 'offline' ? 'Showing the available cached catalog. Remote updates are unavailable.' : status === 'loading' ? 'Retrieving equipment definitions and display assets.' : status === 'error' ? 'The equipment catalog could not be loaded.' : status === 'unsupported' ? 'This catalog cannot be used with the current runtime.' : 'No apparatus definitions are available.')}</LabStateNotice> : null;
  return (
    <div className="mlab-equipment-library">
      {notice && <div className="mlab-library-notice">{notice}</div>}
      {detail ? <EquipmentDetail item={detail} onPlace={onPlace} onBack={canSelect ? () => choose(null) : undefined} placementDisabled={blocked} /> : (
        <>
          <div className="mlab-equipment-search">
            <label className="mlab-search"><Search aria-hidden="true" /><span className="mlab-sr-only">Search apparatus</span><input type="search" value={query} placeholder="Find apparatus…" autoComplete="off" onChange={(event) => setQuery(event.target.value)} aria-controls={`${id}-items`} />{query && <LabButton icon size="sm" aria-label="Clear apparatus search" onClick={() => setQuery('')}><X /></LabButton>}</label>
            <label><span className="mlab-sr-only">Apparatus category</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All apparatus</option>{categories.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          </div>
          <div className="mlab-library-count" role="status">{visible.length} {visible.length === 1 ? 'definition' : 'definitions'}{query ? ' found' : ' in catalog'}</div>
          <ul id={`${id}-items`} className="mlab-equipment-list" aria-label="Apparatus definitions">
            {visible.map((item) => <li key={item.definitionId} className="mlab-equipment-card" data-unavailable={Boolean(item.unavailableReason)}>
              <button type="button" className="mlab-equipment-select" aria-label={`Inspect ${item.label}`} disabled={!canSelect} onClick={() => choose(item.definitionId)}>
                <span className="mlab-equipment-thumb" aria-hidden="true">{item.thumbnail ?? <Box />}</span>
                <span className="mlab-equipment-card__copy"><small>{item.category}</small><strong>{item.label}</strong><span>{item.description}</span></span>
              </button>
              <div className="mlab-equipment-card__footer"><span className="mlab-caption">{item.unavailableReason ?? item.capabilities?.slice(0, 2).map((value) => value.replaceAll('_', ' ')).join(' · ')}</span><LabButton icon size="sm" disabled={blocked || Boolean(item.unavailableReason) || !onPlace} aria-label={`Place ${item.label}`} title={item.unavailableReason ?? `Place ${item.label}`} onClick={() => onPlace?.(item.definitionId)}><Plus /></LabButton></div>
            </li>)}
          </ul>
          {visible.length === 0 && status === 'ready' && <div className="mlab-library-notice"><LabStateNotice status="empty" title={items.length > 0 ? 'No matching apparatus' : 'The catalog is empty'} action={query || category ? { label: 'Clear filters', onPress: () => { setQuery(''); setCategory(''); } } : retry}>{items.length > 0 ? 'Try a label, capability or another category.' : 'Connect an equipment catalog before placing apparatus.'}</LabStateNotice></div>}
        </>
      )}
    </div>
  );
}

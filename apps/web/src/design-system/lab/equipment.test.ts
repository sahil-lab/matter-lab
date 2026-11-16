import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EquipmentDetail, EquipmentLibrary, filterEquipment } from './EquipmentLibrary';
import type { EquipmentLibraryItem } from './EquipmentLibrary';
import { LabInspector } from './LabInspector';
import { LabComponentGallery } from './LabComponentGallery';

const ITEMS: readonly EquipmentLibraryItem[] = Object.freeze([
  Object.freeze({ definitionId: 'receiver', label: 'Receiving flask', category: 'Glassware', description: 'A vessel', keywords: ['conical'], capabilities: ['FLOW_RECEIVER'] }),
  Object.freeze({ definitionId: 'probe', label: 'Probe', category: 'Instruments', unavailableReason: 'The selected runtime has no sensor model.' }),
]);

describe('apparatus catalog presentation', () => {
  it('matches all search words across metadata without changing definitions', () => {
    expect(filterEquipment(ITEMS, '  CONICAL receiver  ')).toEqual([ITEMS[0]]);
    expect(filterEquipment(ITEMS, 'probe', 'Glassware')).toEqual([]);
    expect(filterEquipment(ITEMS, '', 'Instruments')).toEqual([ITEMS[1]]);
    expect(filterEquipment(ITEMS, '')[0]).toBe(ITEMS[0]);
  });

  it('lets an unavailable definition be inspected but cannot issue placement', () => {
    const html = renderToStaticMarkup(createElement(EquipmentLibrary, { items: ITEMS, onPlace: vi.fn() }));
    expect(html.match(/<button[^>]*aria-label="Inspect Probe"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html.match(/<button[^>]*aria-label="Place Probe"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).toContain('The selected runtime has no sensor model.');
    const detail = renderToStaticMarkup(createElement(EquipmentDetail, { item: ITEMS[1]!, onPlace: vi.fn() }));
    expect(detail).toMatch(/<button[^>]*disabled=""[^>]*>.*?Place apparatus/s);
  });

  it('shows cached catalog offline and distinguishes an empty catalog from loading', () => {
    const offline = renderToStaticMarkup(createElement(EquipmentLibrary, { items: ITEMS, status: 'offline', onPlace: vi.fn() }));
    expect(offline).toContain('cached catalog');
    expect(offline.match(/<button[^>]*aria-label="Place Receiving flask"[^>]*>/)?.[0]).not.toContain('disabled');
    const loading = renderToStaticMarkup(createElement(EquipmentLibrary, { items: [], status: 'loading' }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('The catalog is empty');
    const empty = renderToStaticMarkup(createElement(EquipmentLibrary, { items: [] }));
    expect(empty).toContain('The catalog is empty');
  });
});

describe('inspector and in-app gallery', () => {
  it('keeps the keyboard editor slot available when nothing is selected', () => {
    const html = renderToStaticMarkup(createElement(LabInspector, { controls: createElement('button', null, 'Select from apparatus list') }));
    expect(html).toContain('Choose an apparatus');
    expect(html).toContain('Select from apparatus list');
    expect(html).not.toContain('Read-only properties');
  });

  it('labels demonstration content and does not fabricate scientific fixtures', () => {
    const html = renderToStaticMarkup(createElement(LabComponentGallery));
    expect(html).toContain('UI EXAMPLES ONLY');
    expect(html).toContain('No scientific fixture supplied');
    expect(html).toContain('not a simulation');
    expect(html).toContain('No observation supplied.');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LabEntry, LAB_ENTRY_KEY, needsLabEntry, rememberLabEntry } from './LabEntry';
import { LabShell } from './LabShell';
import { LabTransport } from './LabTransport';
import { changePanelVisibility, clampPanelSize, resizePanelWithKey } from './layout';
import { resolveLabMotion } from './motion';
import { LabJobProgress } from './primitives';

describe('laboratory panel controls', () => {
  it('makes compact drawers exclusive without unexpectedly opening panels', () => {
    const initial = Object.freeze({ library: true, inspector: false, timeline: true });
    expect(changePanelVisibility(initial, 'inspector', true, true)).toEqual({ library: false, inspector: true, timeline: true });
    expect(changePanelVisibility(initial, 'library', false, true)).toEqual({ library: false, inspector: false, timeline: true });
    expect(changePanelVisibility(initial, 'inspector', true, false)).toEqual({ library: true, inspector: true, timeline: true });
    expect(initial.library).toBe(true);
  });

  it('supports spatial keyboard resizing and finite, bounded sizes', () => {
    expect(resizePanelWithKey('library', 250, 'ArrowRight')).toBe(260);
    expect(resizePanelWithKey('inspector', 300, 'ArrowLeft', true)).toBe(340);
    expect(resizePanelWithKey('timeline', 200, 'ArrowUp')).toBe(210);
    expect(resizePanelWithKey('timeline', 200, 'ArrowRight')).toBeNull();
    expect(resizePanelWithKey('library', 250, 'Home')).toBe(220);
    expect(resizePanelWithKey('inspector', 300, 'End')).toBe(420);
    expect(clampPanelSize('library', -100)).toBe(220);
    expect(clampPanelSize('timeline', Number.NaN)).toBe(220);
  });

  it('keeps inactive panels hidden and the viewport reachable in a scene-agnostic shell', () => {
    const html = renderToStaticMarkup(createElement(LabShell, {
      viewport: createElement('div', { 'data-test-world': true }),
      library: 'Equipment catalog', inspector: 'Read-only observations', timeline: 'Stored observations',
      onExit: vi.fn(), onViewModeChange: vi.fn(),
    }));
    expect(html).toContain('Skip to laboratory viewport');
    expect(html).toContain('Return to molecular workspace');
    expect(html).toContain('scene coordinates in meters');
    expect(html).toMatch(/class="mlab-drawer__content" hidden=""[^>]*>.*?Read-only observations/s);
    expect(html).toMatch(/class="mlab-timeline-content" hidden=""/);
    expect(html).toContain('aria-label="Resize apparatus library"');
    expect(html).not.toContain('aria-label="Resize scientific inspector"');
  });
});

describe('honest operation states', () => {
  it('does not offer a runnable unsupported simulation even when a play callback exists', () => {
    const html = renderToStaticMarkup(createElement(LabTransport, { state: 'unsupported', onPlay: vi.fn(), disabledReason: 'No validated method for this mixture' }));
    expect(html.match(/<button[^>]*aria-label="Start simulation"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).toContain('No validated method for this mixture');
  });

  it('keeps unknown or invalid job progress indeterminate rather than inventing a percentage', () => {
    for (const progress of [null, Number.NaN, -1, 2]) {
      const html = renderToStaticMarkup(createElement(LabJobProgress, { title: 'Equilibrium', status: 'running', progress }));
      expect(html).toContain('<progress');
      expect(html).not.toMatch(/<progress[^>]*value=/);
    }
    const complete = renderToStaticMarkup(createElement(LabJobProgress, { title: 'Equilibrium', status: 'failed', progress: 1 }));
    expect(complete).not.toContain('<progress');
    expect(complete).toContain('No successful result was produced');
  });
});

describe('first-run entry and shared motion', () => {
  it('makes returning visits immediate and handles blocked preference storage', () => {
    const storage = { getItem: vi.fn(() => 'seen'), setItem: vi.fn() };
    expect(needsLabEntry(storage)).toBe(false);
    expect(renderToStaticMarkup(createElement(LabEntry, { storage }))).toBe('');
    expect(rememberLabEntry(storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(LAB_ENTRY_KEY, 'seen');
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(needsLabEntry(blocked)).toBe(true);
    expect(rememberLabEntry(blocked)).toBe(false);
    const first = renderToStaticMarkup(createElement(LabEntry, { storage: blocked }));
    expect(first).toContain('Skip introduction');
    expect(first).toMatch(/<button(?![^>]*disabled)[^>]*>Enter laboratory/);
  });

  it('never lets cinematic preference override OS reduced motion or leave camera theatrics enabled', () => {
    for (const preference of ['system', 'full', 'reduced'] as const) {
      expect(resolveLabMotion(preference, true)).toMatchObject({ reduced: true, durationMs: 0, cameraDurationS: 0, entryDurationMs: 0 });
    }
    expect(resolveLabMotion('reduced', false).cameraDurationS).toBe(0);
    expect(resolveLabMotion('system', false).entryDurationMs).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { astraLab } from './store';

describe('astra lab shell store (no window, as in this test environment)', () => {
  it('falls back to a sensible default panel layout instead of throwing when `window` is unavailable', () => {
    expect(typeof window).toBe('undefined');
    const state = astraLab.get();
    expect(state.libraryOpen).toBe(true);
    expect(state.inspectorOpen).toBe(true);
    expect(state.onboardingSeen).toBe(true);
  });

  it('starts with no scientific/demo state active: the honest disconnected default', () => {
    const state = astraLab.get();
    expect(state.previewDemoData).toBe(false);
    expect(state.playing).toBe(false);
    expect(state.scrubIndex).toBeNull();
    expect(state.jobs).toEqual([]);
  });
});

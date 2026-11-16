import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LabMotionProvider } from '../../design-system/lab/motion';
import { LabGuidedTutorial } from './LabGuidedTutorial';
import { LabLearningPanel } from './LabLearningPanel';
import { LearningModeChooser } from './LearningModeChooser';
import { goalHighlight, instructionAction } from './hints.ts';
import { replayCursorForKey } from './notebook.ts';
import { createEmptyHarness } from './test-fixtures.ts';

describe('shell-ready accessible learning surfaces', () => {
  it('keeps native keyboard mode controls and guided navigation separate from goal completion', () => {
    const { controller } = createEmptyHarness();
    const modes = renderToStaticMarkup(createElement(LearningModeChooser, { mode: 'guided', onChange: controller.setMode }));
    expect(modes).toContain('<legend>Experiment mode</legend>');
    expect(modes.match(/type="radio"/g)).toHaveLength(4);
    const score = controller.getSnapshot().evaluation.score;
    const before = renderToStaticMarkup(createElement(LabGuidedTutorial, { controller }));
    expect(before).toContain('Read next instruction');
    expect(before).not.toContain('Previous guide step');
    controller.setInstructionIndex(6);
    controller.dismissGuide(true);
    controller.dismissGuide(false);
    expect(controller.getSnapshot().evaluation.score).toBe(score);
    expect(score.complete).toBe(false);
    const final = renderToStaticMarkup(createElement(LabGuidedTutorial, { controller }));
    expect(final).toContain('Previous guide step');
    expect(final).not.toContain('Read next instruction');
    expect(final).toContain('Only accepted laboratory actions');
    controller.dispose();
  });

  it('renders no step overlay in challenge, free or precision mode, and no score objective in free mode', () => {
    const { controller } = createEmptyHarness();
    for (const mode of ['challenge', 'free', 'precision'] as const) {
      controller.setMode(mode);
      expect(renderToStaticMarkup(createElement(LabGuidedTutorial, { controller }))).toBe('');
    }
    controller.setMode('free');
    const markup = renderToStaticMarkup(createElement(LabLearningPanel, { controller }));
    expect(markup).toContain('No forced objective or score');
    expect(markup).not.toContain('Evidence-based objectives');
    expect(markup).toContain('No eligible observation');
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Capture current endpoint/)?.[0]).toBeTruthy();
    controller.dispose();
  });

  it('offers a non-3D path and explicit unsupported/missing-evidence captions without inventing readings', () => {
    const { controller } = createEmptyHarness();
    const markup = renderToStaticMarkup(createElement(LabLearningPanel, {
      controller, onActionRequest: vi.fn(), onExportNotebook: vi.fn(), onExportTemplate: vi.fn(),
    }));
    expect(markup).toContain('Non-3D guided path / apparatus controls');
    expect(markup).toContain('Export complete notebook JSON');
    expect(markup).toContain('Request fresh trial / station reset');
    expect(markup).toContain('No supported receiver pH observations');
    expect(markup).toContain('Known-preparation concentration answer (mol/L)');
    expect(markup).toContain('Endpoint and equivalence');
    expect(markup).toContain('<fieldset disabled="">');
    controller.dispose();
  });

  it('passes reduced-motion intent to real-object highlights without focusing unrelated station apparatus', () => {
    const { controller, ids } = createEmptyHarness();
    const view = controller.getSnapshot();
    expect(goalHighlight(view, 'stopcock', { reducedMotion: true })).toEqual({
      instanceIds: [ids.buretteId], controlId: 'stopcock',
      caption: view.attempt.definition.goals.find((goal) => goal.id === 'stopcock')!.hint,
      reducedMotion: true, focus: false,
    });
    const foreign = { ...view, trial: { ...view.trial, bindings: { ...view.trial.bindings, burette: ids.blankBenchId } } };
    expect(goalHighlight(foreign, 'stopcock', { reducedMotion: true })?.instanceIds).toEqual([]);
    expect(goalHighlight(foreign, 'stopcock', { reducedMotion: true })?.controlId).toBeUndefined();
    const html = renderToStaticMarkup(createElement(LabMotionProvider, {
      preference: 'reduced', children: createElement(LabGuidedTutorial, { controller }),
    }));
    expect(html).toContain('data-motion="reduced"');
    expect(instructionAction(view)?.instanceIds).toEqual([ids.standId, ids.clampId, ids.buretteId]);
    controller.dispose();
  });

  it('bounds replay keyboard navigation and ignores unrelated keys without mutating the controller', () => {
    const { controller } = createEmptyHarness();
    const before = controller.exportAttempt();
    expect(replayCursorForKey(0, 'ArrowLeft', 10)).toBe(0);
    expect(replayCursorForKey(9, 'ArrowRight', 10)).toBe(9);
    expect(replayCursorForKey(6, 'Home', 10)).toBe(0);
    expect(replayCursorForKey(6, 'End', 10)).toBe(9);
    expect(replayCursorForKey(6, 'ArrowUp', 10)).toBe(7);
    expect(replayCursorForKey(6, 'ArrowDown', 10)).toBe(5);
    expect(replayCursorForKey(6, 'Enter', 10)).toBeNull();
    expect(replayCursorForKey(0, 'ArrowRight', 0)).toBeNull();
    expect(controller.exportAttempt()).toEqual(before);
    controller.dispose();
  });
});

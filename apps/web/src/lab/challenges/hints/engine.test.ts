import { describe, expect, it } from 'vitest';
import { buildFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { GUIDED_TITRATION_OBJECTIVE } from '../titrationObjective';
import type { EvaluationContext } from '../goals';
import { buildChecklist, deriveHint } from './engine';

const EMPTY: EvaluationContext = { scene: null, events: [], runResults: [], trials: [], nowSimulationS: 0 };

describe('deriveHint', () => {
  it('points at the apparatus palette for the first step when nothing is placed', () => {
    const hint = deriveHint(GUIDED_TITRATION_OBJECTIVE, EMPTY);
    expect(hint).not.toBeNull();
    expect(hint!.stepId).toBe('place-stand');
    expect(hint!.stepIndex).toBe(0);
    expect(hint!.highlightTargets).toEqual([{ kind: 'paletteCategory', apparatusKind: 'STAND' }]);
    expect(hint!.accessibleText.length).toBeGreaterThan(0);
  });

  it('returns null once every step is satisfied', () => {
    const ctx = buildFixtureContext();
    expect(deriveHint(GUIDED_TITRATION_OBJECTIVE, ctx)).toBeNull();
  });

  it('highlights a resolved instance once its role is bound', () => {
    const full = buildFixtureContext();
    // Only the stand and clamp are placed and attached yet; the burette has not been placed.
    const partialScene = {
      ...full.scene!,
      apparatus: full.scene!.apparatus.filter((a) => a.kind === 'STAND' || a.kind === 'CLAMP'),
      connections: full.scene!.connections.filter((c) => c.kind === 'MECHANICAL' && c.from.instanceId !== 'fixture-burette' && c.to.instanceId !== 'fixture-burette'),
    };
    const partial: EvaluationContext = { scene: partialScene, events: [], runResults: [], trials: [], nowSimulationS: 0 };
    const hint = deriveHint(GUIDED_TITRATION_OBJECTIVE, partial);
    expect(hint!.stepId).toBe('mount-burette');
    expect(hint!.highlightTargets.some((t) => t.kind === 'paletteCategory' && t.apparatusKind === 'BURETTE')).toBe(true);
  });
});

describe('buildChecklist', () => {
  it('lists every step with its own met/unmet status for the non-3D accessible path', () => {
    const ctx = buildFixtureContext();
    const checklist = buildChecklist(GUIDED_TITRATION_OBJECTIVE, ctx);
    expect(checklist).toHaveLength(GUIDED_TITRATION_OBJECTIVE.steps.length);
    expect(checklist.every((item) => item.met)).toBe(true);
  });
});

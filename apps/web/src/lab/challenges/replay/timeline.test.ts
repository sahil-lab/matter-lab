import { describe, expect, it } from 'vitest';
import { buildFixtureTrial } from '../fixtures/strongAcidStrongBaseFixture';
import { buildReplayTimeline } from './timeline';

describe('buildReplayTimeline', () => {
  it('replays a trial as a monotonically increasing, scrubbable sequence from its own saved event log', () => {
    const trial = buildFixtureTrial();
    const timeline = buildReplayTimeline(trial);
    expect(timeline.trialId).toBe(trial.trialId);
    expect(timeline.steps.length).toBe(trial.events.length + trial.observations.length);
    for (let i = 1; i < timeline.steps.length; i++) {
      expect(timeline.steps[i]!.cumulativeVolumeL).toBeGreaterThanOrEqual(timeline.steps[i - 1]!.cumulativeVolumeL);
    }
    const last = timeline.steps[timeline.steps.length - 1]!;
    expect(last.description).toBe('Endpoint marked.');
    expect(timeline.steps.some((s) => s.latestPh !== null)).toBe(true);
  });
});

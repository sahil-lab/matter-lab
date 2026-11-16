import { describe, expect, it } from 'vitest';
import type { LabAction } from '@matterlab/contracts';
import { appendDuplicateEvent, appendEvent, findEventByActionId } from './eventLog';

function action(actionId: string): LabAction {
  return { actionId, atSimulationS: 0, targetInstanceId: 'x', type: 'MOVE', payload: {} };
}

describe('event log', () => {
  it('assigns monotonically increasing sequence numbers', () => {
    const { events: e1 } = appendEvent([], { action: action('a'), sceneRevisionBefore: 0, sceneRevisionAfter: 1, outcome: 'APPLIED' });
    const { events: e2, record } = appendEvent(e1, { action: action('b'), sceneRevisionBefore: 1, sceneRevisionAfter: 2, outcome: 'APPLIED' });
    expect(e1[0]!.sequence).toBe(0);
    expect(record.sequence).toBe(1);
    expect(e2).toHaveLength(2);
  });

  it('finds an existing event by actionId', () => {
    const { events } = appendEvent([], { action: action('a'), sceneRevisionBefore: 0, sceneRevisionAfter: 1, outcome: 'APPLIED' });
    expect(findEventByActionId(events, 'a')).toBeDefined();
    expect(findEventByActionId(events, 'missing')).toBeUndefined();
  });

  it('records a duplicate without changing scene revision', () => {
    const { events } = appendEvent([], { action: action('a'), sceneRevisionBefore: 0, sceneRevisionAfter: 1, outcome: 'APPLIED' });
    const { record } = appendDuplicateEvent(events, action('a'), 1);
    expect(record.outcome).toBe('DUPLICATE');
    expect(record.sceneRevisionBefore).toBe(1);
    expect(record.sceneRevisionAfter).toBe(1);
  });

  it('omits empty optional fields rather than storing them as empty arrays', () => {
    const { record } = appendEvent([], { action: action('a'), sceneRevisionBefore: 0, sceneRevisionAfter: 0, outcome: 'REJECTED', rejectionReason: 'nope', warnings: [] });
    expect(record.rejectionReason).toBe('nope');
    expect(record.warnings).toBeUndefined();
  });
});

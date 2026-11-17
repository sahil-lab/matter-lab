import { describe, expect, it } from 'vitest';
import { createStationClock, pauseClock, resetClock, setClockSpeed, startClock, stepOnce, ticksForElapsed } from './clock';

describe('station clock', () => {
  it('starts IDLE at time zero', () => {
    const clock = createStationClock('station-1', 0.1, 1);
    expect(clock.status).toBe('IDLE');
    expect(clock.simulationS).toBe(0);
    expect(clock.tickIndex).toBe(0);
  });

  it('startClock/pauseClock toggle status without affecting time', () => {
    let clock = createStationClock('station-1', 0.1, 1);
    clock = startClock(clock);
    expect(clock.status).toBe('RUNNING');
    clock = stepOnce(clock);
    expect(clock.simulationS).toBeCloseTo(0.1, 12);
    clock = pauseClock(clock);
    expect(clock.status).toBe('PAUSED');
    expect(clock.simulationS).toBeCloseTo(0.1, 12);
  });

  it('ticksForElapsed is zero while not RUNNING', () => {
    const clock = createStationClock('station-1', 0.1, 1);
    expect(ticksForElapsed(clock, 5, 200)).toBe(0);
  });

  it('ticksForElapsed computes whole ticks scaled by speed', () => {
    const clock = startClock(createStationClock('station-1', 0.1, 2));
    // 1 real second at speed 2 and a 0.1s tick = 20 ticks.
    expect(ticksForElapsed(clock, 1, 200)).toBe(20);
  });

  it('ticksForElapsed is capped at maxTicks (spiral-of-death guard)', () => {
    const clock = startClock(createStationClock('station-1', 0.1, 1));
    expect(ticksForElapsed(clock, 1000, 50)).toBe(50);
  });

  it('setClockSpeed ignores non-positive speeds', () => {
    const clock = createStationClock('station-1', 0.1, 1);
    expect(setClockSpeed(clock, 0).speed).toBe(1);
    expect(setClockSpeed(clock, -3).speed).toBe(1);
    expect(setClockSpeed(clock, 4).speed).toBe(4);
  });

  it('resetClock returns to IDLE at time zero but keeps timeStepS/speed', () => {
    let clock = startClock(createStationClock('station-1', 0.25, 3));
    clock = stepOnce(stepOnce(clock));
    clock = resetClock(clock);
    expect(clock.status).toBe('IDLE');
    expect(clock.simulationS).toBe(0);
    expect(clock.tickIndex).toBe(0);
    expect(clock.timeStepS).toBe(0.25);
    expect(clock.speed).toBe(3);
  });
});

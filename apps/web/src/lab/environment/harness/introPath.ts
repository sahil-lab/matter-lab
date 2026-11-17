/**
 * A short, skippable first-run camera traversal for the harness: a wide establishing view settling
 * onto the first station. Demonstrates `cameraDirectorApi.playIntro`; a real integration would
 * likely compute its waypoints from the actual station layout rather than hardcoding them.
 */
import type { CinematicWaypoint } from '../cameraModes';

export function introWaypoints(): readonly CinematicWaypoint[] {
  return [
    { pose: { position: [9, 5.2, 11], target: [0, 1.1, 0], zoom: 1, projection: 'perspective' }, travelSeconds: 0 },
    { pose: { position: [3.4, 2.5, 4.4], target: [0, 1, 0], zoom: 1, projection: 'perspective' }, travelSeconds: 2.6 },
    { pose: { position: [1.15, 1.35, 1.6], target: [0, 0.95, 0], zoom: 1, projection: 'perspective' }, travelSeconds: 1.8 },
  ];
}

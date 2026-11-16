import { useEffect, useRef } from 'react';
import { useLab } from '../state/store';
import { SetupToggle } from './ChamberBar';
import { ResultsPanel } from './ResultsPanel';
import { SetupPanel } from './SetupPanel';
import { frameCount, reactedGroups, refreshSaved, seek, setPlaying, syncStage, useReaction } from './store';

/** Seconds a full playback of the time course takes at 1x speed. */
const PLAYBACK_SECONDS = 10;

/** Advances the timeline while it is playing, at a pace set by the chosen speed. */
function usePlayback(): void {
  const playing = useReaction((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let position = useReaction.getState().frame;
    let shown = Math.floor(position);
    const tick = (now: number) => {
      const state = useReaction.getState();
      const count = frameCount(state);
      if (count === 0) return;
      // The timeline may have been moved by hand since the last tick.
      if (state.frame !== shown) position = state.frame;
      position += ((now - last) / 1000) * ((count - 1) / PLAYBACK_SECONDS) * state.speed;
      last = now;
      if (position >= count - 1) {
        seek(count - 1);
        setPlaying(false);
        return;
      }
      shown = Math.floor(position);
      if (shown !== state.frame) seek(shown);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
}

/** Keeps the 3D chamber in step with the experiment and the position of the timeline. */
function useChamberStage(): void {
  const plan = useReaction((s) => s.plan);
  const reacted = useReaction(reactedGroups);
  const highlight = useReaction((s) => s.highlight);
  const shownPlan = useRef<unknown>(undefined);
  useEffect(() => {
    // A new chamber is framed by the camera; moving through time leaves the view where it is.
    syncStage(shownPlan.current !== plan);
    shownPlan.current = plan;
  }, [plan, reacted, highlight]);
}

/**
 * The Reaction Laboratory workspace: set up an experiment on the left, read results, graphs and
 * the explanation on the right, and watch the chamber's population in the middle. The legend and
 * the time controls live in the top and bottom rows of the application frame.
 */
export function ReactionLab() {
  const sidePanelOpen = useLab((s) => s.sidePanelOpen);
  usePlayback();
  useChamberStage();
  useEffect(() => void refreshSaved(), []);
  return (
    <>
      {sidePanelOpen ? (
        <div className="ml-sideslot">
          <SetupPanel />
        </div>
      ) : (
        <SetupToggle />
      )}
      <ResultsPanel />
    </>
  );
}

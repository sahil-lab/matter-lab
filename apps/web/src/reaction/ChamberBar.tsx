import { ChevronRight, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import { lab } from '../state/store';
import { formatDuration } from '../ui/charts';
import { ChemText } from '../ui/chem';
import { EvidenceBadge, IconButton } from '../ui/kit';
import { Select } from './fields';
import { frameCount, reactedGroups, seek, setConversion, setPlaying, setSpeed, step, toggleHighlight, useReaction } from './store';

const SPEEDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0.25', label: '0.25×' },
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

/**
 * What the chamber is showing right now: how many molecules of each species are drawn, and the
 * plain statement of what kind of picture it is. Sits between the top bars.
 */
export function ChamberLegend() {
  const plan = useReaction((s) => s.plan);
  const loading = useReaction((s) => s.structuresLoading);
  const structures = useReaction((s) => s.structures);
  const highlight = useReaction((s) => s.highlight);
  const reacted = useReaction(reactedGroups);
  const hasTimeCourse = useReaction((s) => frameCount(s) > 0);
  if (loading) {
    return (
      <div className="ml-panel ml-legend" data-testid="chamber-legend">
        <span className="ml-legend__note">Preparing 3D models of the species…</span>
      </div>
    );
  }
  if (!plan) return null;
  const drawn = plan.species.filter((s) => s.structure);
  if (drawn.length === 0) {
    return (
      <div className="ml-panel ml-legend" data-testid="chamber-legend">
        <span className="ml-legend__note">No species of this reaction has a single-molecule 3D model, so the chamber is empty. The results do not depend on it.</span>
      </div>
    );
  }
  const count = (key: string, side: 'reactant' | 'product', coefficient: number) =>
    (side === 'reactant' ? plan.groups - reacted : reacted) * Math.round(coefficient) + (plan.excess[key] ?? 0);
  return (
    <div className="ml-panel ml-legend" data-testid="chamber-legend">
      <div className="ml-legend__row" data-testid="chamber-counts">
        <EvidenceBadge level="illustrative" tipPos="bottom" />
        {plan.species.map((s) => {
          const lookup = structures[s.key];
          return s.structure ? (
            <button
              key={s.key}
              type="button"
              className="ml-legend__chip"
              data-side={s.side}
              aria-pressed={highlight === s.key}
              title={`${s.structure.note} Click to highlight these molecules.`}
              onClick={() => toggleHighlight(s.key)}
            >
              <b>{count(s.key, s.side, s.coefficient)}</b>
              <ChemText text={s.key} />
            </button>
          ) : (
            <span key={s.key} className="ml-legend__chip" data-undrawn title={lookup && !lookup.ok ? lookup.reason : undefined}>
              <ChemText text={s.key} />
              <i>not drawn</i>
            </span>
          );
        })}
      </div>
      <div className="ml-legend__note">
        Population view: counts follow the {hasTimeCourse ? 'computed concentrations' : 'stoichiometry'}; positions are arbitrary, and nothing moves along a computed path.
        {plan.capped.length > 0 && ` The large surplus of ${plan.capped.join(', ')} is cut down to keep the picture readable.`}
      </div>
    </div>
  );
}

function TimeControls() {
  const frame = useReaction((s) => s.frame);
  const playing = useReaction((s) => s.playing);
  const speed = useReaction((s) => s.speed);
  const times = useReaction((s) => s.result?.kinetics?.times);
  const count = useReaction(frameCount);
  if (!times || count === 0) return null;
  const last = count - 1;
  return (
    <div className="ml-panel ml-bar ml-timeline" data-testid="timeline">
      <IconButton className="ml-hide-narrow" tip="To the start" onClick={() => step(-frame)}>
        <SkipBack />
      </IconButton>
      <IconButton tip="One frame back" onClick={() => step(-1)} disabled={frame === 0}>
        <StepBack />
      </IconButton>
      <IconButton tip={playing ? 'Pause' : 'Play'} active={playing} onClick={() => setPlaying(!playing)} data-testid="timeline-play">
        {playing ? <Pause /> : <Play />}
      </IconButton>
      <IconButton tip="One frame forward" onClick={() => step(1)} disabled={frame === last}>
        <StepForward />
      </IconButton>
      <IconButton className="ml-hide-narrow" tip="To the end" onClick={() => step(last - frame)}>
        <SkipForward />
      </IconButton>
      <input
        className="ml-timeline__slider"
        type="range"
        min={0}
        max={last}
        value={frame}
        aria-label="Reaction time"
        data-testid="timeline-slider"
        onChange={(e) => {
          setPlaying(false);
          seek(Number(e.target.value));
        }}
      />
      <span className="ml-timeline__time ml-mono" data-testid="timeline-time">
        {formatDuration(times[frame]!)} <small>of {formatDuration(times[last]!)}</small>
      </span>
      <Select label="Playback speed" className="ml-timeline__speed" value={String(speed)} options={SPEEDS} onChange={(value) => setSpeed(Number(value))} />
    </div>
  );
}

/** For experiments without a time course: step between the reactant side and the product side of the equation. */
function ConversionControls() {
  const plan = useReaction((s) => s.plan);
  const conversion = useReaction((s) => s.conversion);
  const hasTimeCourse = useReaction((s) => frameCount(s) > 0);
  if (!plan || hasTimeCourse || plan.species.every((s) => !s.structure)) return null;
  const events = Math.round(conversion * plan.groups);
  return (
    <div className="ml-panel ml-bar ml-timeline" data-testid="conversion">
      <span className="ml-timeline__label">Before</span>
      <input
        className="ml-timeline__slider"
        type="range"
        min={0}
        max={plan.groups}
        value={events}
        aria-label="Reaction events shown as products"
        data-testid="conversion-slider"
        onChange={(e) => setConversion(Number(e.target.value) / plan.groups)}
      />
      <span className="ml-timeline__label">After</span>
      <span className="ml-timeline__time ml-mono" data-testid="conversion-count">
        {events} <small>of {plan.groups} events</small>
      </span>
    </div>
  );
}

/** The controls that move through the chamber's states; they sit in the middle of the bottom row. */
export function ChamberControls() {
  return (
    <>
      <TimeControls />
      <ConversionControls />
    </>
  );
}

/** Brings the set-up panel back when it has been hidden. */
export function SetupToggle() {
  return (
    <div className="ml-left">
      <div className="ml-panel ml-bar ml-bar--vertical">
        <IconButton size="lg" tip="Show the experiment set-up" tipPos="right" onClick={() => lab.set({ sidePanelOpen: true })} data-testid="show-setup">
          <ChevronRight />
        </IconButton>
      </div>
    </div>
  );
}

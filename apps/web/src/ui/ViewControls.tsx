import { Aperture, Bookmark, Box, Camera, Rotate3d, RotateCcw, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDeviceInfo } from '../render/MatterCanvas';
import { perfMonitor } from '../render/perf';
import type { PerfSnapshot } from '../render/perf';
import { RENDER_MODE_LABELS } from '../render/style';
import { subscribeViewFrame, viewApi } from '../render/viewApi';
import type { StandardView } from '../render/viewApi';
import { addBookmark, gotoBookmark, removeBookmark } from '../state/actions';
import { exportImage } from '../state/commands';
import { lab, useLab } from '../state/store';
import type { LabelMode, RenderMode } from '../state/store';
import { IconButton, Segmented, formatCount, useDismiss } from './kit';

const AXES = [
  { name: 'X', color: '#ff8791', view: 'right' as StandardView },
  { name: 'Y', color: '#74e3a6', view: 'top' as StandardView },
  { name: 'Z', color: '#7fb4ff', view: 'front' as StandardView },
];
const GIZMO_RADIUS = 27;

/** Orientation gizmo: shows where the world axes point and snaps the view when an axis is clicked. */
export function AxisGizmo() {
  const lines = useRef<Array<SVGLineElement | null>>([]);
  const knobs = useRef<Array<SVGGElement | null>>([]);
  const layer = useRef<SVGGElement>(null);

  useEffect(
    () =>
      subscribeViewFrame(({ rotation }) => {
        const order: Array<{ depth: number; knob: SVGGElement }> = [];
        AXES.forEach((_, i) => {
          // Column i of the world-to-view rotation is where world axis i points on screen.
          const x = rotation[i]! * GIZMO_RADIUS;
          const y = -rotation[3 + i]! * GIZMO_RADIUS;
          const depth = rotation[6 + i]!;
          const line = lines.current[i];
          const knob = knobs.current[i];
          if (!line || !knob) return;
          line.setAttribute('x2', x.toFixed(2));
          line.setAttribute('y2', y.toFixed(2));
          line.style.opacity = String(0.45 + 0.4 * (depth + 1) * 0.5);
          knob.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
          knob.style.opacity = String(0.55 + 0.45 * (depth + 1) * 0.5);
          order.push({ depth, knob });
        });
        // Paint the axis pointing at the viewer last so it sits on top.
        order.sort((a, b) => a.depth - b.depth).forEach(({ knob }) => layer.current?.appendChild(knob));
      }),
    [],
  );

  return (
    <div className="ml-panel ml-gizmo" aria-label="View orientation">
      <svg viewBox="-39 -39 78 78">
        <circle r="3" fill="rgba(135,170,198,0.5)" />
        {AXES.map((axis, i) => (
          <line key={axis.name} ref={(el) => void (lines.current[i] = el)} x1="0" y1="0" stroke={axis.color} strokeWidth="1.7" strokeLinecap="round" />
        ))}
        <g ref={layer}>
          {AXES.map((axis, i) => (
            <g
              key={axis.name}
              ref={(el) => void (knobs.current[i] = el)}
              className="ml-gizmo__axis"
              role="button"
              aria-label={`View along ${axis.name}`}
              onClick={() => viewApi.setStandardView(axis.view)}
            >
              <circle r="7.5" fill={axis.color} />
              <text fill="#06101c">{axis.name}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

const VIEWS: ReadonlyArray<{ id: StandardView; label: string }> = [
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'right', label: 'Right' },
  { id: 'left', label: 'Left' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'iso', label: 'Isometric' },
];

function ViewsMenu() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const bookmarks = useLab((s) => s.bookmarks);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <IconButton tip="Standard views and bookmarks" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Rotate3d />
      </IconButton>
      {open && (
        <div className="ml-menu" role="menu" style={{ bottom: 'calc(100% + 10px)', right: 0, minWidth: 210 }}>
          <button className="ml-menu__item" role="menuitem" onClick={() => viewApi.resetView()}>
            <RotateCcw /> Reset view <span className="ml-kbd">Shift Home</span>
          </button>
          <div className="ml-menu__sep" />
          <div className="ml-menu__label ml-label">Standard views</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            {VIEWS.map((v) => (
              <button key={v.id} className="ml-menu__item" role="menuitem" onClick={() => viewApi.setStandardView(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="ml-menu__sep" />
          <div className="ml-menu__label ml-label">Bookmarks</div>
          {bookmarks.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center' }}>
              <button className="ml-menu__item" role="menuitem" onClick={() => gotoBookmark(b.id)}>
                <Bookmark /> {b.name}
              </button>
              <IconButton size="sm" variant="danger" aria-label={`Delete ${b.name}`} onClick={() => removeBookmark(b.id)}>
                <Trash2 />
              </IconButton>
            </div>
          ))}
          <button className="ml-menu__item" role="menuitem" onClick={addBookmark}>
            <Bookmark /> Bookmark this view
          </button>
        </div>
      )}
    </div>
  );
}

const LABEL_CYCLE: Readonly<Record<LabelMode, LabelMode>> = { none: 'hetero', hetero: 'all', all: 'none' };
const LABEL_TIPS: Readonly<Record<LabelMode, string>> = {
  none: 'Atom labels: off',
  hetero: 'Atom labels: all except carbon and hydrogen',
  all: 'Atom labels: every atom',
};

export function ViewBar() {
  const renderMode = useLab((s) => s.renderMode);
  const projection = useLab((s) => s.projection);
  const labelMode = useLab((s) => s.labelMode);
  const modes = Object.keys(RENDER_MODE_LABELS) as RenderMode[];
  return (
    <div className="ml-panel ml-bar" style={{ gap: 3 }}>
      <span className="ml-wide-only" style={{ display: 'flex' }}>
        <Segmented<RenderMode>
          label="Representation"
          value={renderMode}
          onChange={(value) => lab.set({ renderMode: value })}
          options={modes.map((mode) => ({ value: mode, label: RENDER_MODE_LABELS[mode].label, tip: RENDER_MODE_LABELS[mode].description }))}
        />
      </span>
      <select
        className="ml-select ml-compact-only"
        style={{ width: 132, height: 30 }}
        aria-label="Representation"
        value={renderMode}
        onChange={(e) => lab.set({ renderMode: e.target.value as RenderMode })}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {RENDER_MODE_LABELS[mode].label}
          </option>
        ))}
      </select>
      <div className="ml-sep" />
      <IconButton tip={LABEL_TIPS[labelMode]} active={labelMode !== 'none'} onClick={() => lab.set({ labelMode: LABEL_CYCLE[labelMode] })} data-testid="labels">
        <Tag />
      </IconButton>
      <IconButton
        tip={projection === 'perspective' ? 'Perspective view · switch to orthographic  (5)' : 'Orthographic view · switch to perspective  (5)'}
        active={projection === 'orthographic'}
        onClick={() => lab.set({ projection: projection === 'perspective' ? 'orthographic' : 'perspective' })}
        data-testid="projection"
      >
        {projection === 'perspective' ? <Aperture /> : <Box />}
      </IconButton>
      <ViewsMenu />
      <IconButton tip="Save the view as an image" tipPos="top-end" onClick={() => void exportImage()}>
        <Camera />
      </IconButton>
    </div>
  );
}

function niceLength(angstromPerPixel: number): { angstrom: number; label: string } {
  const ideal = angstromPerPixel * 96;
  const exponent = Math.floor(Math.log10(ideal));
  const fraction = ideal / 10 ** exponent;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  const angstrom = nice * 10 ** exponent;
  const label = angstrom >= 10 ? `${Number((angstrom / 10).toPrecision(3))} nm` : angstrom >= 1 ? `${angstrom} Å` : `${Number((angstrom * 100).toPrecision(3))} pm`;
  return { angstrom, label };
}

/** Scale bar. In perspective the scale is only exact at the depth the camera orbits around, and it says so. */
export function ScaleBar() {
  const rule = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      subscribeViewFrame(({ angstromPerPixel, orthographic }) => {
        if (!rule.current || !text.current || !note.current || !(angstromPerPixel > 0)) return;
        const { angstrom, label } = niceLength(angstromPerPixel);
        rule.current.style.width = `${(angstrom / angstromPerPixel).toFixed(1)}px`;
        text.current.textContent = label;
        note.current.textContent = orthographic ? 'true scale' : 'at focus depth';
      }),
    [],
  );
  return (
    <div className="ml-panel ml-scalebar" data-tip="1 Å = 0.1 nm = 100 pm" aria-label="Scale bar">
      <div ref={rule} className="ml-scalebar__rule" style={{ width: 96 }} />
      <div className="ml-scalebar__text">
        <b ref={text}>1 Å</b>
        <span ref={note}>at focus depth</span>
      </div>
    </div>
  );
}

/** Live performance read-out, fed by the instrumentation built into the frame loop. */
export function PerfHud() {
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(() => perfMonitor.snapshot());
  const atoms = useLab((s) => s.scene.atoms.size);
  const bonds = useLab((s) => s.scene.bonds.size);
  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot(perfMonitor.snapshot()), 400);
    return () => window.clearInterval(timer);
  }, []);
  const row = (name: string, value: string) => (
    <div className="ml-perf__row">
      <span>{name}</span>
      <b>{value}</b>
    </div>
  );
  const device = getDeviceInfo();
  return (
    <div className="ml-panel ml-perf" data-testid="perf-hud">
      <div className="ml-perf__fps">
        {snapshot.idle ? '—' : snapshot.fps.toFixed(0)}
        <small>{snapshot.idle ? 'idle · renders on demand' : 'frames / s'}</small>
      </div>
      {row('frame (mean / p95)', snapshot.idle ? '—' : `${snapshot.frameMs.toFixed(1)} / ${snapshot.frameMsP95.toFixed(1)} ms`)}
      {row('cpu (median)', snapshot.cpuMs === null ? '—' : `${snapshot.cpuMs.toFixed(2)} ms`)}
      {row('gpu (median)', !snapshot.gpuTimingAvailable ? 'not exposed' : snapshot.gpuMs === null ? '—' : `${snapshot.gpuMs.toFixed(2)} ms`)}
      {row('draw calls', formatCount(snapshot.drawCalls))}
      {row('triangles', formatCount(snapshot.triangles))}
      {row('atoms / bonds', `${formatCount(atoms)} / ${formatCount(bonds)}`)}
      {row('pixel ratio', snapshot.pixelRatio.toFixed(2))}
      {snapshot.heapMb !== null && row('js heap', `${snapshot.heapMb.toFixed(0)} MB`)}
      {device && (
        <div style={{ marginTop: 4, color: 'var(--text-3)', maxWidth: 230, overflowWrap: 'anywhere', lineHeight: 1.35 }}>{device.renderer}</div>
      )}
    </div>
  );
}

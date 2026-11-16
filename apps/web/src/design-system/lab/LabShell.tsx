import { ArrowLeft, BookOpen, Columns2, Expand, Footprints, Gauge, Grid2X2, Maximize2, Minimize2, Orbit, PanelBottomClose, PanelBottomOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Settings2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { clampPanelSize, changePanelVisibility, DEFAULT_LAB_PANELS, LAB_PANEL_LIMITS, resizePanelWithKey } from './layout';
import { LabMotionProvider, useLabMotion } from './motion';
import { LabButton, LabDialog, LabHelpHint } from './primitives';
import type { LabInteractionFeedback, LabMotionPreference, LabPanelId, LabPanelVisibility, LabShellSlots } from './types';
import './tokens.css';
import './lab.css';

export type LabViewMode = 'orbit' | 'first-person' | 'top-down' | 'inspection';
export type LabQualityPreset = 'low' | 'balanced' | 'high';

export interface LabShellProps extends LabShellSlots {
  readonly title?: string;
  readonly stationLabel?: string;
  readonly onExit?: () => void;
  readonly viewMode?: LabViewMode;
  readonly onViewModeChange?: (mode: LabViewMode) => void;
  readonly quality?: LabQualityPreset;
  readonly onQualityChange?: (quality: LabQualityPreset) => void;
  readonly motion?: LabMotionPreference;
  readonly onMotionChange?: (preference: LabMotionPreference) => void;
  /** Pass to the environment; system reduced-motion is always respected. */
  readonly onReducedMotionChange?: (reduced: boolean) => void;
  readonly panels?: LabPanelVisibility;
  readonly defaultPanels?: Partial<LabPanelVisibility>;
  readonly onPanelsChange?: (panels: LabPanelVisibility) => void;
  readonly interaction?: LabInteractionFeedback;
  readonly onRequestTutorial?: () => void;
  readonly gallery?: ReactNode;
}

const PANEL_NAMES = { library: 'Apparatus library', inspector: 'Scientific inspector', timeline: 'Observation timeline' };

function subscribeCompact(listener: () => void) {
  const query = window.matchMedia('(max-width: 1000px)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function ResizeHandle({ panel, value, onChange, controls }: { panel: LabPanelId; value: number; onChange: (size: number) => void; controls: string }) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const axis = (event: ReactPointerEvent) => panel === 'timeline' ? event.clientY : event.clientX;
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div className="mlab-resize" data-panel={panel} role="separator" tabIndex={0}
      aria-label={`Resize ${PANEL_NAMES[panel].toLowerCase()}`} aria-controls={controls}
      aria-orientation={panel === 'timeline' ? 'horizontal' : 'vertical'}
      aria-valuemin={LAB_PANEL_LIMITS[panel].min} aria-valuemax={LAB_PANEL_LIMITS[panel].max} aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      onKeyDown={(event) => {
        const next = resizePanelWithKey(panel, value, event.key, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { start: axis(event), value };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const delta = (axis(event) - drag.current.start) * (panel === 'library' ? 1 : -1);
        onChange(clampPanelSize(panel, drag.current.value + delta));
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}
    ><span /></div>
  );
}

function LabShellContent({
  viewport, library, inspector, timeline, tutorial, hud, toolbar, status, entry, gallery,
  title = 'Laboratory', stationLabel, onExit, viewMode = 'orbit', onViewModeChange,
  quality = 'balanced', onQualityChange, motion = 'system', onMotionChange, onReducedMotionChange,
  panels, defaultPanels, onPanelsChange, interaction, onRequestTutorial,
}: LabShellProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [localPanels, setLocalPanels] = useState<LabPanelVisibility>({ ...DEFAULT_LAB_PANELS, ...defaultPanels });
  const [sizes, setSizes] = useState({ library: LAB_PANEL_LIMITS.library.initial as number, inspector: LAB_PANEL_LIMITS.inspector.initial as number, timeline: LAB_PANEL_LIMITS.timeline.initial as number });
  const [immersive, setImmersive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const compact = useSyncExternalStore(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? subscribeCompact : () => () => undefined,
    () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1000px)').matches,
    () => false,
  );
  const activePanels = panels ?? localPanels;
  const motionSettings = useLabMotion();
  const isOpen = (panel: LabPanelId) => !immersive && activePanels[panel] && ({ library, inspector, timeline }[panel] != null);
  const setPanel = (panel: LabPanelId, open: boolean) => {
    const next = changePanelVisibility(activePanels, panel, open, compact);
    if (!panels) setLocalPanels(next);
    onPanelsChange?.(next);
    if (!open) document.getElementById(`${id}-${panel}-toggle`)?.focus();
  };
  useEffect(() => { onReducedMotionChange?.(motionSettings.reduced); }, [motionSettings.reduced, onReducedMotionChange]);
  useEffect(() => {
    if (!compact || !activePanels.library || !activePanels.inspector) return;
    const next = changePanelVisibility(activePanels, 'inspector', true, true);
    if (!panels) setLocalPanels(next);
    onPanelsChange?.(next);
  }, [compact, activePanels, panels, onPanelsChange]);
  useEffect(() => {
    const onFullscreen = () => { if (!document.fullscreenElement) setImmersive(false); };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const exitImmersive = () => {
    setImmersive(false);
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined);
  };
  const toggleImmersive = async () => {
    if (immersive) { exitImmersive(); return; }
    setImmersive(true);
    setAnnouncement('Immersive view. Press Escape or Restore panels to return.');
    try {
      if (root.current?.requestFullscreen) await root.current.requestFullscreen();
    } catch {
      setAnnouncement('Immersive view is active in this window. Browser fullscreen is unavailable.');
    }
  };
  const resize = (panel: LabPanelId, size: number) => setSizes((current) => ({ ...current, [panel]: size }));
  const style = {
    '--mlab-library-size': `${sizes.library}px`,
    '--mlab-inspector-size': `${sizes.inspector}px`,
    '--mlab-timeline-size': `${sizes.timeline}px`,
    '--mlab-motion-duration': `${motionSettings.durationMs}ms`,
  } as CSSProperties;

  const sidePanel = (panel: 'library' | 'inspector', slot: ReactNode) => {
    if (slot == null) return null;
    const open = isOpen(panel);
    const Icon = panel === 'library' ? (open ? PanelLeftClose : PanelLeftOpen) : (open ? PanelRightClose : PanelRightOpen);
    return (
      <aside className="mlab-drawer" data-panel={panel} data-open={open} aria-label={PANEL_NAMES[panel]}>
        <div className="mlab-drawer__rail">
          <LabButton id={`${id}-${panel}-toggle`} icon active={open} aria-label={`${open ? 'Collapse' : 'Open'} ${PANEL_NAMES[panel].toLowerCase()}`}
            title={PANEL_NAMES[panel]} aria-expanded={open} aria-controls={`${id}-${panel}`} onClick={() => setPanel(panel, !open)}>
            <Icon />
          </LabButton>
          <span className="mlab-rail-label" aria-hidden="true">{panel === 'library' ? 'Apparatus' : 'Inspector'}</span>
        </div>
        <div id={`${id}-${panel}`} className="mlab-drawer__content" hidden={!open} tabIndex={-1}>
          <header className="mlab-panel-heading"><span className="mlab-eyebrow">{panel === 'library' ? '01 / Build' : '02 / Inspect'}</span><h2>{PANEL_NAMES[panel]}</h2></header>
          <div className="mlab-panel-scroll">{slot}</div>
        </div>
        {open && <ResizeHandle panel={panel} value={sizes[panel]} controls={`${id}-${panel}`} onChange={(size) => resize(panel, size)} />}
      </aside>
    );
  };

  return (
    <div ref={root} className="ml-lab mlab-shell" style={style} data-reduced-motion={motionSettings.reduced}
      data-immersive={immersive} data-library={isOpen('library')} data-inspector={isOpen('inspector')}
      data-has-library={library != null} data-has-inspector={inspector != null}
      data-interaction={interaction?.mode ?? 'idle'} data-pointer-captured={interaction?.pointerCaptured ?? false}
      onKeyDown={(event) => { if (event.key === 'Escape' && immersive && !settingsOpen && !galleryOpen) { event.preventDefault(); exitImmersive(); } }}>
      <a className="mlab-skip" href={`#${id}-viewport`}>Skip to laboratory viewport</a>
      <header className="mlab-topbar">
        <div className="mlab-brand-group">
          {onExit && <LabButton icon aria-label="Return to molecular workspace" title="Return to molecular workspace — your document is preserved" onClick={onExit}><ArrowLeft /></LabButton>}
          <div className="mlab-brand" aria-label="Matter Lab instrument room"><span className="mlab-brand__mark" aria-hidden="true">M<span>·</span></span><span>MATTER <b>LAB</b><small>INSTRUMENT ROOM</small></span></div>
          <div className="mlab-project"><strong title={title}>{title}</strong><span>{stationLabel ?? 'Virtual laboratory'} <i aria-hidden="true">/</i> meters</span></div>
        </div>
        <div className="mlab-toolbar-slot">{toolbar}</div>
        <nav className="mlab-navigation" aria-label="Laboratory view">
          {onViewModeChange && (
            <div className="mlab-view-modes" role="group" aria-label="Camera mode">
              {([
                ['orbit', Orbit, 'Orbit view'],
                ['first-person', Footprints, 'First-person view'],
                ['top-down', Grid2X2, 'Top-down view'],
              ] as const).map(([value, Icon, label]) => (
                <LabButton key={value} icon active={viewMode === value} aria-label={label} title={label} onClick={() => onViewModeChange(value)}><Icon /></LabButton>
              ))}
            </div>
          )}
          {onRequestTutorial && <LabButton icon aria-label="Open guided experiments" title="Guided experiments" onClick={onRequestTutorial}><BookOpen /></LabButton>}
          <LabButton icon aria-label="Laboratory display settings" title="Display settings" onClick={() => setSettingsOpen(true)}><Settings2 /></LabButton>
          <LabButton icon active={immersive} aria-label={immersive ? 'Restore panels' : 'Enter immersive view'} title={immersive ? 'Restore panels' : 'Immersive view'} onClick={() => void toggleImmersive()}>{immersive ? <Minimize2 /> : <Maximize2 />}</LabButton>
        </nav>
      </header>

      <div className="mlab-layout">
        {sidePanel('library', library)}
        <main className="mlab-main">
          <section id={`${id}-viewport`} className="mlab-stage" tabIndex={-1} aria-label="Laboratory viewport, scene coordinates in meters">
            <div className="mlab-viewport">{viewport}</div>
            <div className="mlab-stage-caption"><span className="mlab-crosshair" aria-hidden="true">+</span><span>{stationLabel ?? 'Laboratory'}<small>SCENE / m</small></span></div>
            {hud && <div className="mlab-hud-slot">{hud}</div>}
            {tutorial && <div className="mlab-tutorial-slot">{tutorial}</div>}
            {interaction?.label && <div className="mlab-interaction" data-validity={interaction.mode} role="status"><strong>{interaction.label}</strong>{interaction.detail && <span>{interaction.detail}</span>}</div>}
          </section>
          {!immersive && timeline != null && (
            <section className="mlab-timeline-dock" data-open={isOpen('timeline')}>
              {isOpen('timeline') && <ResizeHandle panel="timeline" value={sizes.timeline} controls={`${id}-timeline`} onChange={(size) => resize('timeline', size)} />}
              <button type="button" id={`${id}-timeline-toggle`} className="mlab-timeline-toggle" aria-expanded={isOpen('timeline')} aria-controls={`${id}-timeline`} onClick={() => setPanel('timeline', !isOpen('timeline'))}>
                {isOpen('timeline') ? <PanelBottomClose /> : <PanelBottomOpen />}<span>Observation ledger</span><small>Recorded data / no inferred curve</small><span className="mlab-keycap">{isOpen('timeline') ? '−' : '+'}</span>
              </button>
              <div id={`${id}-timeline`} className="mlab-timeline-content" hidden={!isOpen('timeline')} tabIndex={-1}>{timeline}</div>
            </section>
          )}
        </main>
        {sidePanel('inspector', inspector)}
      </div>
      <footer className="mlab-statusbar"><div>{status ?? <><span className="mlab-status-dot" />Educational simulation · evidence accompanies each observation</>}</div><span>WORLD / m <span className="mlab-status-divider">≠</span> MOLECULAR / Å</span></footer>
      <div className="mlab-sr-only" role="status">{announcement}</div>
      {entry}
      <LabDialog open={settingsOpen} title="Display & access" description="Presentation settings never change a chemical inventory or a result." onClose={() => setSettingsOpen(false)}>
        <div className="mlab-settings">
          {onQualityChange && <label><span><Gauge />Render quality</span><select value={quality} onChange={(event) => onQualityChange(event.target.value as LabQualityPreset)}><option value="low">Efficient · simpler lighting</option><option value="balanced">Balanced</option><option value="high">Quality · richer materials</option></select></label>}
          {onMotionChange && <label><span><Orbit />Motion</span><select value={motion} onChange={(event) => onMotionChange(event.target.value as LabMotionPreference)}><option value="system">Follow system</option><option value="reduced">Reduce motion</option><option value="full">Cinematic, when system allows</option></select></label>}
          <LabHelpHint>{motionSettings.reduced ? 'Reduced motion is active. Camera moves and decorative transitions are immediate.' : 'Camera transitions and interface motion share one timing system.'}</LabHelpHint>
          <LabButton variant="outline" onClick={() => { setSettingsOpen(false); void toggleImmersive(); }}><Expand />{immersive ? 'Restore panels' : 'Use the whole viewport'}</LabButton>
          {gallery && <LabButton variant="outline" onClick={() => { setSettingsOpen(false); setGalleryOpen(true); }}><Columns2 />Interface reference gallery</LabButton>}
          <p className="mlab-caption">Use Tab to reach every control. Resize panel dividers with arrow keys; Shift makes a larger step. Home / End choose their limits. Scene editing alternatives live in the inspector.</p>
        </div>
      </LabDialog>
      {gallery && <LabDialog open={galleryOpen} size="large" title="Interface reference" description="A scene-independent gallery. Demonstration states are not scientific results." onClose={() => setGalleryOpen(false)}>{gallery}</LabDialog>}
    </div>
  );
}

export function LabShell(props: LabShellProps) {
  const [localMotion, setLocalMotion] = useState<LabMotionPreference>('system');
  const motion = props.motion ?? localMotion;
  return (
    <LabMotionProvider preference={motion}>
      <LabShellContent {...props} motion={motion} onMotionChange={(next) => { if (props.motion === undefined) setLocalMotion(next); props.onMotionChange?.(next); }} />
    </LabMotionProvider>
  );
}

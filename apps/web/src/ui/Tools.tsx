import { getElement } from '@matterlab/core';
import type { BondOrder } from '@matterlab/core';
import { Atom, Copy, Crosshair, Eraser, Maximize, MousePointer2, Ruler, Sparkles, Trash2 } from 'lucide-react';
import { viewApi } from '../render/viewApi';
import { clearMeasurements, deleteSelection, duplicateSelection, focusSelection, hydrogenate } from '../state/actions';
import { runCommand } from '../state/commands';
import { MEASURE_ATOM_COUNT, lab, useLab } from '../state/store';
import type { MeasureKind, ToolId } from '../state/store';
import { BOND_ORDER_NAMES, BondGlyph, Button, IconButton, Segmented, cx } from './kit';

const TOOLS: ReadonlyArray<{ id: ToolId; label: string; key: string; icon: typeof Atom }> = [
  { id: 'select', label: 'Select and move', key: 'V', icon: MousePointer2 },
  { id: 'build', label: 'Build atoms and bonds', key: 'A', icon: Atom },
  { id: 'erase', label: 'Erase', key: 'E', icon: Eraser },
  { id: 'measure', label: 'Measure', key: 'M', icon: Ruler },
];

/** Hydrogen with the "add" plus sign, drawn to match the stroke icons around it. */
function HydrogenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 6v12M5 12h8M13 6v12" />
      <path d="M17.5 9.5h5M20 7v5" />
    </svg>
  );
}

export function ToolRail() {
  const tool = useLab((s) => s.tool);
  return (
    <div className="ml-left">
      <div className="ml-panel ml-bar ml-bar--vertical" role="toolbar" aria-label="Tools" aria-orientation="vertical">
        {TOOLS.map(({ id, label, key, icon: Icon }) => (
          <IconButton
            key={id}
            size="lg"
            tip={`${label}  (${key})`}
            tipPos="right"
            active={tool === id}
            onClick={() => lab.set({ tool: id, measurePicks: [] })}
            data-testid={`tool-${id}`}
          >
            <Icon />
          </IconButton>
        ))}
        <div className="ml-sep" />
        <IconButton size="lg" tip="Add missing hydrogens  (H)" tipPos="right" onClick={hydrogenate} data-testid="add-hydrogens">
          <HydrogenIcon />
        </IconButton>
        <IconButton size="lg" tip="Optimise geometry  (O)" tipPos="right" onClick={() => runCommand('optimize')} data-testid="tool-optimize">
          <Sparkles />
        </IconButton>
        <div className="ml-sep" />
        <IconButton size="lg" tip="Focus selection  (F)" tipPos="right" onClick={focusSelection}>
          <Crosshair />
        </IconButton>
        <IconButton size="lg" tip="Fit everything in view  (Home)" tipPos="right" onClick={() => viewApi.fitAll(true)}>
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}

const QUICK_ELEMENTS = [1, 6, 7, 8, 9, 15, 16, 17, 35, 53];
const ORDERS: readonly BondOrder[] = [1, 2, 3, 1.5];

function BuildBar() {
  const element = useLab((s) => s.buildElement);
  const order = useLab((s) => s.bondOrder);
  const autoHydrogens = useLab((s) => s.autoHydrogens);
  const current = getElement(element);
  return (
    <div className="ml-panel ml-bar ml-bar--wrap" style={{ padding: 5, gap: 3 }} data-testid="build-bar">
      <button
        type="button"
        className="ml-el ml-el--current"
        style={{ ['--el' as string]: current.color }}
        data-tip={`${current.name} · open the periodic table  (P)`}
        aria-label={`Current element: ${current.name}. Open the periodic table`}
        onClick={() => lab.set({ dialog: 'periodic-table' })}
        data-testid="current-element"
      >
        <small>{current.z}</small>
        {current.symbol}
      </button>
      <div className="ml-sep" />
      {QUICK_ELEMENTS.map((z) => {
        const e = getElement(z);
        return (
          <button
            key={z}
            type="button"
            className="ml-el"
            style={{ ['--el' as string]: e.color }}
            aria-pressed={z === element}
            aria-label={e.name}
            data-tip={e.name}
            onClick={() => lab.set({ buildElement: z })}
            data-testid={`element-${e.symbol}`}
          >
            {e.symbol}
          </button>
        );
      })}
      <div className="ml-sep" />
      <Segmented<BondOrder>
        label="Bond order"
        value={order}
        onChange={(value) => lab.set({ bondOrder: value })}
        options={ORDERS.map((o, i) => ({ value: o, label: <BondGlyph order={o} />, tip: `${BOND_ORDER_NAMES[o]} bond  (${i + 1})` }))}
      />
      <div className="ml-sep" />
      <Button
        size="sm"
        active={autoHydrogens}
        tip="Keep hydrogens in step with valence as you build"
        onClick={() => lab.set({ autoHydrogens: !autoHydrogens })}
        data-testid="auto-hydrogens"
        style={{ height: 30 }}
      >
        Auto H
      </Button>
    </div>
  );
}

function MeasureBar() {
  const kind = useLab((s) => s.measureKind);
  const picks = useLab((s) => s.measurePicks.length);
  const count = useLab((s) => s.measurements.length);
  return (
    <div className="ml-panel ml-bar" style={{ padding: 5, gap: 8 }}>
      <Segmented<MeasureKind>
        label="Measurement type"
        value={kind}
        onChange={(value) => lab.set({ measureKind: value, measurePicks: [] })}
        options={[
          { value: 'distance', label: 'Distance' },
          { value: 'angle', label: 'Angle' },
          { value: 'dihedral', label: 'Dihedral' },
        ]}
      />
      <span className="ml-mono" style={{ color: 'var(--text-2)', fontSize: 12, padding: '0 4px' }}>
        {picks} / {MEASURE_ATOM_COUNT[kind]} atoms
      </span>
      {count > 0 && (
        <Button size="sm" variant="danger" onClick={clearMeasurements}>
          Clear all
        </Button>
      )}
    </div>
  );
}

function SelectionBar() {
  const atoms = useLab((s) => s.selectedAtoms.size);
  const bonds = useLab((s) => s.selectedBonds.size);
  if (atoms + bonds === 0) return null;
  const parts = [atoms > 0 ? `${atoms} atom${atoms === 1 ? '' : 's'}` : '', bonds > 0 ? `${bonds} bond${bonds === 1 ? '' : 's'}` : ''].filter(Boolean);
  return (
    <div className="ml-panel ml-bar" style={{ padding: 5, gap: 2 }}>
      <span style={{ padding: '0 10px 0 8px', color: 'var(--text)', fontWeight: 500, fontSize: 12.5 }}>{parts.join(', ')} selected</span>
      <div className="ml-sep" />
      <IconButton tip="Focus  (F)" onClick={focusSelection}>
        <Crosshair />
      </IconButton>
      {atoms > 0 && (
        <IconButton tip="Duplicate  (Ctrl D)" onClick={duplicateSelection}>
          <Copy />
        </IconButton>
      )}
      <IconButton tip="Delete  (Del)" variant="danger" onClick={deleteSelection}>
        <Trash2 />
      </IconButton>
    </div>
  );
}

function Hint() {
  const tool = useLab((s) => s.tool);
  const element = useLab((s) => getElement(s.buildElement).name.toLowerCase());
  const kind = useLab((s) => s.measureKind);
  const empty = useLab((s) => s.scene.atoms.size === 0);
  let text;
  if (tool === 'build') {
    text = empty ? (
      <>
        <b>Click</b> anywhere to place your first {element} atom
      </>
    ) : (
      <>
        <b>Click</b> empty space to place {element} · <b>drag from an atom</b> to bond or grow · <b>click</b> an atom or bond to change it
      </>
    );
  } else if (tool === 'erase') {
    text = (
      <>
        <b>Click</b> an atom or bond to delete it
      </>
    );
  } else if (tool === 'measure') {
    text = (
      <>
        <b>Click {MEASURE_ATOM_COUNT[kind]} atoms</b> to measure a {kind}
      </>
    );
  } else {
    text = (
      <>
        <b>Drag</b> an atom to move it · <b>Shift-drag</b> to box-select · <b>double-click</b> selects a molecule · <b>G</b> / <b>R</b> move and rotate
      </>
    );
  }
  return <div className={cx('ml-hint', 'ml-hide-narrow')}>{text}</div>;
}

/** The context-sensitive strip at the bottom of the view: only the controls the current tool needs. */
export function ContextBar() {
  const tool = useLab((s) => s.tool);
  const transforming = useLab((s) => s.transformHud !== null);
  // While a keyboard transform runs, its read-out takes the place of the hint and the tool controls.
  if (transforming) return <TransformHud />;
  return (
    <>
      <Hint />
      {tool === 'build' ? <BuildBar /> : tool === 'measure' ? <MeasureBar /> : tool === 'select' ? <SelectionBar /> : null}
    </>
  );
}

function TransformHud() {
  const hud = useLab((s) => s.transformHud);
  if (!hud) return null;
  return (
    <div className="ml-panel ml-transform-hud" data-testid="transform-hud">
      <span className="ml-mono">{hud}</span>
      <span style={{ color: 'var(--text-2)', marginLeft: 12 }}>X / Y / Z constrain · type a value · Enter confirms · Esc cancels</span>
    </div>
  );
}

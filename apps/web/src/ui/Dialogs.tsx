import { ELEMENTS, ELEMENT_CATEGORY_LABELS, EXAMPLES, FILE_FORMATS, composition, exampleScene, getElement } from '@matterlab/core';
import type { Composition, ElementCategory, ElementInfo, ExampleRecord, FileFormatId } from '@matterlab/core';
import { Download, FileInput, FolderOpen, Image as ImageIcon, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CATEGORY_COLORS } from '../render/style';
import { addExample, changeElement, openExample } from '../state/actions';
import { exportIdentifier, exportImage, exportProject, exportStructure, pickFile } from '../state/commands';
import type { IdentifierFormat } from '../state/commands';
import { deleteProject, listProjects, openProject } from '../state/persistence';
import type { ProjectSummary } from '../state/persistence';
import { lab, useLab } from '../state/store';
import { FindPanel } from './FindStructures';
import { Button, EvidenceBadge, Formula, IconButton, Segmented, cx } from './kit';

function close(): void {
  lab.set({ dialog: null, elementPickerTarget: 'build' });
}

export function Dialog({
  title,
  subtitle,
  children,
  width,
  height,
  headerExtra,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: number | string;
  /** A fixed height, for dialogs whose sections differ in length: the dialog then stays put when the section changes. */
  height?: number | string;
  headerExtra?: ReactNode;
}) {
  return (
    <div className="ml-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="ml-dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width, height }}>
        <div className="ml-dialog__head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ml-dialog__title">{title}</div>
            {subtitle && <div className="ml-dialog__sub">{subtitle}</div>}
          </div>
          {headerExtra}
          <IconButton tip="Close  (Esc)" tipPos="bottom-end" onClick={close}>
            <X />
          </IconButton>
        </div>
        <div className="ml-dialog__body ml-scroll">{children}</div>
      </div>
    </div>
  );
}

// ---------- periodic table ----------

function ElementDetail({ element }: { element: ElementInfo }) {
  const state = `${element.standardStatePredicted ? 'predicted ' : ''}${element.standardState}`;
  const valences = element.valenceUnconstrained ? 'no fixed valence' : element.valences.join(', ');
  return (
    <div className="ml-ptable__detail">
      <div className="ml-tile" style={{ ['--el' as string]: element.color, width: 86, height: 86 }}>
        <span className="ml-tile__z">{element.z}</span>
        <span className="ml-tile__sym" style={{ fontSize: 34 }}>
          {element.symbol}
        </span>
        <span className="ml-tile__mass">{element.atomicWeight}</span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ml-hero__title" style={{ fontSize: 21 }}>
          {element.name}
        </div>
        <div className="ml-hero__sub" style={{ color: CATEGORY_COLORS[element.category] }}>
          {ELEMENT_CATEGORY_LABELS[element.category]} · period {element.period}
          {element.group ? ` · group ${element.group}` : ''} · {element.block}-block
        </div>
        <dl className="ml-kv" style={{ marginTop: 8, gridTemplateColumns: 'auto 1fr auto 1fr', columnGap: 14, fontSize: 12 }}>
          <dt>Configuration</dt>
          <dd className="ml-mono" style={{ textAlign: 'left' }}>
            {element.electronConfiguration}
            {element.electronConfigurationPredicted ? ' (predicted)' : ''}
          </dd>
          <dt>Electronegativity</dt>
          <dd className="ml-mono" style={{ textAlign: 'left' }}>
            {element.electronegativityPauling ?? '—'}
          </dd>
          <dt>Standard state</dt>
          <dd style={{ textAlign: 'left' }}>{state}</dd>
          <dt>Valences</dt>
          <dd className="ml-mono" style={{ textAlign: 'left' }}>
            {valences}
          </dd>
        </dl>
      </div>
    </div>
  );
}

export function PeriodicTableDialog() {
  const buildElement = useLab((s) => s.buildElement);
  const target = useLab((s) => s.elementPickerTarget);
  const selectedAtoms = useLab((s) => s.selectedAtoms);
  const [focused, setFocused] = useState(buildElement);
  const [query, setQuery] = useState('');
  const changing = target === 'selection' && selectedAtoms.size > 0;

  const q = query.trim().toLowerCase();
  const matches = (e: ElementInfo) => q === '' || e.symbol.toLowerCase().startsWith(q) || e.name.toLowerCase().includes(q) || String(e.z) === q;
  const best = useMemo(() => {
    if (q === '') return null;
    return ELEMENTS.find((e) => e.symbol.toLowerCase() === q) ?? ELEMENTS.find((e) => String(e.z) === q) ?? ELEMENTS.find((e) => e.name.toLowerCase().startsWith(q)) ?? ELEMENTS.find(matches) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  useEffect(() => {
    if (best) setFocused(best.z);
  }, [best]);

  const choose = (z: number) => {
    if (changing) changeElement(selectedAtoms, z);
    else lab.set({ buildElement: z, tool: 'build' });
    close();
  };

  return (
    <Dialog
      title="Periodic table"
      subtitle={changing ? `Choose the element for the ${selectedAtoms.size} selected atom${selectedAtoms.size === 1 ? '' : 's'}` : 'Choose the element to build with'}
      headerExtra={
        <div style={{ position: 'relative', width: 230 }}>
          <Search style={{ position: 'absolute', left: 9, top: 7, width: 15, height: 15, color: 'var(--text-3)' }} />
          <input
            className="ml-input"
            style={{ paddingLeft: 30, height: 30 }}
            placeholder="Symbol, name or number"
            aria-label="Search elements"
            autoFocus
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && best) choose(best.z);
            }}
            data-testid="element-search"
          />
        </div>
      }
    >
      <div className="ml-ptable" style={{ gridTemplateRows: 'repeat(7, auto) 10px repeat(2, auto)' }} data-testid="periodic-table">
        <ElementDetail element={getElement(focused)} />
        {ELEMENTS.map((e) => (
          <button
            key={e.z}
            type="button"
            className={cx('ml-ptable__cell', !matches(e) && 'is-dim')}
            style={{ gridColumn: e.tableColumn, gridRow: e.tableRow, ['--cat' as string]: CATEGORY_COLORS[e.category], ['--el' as string]: e.color }}
            aria-label={`${e.name}, atomic number ${e.z}`}
            aria-pressed={e.z === buildElement && !changing}
            onMouseEnter={() => setFocused(e.z)}
            onFocus={() => setFocused(e.z)}
            onClick={() => choose(e.z)}
            data-z={e.z}
          >
            <span className="ml-ptable__z">{e.z}</span>
            <span className="ml-ptable__swatch" />
            <span className="ml-ptable__sym">{e.symbol}</span>
            <span className="ml-ptable__name">{e.name}</span>
          </button>
        ))}
        <div className="ml-ptable__marker" style={{ gridColumn: 3, gridRow: 6 }}>
          57–71
        </div>
        <div className="ml-ptable__marker" style={{ gridColumn: 3, gridRow: 7 }}>
          89–103
        </div>
      </div>
      <div className="ml-ptable__legend">
        {(Object.keys(ELEMENT_CATEGORY_LABELS) as ElementCategory[]).map((category) => (
          <span key={category} style={{ ['--cat' as string]: CATEGORY_COLORS[category] }}>
            <i />
            {ELEMENT_CATEGORY_LABELS[category]}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--text-3)' }}>The dot in each cell is the element’s colour in the 3D view.</span>
      </div>
    </Dialog>
  );
}

// ---------- library ----------

const exampleFormula = new Map<string, Composition>();
function formulaOf(example: ExampleRecord): Composition {
  let formula = exampleFormula.get(example.id);
  if (!formula) {
    formula = composition(exampleScene(example));
    exampleFormula.set(example.id, formula);
  }
  return formula;
}

type LibraryTab = 'examples' | 'find' | 'saved' | 'files';

function SavedProjects() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'The library could not be read.'));
  useEffect(() => void refresh(), []);

  if (error) return <p className="ml-empty">{error}</p>;
  if (!projects) return <p className="ml-empty">Loading…</p>;
  if (projects.length === 0) {
    return <p className="ml-empty">Nothing saved yet. Press Ctrl+S to save the current project to this device’s library.</p>;
  }
  return (
    <div className="ml-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {projects.map((p) => (
        <div key={p.id} className="ml-card" style={{ padding: 0, overflow: 'hidden' }}>
          <button type="button" className="ml-card__main" style={{ gap: 0 }} onClick={() => void openProject(p.id)}>
            <div style={{ aspectRatio: '16 / 9', background: '#080d18' }}>
              {p.thumbnail && <img src={p.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            </div>
            <div style={{ padding: '9px 12px 4px' }}>
              <div className="ml-card__title">{p.name}</div>
              <div className="ml-card__meta">
                {p.formula || 'empty'} · {p.atomCount} atoms
              </div>
            </div>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px 6px 12px' }}>
            <span className="ml-card__text">{new Date(p.savedAt).toLocaleString()}</span>
            <IconButton size="sm" variant="danger" tip="Delete from library" tipPos="top-end" onClick={() => void deleteProject(p.id).then(refresh)}>
              <Trash2 />
            </IconButton>
          </div>
        </div>
      ))}
    </div>
  );
}

function FormatList({ onExport }: { onExport?: (id: FileFormatId) => void }) {
  return (
    <div className="ml-list">
      {FILE_FORMATS.map((f) => (
        <div key={f.id} className="ml-row" style={{ alignItems: 'flex-start', padding: '9px 10px 9px 12px', minHeight: 0 }}>
          <div className="ml-row__grow" style={{ whiteSpace: 'normal' }}>
            <div style={{ fontWeight: 600 }}>
              {f.label} <span className="ml-mono" style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 11 }}>.{f.extensions.join(' .')}</span>
            </div>
            <div className="ml-card__text">Keeps: {f.preserves}</div>
            <div className="ml-card__text">Loses: {f.loses}</div>
          </div>
          {onExport && (
            <Button size="sm" variant="outline" onClick={() => onExport(f.id)}>
              <Download /> Export
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function LibraryDialog() {
  const [tab, setTab] = useState<LibraryTab>('examples');
  return (
    <Dialog
      title="Library"
      subtitle="Start from an example, find a compound, reopen saved work, or bring in a file"
      width={880}
      height="min(720px, 100%)"
      headerExtra={
        <Segmented<LibraryTab>
          label="Library section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'examples', label: 'Examples' },
            { value: 'find', label: 'Find' },
            { value: 'saved', label: 'Saved' },
            { value: 'files', label: 'Files' },
          ]}
        />
      }
    >
      {tab === 'find' && <FindPanel onPlaced={close} />}
      {tab === 'examples' && (
        <>
          <div className="ml-cards" data-testid="examples">
            {EXAMPLES.map((e) => (
              <div key={e.id} className="ml-card" style={{ padding: 0 }}>
                <button
                  type="button"
                  className="ml-card__main"
                  style={{ padding: '11px 12px 4px' }}
                  onClick={() => {
                    openExample(e.id);
                    close();
                  }}
                  data-example={e.id}
                >
                  <div className="ml-card__title">{e.name}</div>
                  <div className="ml-card__meta">
                    <Formula value={formulaOf(e)} />
                  </div>
                  <div className="ml-card__text">{e.description}</div>
                </button>
                <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 6px 6px' }}>
                  <IconButton
                    size="sm"
                    tip="Add to the current workspace"
                    tipPos="top-end"
                    onClick={() => {
                      addExample(e.id);
                      close();
                    }}
                  >
                    <Plus />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
          <p className="ml-empty" style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
            <EvidenceBadge level="computed" tipPos="top" />
            Example geometries are force-field structures (ETKDG + MMFF94, computed with RDKit), close to but not the same as experimental ones.
          </p>
        </>
      )}
      {tab === 'saved' && <SavedProjects />}
      {tab === 'files' && (
        <>
          <div className="ml-actions" style={{ marginBottom: 14 }}>
            <Button
              variant="primary"
              onClick={() => {
                close();
                pickFile('replace');
              }}
            >
              <FolderOpen /> Open file…
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                close();
                pickFile('insert');
              }}
            >
              <FileInput /> Insert into workspace…
            </Button>
          </div>
          <p className="ml-empty" style={{ marginBottom: 10 }}>
            You can also drop a file anywhere on the window. Supported formats:
          </p>
          <FormatList />
        </>
      )}
    </Dialog>
  );
}

export function ExportDialog() {
  const [exporting, setExporting] = useState<IdentifierFormat | null>(null);
  const saveIdentifier = async (format: IdentifierFormat) => {
    setExporting(format);
    const saved = await exportIdentifier(format);
    setExporting(null);
    if (saved) close();
  };
  return (
    <Dialog title="Export" subtitle="Each format keeps different information. Choose knowingly." width={640}>
      <div className="ml-actions" style={{ marginBottom: 14 }}>
        <Button
          variant="primary"
          onClick={() => {
            exportProject();
            close();
          }}
        >
          <Download /> Project file (.matterlab.json)
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            close();
            void exportImage();
          }}
        >
          <ImageIcon /> Image of the view (.png)
        </Button>
      </div>
      <p className="ml-empty" style={{ marginBottom: 10 }}>
        The project file keeps everything, including measurements and the camera. Chemistry formats exchange the structure with other software:
      </p>
      <FormatList
        onExport={(id) => {
          exportStructure(id);
          close();
        }}
      />
      <div className="ml-actions" style={{ marginTop: 14 }} aria-busy={exporting !== null}>
        <Button variant="outline" disabled={exporting !== null} onClick={() => void saveIdentifier('smiles')} data-testid="export-smiles">
          <Download /> {exporting === 'smiles' ? 'Preparing SMILES...' : 'SMILES file (.smi)'}
        </Button>
        <Button variant="outline" disabled={exporting !== null} onClick={() => void saveIdentifier('inchi')} data-testid="export-inchi">
          <Download /> {exporting === 'inchi' ? 'Preparing InChI...' : 'InChI file (.inchi)'}
        </Button>
      </div>
      <p className="ml-empty">
        Identifiers require a structure RDKit accepts. They keep chemical identity, including specified isotopes, charge and stereochemistry, but not coordinates,
        atom IDs, measurements or the view.
      </p>
    </Dialog>
  );
}

// ---------- shortcuts ----------

const SHORTCUTS: ReadonlyArray<{ title: string; items: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: 'View',
    items: [
      ['Orbit', 'Drag empty space'],
      ['Pan', 'Right-drag'],
      ['Zoom towards the cursor', 'Scroll'],
      ['Focus selection', 'F'],
      ['Fit everything', 'Home'],
      ['Reset view', 'Shift Home'],
      ['Perspective / orthographic', '5'],
    ],
  },
  {
    title: 'Tools',
    items: [
      ['Select and move', 'V'],
      ['Build atoms and bonds', 'A'],
      ['Erase', 'E'],
      ['Measure', 'M'],
      ['Periodic table', 'P'],
      ['Bond order 1 / 2 / 3 / aromatic (Build)', '1  2  3  4'],
    ],
  },
  {
    title: 'Selection',
    items: [
      ['Add to or remove from selection', 'Shift-click'],
      ['Box-select', 'Shift-drag'],
      ['Select the whole molecule', 'Double-click'],
      ['Move the whole molecule', 'Alt-drag an atom'],
      ['Select all', 'Ctrl A'],
      ['Clear selection', 'Esc'],
    ],
  },
  {
    title: 'Editing',
    items: [
      ['Undo / redo', 'Ctrl Z  /  Ctrl Shift Z'],
      ['Delete', 'Del'],
      ['Copy / cut / paste', 'Ctrl C  X  V'],
      ['Duplicate', 'Ctrl D'],
      ['Add missing hydrogens', 'H'],
      ['Free-length bond while drawing', 'Hold Alt'],
    ],
  },
  {
    title: 'Precise transforms',
    items: [
      ['Move selection', 'G'],
      ['Rotate selection', 'R'],
      ['Constrain to an axis', 'X  Y  Z'],
      ['Exact distance or angle', 'Type a number'],
      ['Confirm / cancel', 'Enter  /  Esc'],
    ],
  },
  {
    title: 'Project',
    items: [
      ['Save to library', 'Ctrl S'],
      ['Open library', 'Ctrl O'],
      ['This list', '?'],
    ],
  },
];

export function ShortcutsDialog() {
  return (
    <Dialog title="Keyboard and mouse" width={820}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '18px 34px' }}>
        {SHORTCUTS.map((group) => (
          <div key={group.title}>
            <div className="ml-label" style={{ marginBottom: 6 }}>
              {group.title}
            </div>
            <div className="ml-shortcuts" style={{ gridTemplateColumns: '1fr' }}>
              {group.items.map(([label, keys]) => (
                <div key={label}>
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

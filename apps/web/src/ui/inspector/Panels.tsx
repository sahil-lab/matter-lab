import {
  EXAMPLES,
  atomLabel,
  composition,
  formatCharge,
  fragments,
  getElement,
  idealBondLength,
  isBondInRing,
  measurePoints,
  molecularMass,
  validateScene,
  vdist,
} from '@matterlab/core';
import type { AtomId, BondId, BondOrder, ValidationIssue } from '@matterlab/core';
import { Copy, Crosshair, Pin, Replace, Trash2 } from 'lucide-react';
import { viewApi } from '../../render/viewApi';
import {
  addMeasurement,
  applyAngle,
  applyDihedral,
  applyDistance,
  deleteSelection,
  duplicateSelection,
  eraseBonds,
  focusSelection,
  hydrogenate,
  openExample,
  selectOnly,
  setBondOrders,
} from '../../state/actions';
import { lab, useLab } from '../../state/store';
import { BOND_ORDER_NAMES, BondGlyph, Button, EvidenceBadge, Formula, Note, NumberField, Section, Segmented, formatCount } from '../kit';
import { useSettledScene } from '../../state/useSettledScene';
import { IdentitySection } from './IdentityPanel';

const ORDERS: readonly BondOrder[] = [1, 2, 3, 1.5];
const MAX_ISSUES_SHOWN = 30;

function IssueList({ issues }: { issues: readonly ValidationIssue[] }) {
  const fixable = issues.some((i) => i.fix === 'add-hydrogens');
  return (
    <div className="ml-list" data-testid="issues">
      {fixable && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            selectOnly();
            hydrogenate();
          }}
          style={{ alignSelf: 'flex-start' }}
          data-testid="fix-hydrogens"
        >
          Add missing hydrogens
        </Button>
      )}
      {issues.slice(0, MAX_ISSUES_SHOWN).map((issue, i) => (
        <Note
          key={`${issue.code}-${i}`}
          severity={issue.severity}
          onClick={
            issue.atomIds.length + issue.bondIds.length > 0
              ? () => {
                  selectOnly(issue.atomIds, issue.atomIds.length > 0 ? [] : issue.bondIds);
                  viewApi.focusAtoms(issue.atomIds, true);
                }
              : undefined
          }
        >
          {issue.message}
        </Note>
      ))}
      {issues.length > MAX_ISSUES_SHOWN && <p className="ml-empty">…and {issues.length - MAX_ISSUES_SHOWN} more.</p>}
    </div>
  );
}

/** Shown when nothing is selected: what the structure is and whether it holds together. */
export function StructurePanel() {
  const scene = useLab((s) => s.scene);
  const settled = useSettledScene(scene);
  if (scene.atoms.size === 0) {
    return (
      <>
        <div>
          <div className="ml-hero__title">An empty workspace</div>
          <p className="ml-empty" style={{ marginTop: 6 }}>
            Choose the Build tool and click in the view to place atoms, drag from an atom to bond, or start from an example.
          </p>
        </div>
        <div className="ml-actions">
          <Button size="sm" variant="primary" onClick={() => lab.set({ tool: 'build' })}>
            Start building
          </Button>
          {EXAMPLES.filter((e) => ['water', 'methane', 'benzene'].includes(e.id)).map((e) => (
            <Button key={e.id} size="sm" variant="outline" onClick={() => openExample(e.id)}>
              {e.name}
            </Button>
          ))}
        </div>
      </>
    );
  }

  const total = composition(scene);
  const mass = molecularMass(scene);
  // Formula, mass and counts follow every edit. What needs the whole structure walked (the checks, the
  // number of molecules) waits, for a large structure, until editing pauses.
  const report = settled.pending ? null : validateScene(settled.scene);
  const parts = settled.pending ? null : fragments(settled.scene).length;

  return (
    <>
      <div>
        <div className="ml-label" style={{ marginBottom: 4 }}>
          Formula
        </div>
        <div className="ml-formula" data-testid="formula">
          <Formula value={total} />
        </div>
      </div>
      <dl className="ml-kv">
        <dt>Molar mass</dt>
        <dd>
          <span className="ml-mono" data-testid="molar-mass">
            {mass.mass.toFixed(3)} g/mol
          </span>{' '}
          <EvidenceBadge level={mass.estimated ? 'rule-based' : 'reference'} />
        </dd>
        <dt>Atoms</dt>
        <dd className="ml-mono" data-testid="atom-count">
          {formatCount(scene.atoms.size)}
        </dd>
        <dt>Bonds</dt>
        <dd className="ml-mono" data-testid="bond-count">
          {formatCount(scene.bonds.size)}
        </dd>
        <dt>Net charge</dt>
        <dd className="ml-mono">{total.charge === 0 ? '0' : formatCharge(total.charge)}</dd>
        <dt>Molecules</dt>
        <dd className="ml-mono">{parts === null ? '…' : formatCount(parts)}</dd>
      </dl>
      <div className="ml-divider" />
      <Section title="Structure checks" right={<EvidenceBadge level="rule-based" />}>
        {report === null ? (
          <p className="ml-empty" data-testid="checks-pending">
            Checking the structure…
          </p>
        ) : report.issues.length === 0 ? (
          <Note severity="info">No problems found. Every atom has an allowed valence and the geometry is plausible.</Note>
        ) : (
          <IssueList issues={report.issues} />
        )}
      </Section>
      <IdentitySection />
    </>
  );
}

export function BondPanel({ bondId }: { bondId: BondId }) {
  const scene = useLab((s) => s.scene);
  const bond = scene.bonds.get(bondId);
  if (!bond) return null;
  const a = scene.atoms.get(bond.a)!;
  const b = scene.atoms.get(bond.b)!;
  const length = vdist(a.position, b.position);
  const typical = idealBondLength(a.protons, b.protons, bond.order);
  const ring = isBondInRing(scene, bond);
  return (
    <>
      <div data-testid="bond-panel">
        <div className="ml-hero__title">
          {atomLabel(a)} – {atomLabel(b)}
        </div>
        <div className="ml-hero__sub">
          {BOND_ORDER_NAMES[bond.order]} bond between atoms {bond.a} and {bond.b}
          {ring ? ' · in a ring' : ''}
        </div>
      </div>
      <Section title="Bond order">
        <Segmented<BondOrder>
          label="Bond order"
          fill
          accent
          value={bond.order}
          onChange={(order) => setBondOrders([bondId], order)}
          options={ORDERS.map((o) => ({ value: o, label: <BondGlyph order={o} />, tip: BOND_ORDER_NAMES[o] }))}
        />
      </Section>
      <Section title="Length">
        <div className="ml-field" style={{ gridTemplateColumns: '1fr 110px' }}>
          <span style={{ color: 'var(--text-2)', fontSize: 12 }}>Current (Å)</span>
          <NumberField label="Bond length in angstrom" value={length} min={0.2} max={20} step={0.01} onCommit={(v) => applyDistance(bond.a, bond.b, v)} />
        </div>
        <dl className="ml-kv">
          <dt>Typical</dt>
          <dd>
            <span className="ml-mono">{typical.toFixed(2)} Å</span> <EvidenceBadge level="rule-based" />
          </dd>
        </dl>
        <p className="ml-empty" style={{ margin: 0 }}>
          {ring ? 'In a ring, setting the length moves only the second atom.' : 'Setting the length moves the second atom and everything attached to it.'}
        </p>
      </Section>
      <div className="ml-actions">
        <Button size="sm" variant="outline" onClick={focusSelection}>
          <Crosshair /> Focus
        </Button>
        <Button size="sm" variant="danger" onClick={() => eraseBonds([bondId])}>
          <Trash2 /> Delete bond
        </Button>
      </div>
    </>
  );
}

/** Two to four atoms selected in order give an editable distance, angle or dihedral. */
function GeometryField({ atoms }: { atoms: readonly AtomId[] }) {
  const scene = useLab((s) => s.scene);
  const points = atoms.map((id) => scene.atoms.get(id)?.position);
  if (points.some((p) => !p)) return null;
  const result = measurePoints(points as never);
  if (!result) return null;
  const labels = atoms.map((id) => `${getElement(scene.atoms.get(id)!.protons).symbol}${id}`).join(' – ');
  const [a, b, c, d] = atoms as [AtomId, AtomId, AtomId, AtomId];
  const commit =
    result.kind === 'distance'
      ? (v: number) => applyDistance(a, b, v)
      : result.kind === 'angle'
        ? (v: number) => applyAngle(a, b, c, v)
        : (v: number) => applyDihedral(a, b, c, d, v);
  const title = result.kind === 'distance' ? 'Distance' : result.kind === 'angle' ? 'Angle' : 'Dihedral';
  return (
    <Section title={title}>
      <div className="ml-field" style={{ gridTemplateColumns: '1fr 110px' }}>
        <span className="ml-mono" style={{ color: 'var(--text-2)', fontSize: 11.5 }}>
          {labels} ({result.unit})
        </span>
        <NumberField
          label={`${title} value`}
          value={result.value}
          digits={result.kind === 'distance' ? 3 : 1}
          step={result.kind === 'distance' ? 0.01 : 1}
          min={result.kind === 'distance' ? 0.2 : result.kind === 'angle' ? 0 : -180}
          max={result.kind === 'distance' ? 100 : 180}
          onCommit={commit}
        />
      </div>
      <p className="ml-empty" style={{ margin: 0 }}>
        Atoms are taken in the order you selected them. Editing the value moves the last atom and whatever is attached beyond it.
      </p>
      <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={() => addMeasurement(atoms)}>
        <Pin /> Pin as measurement
      </Button>
    </Section>
  );
}

export function MultiPanel() {
  const scene = useLab((s) => s.scene);
  const selectedAtoms = useLab((s) => s.selectedAtoms);
  const selectedBonds = useLab((s) => s.selectedBonds);
  const atoms = [...selectedAtoms];
  const total = composition(scene, atoms);
  const mass = molecularMass(scene, atoms);
  return (
    <>
      <div data-testid="multi-panel">
        <div className="ml-hero__title">
          {atoms.length > 0 ? `${formatCount(atoms.length)} atoms` : ''}
          {atoms.length > 0 && selectedBonds.size > 0 ? ', ' : ''}
          {selectedBonds.size > 0 ? `${selectedBonds.size} bond${selectedBonds.size === 1 ? '' : 's'}` : ''} selected
        </div>
        {atoms.length > 0 && (
          <div className="ml-formula" style={{ fontSize: 19, marginTop: 4 }}>
            <Formula value={total} />
          </div>
        )}
      </div>
      {atoms.length > 0 && (
        <dl className="ml-kv">
          <dt>Mass</dt>
          <dd className="ml-mono">{mass.mass.toFixed(3)} u</dd>
          <dt>Net charge</dt>
          <dd className="ml-mono">{total.charge === 0 ? '0' : formatCharge(total.charge)}</dd>
        </dl>
      )}
      {atoms.length >= 2 && atoms.length <= 4 && selectedBonds.size === 0 && <GeometryField atoms={atoms} />}
      <div className="ml-actions">
        <Button size="sm" variant="outline" onClick={focusSelection}>
          <Crosshair /> Focus
        </Button>
        {atoms.length > 0 && (
          <>
            <Button size="sm" variant="outline" onClick={duplicateSelection}>
              <Copy /> Duplicate
            </Button>
            <Button size="sm" variant="outline" onClick={() => lab.set({ dialog: 'periodic-table', elementPickerTarget: 'selection' })}>
              <Replace /> Element…
            </Button>
            <Button size="sm" variant="outline" onClick={hydrogenate}>
              Add H
            </Button>
          </>
        )}
        <Button size="sm" variant="danger" onClick={deleteSelection}>
          <Trash2 /> Delete
        </Button>
      </div>
    </>
  );
}

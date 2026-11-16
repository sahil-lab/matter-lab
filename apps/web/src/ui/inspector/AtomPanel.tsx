import {
  MAX_ELECTRONS,
  MAX_NEUTRONS,
  analyseValences,
  describeAtom,
  describeStability,
  electronConfiguration,
  formatCharge,
  formatHalfLife,
  getElement,
  getIsotopes,
  naturalIsotopes,
  neighborsOf,
  subshellLabel,
  toSuperscript,
} from '@matterlab/core';
import type { AtomId, IsotopeInfo, Subshell } from '@matterlab/core';
import { Atom, Crosshair, Network, Replace, Trash2 } from 'lucide-react';
import { NUCLEON_COLORS } from '../../nucleus/model';
import { viewApi } from '../../render/viewApi';
import { eraseAtoms, selectMolecule, setAtomPosition, setParticles } from '../../state/actions';
import { lab, useLab } from '../../state/store';
import { Button, EvidenceBadge, Note, NumberField, Section, Stepper } from '../kit';
import { useSettledScene } from '../../state/useSettledScene';

const PARTICLES = {
  ...NUCLEON_COLORS,
  electron: '#55e2d1',
};

/** Orbital box diagram for the subshells outside the noble-gas core, filled by Hund's rule. */
function OrbitalBoxes({ subshells }: { subshells: readonly Subshell[] }) {
  return (
    <div className="ml-orbitals" aria-hidden>
      {subshells.map((s) => {
        const orbitals = 2 * s.l + 1;
        return (
          <div key={subshellLabel(s)} className="ml-orbitals__shell">
            <div className="ml-orbitals__boxes">
              {Array.from({ length: orbitals }, (_, i) => {
                const up = i < Math.min(s.electrons, orbitals);
                const down = i < s.electrons - orbitals;
                return (
                  <span key={i} className="ml-orbitals__box">
                    {up ? '↿' : ''}
                    {down ? '⇂' : ''}
                  </span>
                );
              })}
            </div>
            <span className="ml-orbitals__name">{subshellLabel(s)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The subshells written out after the noble-gas core in the condensed configuration. */
function outerSubshells(text: string, all: readonly Subshell[]): Subshell[] {
  const letters = 'spdfgh';
  const outer: Subshell[] = [];
  const pattern = /(\d)([spdfgh])\d+/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text.replace(/\[[A-Za-z]+\]/, ''))) !== null) {
    const found = all.find((s) => s.n === Number(m![1]) && s.l === letters.indexOf(m![2]!));
    if (found) outer.push(found);
  }
  return outer;
}

function isotopeChoices(z: number): IsotopeInfo[] {
  const natural = naturalIsotopes(z);
  if (natural.length > 0) return [...natural].sort((a, b) => a.a - b.a);
  // No natural isotopes: offer the longest-lived ones.
  return [...getIsotopes(z)]
    .filter((i) => i.halfLifeSeconds !== null)
    .sort((a, b) => b.halfLifeSeconds! - a.halfLifeSeconds!)
    .slice(0, 4)
    .sort((a, b) => a.a - b.a);
}

/** The Atomic Forge: edit an atom's protons, neutrons and electrons and see what it becomes. */
export function AtomPanel({ atomId }: { atomId: AtomId }) {
  const atom = useLab((s) => s.scene.atoms.get(atomId));
  const degree = useLab((s) => neighborsOf(s.scene, atomId).length);
  // Valence bookkeeping walks the whole structure; for a large one it waits until editing pauses.
  const settled = useSettledScene(useLab((s) => s.scene));
  const valence = settled.pending ? undefined : analyseValences(settled.scene).atoms.get(atomId);
  if (!atom) return null;

  const element = getElement(atom.protons);
  const info = describeAtom(atom, { bonded: degree > 0 });
  const config = electronConfiguration(atom.protons, atom.electrons);
  const representativeN = info.representative?.n ?? Math.max(0, Math.round(element.atomicWeight) - atom.protons);
  const neutrons = atom.neutrons ?? representativeN;
  const choices = isotopeChoices(atom.protons);
  const kind = info.kind === 'neutral atom' ? 'neutral atom' : info.kind;
  const massDigits = info.mass.basis === 'isotope-mass' ? 6 : 3;

  const bonding =
    degree === 0
      ? 'not bonded'
      : !valence
        ? settled.pending
          ? 'checking…'
          : 'not bonded'
        : valence.status === 'ok'
        ? `bond order ${valence.valence} · complete`
        : valence.status === 'open'
          ? `bond order ${valence.valence} · ${valence.open} open`
          : valence.status === 'exceeded'
            ? `bond order ${valence.valence} · over-bonded`
            : `bond order ${valence.valence} · no fixed limit`;

  return (
    <>
      <div className="ml-hero" data-testid="atom-panel">
        <div className="ml-tile" style={{ ['--el' as string]: element.color }}>
          <span className="ml-tile__z">{atom.protons}</span>
          <span className="ml-tile__sym">{element.symbol}</span>
          <span className="ml-tile__mass">{info.massNumber ?? element.atomicWeight}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="ml-hero__title" data-testid="atom-name">
            {element.name}
            {info.massNumber !== null ? `-${info.massNumber}` : ''}
          </div>
          <div className="ml-hero__sub">
            <span className="ml-mono" style={{ color: 'var(--text)' }} data-testid="atom-label">
              {info.label}
            </span>{' '}
            · {kind}
          </div>
          <div className="ml-hero__sub">atom {atomId}</div>
        </div>
      </div>

      <Section title="Particles">
        <div className="ml-particles">
          <span className="ml-particles__name">
            <i className="ml-dot" style={{ background: PARTICLES.proton }} /> Protons
          </span>
          <Stepper label="protons" min={1} max={118} value={atom.protons} onChange={(v) => setParticles(atomId, { protons: v }, 'Change proton count')} />
          <span className="ml-particles__name">
            <i className="ml-dot" style={{ background: PARTICLES.neutron }} /> Neutrons
          </span>
          <Stepper
            label="neutrons"
            min={0}
            max={MAX_NEUTRONS}
            value={neutrons}
            muted={atom.neutrons === null}
            onChange={(v) => setParticles(atomId, { neutrons: v }, 'Change neutron count')}
          />
          <span className="ml-particles__name">
            <i className="ml-dot" style={{ background: PARTICLES.electron }} /> Electrons
          </span>
          <Stepper label="electrons" min={0} max={MAX_ELECTRONS} value={atom.electrons} onChange={(v) => setParticles(atomId, { electrons: v }, 'Change electron count')} />
        </div>
        <p className="ml-empty" style={{ margin: 0 }}>
          Protons set the element, neutrons the isotope, electrons the charge.
        </p>
        <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={() => lab.set({ dialog: 'nucleus' })} data-testid="open-nucleus">
          <Atom /> Look inside the nucleus
        </Button>
      </Section>

      <Section title="Isotope">
        <div className="ml-isotopes">
          <button
            type="button"
            className="ml-chip"
            aria-pressed={atom.neutrons === null}
            onClick={() => setParticles(atomId, { neutrons: null }, 'Use natural isotope mix')}
            data-tip="Natural isotopic composition (standard atomic weight)"
          >
            Natural mix
          </button>
          {choices.map((iso) => (
            <button
              key={iso.a}
              type="button"
              className="ml-chip"
              aria-pressed={atom.neutrons === iso.n}
              onClick={() => setParticles(atomId, { neutrons: iso.n }, 'Change isotope')}
              data-tip={describeStability(iso)}
            >
              {toSuperscript(iso.a)}
              {element.symbol}
              <small>{iso.abundance ? `${(iso.abundance * 100).toPrecision(3)}%` : iso.halfLifeSeconds ? formatHalfLife(iso.halfLifeSeconds) : ''}</small>
            </button>
          ))}
        </div>
      </Section>

      <dl className="ml-kv">
        <dt>Mass number</dt>
        <dd className="ml-mono">{info.massNumber ?? '— (natural mix)'}</dd>
        <dt>Net charge</dt>
        <dd className="ml-mono" data-testid="atom-charge">
          {info.charge === 0 ? '0' : formatCharge(info.charge)}
        </dd>
        <dt>Mass</dt>
        <dd>
          <span className="ml-mono">{info.mass.mass.toFixed(massDigits)} u</span>{' '}
          <EvidenceBadge level={info.mass.basis === 'mass-number-estimate' ? 'rule-based' : 'reference'} />
        </dd>
        {info.isotope && (
          <>
            <dt>Stability</dt>
            <dd>{describeStability(info.isotope)}</dd>
          </>
        )}
        <dt>Bonding</dt>
        <dd>{bonding}</dd>
      </dl>

      <Section title="Electron configuration" right={<EvidenceBadge level={config.evidence} />}>
        <div className="ml-config" data-testid="atom-config">
          {config.text}
        </div>
        <OrbitalBoxes subshells={outerSubshells(config.text, config.subshells)} />
        <p className="ml-empty" style={{ margin: 0 }}>
          {config.unpaired === 0 ? 'All electrons paired.' : `${config.unpaired} unpaired electron${config.unpaired === 1 ? '' : 's'} (Hund’s rule).`}
        </p>
      </Section>

      {info.notes.length > 0 && (
        <div className="ml-list">
          {info.notes.map((note) => (
            <Note key={note.code} severity={note.severity}>
              {note.message}
            </Note>
          ))}
        </div>
      )}

      <Section title="Position (Å)">
        <div className="ml-xyz">
          {(['x', 'y', 'z'] as const).map((axis, i) => (
            <label key={axis}>
              {axis}
              <NumberField
                label={`${axis} coordinate`}
                value={atom.position[i]!}
                step={0.05}
                onCommit={(v) => {
                  const next: [number, number, number] = [...atom.position];
                  next[i] = v;
                  setAtomPosition(atomId, next);
                }}
              />
            </label>
          ))}
        </div>
      </Section>

      <div className="ml-actions">
        <Button size="sm" variant="outline" onClick={() => viewApi.focusAtoms([atomId], true)}>
          <Crosshair /> Focus
        </Button>
        <Button size="sm" variant="outline" onClick={() => lab.set({ dialog: 'periodic-table', elementPickerTarget: 'selection' })}>
          <Replace /> Element…
        </Button>
        {degree > 0 && (
          <Button size="sm" variant="outline" onClick={() => selectMolecule(atomId)}>
            <Network /> Molecule
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => eraseAtoms([atomId])}>
          <Trash2 /> Delete
        </Button>
      </div>
    </>
  );
}

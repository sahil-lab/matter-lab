import { getElement } from '@matterlab/core';
import type { Scene } from '@matterlab/core';
import { virialRatio } from '@matterlab/quantum';
import type { ScfResult } from '@matterlab/quantum';
import { Atom, ChevronLeft, ChevronRight, FlipHorizontal2, Square } from 'lucide-react';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  ISO_LIMITS,
  MOLECULAR_SURFACE_ATOM_LIMIT,
  PROBE_RADIUS,
  cancelFieldJobs,
  cancelQuantum,
  dismissQuantumProblem,
  orbitalLabel,
  quantumIsCurrent,
  runQuantum,
  setField,
  setMolecular,
  setSlice,
  sliceThroughSelection,
  useQuantum,
} from '../../compute/quantum';
import type { FieldKind, FieldStyle, MolecularSurfaceKind, QuantumRecord, SliceAxis, SliceField } from '../../compute/quantum';
import { Select } from '../../reaction/fields';
import { quantumSupport } from '../../science/quantum';
import { selectOnly } from '../../state/actions';
import { lab, useLab } from '../../state/store';
import { LineChart, formatDuration } from '../charts';
import { UNIT_DENSITY, UNIT_ORBITAL, UNIT_POTENTIAL, legendNumber } from '../FieldLegend';
import { Button, EvidenceBadge, IconButton, Note, Section, Segmented } from '../kit';

/** CODATA 2018. */
const HARTREE_TO_EV = 27.211386245988;
/** The engine accepts at most 128 basis functions, and every atom brings at least one. */
const ATOM_LIMIT_FOR_SUPPORT_CHECK = 128;

const minus = (text: string): string => text.replace(/-/g, '−');
const hartree = (value: number, digits = 6): string => minus(value.toFixed(digits));
const signed = (value: number, digits: number): string => (value > 0 ? '+' : '') + minus(value.toFixed(digits));
/** Three significant figures: as much as a measurement on a triangle mesh supports. */
const measured = (value: number): string => Number(value.toPrecision(3)).toLocaleString('en-US', { maximumSignificantDigits: 3 });

function Slider({
  label,
  value,
  min,
  max,
  log,
  step,
  onChange,
  format,
  name,
  testId,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  /** Logarithmic travel, for quantities that span orders of magnitude. */
  log?: boolean;
  step?: number;
  onChange: (value: number) => void;
  format: (value: number) => ReactNode;
  /** Accessible name. */
  name: string;
  testId?: string;
}) {
  const position = log ? (Math.log(value / min) / Math.log(max / min)) * 1000 : ((value - min) / (max - min)) * 1000;
  const fromPosition = (p: number): number => {
    const raw = log ? min * (max / min) ** (p / 1000) : min + ((max - min) * p) / 1000;
    const rounded = log ? Number(raw.toPrecision(2)) : step ? Math.round(raw / step) * step : raw;
    return Math.min(max, Math.max(min, Number(rounded.toPrecision(6))));
  };
  return (
    <label className="ml-slider">
      <span className="ml-slider__label">{label}</span>
      <input type="range" min={0} max={1000} value={Math.round(Math.min(1000, Math.max(0, position)))} aria-label={name} data-testid={testId} onChange={(e) => onChange(fromPosition(Number(e.target.value)))} />
      <span className="ml-slider__value ml-mono">{format(value)}</span>
    </label>
  );
}

function Busy({ text, onCancel, cancelTestId }: { text: string; onCancel?: () => void; cancelTestId?: string }) {
  return (
    <div className="ml-running">
      <div className="ml-progress" data-indeterminate="true" style={{ margin: 0 }}>
        <i />
      </div>
      <span className="ml-mono">{text}</span>
      {onCancel && (
        <Button size="sm" variant="outline" onClick={onCancel} data-testid={cancelTestId}>
          <Square /> Cancel
        </Button>
      )}
    </div>
  );
}

function atomName(scene: Scene, id: number): string {
  const atom = scene.atoms.get(id);
  return atom ? `${getElement(atom.protons).symbol}${id}` : `atom ${id}`;
}

function orbitalEnergy(result: ScfResult, index: number): string {
  const energy = result.orbitalEnergies[index]!;
  return `${signed(energy, 4)} Eh (${signed(energy * HARTREE_TO_EV, 2)} eV)`;
}

function QuantumResult({ record, scene }: { record: QuantumRecord; scene: Scene }) {
  const { result } = record;
  const lumo = result.lumoIndex;
  const gap = lumo === null ? null : result.orbitalEnergies[lumo]! - result.orbitalEnergies[result.homoIndex]!;
  const iterations = result.iterations;
  const chart = useMemo(
    () => ({
      x: iterations.map((it) => it.iteration),
      series: [
        // The first entry compares with an energy of zero, so it is not a change between iterations.
        { id: 'energy', name: 'energy change', label: '|ΔE| / Eh', values: iterations.map((it, i) => (i === 0 ? NaN : Math.abs(it.deltaEnergy))) },
        { id: 'density', name: 'density change', label: 'RMS ΔP', values: iterations.map((it) => it.rmsDensityChange) },
      ],
    }),
    [iterations],
  );
  return (
    <div className="ml-result" data-testid="quantum-result">
      <div className="ml-statusline" data-tone={result.converged ? 'ok' : 'warning'}>
        <b data-testid="quantum-status">{result.converged ? 'Converged' : 'Not converged'}</b>
        <span className="ml-mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>
          {iterations.length} iterations · {formatDuration(record.elapsedMs / 1000)}
        </span>
      </div>
      <dl className="ml-kv">
        <dt>Total energy</dt>
        <dd className="ml-mono" data-testid="quantum-energy">
          {hartree(result.energy.total)} Eh
        </dd>
        <dt>Highest occupied orbital</dt>
        <dd className="ml-mono" data-testid="quantum-homo">
          {orbitalEnergy(result, result.homoIndex)}
        </dd>
        {lumo !== null && (
          <>
            <dt>Lowest empty orbital</dt>
            <dd className="ml-mono" data-testid="quantum-lumo">
              {orbitalEnergy(result, lumo)}
            </dd>
            <dt>Gap between them</dt>
            <dd className="ml-mono" data-testid="quantum-gap">
              {hartree(gap!, 4)} Eh ({(gap! * HARTREE_TO_EV).toFixed(2)} eV)
            </dd>
          </>
        )}
        <dt>Dipole moment</dt>
        <dd className="ml-mono" data-testid="quantum-dipole">
          {result.dipole.magnitudeDebye.toFixed(3)} D{result.dipole.originDependent ? ' *' : ''}
        </dd>
        <dt>Electrons · basis functions</dt>
        <dd className="ml-mono">
          {result.nElectrons} · {result.nBasis}
        </dd>
      </dl>
      {result.dipole.originDependent && <p className="ml-empty">* The dipole moment of an ion depends on the origin; the centre of nuclear charge is used.</p>}

      <details className="ml-details">
        <summary>Energy components</summary>
        <dl className="ml-kv" style={{ marginTop: 6 }}>
          <dt>Kinetic</dt>
          <dd className="ml-mono">{hartree(result.energy.kinetic)}</dd>
          <dt>Electron–nucleus attraction</dt>
          <dd className="ml-mono">{hartree(result.energy.nuclearAttraction)}</dd>
          <dt>Electron–electron repulsion</dt>
          <dd className="ml-mono">{hartree(result.energy.twoElectron)}</dd>
          <dt>Nucleus–nucleus repulsion</dt>
          <dd className="ml-mono">{hartree(result.energy.nuclearRepulsion)}</dd>
          <dt>Virial ratio −V/T</dt>
          <dd className="ml-mono">{virialRatio(result).toFixed(4)}</dd>
        </dl>
        <p className="ml-empty" style={{ marginTop: 6 }}>
          In hartree (E<sub>h</sub>); 1 E<sub>h</sub> = 27.2114 eV = 2625.50 kJ/mol. The total energy is that of the electrons and nuclei relative to all of them at rest and
          infinitely far apart, so only differences between calculations done the same way mean anything.
        </p>
      </details>

      <details className="ml-details">
        <summary>Atomic charges (Mulliken)</summary>
        <dl className="ml-kv" style={{ marginTop: 6 }} data-testid="quantum-charges">
          {record.atomIds.map((id, i) => (
            <div key={id} style={{ display: 'contents' }}>
              <dt>
                <button type="button" className="ml-link" onClick={() => selectOnly([id])}>
                  {atomName(scene, id)}
                </button>
              </dt>
              <dd className="ml-mono">{signed(result.mullikenCharges[i]!, 3)} e</dd>
            </div>
          ))}
        </dl>
        <p className="ml-empty" style={{ marginTop: 6 }}>
          Mulliken charges divide the electrons between atoms by the basis functions they sit in. They are a bookkeeping convention, change strongly with the basis set and
          are not observable.
        </p>
      </details>

      <details className="ml-details">
        <summary>Convergence</summary>
        <div style={{ marginTop: 6 }}>
          <LineChart x={chart.x} series={chart.series} xLabel="iteration" yLabel="change per iteration" logY height={170} testId="quantum-convergence" />
        </div>
        <p className="ml-empty">
          Converged means the energy changed by less than 10⁻⁹ E<sub>h</sub> and the density matrix by less than 10⁻⁷ (RMS) in the last iteration. A plateau followed by a
          drop means the first solution was a saddle point, which the engine detects and leaves.
        </p>
      </details>

      {result.warnings.map((warning, i) => (
        <Note key={i} severity="warning">
          {warning}
        </Note>
      ))}
    </div>
  );
}

function ElectronicStructure() {
  const scene = useLab((s) => s.scene);
  const running = useQuantum((s) => s.running);
  const progress = useQuantum((s) => s.progress);
  const record = useQuantum((s) => s.record);
  const problem = useQuantum((s) => s.problem);
  const atoms = scene.atoms.size;
  const support = useMemo(() => (atoms > 0 && atoms <= ATOM_LIMIT_FOR_SUPPORT_CHECK ? quantumSupport(scene) : null), [scene, atoms]);
  const current = quantumIsCurrent(record, scene);
  const tooLarge = atoms > ATOM_LIMIT_FOR_SUPPORT_CHECK;
  const reasons = tooLarge
    ? [
        `The structure has ${atoms.toLocaleString('en-US')} atoms. The engine is limited to 96 basis functions: one for each hydrogen, five for each atom of Li to Ne and nine for Na to Ar. C13H28 is the largest alkane that fits.`,
      ]
    : (support?.reasons ?? []);
  const supported = support?.supported ?? false;

  const stage =
    progress === null
      ? 'preparing…'
      : progress.phase === 'integrals'
        ? `integrals ${Math.round(progress.fraction * 100)} %`
        : progress.phase === 'scf'
          ? progress.iteration !== null && progress.energy !== null
            ? `iteration ${progress.iteration} · ${hartree(progress.energy)} Eh`
            : 'self-consistent field…'
          : 'properties…';

  return (
    <Section title="Electronic structure" right={<EvidenceBadge level="computed" />}>
      {running ? (
        <div data-testid="quantum-running">
          <Busy text={stage} onCancel={cancelQuantum} cancelTestId="quantum-cancel" />
        </div>
      ) : (
        <Button variant="primary" disabled={!supported} onClick={() => void runQuantum()} data-testid="quantum-run" style={{ alignSelf: 'flex-start' }}>
          <Atom /> {current ? 'Run again' : 'Run Hartree–Fock'}
        </Button>
      )}
      {atoms === 0 ? (
        <p className="ml-empty">Build a molecule and its orbitals, electron density and electrostatic potential can be computed here.</p>
      ) : supported && support ? (
        <p className="ml-empty" data-testid="quantum-support">
          RHF/STO-3G · {support.nBasis} basis functions · {support.nElectrons} electrons{support.estimatedSeconds >= 0.5 ? ` · about ${formatDuration(support.estimatedSeconds)}` : ''}. Solves
          the Hartree–Fock equations for this geometry, here in the browser.
        </p>
      ) : (
        <Note severity="info">
          <span data-testid="quantum-unsupported">Not available for this structure.</span>
          {reasons.map((reason, i) => (
            <span key={i} style={{ display: 'block', marginTop: 3 }}>
              {reason}
            </span>
          ))}
          <span style={{ display: 'block', marginTop: 3 }}>Supported: molecules of H to Ar with all electrons paired, up to 96 basis functions.</span>
        </Note>
      )}
      <details className="ml-details">
        <summary>What this does and does not tell you</summary>
        <p className="ml-empty" style={{ marginTop: 6 }}>
          Restricted Hartree–Fock gives every pair of electrons one orbital and lets each electron feel only the average of the others, so electron correlation is left
          out. STO-3G is the smallest sensible basis set: one function per occupied atomic orbital. Together they give the right qualitative picture of orbitals, density
          and potential for ordinary closed-shell molecules, and the engine reproduces the PySCF program to 10⁻⁸ E<sub>h</sub> on 48 test systems. The physics is still
          approximate: energy differences can be wrong by tens of kJ/mol, the dipole moment is a rough guide, and an orbital energy is only an estimate of an ionisation
          energy. The result is for one isolated molecule with its nuclei fixed where they are drawn, without solvent or temperature.
        </p>
      </details>
      {current && (
        <button type="button" className="ml-link" style={{ alignSelf: 'flex-start' }} onClick={() => lab.set({ inspectorTab: 'explain', explainSubject: 'electrons' })} data-testid="explain-electrons">
          Explain this calculation
        </button>
      )}
      {problem && (
        <Note severity="error">
          <span data-testid="quantum-problem">{problem.title}</span>
          {problem.details.map((detail, i) => (
            <span key={i} style={{ display: 'block', marginTop: 3 }}>
              {detail}
            </span>
          ))}
          <button type="button" className="ml-link" style={{ display: 'block', marginTop: 5 }} onClick={dismissQuantumProblem}>
            Dismiss
          </button>
        </Note>
      )}
      {current ? (
        <QuantumResult record={record} scene={scene} />
      ) : (
        record && (
          <p className="ml-empty" data-testid="quantum-stale">
            The structure has been edited since the last calculation, so its results and surfaces are no longer shown.
          </p>
        )
      )}
    </Section>
  );
}

const FIELD_OPTIONS: ReadonlyArray<{ value: FieldKind; label: string; tip: string }> = [
  { value: 'off', label: 'Off', tip: 'Show no field' },
  { value: 'orbital', label: 'Orbital', tip: 'One molecular orbital, with its two phases' },
  { value: 'density', label: 'Density', tip: 'The electron density of all occupied orbitals' },
  { value: 'potential', label: 'Potential', tip: 'The electrostatic potential, mapped on a density surface' },
];

const STYLE_OPTIONS: ReadonlyArray<{ value: FieldStyle; label: string; tip: string }> = [
  { value: 'surface', label: 'Isosurface', tip: 'The surface on which the field has one chosen value' },
  { value: 'cloud', label: 'Dot cloud', tip: 'Dots drawn at random in proportion to the field: a picture of the whole volume' },
];

function OrbitalPicker({ record }: { record: QuantumRecord }) {
  const index = useQuantum((s) => s.field.orbital);
  const { result } = record;
  const last = result.nBasis - 1;
  const occupied = index <= result.homoIndex;
  return (
    <div className="ml-orbital-picker">
      <div className="ml-orbital-picker__row">
        <IconButton size="sm" tip="Lower orbital" disabled={index <= 0} onClick={() => setField({ orbital: index - 1 })} data-testid="orbital-previous">
          <ChevronLeft />
        </IconButton>
        <div className="ml-orbital-picker__name">
          <b data-testid="orbital-name">
            Orbital {index + 1} of {result.nBasis} · {orbitalLabel(result, index)}
          </b>
          <span className="ml-mono" data-testid="orbital-energy">
            {orbitalEnergy(result, index)} · {occupied ? '2 electrons' : 'empty'}
          </span>
        </div>
        <IconButton size="sm" tip="Higher orbital" disabled={index >= last} onClick={() => setField({ orbital: index + 1 })} data-testid="orbital-next">
          <ChevronRight />
        </IconButton>
      </div>
      <div className="ml-isotopes">
        <button type="button" className="ml-chip" aria-pressed={index === result.homoIndex} onClick={() => setField({ orbital: result.homoIndex })} data-testid="orbital-homo">
          HOMO
        </button>
        {result.lumoIndex !== null && (
          <button type="button" className="ml-chip" aria-pressed={index === result.lumoIndex} onClick={() => setField({ orbital: result.lumoIndex! })} data-testid="orbital-lumo">
            LUMO
          </button>
        )}
      </div>
    </div>
  );
}

function FieldSection({ record }: { record: QuantumRecord }) {
  const field = useQuantum((s) => s.field);
  const busy = useQuantum((s) => s.fieldBusy);
  const progress = useQuantum((s) => s.fieldProgress);
  const info = useQuantum((s) => s.fieldInfo);
  const error = useQuantum((s) => s.fieldError);
  const shown = info !== null && info.kind === field.kind ? info : null;
  const kind = field.kind;

  return (
    <Section title="Orbitals, density, potential" right={<EvidenceBadge level="computed" />}>
      <Segmented<FieldKind> label="Field on stage" fill value={kind} options={FIELD_OPTIONS} onChange={(value) => setField({ kind: value })} />
      {kind === 'orbital' && <OrbitalPicker record={record} />}
      {(kind === 'orbital' || kind === 'density') && (
        <Segmented<FieldStyle> label="How the field is drawn" fill value={field.style} options={STYLE_OPTIONS} onChange={(value) => setField({ style: value })} />
      )}
      {kind === 'orbital' && field.style === 'surface' && (
        <Slider
          label="Isovalue"
          name="Orbital isovalue"
          log
          min={ISO_LIMITS.orbital.min}
          max={ISO_LIMITS.orbital.max}
          value={field.orbitalIso}
          onChange={(value) => setField({ orbitalIso: value })}
          format={(value) => (
            <>
              ±{legendNumber(value)} {UNIT_ORBITAL}
            </>
          )}
          testId="iso-orbital"
        />
      )}
      {kind === 'density' && field.style === 'surface' && (
        <Slider
          label="Isovalue"
          name="Density isovalue"
          log
          min={ISO_LIMITS.density.min}
          max={ISO_LIMITS.density.max}
          value={field.densityIso}
          onChange={(value) => setField({ densityIso: value })}
          format={(value) => (
            <>
              {legendNumber(value)} {UNIT_DENSITY}
            </>
          )}
          testId="iso-density"
        />
      )}
      {kind === 'potential' && (
        <>
          <Slider
            label="On density"
            name="Density isovalue of the surface the potential is shown on"
            log
            min={ISO_LIMITS.potential.min}
            max={ISO_LIMITS.potential.max}
            value={field.potentialIso}
            onChange={(value) => setField({ potentialIso: value })}
            format={(value) => (
              <>
                {legendNumber(value)} {UNIT_DENSITY}
              </>
            )}
            testId="iso-potential"
          />
          <Slider
            label="Colour range"
            name="Half-width of the potential colour scale"
            log
            min={0.005}
            max={0.5}
            value={field.potentialRange ?? shown?.potentialRange ?? 0.1}
            onChange={(value) => setField({ potentialRange: value })}
            format={(value) => (
              <>
                ±{legendNumber(value)} {UNIT_POTENTIAL}
              </>
            )}
            testId="potential-range"
          />
          {field.potentialRange !== null && (
            <button type="button" className="ml-link" style={{ alignSelf: 'flex-start', fontSize: 12 }} onClick={() => setField({ potentialRange: null })}>
              Fit the colour range to this surface
            </button>
          )}
        </>
      )}
      {(kind === 'orbital' || kind === 'density') && field.style === 'cloud' && (
        <Slider
          label="Dots"
          name="Number of dots"
          log
          min={5000}
          max={250000}
          value={field.dots}
          onChange={(value) => setField({ dots: Math.round(value) })}
          format={(value) => value.toLocaleString('en-US')}
          testId="cloud-dots"
        />
      )}
      {kind !== 'off' && (
        <Slider
          label="Opacity"
          name="Opacity of the field"
          min={0.15}
          max={1}
          step={0.01}
          value={field.opacity}
          onChange={(value) => setField({ opacity: value })}
          format={(value) => `${Math.round(value * 100)} %`}
          testId="field-opacity"
        />
      )}
      {busy && (
        <div data-testid="field-busy">
          <Busy
            text={progress?.stage === 'potential' ? `potential ${Math.round(progress.fraction * 100)} %` : progress?.stage === 'field' ? `sampling ${Math.round(progress.fraction * 100)} %` : 'building…'}
            onCancel={cancelFieldJobs}
            cancelTestId="field-cancel"
          />
        </div>
      )}
      {error && <Note severity="error">{error}</Note>}
      {shown && !busy && (
        <dl className="ml-kv" data-testid="field-info">
          {shown.style === 'surface' &&
            shown.parts.map((part) => (
              <div key={part.sign} style={{ display: 'contents' }}>
                <dt>{shown.kind === 'orbital' ? (part.sign > 0 ? 'Positive lobes' : 'Negative lobes') : 'Surface'}</dt>
                <dd className="ml-mono">
                  {measured(part.area)} Å²{part.closed ? ` · ${measured(part.volume)} Å³ inside` : ' · leaves the sampled box'}
                </dd>
              </div>
            ))}
          {shown.style === 'surface' && shown.parts.length === 0 && (
            <>
              <dt>Surface</dt>
              <dd>The field does not reach this value anywhere.</dd>
            </>
          )}
          {shown.kind === 'potential' && shown.potentialMin !== null && shown.potentialMax !== null && (
            <>
              <dt>Potential on the surface</dt>
              <dd className="ml-mono" data-testid="potential-extremes">
                {legendNumber(shown.potentialMin, 3)} to {shown.potentialMax > 0 ? '+' : ''}
                {legendNumber(shown.potentialMax, 3)} {UNIT_POTENTIAL}
              </dd>
            </>
          )}
          {shown.style === 'cloud' && shown.captured !== null && (
            <>
              <dt>{shown.kind === 'density' ? 'Electrons in the sampled box' : 'Probability in the sampled box'}</dt>
              <dd className="ml-mono">{shown.kind === 'density' ? `${shown.captured.toFixed(2)} of ${record.result.nElectrons}` : `${(shown.captured * 100).toFixed(1)} %`}</dd>
            </>
          )}
          <dt>Sampling grid</dt>
          <dd className="ml-mono">{shown.gridSpacing.toFixed(2)} Å</dd>
        </dl>
      )}
      {shown && !busy && shown.style === 'surface' && shown.parts.length > 0 && (
        <p className="ml-empty" data-testid="field-accuracy">
          Area and volume are measured on the triangle mesh, which lies just inside the true surface, so both come out slightly low: a few tenths of a per cent for the
          outline of a molecule, one to three per cent for a lobe smaller than an atom.
        </p>
      )}
      {kind === 'orbital' && (
        <p className="ml-empty">
          The two colours are the two signs of the wavefunction. Only the difference in sign between lobes is physical: the overall sign of an orbital is arbitrary.
          {field.style === 'cloud' ? ' The dots are a random sample of |ψ|², so each run of the sampler would place them differently; the seed is fixed so the picture is reproducible.' : ''}
        </p>
      )}
      {kind === 'density' && (
        <p className="ml-empty">
          {field.style === 'cloud'
            ? 'Each dot stands for the same amount of charge, so dots crowd where the density is high. Detail finer than the sampling grid, such as the sharp peak at each nucleus, is not resolved.'
            : 'The surface encloses the region where the electron density is above the chosen value. About 0.002 e/a₀³ is commonly taken as the outline of a molecule.'}
        </p>
      )}
      {kind === 'potential' && (
        <p className="ml-empty">
          The energy of a unit positive test charge at each point of the surface, from the nuclei and the computed electron density. Red is negative (attracts positive
          charge), blue positive. 1 E<sub>h</sub>/e = 27.2114 V.
        </p>
      )}
    </Section>
  );
}

const SLICE_FIELDS: ReadonlyArray<{ value: SliceField; label: string }> = [
  { value: 'density', label: 'Electron density' },
  { value: 'orbital', label: 'Selected orbital' },
  { value: 'potential', label: 'Electrostatic potential' },
];

const AXIS_OPTIONS: ReadonlyArray<{ value: SliceAxis; label: string; tip: string }> = [
  { value: 'x', label: 'yz', tip: 'Plane perpendicular to the x axis' },
  { value: 'y', label: 'xz', tip: 'Plane perpendicular to the y axis' },
  { value: 'z', label: 'xy', tip: 'Plane perpendicular to the z axis' },
  { value: 'atoms', label: '3 atoms', tip: 'Plane through the three selected atoms' },
];

function PlaneSection() {
  const slice = useQuantum((s) => s.slice);
  const busy = useQuantum((s) => s.sliceBusy);
  const info = useQuantum((s) => s.sliceInfo);
  const error = useQuantum((s) => s.sliceError);
  const selected = useLab((s) => s.selectedAtoms.size);
  const range = info?.offsetRange ?? [-3, 3];

  return (
    <Section
      title="Cutting plane"
      right={
        <Button size="sm" variant="outline" active={slice.enabled} onClick={() => setSlice({ enabled: !slice.enabled })} data-testid="plane-toggle">
          {slice.enabled ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {slice.enabled ? (
        <>
          <Select<SliceField> label="Field shown on the plane" value={slice.field} options={SLICE_FIELDS} onChange={(value) => setSlice({ field: value })} testId="plane-field" />
          <Segmented<SliceAxis>
            label="Orientation of the plane"
            fill
            value={slice.axis}
            options={AXIS_OPTIONS}
            onChange={(value) => {
              if (value === 'atoms') sliceThroughSelection();
              else setSlice({ axis: value, offset: 0 });
            }}
          />
          {slice.axis === 'atoms' && (
            <button type="button" className="ml-link" style={{ alignSelf: 'flex-start', fontSize: 12 }} disabled={selected !== 3} onClick={() => sliceThroughSelection()}>
              {selected === 3 ? 'Lay the plane through the three selected atoms' : 'Select three atoms to move the plane to them'}
            </button>
          )}
          <Slider
            label="Position"
            name="Position of the plane along its normal"
            min={range[0]}
            max={range[1]}
            step={0.05}
            value={Math.min(range[1], Math.max(range[0], slice.offset))}
            onChange={(value) => setSlice({ offset: Number(value.toFixed(2)) })}
            format={(value) => `${signed(value, 2)} Å`}
            testId="plane-offset"
          />
          <div className="ml-actions">
            <Button size="sm" variant="outline" active={slice.cut} onClick={() => setSlice({ cut: !slice.cut })} data-testid="plane-cut">
              Cut surfaces open
            </Button>
            {slice.cut && (
              <Button size="sm" variant="outline" onClick={() => setSlice({ flipped: !slice.flipped })} data-testid="plane-flip">
                <FlipHorizontal2 /> Other side
              </Button>
            )}
          </div>
          {busy && (
            <div data-testid="plane-busy">
              <Busy text="evaluating the field on the plane…" onCancel={slice.field === 'potential' ? cancelFieldJobs : undefined} />
            </div>
          )}
          {error && <Note severity="error">{error}</Note>}
          {info && !busy && (
            <dl className="ml-kv" data-testid="plane-info">
              <dt>Range on the plane</dt>
              <dd className="ml-mono">
                {legendNumber(info.min, 3)} to {legendNumber(info.max, 3)} {info.field === 'density' ? UNIT_DENSITY : info.field === 'orbital' ? UNIT_ORBITAL : UNIT_POTENTIAL}
              </dd>
              <dt>Sampled at</dt>
              <dd className="ml-mono">
                {info.columns} × {info.rows} points, {((info.width / (info.columns - 1)) * 100).toFixed(0)} pm apart
              </dd>
            </dl>
          )}
          <p className="ml-empty">
            The field is evaluated at every point of the plane, not interpolated. Contour lines are evenly spaced on the colour scale
            {slice.field === 'density' ? ' (two per factor of ten).' : '.'} “Position” is measured from {slice.axis === 'atoms' ? 'the three atoms' : 'the middle of the molecule'}.
          </p>
        </>
      ) : (
        <p className="ml-empty">A flat cut through the molecule that shows a field in colour, with a scale. It can also cut the surfaces open to look inside.</p>
      )}
    </Section>
  );
}

const SURFACE_KINDS: ReadonlyArray<{ value: MolecularSurfaceKind; label: string; tip: string }> = [
  { value: 'vdw', label: 'Van der Waals', tip: 'The outside of the atoms drawn as spheres of their van der Waals radius' },
  { value: 'sas', label: 'Solvent-accessible', tip: `Where the centre of a water-sized probe (${PROBE_RADIUS} Å) can go` },
];

function MolecularSurfaceSection() {
  const atoms = useLab((s) => s.scene.atoms.size);
  const settings = useQuantum((s) => s.molecular);
  const busy = useQuantum((s) => s.molecularBusy);
  const info = useQuantum((s) => s.molecularInfo);
  const error = useQuantum((s) => s.molecularError);
  const shown = info !== null && info.kind === settings.kind ? info : null;
  return (
    <Section
      title="Molecular surface"
      right={
        <Button size="sm" variant="outline" active={settings.enabled} disabled={atoms === 0} onClick={() => setMolecular({ enabled: !settings.enabled })} data-testid="surface-toggle">
          {settings.enabled ? 'Hide' : 'Show'}
        </Button>
      }
    >
      {settings.enabled ? (
        <>
          <Segmented<MolecularSurfaceKind> label="Kind of surface" fill value={settings.kind} options={SURFACE_KINDS} onChange={(value) => setMolecular({ kind: value })} />
          <Segmented<'element' | 'plain'>
            label="Colouring of the surface"
            fill
            value={settings.coloring}
            options={[
              { value: 'element', label: 'By element' },
              { value: 'plain', label: 'One colour' },
            ]}
            onChange={(value) => setMolecular({ coloring: value })}
          />
          <Slider
            label="Opacity"
            name="Opacity of the molecular surface"
            min={0.15}
            max={1}
            step={0.01}
            value={settings.opacity}
            onChange={(value) => setMolecular({ opacity: value })}
            format={(value) => `${Math.round(value * 100)} %`}
            testId="surface-opacity"
          />
          {busy && (
            <div data-testid="surface-busy">
              <Busy text="building the surface…" />
            </div>
          )}
          {error && <Note severity="warning">{error}</Note>}
          {shown && !busy && (
            <dl className="ml-kv" data-testid="surface-info">
              <dt>Area</dt>
              <dd className="ml-mono" data-testid="surface-area">
                {measured(shown.area)} Å²
              </dd>
              <dt>Volume enclosed</dt>
              <dd className="ml-mono" data-testid="surface-volume">
                {shown.closed ? `${measured(shown.volume)} Å³` : '—'}
              </dd>
              <dt>Sampling grid</dt>
              <dd className="ml-mono">{shown.gridSpacing.toFixed(2)} Å</dd>
            </dl>
          )}
          <p className="ml-empty">
            A geometric construction, not a computed electron distribution: every atom is a sphere of its tabulated van der Waals radius
            {settings.kind === 'sas' ? `, enlarged by a probe of ${PROBE_RADIUS} Å` : ''}. Area and volume are measured on the triangle mesh, which lies just inside the
            spheres, so both come out low
            {shown ? (shown.gridSpacing <= 0.14 ? ' by under one per cent on this grid.' : shown.gridSpacing <= 0.21 ? ' by one to two per cent on this grid.' : ' by two to four per cent on this grid.') : '.'}
          </p>
        </>
      ) : (
        <p className="ml-empty">
          The outline of the molecule built from van der Waals radii. Works for any structure up to {MOLECULAR_SURFACE_ATOM_LIMIT.toLocaleString('en-US')} atoms and needs no
          calculation.
        </p>
      )}
    </Section>
  );
}

/** Quantum-chemical calculation and the fields derived from it, plus the geometric molecular surface. */
export function QuantumPanel() {
  const scene = useLab((s) => s.scene);
  const record = useQuantum((s) => s.record);
  const current = quantumIsCurrent(record, scene);
  return (
    <>
      <ElectronicStructure />
      {current && (
        <>
          <div className="ml-divider" />
          <FieldSection record={record} />
          <div className="ml-divider" />
          <PlaneSection />
        </>
      )}
      <div className="ml-divider" />
      <MolecularSurfaceSection />
    </>
  );
}

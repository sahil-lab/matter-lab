import { getElement } from '@matterlab/core';
import type { AtomId, Scene } from '@matterlab/core';
import { Eye, EyeOff, Pause, Play, Sparkles, Square, Undo2 } from 'lucide-react';
import { useMemo } from 'react';
import {
  cancelOptimization,
  dismissProblem,
  optimizationIsCurrent,
  optimizeGeometry,
  playReplay,
  seekReplay,
  setShowOriginal,
  stopReplay,
  useCompute,
} from '../../compute/store';
import type { OptimizationRecord } from '../../compute/store';
import { selectOnly, undo } from '../../state/actions';
import { lab, useLab } from '../../state/store';
import { LineChart, formatNumber } from '../charts';
import { Button, EvidenceBadge, Note, Section } from '../kit';
import { QuantumPanel } from './QuantumPanel';

const minus = (text: string) => text.replace(/-/g, '−');
/** A value that rounds to zero is written as zero, never as "−0.000". */
const kcal = (value: number) => minus((Math.abs(value) >= 1000 ? value.toFixed(1) : value.toFixed(3)).replace(/^-(0(\.0+)?)$/, '$1'));

function atomName(scene: Scene, id: AtomId): string {
  const atom = scene.atoms.get(id);
  return atom ? `${getElement(atom.protons).symbol}${id}` : `atom ${id}`;
}

function OptimizationResult({ record, scene }: { record: OptimizationRecord; scene: Scene }) {
  const showOriginal = useCompute((s) => s.showOriginal);
  const replayFrame = useCompute((s) => s.replayFrame);
  const replaying = useCompute((s) => s.replaying);
  const canUndo = useLab((s) => s.history.past[s.history.past.length - 1]?.label === 'Optimise geometry (UFF)');
  const frames = record.trajectory.length;
  const change = record.finalEnergy - record.initialEnergy;
  const terms = record.energyTerms;
  // The energy above its final value, which is what a logarithmic axis can show falling by orders of magnitude.
  const path = useMemo(() => {
    const { steps, energies } = record.energyPath;
    const excess = energies.map((energy) => energy - record.finalEnergy);
    return { x: steps, values: excess.map((value) => (value > 0 ? value : NaN)), points: excess.filter((value) => value > 0).length };
  }, [record]);
  return (
    <div className="ml-result" data-testid="optimization-result">
      <div className="ml-statusline" data-tone={record.converged ? 'ok' : 'warning'}>
        <b data-testid="optimization-status">{record.converged ? 'Converged to a minimum' : 'Not converged'}</b>
        <span className="ml-mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>
          {record.steps} steps · {record.elapsedMs < 1000 ? `${Math.round(record.elapsedMs)} ms` : `${(record.elapsedMs / 1000).toFixed(1)} s`}
        </span>
      </div>
      <dl className="ml-kv">
        <dt>Energy before</dt>
        <dd className="ml-mono" data-testid="energy-before">
          {kcal(record.initialEnergy)} kcal/mol
        </dd>
        <dt>Energy after</dt>
        <dd className="ml-mono" data-testid="energy-after">
          {kcal(record.finalEnergy)} kcal/mol
        </dd>
        <dt>Change</dt>
        <dd className="ml-mono" style={{ color: change < 0 ? 'var(--ok)' : 'var(--text)' }}>
          {kcal(change)} kcal/mol
        </dd>
        <dt>RMS gradient</dt>
        <dd className="ml-mono">{formatNumber(record.rmsGradient, 2)} kcal/mol/Å</dd>
        <dt>RMS displacement</dt>
        <dd className="ml-mono" data-testid="rms-displacement">
          {record.rmsDisplacement.toFixed(3)} Å
        </dd>
        {record.largestMove && record.largestMove.distance > 0.0005 && (
          <>
            <dt>Largest move</dt>
            <dd>
              <button type="button" className="ml-link" onClick={() => selectOnly([record.largestMove!.atomId])}>
                {atomName(scene, record.largestMove.atomId)}
              </button>{' '}
              <span className="ml-mono">{record.largestMove.distance.toFixed(3)} Å</span>
            </dd>
          </>
        )}
        {record.movable < record.atomIds.length && (
          <>
            <dt>Atoms moved</dt>
            <dd className="ml-mono">
              {record.movable} of {record.atomIds.length} (the rest were held fixed)
            </dd>
          </>
        )}
      </dl>

      <details className="ml-details">
        <summary>Energy by term</summary>
        <dl className="ml-kv" style={{ marginTop: 6 }}>
          <dt>Bond stretching</dt>
          <dd className="ml-mono">{kcal(terms.bondStretch)}</dd>
          <dt>Angle bending</dt>
          <dd className="ml-mono">{kcal(terms.angleBend)}</dd>
          <dt>Torsion</dt>
          <dd className="ml-mono">{kcal(terms.torsion)}</dd>
          <dt>Inversion</dt>
          <dd className="ml-mono">{kcal(terms.inversion)}</dd>
          <dt>Van der Waals</dt>
          <dd className="ml-mono">{kcal(terms.vanDerWaals)}</dd>
        </dl>
        <p className="ml-empty" style={{ marginTop: 6 }}>
          In kcal/mol. A force-field energy is a strain measure for this bonding pattern; it can be compared between shapes of the same molecule, not between different
          molecules.
        </p>
      </details>

      {path.points > 1 && (
        <details className="ml-details">
          <summary>Energy along the path</summary>
          <div style={{ marginTop: 6 }}>
            <LineChart
              x={path.x}
              series={[{ id: 'energy', name: 'energy above the final value', label: 'E − E(final)', values: path.values }]}
              xLabel="step"
              yLabel="energy above the final value"
              yUnit="kcal mol-1"
              logY
              height={170}
              testId="optimization-path"
            />
          </div>
          <p className="ml-empty">
            How far the energy still was above its final value at each step of the search, on a logarithmic scale. A sudden drop after a plateau means the search had
            stopped at a saddle point and was moved off it.
          </p>
        </details>
      )}

      {record.bondChanges.some((b) => Math.abs(b.after - b.before) > 0.0005) && (
        <details className="ml-details">
          <summary>Largest bond-length changes</summary>
          <dl className="ml-kv" style={{ marginTop: 6 }}>
            {record.bondChanges
              .filter((b) => Math.abs(b.after - b.before) > 0.0005)
              .map((b) => (
                <div key={`${b.a}-${b.b}`} style={{ display: 'contents' }}>
                  <dt>
                    {atomName(scene, b.a)}–{atomName(scene, b.b)}
                  </dt>
                  <dd className="ml-mono">
                    {b.before.toFixed(3)} → {b.after.toFixed(3)} Å
                  </dd>
                </div>
              ))}
          </dl>
        </details>
      )}

      <div className="ml-actions">
        <Button size="sm" variant="outline" active={showOriginal} onClick={() => setShowOriginal(!showOriginal)} data-testid="show-original">
          {showOriginal ? <EyeOff /> : <Eye />} {showOriginal ? 'Hide original' : 'Compare with original'}
        </Button>
        {frames > 1 && (
          <Button size="sm" variant="outline" onClick={() => (replaying ? stopReplay() : playReplay())} data-testid="replay">
            {replaying ? <Pause /> : <Play />} {replaying ? 'Stop' : 'Replay path'}
          </Button>
        )}
        {canUndo && (
          <Button size="sm" onClick={undo}>
            <Undo2 /> Undo
          </Button>
        )}
      </div>
      {frames > 1 && (
        <label className="ml-scrub">
          <input
            type="range"
            min={0}
            max={frames - 1}
            value={replayFrame ?? frames - 1}
            aria-label="Step of the optimiser's path"
            onChange={(e) => seekReplay(Number(e.target.value))}
            onPointerUp={() => {
              if (!useCompute.getState().replaying) stopReplay();
            }}
          />
          <span className="ml-mono">{replayFrame === null ? 'final geometry' : `frame ${replayFrame + 1} / ${frames}`}</span>
        </label>
      )}
      {showOriginal && <p className="ml-empty">The orange outline is the geometry before optimisation, in the same position, without any alignment.</p>}
      {frames > 1 && (
        <p className="ml-empty">
          The replay shows the minimiser’s own steps, which are real computed data, but it is the path of a numerical search and not the motion of a molecule in time.
        </p>
      )}
      {record.warnings.map((warning, i) => (
        <Note key={i} severity="warning">
          {warning}
        </Note>
      ))}
    </div>
  );
}

/** Calculations on the structure being built: force-field optimisation, electronic structure, fields and surfaces. */
export function ComputePanel() {
  const scene = useLab((s) => s.scene);
  const selected = useLab((s) => s.selectedAtoms.size);
  const optimizing = useCompute((s) => s.optimizing);
  const progress = useCompute((s) => s.progress);
  const record = useCompute((s) => s.optimization);
  const problem = useCompute((s) => s.problem);
  const atoms = scene.atoms.size;
  const partial = selected > 0 && selected < atoms;
  const current = optimizationIsCurrent(record, scene);

  return (
    <>
      <Section title="Geometry optimisation" right={<EvidenceBadge level="computed" />}>
        {optimizing ? (
          <div className="ml-running" data-testid="optimization-running">
            <div className="ml-progress" data-indeterminate="true" style={{ margin: 0 }}>
              <i />
            </div>
            <span className="ml-mono">{progress ? `step ${progress.step} · ${kcal(progress.energy)} kcal/mol` : 'preparing…'}</span>
            <Button size="sm" variant="outline" onClick={cancelOptimization} data-testid="optimization-cancel">
              <Square /> Cancel
            </Button>
          </div>
        ) : (
          <Button variant="primary" disabled={atoms === 0} onClick={() => void optimizeGeometry()} data-testid="optimize" style={{ alignSelf: 'flex-start' }}>
            <Sparkles /> {partial ? `Optimise ${selected} selected atom${selected === 1 ? '' : 's'}` : 'Optimise geometry'}
          </Button>
        )}
        <p className="ml-empty">
          Universal Force Field: a classical model that moves the atoms to the nearest energy minimum.
          {partial ? ' Only the selected atoms move; the others are held fixed.' : ' Select atoms first to optimise only those.'}
        </p>
        <details className="ml-details">
          <summary>What this does and does not tell you</summary>
          <p className="ml-empty" style={{ marginTop: 6 }}>
            UFF describes a molecule by springs for bond lengths and angles, terms for torsions and inversions, and van der Waals contacts. This is a port of RDKit’s
            implementation, checked against RDKit on 194 molecules. The result is a model geometry, not a measured one. The optimiser finds the nearest minimum, which
            need not be the lowest, and it has no electrostatics, so hydrogen bonds and charged groups are described poorly.
          </p>
        </details>
        {current && (
          <button type="button" className="ml-link" style={{ alignSelf: 'flex-start' }} onClick={() => lab.set({ inspectorTab: 'explain', explainSubject: 'optimisation' })} data-testid="explain-optimisation">
            Explain this calculation
          </button>
        )}
        {problem && (
          <Note severity="error">
            <span data-testid="optimization-problem">{problem.title}</span>
            {problem.details.map((detail, i) => (
              <span key={i} style={{ display: 'block', marginTop: 3 }}>
                {detail}
              </span>
            ))}
            <button type="button" className="ml-link" style={{ display: 'block', marginTop: 5 }} onClick={dismissProblem}>
              Dismiss
            </button>
          </Note>
        )}
        {current ? (
          <OptimizationResult record={record} scene={scene} />
        ) : (
          record && <p className="ml-empty">The structure has been edited since the last optimisation, so its result is no longer shown.</p>
        )}
      </Section>
      <div className="ml-divider" />
      <QuantumPanel />
    </>
  );
}

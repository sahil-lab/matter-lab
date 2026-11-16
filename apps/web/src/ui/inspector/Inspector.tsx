import { getElement, measurePoints } from '@matterlab/core';
import type { Vec3 } from '@matterlab/core';
import { BookOpen, ChevronRight, GraduationCap, Trash2 } from 'lucide-react';
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { quantumIsCurrent, useQuantum } from '../../compute/quantum';
import { optimizationIsCurrent, useCompute } from '../../compute/store';
import { formatMeasurement } from '../../render/Annotations';
import { clearMeasurements, removeMeasurement, selectOnly } from '../../state/actions';
import { lab, useLab } from '../../state/store';
import type { ExplainLevel, ExplainSubject, InspectorTab } from '../../state/store';
import { explainAtom, explainBond, explainStructure } from '../explain';
import type { Explanation } from '../explain';
import { explainOptimisation, explainQuantum } from '../explainCompute';
import { Button, EvidenceBadge, IconButton, Segmented } from '../kit';
import { AtomPanel } from './AtomPanel';
import { ComputePanel } from './ComputePanel';
import { BondPanel, MultiPanel, StructurePanel } from './Panels';

function MeasurePanel() {
  const measurements = useLab((s) => s.measurements);
  const scene = useLab((s) => s.scene);
  if (measurements.length === 0) {
    return (
      <p className="ml-empty">
        No measurements yet. Choose the Measure tool and click two atoms for a distance, three for an angle or four for a dihedral. Measurements follow the atoms as you
        edit.
      </p>
    );
  }
  return (
    <>
      <div className="ml-list" data-testid="measurements">
        {measurements.map((m) => {
          const points: Vec3[] = [];
          for (const id of m.atoms) {
            const atom = scene.atoms.get(id);
            if (atom) points.push(atom.position);
          }
          const result = measurePoints(points);
          if (!result) return null;
          const labels = m.atoms.map((id) => `${getElement(scene.atoms.get(id)!.protons).symbol}${id}`).join('–');
          return (
            <div key={m.id} className="ml-row">
              <button type="button" className="ml-row__grow ml-mono" style={{ textAlign: 'left', fontSize: 12, color: 'var(--text-2)' }} onClick={() => selectOnly(m.atoms)}>
                {labels}
              </button>
              <b className="ml-mono" style={{ color: 'var(--energy)', fontWeight: 500 }}>
                {formatMeasurement(result.value, result.unit)}
              </b>
              <IconButton size="sm" variant="danger" aria-label="Remove measurement" onClick={() => removeMeasurement(m.id)}>
                <Trash2 />
              </IconButton>
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="outline" style={{ alignSelf: 'flex-start' }} onClick={clearMeasurements}>
        Clear all
      </Button>
      <p className="ml-empty">Values are measured directly from the atom positions in the scene.</p>
    </>
  );
}

/** Renders **emphasis** inside explanation text. */
export function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function ExplanationView({ explanation, testId = 'explanation' }: { explanation: Explanation; testId?: string }) {
  return (
    <div className="ml-explain" data-testid={testId}>
      {explanation.title && <div className="ml-hero__title">{explanation.title}</div>}
      {explanation.sections.map((section, index) => (
        <div key={`${section.heading}-${index}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <h4 style={{ margin: 0 }}>{section.heading}</h4>
            {section.evidence && <EvidenceBadge level={section.evidence} />}
          </div>
          {section.paragraphs.map((p, i) => (
            <p key={i}>{rich(p)}</p>
          ))}
          {section.equation && (
            <div className="ml-eq" style={{ marginTop: 6 }}>
              {section.equation}
            </div>
          )}
        </div>
      ))}
      {explanation.references.length > 0 && (
        <div>
          <h4>Sources</h4>
          {explanation.references.map((ref, i) => (
            <cite key={i}>
              {ref.authors ? `${ref.authors}, ` : ''}
              {ref.title}
              {ref.source ? `. ${ref.source}` : ''}
              {ref.year ? ` (${ref.year})` : ''}
              {ref.doi ? `. doi:${ref.doi}` : ''}
            </cite>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The explanation panel. It describes whatever is selected, or one of the calculations done on the
 * structure, at the chosen depth, and follows the selection and what is drawn on stage.
 */
function ExplainPanel() {
  const scene = useLab((s) => s.scene);
  const selectedAtoms = useLab((s) => s.selectedAtoms);
  const selectedBonds = useLab((s) => s.selectedBonds);
  const level = useLab((s) => s.explainLevel);
  const subject = useLab((s) => s.explainSubject);
  const mode = useLab((s) => s.renderMode);
  const optimisation = useCompute((s) => s.optimization);
  const quantum = useQuantum((s) => s.record);
  const field = useQuantum((s) => s.field);
  const fieldInfo = useQuantum((s) => s.fieldInfo);
  const slice = useQuantum((s) => s.slice);
  const sliceInfo = useQuantum((s) => s.sliceInfo);

  const hasOptimisation = optimizationIsCurrent(optimisation, scene);
  const hasQuantum = quantumIsCurrent(quantum, scene);
  // A calculation that no longer belongs to the structure on stage cannot be explained as if it did.
  const shown: ExplainSubject = (subject === 'optimisation' && !hasOptimisation) || (subject === 'electrons' && !hasQuantum) ? 'selection' : subject;
  const singleAtom = selectedAtoms.size === 1 && selectedBonds.size === 0 ? [...selectedAtoms][0]! : null;

  let explanation: Explanation | null;
  if (shown === 'optimisation' && hasOptimisation) explanation = explainOptimisation(optimisation, level, singleAtom);
  else if (shown === 'electrons' && hasQuantum) explanation = explainQuantum(quantum, level, { field, fieldInfo, slice, sliceInfo, selectedAtom: singleAtom });
  else if (singleAtom !== null) explanation = explainAtom(scene, singleAtom, level, mode);
  else if (selectedBonds.size === 1 && selectedAtoms.size === 0) explanation = explainBond(scene, [...selectedBonds][0]!, level);
  else if (selectedAtoms.size > 1) explanation = explainStructure(scene, [...selectedAtoms], level, mode);
  else explanation = explainStructure(scene, null, level, mode);

  return (
    <>
      {(hasOptimisation || hasQuantum) && (
        <Segmented<ExplainSubject>
          label="What to explain"
          fill
          value={shown}
          onChange={(value) => lab.set({ explainSubject: value })}
          options={[
            { value: 'selection', label: 'Selection' },
            ...(hasOptimisation ? [{ value: 'optimisation' as const, label: 'Optimisation' }] : []),
            ...(hasQuantum ? [{ value: 'electrons' as const, label: 'Electrons' }] : []),
          ]}
        />
      )}
      <Segmented<ExplainLevel>
        label="Explanation depth"
        fill
        value={level}
        onChange={(value) => lab.set({ explainLevel: value })}
        options={[
          {
            value: 'beginner',
            label: (
              <>
                <BookOpen /> Essentials
              </>
            ),
          },
          {
            value: 'advanced',
            label: (
              <>
                <GraduationCap /> In depth
              </>
            ),
          },
        ]}
      />
      {explanation ? (
        <ExplanationView explanation={explanation} testId={shown === 'selection' ? 'explanation' : `explanation-${shown}`} />
      ) : (
        <p className="ml-empty">Build or select something and its explanation appears here.</p>
      )}
    </>
  );
}

function InspectPanel() {
  const selectedAtoms = useLab((s) => s.selectedAtoms);
  const selectedBonds = useLab((s) => s.selectedBonds);
  if (selectedAtoms.size === 1 && selectedBonds.size === 0) return <AtomPanel atomId={[...selectedAtoms][0]!} />;
  if (selectedBonds.size === 1 && selectedAtoms.size === 0) return <BondPanel bondId={[...selectedBonds][0]!} />;
  if (selectedAtoms.size + selectedBonds.size > 0) return <MultiPanel />;
  return <StructurePanel />;
}

/** The collapsible inspector on the right: properties, explanation and measurements for the selection. */
export function Inspector() {
  const open = useLab((s) => s.inspectorOpen);
  const tab = useLab((s) => s.inspectorTab);
  const measurementCount = useLab((s) => s.measurements.length);
  if (!open) return null;
  return (
    <div className="ml-right">
      <aside className="ml-panel ml-inspector" aria-label="Inspector" data-testid="inspector">
        <div className="ml-inspector__tabs">
          <Segmented<InspectorTab>
            label="Inspector section"
            fill
            value={tab}
            onChange={(value) => lab.set({ inspectorTab: value })}
            options={[
              { value: 'inspect', label: 'Inspect' },
              { value: 'explain', label: 'Explain' },
              { value: 'measure', label: measurementCount > 0 ? `Measure · ${measurementCount}` : 'Measure' },
              { value: 'compute', label: 'Compute' },
            ]}
          />
          <IconButton size="sm" tip="Hide inspector" tipPos="bottom-end" onClick={() => lab.set({ inspectorOpen: false })}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="ml-inspector__body ml-scroll">
          {tab === 'inspect' ? <InspectPanel /> : tab === 'explain' ? <ExplainPanel /> : tab === 'measure' ? <MeasurePanel /> : <ComputePanel />}
        </div>
      </aside>
    </div>
  );
}

import type { Quantity } from '@matterlab/core';
import { rateConstant } from '@matterlab/reactions';
import type { ExperimentResult, ExperimentStatus, ExperimentStep } from '@matterlab/reactions';
import { BookOpen, Check, ChevronRight, CircleAlert, CircleCheck, Download, FolderInput, GraduationCap, Repeat2, Save, SkipForward, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { lab, useLab } from '../state/store';
import type { ExplainLevel } from '../state/store';
import { EnergyLevels, LineChart, formatDuration, formatNumber, formatUnit } from '../ui/charts';
import { ChemText, EquationText } from '../ui/chem';
import { ExplanationView } from '../ui/inspector/Inspector';
import { Button, EvidenceBadge, IconButton, Note, Section, Segmented } from '../ui/kit';
import {
  deleteExperiment,
  exportExperiment,
  importExperimentFile,
  isStale,
  openExperiment,
  refreshSaved,
  reproduce,
  saveExperiment,
  seekTime,
  setTab,
  toggleCompare,
  useReaction,
} from './store';
import type { ExperimentSummary, ResultTab } from './store';

const STATUS: Readonly<Record<ExperimentStatus, { label: string; tone: 'ok' | 'warning' | 'error' | 'muted'; text: string }>> = {
  completed: { label: 'Completed', tone: 'ok', text: 'Everything that was asked for was calculated.' },
  partial: { label: 'Partial', tone: 'warning', text: 'Some results are shown, but less than was asked for.' },
  unsupported: { label: 'Not supported', tone: 'warning', text: 'The experiment is well-formed, but what was asked for cannot be calculated.' },
  invalid: { label: 'Cannot run', tone: 'error', text: 'The experiment cannot be run as given. Nothing was calculated.' },
  cancelled: { label: 'Cancelled', tone: 'muted', text: 'The run was stopped before it finished.' },
};

const minus = (text: string) => text.replace(/-/g, '−');

const LEVEL_NAMES = { reactants: 'reactants', barrier: 'barrier', products: 'products' } as const;

/** A value with its uncertainty, rounded to where the uncertainty says the digits stop meaning anything. */
function quantityText(q: Quantity, fallbackDecimals = 1): string {
  if (!Number.isFinite(q.value)) return '—';
  if (q.uncertainty !== undefined && q.uncertainty > 0) {
    const decimals = Math.min(6, Math.max(0, 1 - Math.floor(Math.log10(q.uncertainty))));
    return `${minus(q.value.toFixed(decimals))} ± ${q.uncertainty.toFixed(decimals)}`;
  }
  return Math.abs(q.value) >= 1 ? minus(q.value.toFixed(fallbackDecimals)) : minus(formatNumber(q.value, 3));
}

function StepRow({ step, index }: { step: ExperimentStep; index: number }) {
  const Icon = step.status === 'passed' ? CircleCheck : step.status === 'warning' ? TriangleAlert : step.status === 'failed' ? CircleAlert : SkipForward;
  return (
    <details className="ml-step" data-status={step.status} data-testid="reaction-step">
      <summary>
        <Icon />
        <span className="ml-step__n">{index + 1}</span>
        <span className="ml-step__text">
          <b>{step.title}</b>
          <span>{step.summary}</span>
        </span>
      </summary>
      {step.details.length > 0 ? (
        <ul>
          {step.details.map((detail, i) => (
            <li key={i}>{detail}</li>
          ))}
        </ul>
      ) : (
        <p>Nothing further to report for this step.</p>
      )}
    </details>
  );
}

function Thermo({ result }: { result: ExperimentResult }) {
  const thermo = result.thermo;
  if (!thermo || (thermo.status !== 'ok' && thermo.status !== 'partial')) return null;
  const temperature = `${formatNumber(thermo.temperatureK, 5)} K`;
  const verdict =
    thermo.spontaneity === 'product-favoured'
      ? 'Products are favoured at equilibrium'
      : thermo.spontaneity === 'reactant-favoured'
        ? 'Reactants are favoured at equilibrium'
        : thermo.spontaneity === 'near-equilibrium'
          ? 'Neither side is clearly favoured'
          : null;
  return (
    <Section title="Thermodynamics" right={<EvidenceBadge level={thermo.evidence} />}>
      <dl className="ml-kv" data-testid="reaction-thermo">
        {thermo.deltaH && (
          <>
            <dt>ΔH° (298.15 K)</dt>
            <dd className="ml-mono" data-testid="delta-h">
              {quantityText(thermo.deltaH)} kJ/mol
            </dd>
          </>
        )}
        {thermo.deltaS && (
          <>
            <dt>ΔS° (298.15 K)</dt>
            <dd className="ml-mono">{quantityText(thermo.deltaS)} J/(mol·K)</dd>
          </>
        )}
        {thermo.deltaG && (
          <>
            <dt>ΔG° ({temperature})</dt>
            <dd className="ml-mono" data-testid="delta-g">
              {quantityText(thermo.deltaG)} kJ/mol
            </dd>
          </>
        )}
        {thermo.log10K !== undefined && (
          <>
            <dt>log₁₀ K ({temperature})</dt>
            <dd className="ml-mono" data-testid="log-k">
              {minus(thermo.log10K.toFixed(Math.abs(thermo.log10K) < 100 ? 2 : 1))}
            </dd>
          </>
        )}
        {thermo.equilibriumConstant !== undefined && (
          <>
            <dt>K</dt>
            <dd className="ml-mono">{formatNumber(thermo.equilibriumConstant, 3)}</dd>
          </>
        )}
      </dl>
      {verdict && (
        <p className="ml-empty" style={{ color: 'var(--text-2)' }}>
          {verdict} with every species in its standard state. This says where the reaction would settle, not how fast it gets there, or whether it starts at all.
        </p>
      )}
      {thermo.deltaH && thermo.deltaH.uncertainty === undefined && <p className="ml-empty">At least one reference value has no stated uncertainty, so none is given for the sums.</p>}
    </Section>
  );
}

function Kinetics({ result }: { result: ExperimentResult }) {
  const model = result.kineticModel;
  if (!model) return null;
  const k = result.rateConstant;
  const run = result.kinetics;
  const [low, high] = model.validTemperatureRangeK;
  return (
    <Section title="Kinetics" right={<EvidenceBadge level={run?.evidence ?? (k?.withinValidatedRange ? 'computed' : 'rule-based')} />}>
      <div className="ml-eq" data-testid="rate-law">
        {model.rateLaw.description}
      </div>
      <dl className="ml-kv" data-testid="reaction-kinetics">
        {k && (
          <>
            <dt>k ({formatNumber(result.input.conditions.temperatureK, 5)} K)</dt>
            <dd className="ml-mono" data-testid="rate-constant">
              {formatNumber(k.k.value, 3)} {formatUnit(k.k.unit)}
            </dd>
          </>
        )}
        {k?.log10Uncertainty !== undefined && (
          <>
            <dt>Uncertainty of k</dt>
            <dd>
              a factor of <span className="ml-mono">{formatNumber(10 ** k.log10Uncertainty, 2)}</span>
            </dd>
          </>
        )}
        <dt>Validated range</dt>
        <dd className="ml-mono">
          {low}–{high} K
        </dd>
        {run?.halfLife && (
          <>
            <dt>
              Half-life of <ChemText text={run.halfLife.species} />
            </dt>
            <dd className="ml-mono" data-testid="half-life">
              {formatDuration(run.halfLife.seconds)}
            </dd>
          </>
        )}
        {run && run.status !== 'unsupported' && (
          <>
            <dt>Integration</dt>
            <dd data-testid="integration">{run.status === 'ok' ? `converged in ${run.solver.steps} steps` : `stopped early (${run.solver.stopReason ?? 'incomplete'})`}</dd>
          </>
        )}
      </dl>
      {k?.log10Uncertainty !== undefined && <p className="ml-empty">The uncertainty is the source’s reliability estimate, about a 95 % confidence limit.</p>}
      {model.conditions && <p className="ml-empty">Conditions of the rate expression: {model.conditions}</p>}
      {run?.status === 'unsupported' && run.reasons.map((reason, i) => <Note key={i} severity="warning">{reason}</Note>)}
    </Section>
  );
}

const ORIGIN_LABEL: Readonly<Record<string, string>> = {
  'single-atom': 'single atom',
  'pubchem-3d': 'PubChem3D conformer',
  'pubchem-bonding-uff': 'PubChem bonding, UFF geometry',
  'example-library': 'example library',
};

/** Where each molecule drawn in the chamber comes from, and which species could not be drawn. */
function SpeciesModels() {
  const plan = useReaction((s) => s.plan);
  const structures = useReaction((s) => s.structures);
  if (!plan) return null;
  return (
    <details className="ml-details" data-testid="species-models">
      <summary>3D models in the chamber</summary>
      <div className="ml-list" style={{ marginTop: 7 }}>
        {plan.species.map((s) => {
          const lookup = structures[s.key];
          return (
            <div key={s.key} className="ml-source">
              <b>
                <ChemText text={s.key} /> · {s.structure ? ORIGIN_LABEL[s.structure.origin] : 'not drawn'}
              </b>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5 }}>{s.structure ? s.structure.note : lookup && !lookup.ok ? lookup.reason : ''}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ResultTabBody({ result }: { result: ExperimentResult }) {
  const status = STATUS[result.status];
  return (
    <>
      <div>
        <div className="ml-statusline" data-tone={status.tone} data-testid="reaction-status">
          <b>{status.label}</b>
          <EvidenceBadge level={result.evidence} />
        </div>
        {result.equation ? (
          <div className="ml-equation-hero" data-testid="reaction-equation">
            <EquationText text={result.equation.text} />
          </div>
        ) : (
          <p className="ml-empty" style={{ marginTop: 6 }}>
            {result.balance?.message ?? status.text}
          </p>
        )}
      </div>
      <Thermo result={result} />
      <Kinetics result={result} />
      <SpeciesModels />
      <Section title="How this was obtained">
        <div className="ml-list">
          {result.steps.map((step, i) => (
            <StepRow key={step.id} step={step} index={i} />
          ))}
        </div>
      </Section>
      {result.warnings.length > 0 && (
        <Section title={`Warnings · ${result.warnings.length}`}>
          <div className="ml-list" data-testid="reaction-warnings">
            {result.warnings.map((warning, i) => (
              <Note key={i} severity="warning">
                {warning}
              </Note>
            ))}
          </div>
        </Section>
      )}
      {result.limitations.length > 0 && (
        <Section title={`Limitations · ${result.limitations.length}`}>
          <ul className="ml-bullets" data-testid="reaction-limitations">
            {result.limitations.map((limitation, i) => (
              <li key={i}>{limitation}</li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function ArrheniusChart({ result }: { result: ExperimentResult }) {
  const model = result.kineticModel;
  const data = useMemo(() => {
    if (!model) return null;
    const [low, high] = model.validTemperatureRangeK;
    const n = 60;
    const temperatures = Float64Array.from({ length: n }, (_, i) => low + ((high - low) * i) / (n - 1));
    const values = Float64Array.from(temperatures, (t) => rateConstant(model, t).k.value);
    return { temperatures, values };
  }, [model]);
  if (!model || !data) return null;
  const t = result.input.conditions.temperatureK;
  const inside = t >= model.validTemperatureRangeK[0] && t <= model.validTemperatureRangeK[1];
  return (
    <Section title="Rate constant against temperature" right={<EvidenceBadge level="computed" />}>
      <LineChart
        x={data.temperatures}
        series={[{ id: 'k', name: 'rate constant', label: 'k', values: data.values, color: '#FFB66B' }]}
        xLabel="temperature"
        xUnit="K"
        yLabel="k"
        yUnit={model.arrhenius.AUnits}
        height={150}
        cursor={inside ? t : null}
        testId="arrhenius-chart"
      />
      <p className="ml-empty">
        The evaluated Arrhenius expression over the range the source recommends it for ({model.validTemperatureRangeK[0]}–{model.validTemperatureRangeK[1]} K).
        {inside ? ' The line marks this experiment.' : ' This experiment lies outside that range.'}
      </p>
    </Section>
  );
}

function GraphsTabBody({ result }: { result: ExperimentResult }) {
  const frame = useReaction((s) => s.frame);
  const [logScale, setLogScale] = useState(false);
  const run = result.kinetics && result.kinetics.times.length > 1 ? result.kinetics : null;
  const diagrams = result.energyDiagrams.filter((d) => d.levels.length > 0);
  const notes = result.energyDiagrams.flatMap((d) => d.notes);
  return (
    <>
      {run ? (
        <>
          <Section
            title="Concentration against time"
            right={
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Button size="sm" active={logScale} onClick={() => setLogScale((v) => !v)} tip="Logarithmic concentration axis" tipPos="top-end">
                  log
                </Button>
                <EvidenceBadge level={run.evidence} />
              </span>
            }
          >
            <LineChart
              x={run.times}
              series={run.species.map((formula) => ({ id: formula, name: formula, label: <ChemText text={formula} />, values: run.concentrations[formula]! }))}
              xLabel="time"
              xUnit="s"
              yLabel="concentration"
              yUnit={run.concentrationUnit}
              logY={logScale}
              cursor={run.times[Math.min(run.times.length - 1, frame)]}
              onScrub={seekTime}
              testId="concentration-chart"
            />
            <p className="ml-empty">Integrated from the rate law. Drag in the plot to move the timeline; click a name to hide a curve.</p>
          </Section>
          <Section title="Rate of reaction" right={<EvidenceBadge level={run.evidence} />}>
            <LineChart
              x={run.times}
              series={[{ id: 'rate', name: 'rate of reaction', label: 'rate', values: run.rates, color: '#8C92FC' }]}
              xLabel="time"
              xUnit="s"
              yLabel="rate"
              yUnit={run.rateUnit}
              height={140}
              cursor={run.times[Math.min(run.times.length - 1, frame)]}
              onScrub={seekTime}
              testId="rate-chart"
            />
          </Section>
        </>
      ) : (
        <Note severity="info">
          There is no concentration–time curve for this experiment: {result.kineticModel ? 'the simulation did not produce one.' : 'no sourced rate law exists for this reaction, and none is invented.'}
        </Note>
      )}
      <ArrheniusChart result={result} />
      {diagrams.map((diagram) => (
        <Section
          key={diagram.quantity}
          title={diagram.quantity === 'enthalpy' ? 'Enthalpy levels' : 'Gibbs energy levels'}
          right={<EvidenceBadge level={diagram.levels.some((l) => l.evidence === 'rule-based') ? 'rule-based' : 'computed'} />}
        >
          <EnergyLevels
            levels={diagram.levels.map((level) => ({ kind: level.kind, value: level.value, label: LEVEL_NAMES[level.kind] }))}
            unit={diagram.unit}
            quantityLabel={diagram.quantity === 'enthalpy' ? 'ΔH' : 'ΔG'}
            testId={`energy-${diagram.quantity}`}
          />
          <dl className="ml-notes">
            {diagram.levels.map((level) => (
              <div key={level.kind}>
                <dt>{level.label}</dt>
                {level.note && <dd>{level.note}</dd>}
              </div>
            ))}
          </dl>
          <p className="ml-empty">The levels are data. The dashed lines that join them only guide the eye: no reaction path was computed.</p>
        </Section>
      ))}
      {notes.length > 0 && (
        <div className="ml-list">
          {notes.map((note, i) => (
            <Note key={i} severity="info">
              {note}
            </Note>
          ))}
        </div>
      )}
    </>
  );
}

function ExplainTabBody({ result }: { result: ExperimentResult }) {
  const level = useLab((s) => s.explainLevel);
  return (
    <>
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
      <ExplanationView explanation={{ title: '', sections: result.explanation[level], references: result.explanation.references }} />
    </>
  );
}

function CompareTable({ records }: { records: readonly ExperimentSummary[] }) {
  const rows: Array<[string, (r: ExperimentSummary) => string]> = [
    ['Temperature / K', (r) => formatNumber(r.temperatureK, 5)],
    ['ΔH° / kJ mol⁻¹', (r) => (r.deltaH === null ? '—' : minus(r.deltaH.toFixed(1)))],
    ['ΔG° / kJ mol⁻¹', (r) => (r.deltaG === null ? '—' : minus(r.deltaG.toFixed(1)))],
    ['log₁₀ K', (r) => (r.log10K === null ? '—' : minus(r.log10K.toFixed(2)))],
    ['k', (r) => (r.rateConstant === null ? '—' : `${formatNumber(r.rateConstant, 3)}`)],
    ['Half-life', (r) => (r.halfLifeSeconds === null ? '—' : formatDuration(r.halfLifeSeconds))],
  ];
  return (
    <div className="ml-compare ml-scroll" data-testid="reaction-compare">
      <table>
        <thead>
          <tr>
            <th />
            {records.map((r) => (
              <th key={r.id} title={r.equation ?? undefined}>
                {r.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <th>{name}</th>
              {records.map((r) => (
                <td key={r.id}>{value(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordTabBody({ result }: { result: ExperimentResult | null }) {
  const saved = useReaction((s) => s.saved);
  const savedId = useReaction((s) => s.savedId);
  const compare = useReaction((s) => s.compare);
  const reproduction = useReaction((s) => s.reproduction);
  const running = useReaction((s) => s.running);
  useEffect(() => void refreshSaved(), []);
  const compared = compare.map((id) => saved.find((r) => r.id === id)).filter((r): r is ExperimentSummary => !!r);
  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void importExperimentFile(file);
    };
    input.click();
  };

  return (
    <>
      {result && (
        <Section title="Reproducibility record">
          <dl className="ml-kv">
            <dt>Engine</dt>
            <dd className="ml-mono">
              {result.reproducibility.engine} {result.reproducibility.engineVersion}
            </dd>
            <dt>Input hash (SHA-256)</dt>
            <dd className="ml-mono" title={result.inputHash} data-testid="input-hash">
              {result.inputHash.slice(0, 16)}…
            </dd>
            <dt>Deterministic</dt>
            <dd>yes</dd>
            {result.reproducibility.solver && (
              <>
                <dt>Integration</dt>
                <dd className="ml-mono">
                  {result.reproducibility.solver.steps} steps · tolerance {formatNumber(result.reproducibility.solver.tolerance, 1)}
                </dd>
              </>
            )}
          </dl>
          <p className="ml-empty">
            The same inputs always give the same numbers, so the record can be checked by running it again.
            {result.reproducibility.solver ? ` Integrator: ${result.reproducibility.solver.method}.` : ''}
          </p>
          <div className="ml-actions">
            <Button size="sm" variant="primary" onClick={() => void saveExperiment()} data-testid="reaction-save">
              <Save /> {savedId ? 'Save again' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={exportExperiment} data-testid="reaction-export">
              <Download /> Export record
            </Button>
            <Button size="sm" variant="outline" disabled={running || reproduction?.status === 'running'} onClick={() => void reproduce()} data-testid="reaction-reproduce">
              <Repeat2 /> Reproduce
            </Button>
          </div>
          {reproduction && reproduction.status !== 'running' && (
            <Note severity={reproduction.status === 'identical' ? 'info' : 'warning'}>
              <span data-testid="reproduction">
                {reproduction.status === 'identical' ? 'Reproduced exactly. ' : reproduction.status === 'different' ? 'The result differs from the record. ' : 'The record could not be re-run. '}
                {reproduction.detail}
              </span>
            </Note>
          )}
          {result.reproducibility.dataSources.length > 0 && (
            <details className="ml-details" data-testid="data-sources">
              <summary>Data sources · {result.reproducibility.dataSources.length}</summary>
              <div className="ml-list" style={{ marginTop: 7 }}>
                {result.reproducibility.dataSources.map((source) => (
                  <div key={source.id} className="ml-source">
                    <b>{source.title}</b>
                    <span className="ml-mono">
                      {source.retrieved ? `retrieved ${source.retrieved}` : ''}
                      {source.sha256 ? ` · sha256 ${source.sha256.slice(0, 12)}…` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Section>
      )}
      <Section
        title={`Saved experiments · ${saved.length}`}
        right={
          <Button size="sm" onClick={pickFile}>
            <FolderInput /> Open file
          </Button>
        }
      >
        {saved.length === 0 ? (
          <p className="ml-empty">Nothing saved yet. A saved experiment keeps its inputs, settings, results and sources, and can be reopened, re-run and compared.</p>
        ) : (
          <div className="ml-list" data-testid="saved-experiments">
            {saved.map((record) => (
              <div key={record.id} className="ml-saved" data-current={record.id === savedId}>
                <button type="button" className="ml-saved__main" onClick={() => void openExperiment(record.id)}>
                  <b>{record.title}</b>
                  <span>{record.equation ? <EquationText text={record.equation} /> : STATUS[record.status].label}</span>
                  <span className="ml-mono">{new Date(record.savedAt).toLocaleString()}</span>
                </button>
                <IconButton size="sm" tip="Include in the comparison" tipPos="top-end" active={compare.includes(record.id)} onClick={() => toggleCompare(record.id)}>
                  <Check />
                </IconButton>
                <IconButton size="sm" variant="danger" tip="Delete from the library" tipPos="top-end" onClick={() => void deleteExperiment(record.id)}>
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        {compared.length >= 2 ? (
          <CompareTable records={compared} />
        ) : (
          saved.length >= 2 && <p className="ml-empty">Tick two or more experiments to compare their results side by side.</p>
        )}
      </Section>
    </>
  );
}

/** Right panel of the Reaction Laboratory: results, graphs, explanation and the experiment record. */
export function ResultsPanel() {
  const open = useLab((s) => s.inspectorOpen);
  const result = useReaction((s) => s.result);
  const tab = useReaction((s) => s.tab);
  const stale = useReaction(isStale);
  const error = useReaction((s) => s.error);
  if (!open) return null;
  return (
    <div className="ml-right">
      <aside className="ml-panel ml-inspector" aria-label="Experiment results" data-testid="reaction-results">
        <div className="ml-inspector__tabs">
          <Segmented<ResultTab>
            label="Results section"
            fill
            value={tab}
            onChange={setTab}
            options={[
              { value: 'result', label: 'Result' },
              { value: 'graphs', label: 'Graphs' },
              { value: 'explain', label: 'Explain' },
              { value: 'record', label: 'Record' },
            ]}
          />
          <IconButton size="sm" tip="Hide results" tipPos="bottom-end" onClick={() => lab.set({ inspectorOpen: false })}>
            <ChevronRight />
          </IconButton>
        </div>
        <div className="ml-inspector__body ml-scroll">
          {error && (
            <Note severity="error">
              The calculation failed: {error}
            </Note>
          )}
          {stale && tab !== 'record' && (
            <Note severity="warning">
              <span data-testid="reaction-stale">The experiment was changed after this result was calculated. Run it again to bring the result up to date.</span>
            </Note>
          )}
          {tab === 'record' ? (
            <RecordTabBody result={result} />
          ) : !result ? (
            <div data-testid="reaction-empty">
              <div className="ml-hero__title">No result yet</div>
              <p className="ml-empty" style={{ marginTop: 6 }}>
                Choose an example or enter your own species and conditions, then run the experiment. The laboratory balances the equation, looks up reference data, and
                calculates thermodynamics and, where a sourced rate law exists, kinetics. It never predicts products or invents data.
              </p>
            </div>
          ) : tab === 'result' ? (
            <ResultTabBody result={result} />
          ) : tab === 'graphs' ? (
            <GraphsTabBody result={result} />
          ) : (
            <ExplainTabBody result={result} />
          )}
        </div>
      </aside>
    </div>
  );
}

import { LineChart } from '../../../ui/charts';
import type { NotebookData } from '../notebook';
import { EvidenceTag, formatMl } from './evidence';

/**
 * The mini-lab notebook: trial table, pH-vs-volume curves and a conclusion. Every number here is
 * read directly off `NotebookData` — nothing is computed in this component.
 */
export function NotebookView({ notebook, onExport }: { notebook: NotebookData | null; onExport: () => void }) {
  if (!notebook) return <p className="lc-muted">Complete at least one trial to generate the lab notebook.</p>;
  return (
    <div className="lc-notebook">
      <header className="lc-notebook__head">
        <h3>{notebook.objectiveTitle}</h3>
        <button type="button" className="lc-btn" onClick={onExport}>
          Export notebook (JSON)
        </button>
      </header>

      <table className="lc-table">
        <thead>
          <tr>
            <th>Trial</th>
            <th>Delivered (mL)</th>
            <th>Equivalence (mL)</th>
            <th>Deviation (mL)</th>
            <th>Reported molarity (mol/L)</th>
            <th>Expected molarity (mol/L)</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {notebook.rows.map((row) => (
            <tr key={row.trialId}>
              <td>{row.index}</td>
              <td>{formatMl(row.deliveredVolumeL)}</td>
              <td>{formatMl(row.equivalenceVolumeL)}</td>
              <td>{formatMl(row.deviationL)}</td>
              <td>{row.reportedAnalyteMolarity !== null ? row.reportedAnalyteMolarity.toFixed(4) : '\u2014'}</td>
              <td>{row.expectedAnalyteMolarity !== null ? row.expectedAnalyteMolarity.toFixed(4) : '\u2014'}</td>
              <td>
                <EvidenceTag level={row.evidence} />
              </td>
            </tr>
          ))}
          {notebook.rows.length === 0 && (
            <tr>
              <td colSpan={7} className="lc-muted">
                No trials recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {notebook.meanVolumeL !== null && (
        <p className="lc-muted">
          Mean endpoint volume {formatMl(notebook.meanVolumeL)} mL
          {notebook.rsdPercent !== null ? `, relative standard deviation ${notebook.rsdPercent.toFixed(2)}%` : ''}.
        </p>
      )}

      <EquivalenceVsEndpointNote notebook={notebook} />

      <div className="lc-notebook__curves">
        {notebook.curves.map(
          (curve) =>
            curve.points.length > 0 && (
              <div key={curve.trialId} className="lc-notebook__curve">
                <span className="lc-label">
                  Trial {curve.trialIndex} pH curve <EvidenceTag level={curve.evidence} />
                </span>
                <LineChart
                  x={curve.points.map((p) => p.volumeL * 1000)}
                  series={[{ id: 'ph', label: 'pH', name: `Trial ${curve.trialIndex} pH`, values: curve.points.map((p) => p.ph) }]}
                  xLabel="Volume delivered"
                  xUnit="mL"
                  yLabel="pH"
                  height={170}
                />
              </div>
            ),
        )}
      </div>

      <section className="lc-notebook__conclusion">
        <h4>
          {notebook.conclusion.headline} <EvidenceTag level={notebook.conclusion.evidence} />
        </h4>
        {notebook.conclusion.paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>
    </div>
  );
}

/**
 * Explicitly teaches the distinction the brief names: the equivalence point is a computed fact
 * about the chemistry (moles of acid and base exactly balanced); the endpoint is what the learner
 * *observed* (an indicator colour change). They differ because real indicators change colour over
 * a pH range, not at one exact point. Uses the learner's own measured numbers when available.
 */
function EquivalenceVsEndpointNote({ notebook }: { notebook: NotebookData }) {
  const measured = notebook.rows.find((r) => r.deliveredVolumeL !== null && r.equivalenceVolumeL !== null);
  return (
    <section className="lc-notebook__concept">
      <h4>Equivalence point vs. endpoint</h4>
      <p>
        The <strong>equivalence point</strong> is where the moles of acid and base added are chemically equal — a computed fact about the solution, not something you can see directly. The{' '}
        <strong>endpoint</strong> is what you actually observed and marked: the volume where the indicator changed colour. They are rarely identical, because real indicators change colour over a
        pH range, not at one exact pH.
      </p>
      {measured && measured.deliveredVolumeL !== null && measured.equivalenceVolumeL !== null && measured.deviationL !== null ? (
        <p>
          In trial {measured.index}, you marked the endpoint at {formatMl(measured.deliveredVolumeL)} mL. The solver's computed equivalence point was {formatMl(measured.equivalenceVolumeL)} mL — a
          difference of {formatMl(measured.deviationL)} mL.
        </p>
      ) : (
        <p className="lc-muted">Mark an endpoint to see your own measured endpoint compared with the computed equivalence point here.</p>
      )}
    </section>
  );
}

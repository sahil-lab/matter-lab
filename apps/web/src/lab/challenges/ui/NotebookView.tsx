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

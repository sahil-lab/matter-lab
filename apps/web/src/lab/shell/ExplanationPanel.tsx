import { Eyebrow, Segmented, StatePanel, TabPanel, Tabs } from '../../design-system';
import type { RunResult } from './contracts';
import type { AstraExplainLevel, AstraExplainTab } from './store';

const TAB_LABELS: Readonly<Record<AstraExplainTab, string>> = {
  method: 'Method',
  assumptions: 'Assumptions',
  limitations: 'Limitations',
  references: 'References',
  diagnostics: 'Diagnostics',
};

function DiagnosticsTable({ diagnostics }: { diagnostics: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(diagnostics);
  if (entries.length === 0) return <p className="astra-explain__empty">No solver diagnostics were reported with this run.</p>;
  return (
    <div className="astra-proprow-list">
      {entries.map(([key, value]) => (
        <div className="astra-proprow" key={key}>
          <span className="astra-proprow__label">{key}</span>
          <span className="astra-proprow__value astra-mono">{typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The scientific explanation panel (brief §"Required implementation" 6): method, assumptions,
 * limitations, references and diagnostics, with a beginner/advanced depth toggle. It renders only
 * what a `RunResult` actually carries — when `run` is `null` (no connected solver yet) or
 * `UNSUPPORTED`, it says so plainly instead of inventing an equation or a number.
 */
export function ExplanationPanel({
  run,
  tab,
  onTabChange,
  level,
  onLevelChange,
}: {
  run: RunResult | null;
  tab: AstraExplainTab;
  onTabChange: (tab: AstraExplainTab) => void;
  level: AstraExplainLevel;
  onLevelChange: (level: AstraExplainLevel) => void;
}) {
  if (!run) {
    return (
      <StatePanel
        kind="empty"
        title="No run to explain yet"
        detail="Once a station runs a supported calculation (Agent 06/07), its method, assumptions, limitations, references and diagnostics appear here."
      />
    );
  }
  if (run.status === 'UNSUPPORTED') {
    return (
      <StatePanel
        kind="unsupported"
        title="This configuration is not scientifically supported"
        detail={run.warnings[0] ?? 'The assembled apparatus or chemical system falls outside the validated models for this lab.'}
      />
    );
  }

  const references = Array.isArray(run.solverDiagnostics?.references) ? (run.solverDiagnostics!.references as unknown[]).map(String) : [];

  return (
    <div className="astra-explain">
      <div className="astra-explain__head">
        <Eyebrow>Depth</Eyebrow>
        <Segmented<AstraExplainLevel>
          label="Explanation depth"
          value={level}
          onChange={onLevelChange}
          options={[
            { value: 'simple', label: 'Simple' },
            { value: 'advanced', label: 'Advanced' },
          ]}
        />
      </div>
      <Tabs<AstraExplainTab>
        idPrefix="astra-explain"
        label="Explanation section"
        value={tab}
        onChange={onTabChange}
        items={(Object.keys(TAB_LABELS) as AstraExplainTab[]).map((id) => ({ value: id, label: TAB_LABELS[id] }))}
      />
      <div className="astra-explain__body astra-scroll">
        <TabPanel id="astra-explain-panel-method" tabId="astra-explain-tab-method" active={tab === 'method'}>
          <p>
            Method <strong className="astra-mono">{run.methodId}</strong>
            {level === 'advanced' && <span className="astra-mono astra-text-3"> · v{run.methodVersion}</span>}.
          </p>
          {level === 'advanced' && <p className="astra-mono astra-text-3">input hash {run.inputHash} · run {run.runId}</p>}
          <p className="astra-explain__empty">
            The governing equations for this method are published by Agent 06 alongside the solver; this panel renders whatever it reports rather than restating chemistry here.
          </p>
        </TabPanel>
        <TabPanel id="astra-explain-panel-assumptions" tabId="astra-explain-tab-assumptions" active={tab === 'assumptions'}>
          {run.assumptions.length > 0 ? (
            <ul className="astra-explain__list">
              {run.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : (
            <p className="astra-explain__empty">No assumptions were reported with this run.</p>
          )}
        </TabPanel>
        <TabPanel id="astra-explain-panel-limitations" tabId="astra-explain-tab-limitations" active={tab === 'limitations'}>
          {run.warnings.length > 0 ? (
            <ul className="astra-explain__list">
              {run.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : (
            <p className="astra-explain__empty">No limitations were reported with this run.</p>
          )}
        </TabPanel>
        <TabPanel id="astra-explain-panel-references" tabId="astra-explain-tab-references" active={tab === 'references'}>
          {references.length > 0 ? (
            <ul className="astra-explain__list">
              {references.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="astra-explain__empty">
              This run did not carry citation data. The shared contract&rsquo;s <span className="astra-mono">RunResult</span> has no references field yet — Agent 06/10 should extend it (or populate{' '}
              <span className="astra-mono">solverDiagnostics.references</span>) so this tab can show real sources.
            </p>
          )}
        </TabPanel>
        <TabPanel id="astra-explain-panel-diagnostics" tabId="astra-explain-tab-diagnostics" active={tab === 'diagnostics'}>
          <DiagnosticsTable diagnostics={run.solverDiagnostics ?? {}} />
        </TabPanel>
      </div>
    </div>
  );
}

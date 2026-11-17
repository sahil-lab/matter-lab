import { Droplets } from 'lucide-react';
import { EvidenceBadge, Panel, PanelHeader, ProgressBar, StatePanel, StatusBadge } from '../../design-system';
import type { TitrationHudData } from './contracts';

/** Liters to a millilitre reading with two decimal places — unit conversion/display only, never a computed quantity. */
function mL(valueL: number): string {
  return `${(valueL * 1000).toFixed(2)} mL`;
}

/**
 * The adaptable titration HUD (brief §"Required implementation" 5): delivered volume, burette
 * remaining volume, pH, indicator legend, equivalence/endpoint status and evidence. Every number
 * comes from `TitrationHudData`, itself only ever derived from a `RunResult`/`Observation[]` by
 * {@link deriveTitrationHudData} (see `contracts.ts`) — this component computes nothing.
 */
export function TitrationHud({ data, onPreviewSampleData }: { data: TitrationHudData; onPreviewSampleData?: () => void }) {
  if (data.connectionStatus === 'disconnected') {
    return (
      <Panel elevation="raised" className="astra-hud" aria-label="Titration HUD">
        <PanelHeader eyebrow="Live readout" title="Titration HUD" right={<StatusBadge tone="neutral">Disconnected</StatusBadge>} />
        <StatePanel
          kind="empty"
          title="No simulation connected"
          detail="Agent 02/03/04 (scene and apparatus) and Agent 06/07 (chemistry and runtime) are not wired into this worktree yet."
          action={
            onPreviewSampleData && (
              <button type="button" className="astra-link-btn" onClick={onPreviewSampleData} data-testid="astra-preview-sample">
                Preview with watermarked sample data
              </button>
            )
          }
        />
      </Panel>
    );
  }
  if (data.connectionStatus === 'unsupported') {
    return (
      <Panel elevation="raised" className="astra-hud" aria-label="Titration HUD">
        <PanelHeader eyebrow="Live readout" title="Titration HUD" right={<StatusBadge tone="warning">Unsupported</StatusBadge>} />
        <StatePanel kind="unsupported" title="This setup is not scientifically supported" detail={data.warnings[0] ?? 'No validated model covers the current apparatus or chemical configuration.'} />
      </Panel>
    );
  }

  const buretteFraction = data.buretteRemainingL !== null && data.buretteCapacityL ? data.buretteRemainingL / data.buretteCapacityL : null;
  const phFraction = data.ph ? Math.max(0, Math.min(1, data.ph.value / 14)) : null;

  return (
    <Panel elevation="raised" className="astra-hud" aria-label="Titration HUD">
      <PanelHeader eyebrow="Live readout" title="Titration HUD" right={<StatusBadge tone="ok">Connected</StatusBadge>} />

      <div className="astra-hud__grid">
        <div className="astra-hud__metric">
          <span className="astra-hud__metric-label">Delivered</span>
          <span className="astra-hud__metric-value astra-mono">{data.deliveredVolumeL !== null ? mL(data.deliveredVolumeL) : '—'}</span>
        </div>
        <div className="astra-hud__metric">
          <span className="astra-hud__metric-label">Burette remaining</span>
          <span className="astra-hud__metric-value astra-mono">{data.buretteRemainingL !== null ? mL(data.buretteRemainingL) : '—'}</span>
          {buretteFraction !== null && <ProgressBar progress={buretteFraction} tone="cool" />}
        </div>
      </div>

      <div className="astra-hud__ph">
        <div>
          <span className="astra-hud__metric-label">pH</span>
          <div className="astra-hud__ph-value astra-mono">{data.ph ? data.ph.value.toFixed(2) : '—'}</div>
        </div>
        {data.phEvidence && <EvidenceBadge level={data.phEvidence} />}
      </div>
      {phFraction !== null && (
        <div className="astra-hud__phscale" aria-hidden>
          <i style={{ left: `${phFraction * 100}%` }} />
        </div>
      )}

      <div className="astra-hud__indicator">
        <Droplets aria-hidden />
        {data.indicator ? (
          <>
            <span className="astra-hud__swatch" style={{ background: data.indicator.colorHex }} aria-hidden />
            <span>{data.indicator.label}</span>
            <EvidenceBadge level={data.indicator.evidence} />
          </>
        ) : (
          <span className="astra-text-3">No indicator selected</span>
        )}
      </div>

      <div className="astra-hud__equivalence">
        <div>
          <span className="astra-hud__metric-label">Equivalence (model)</span>
          <span className="astra-mono">{data.equivalenceVolumeL !== null ? mL(data.equivalenceVolumeL) : 'not yet reached'}</span>
        </div>
        <div>
          <span className="astra-hud__metric-label">Endpoint (observed)</span>
          <span className="astra-mono">{data.endpointVolumeL !== null ? mL(data.endpointVolumeL) : 'not yet captured'}</span>
        </div>
      </div>
      <p className="astra-hud__note">Equivalence is the model&rsquo;s stoichiometric point; the endpoint is where the indicator visibly changes. They can differ.</p>

      {data.warnings.length > 0 && <p className="astra-hud__warning">{data.warnings[0]}</p>}
      {data.sourceIds.length > 0 && <p className="astra-hud__sources astra-mono">sources: {data.sourceIds.join(', ')}</p>}
    </Panel>
  );
}

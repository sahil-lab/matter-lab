import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { startQuantumWatch } from './compute/quantum';
import { startComputeWatch } from './compute/store';
import { ChamberControls, ChamberLegend } from './reaction/ChamberBar';
import { ReactionLab } from './reaction/ReactionLab';
import { MatterCanvas, getDeviceInfo } from './render/MatterCanvas';
import { recommendQuality } from './render/quality';
import { NucleusDialog } from './nucleus/NucleusDialog';
import { startChemistryWatch } from './science/chem';
import { dismissToast, notify } from './state/actions';
import { importFile } from './state/commands';
import { startAutosave } from './state/persistence';
import { lab, useLab } from './state/store';
import { ExportDialog, LibraryDialog, PeriodicTableDialog, ShortcutsDialog } from './ui/Dialogs';
import { FieldLegend } from './ui/FieldLegend';
import { Inspector } from './ui/inspector/Inspector';
import { IconButton } from './ui/kit';
import { ContextBar, ToolRail } from './ui/Tools';
import { TopBar } from './ui/TopBar';
import { AxisGizmo, PerfHud, ScaleBar, ViewBar } from './ui/ViewControls';
import { VaultBanner, VaultLab } from './vault/VaultLab';

const TOAST_ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

function Toasts() {
  const toasts = useLab((s) => s.toasts);
  return (
    <div className="ml-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICONS[toast.kind];
        return (
          <div key={toast.id} className="ml-panel ml-toast" data-kind={toast.kind} data-testid="toast">
            <Icon />
            <div style={{ minWidth: 0 }}>
              <div className="ml-toast__title">{toast.title}</div>
              {toast.detail && <div className="ml-toast__detail">{toast.detail}</div>}
            </div>
            <IconButton size="sm" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
              <X />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

export function App({ hasQualityPreference }: { hasQualityPreference: boolean }) {
  const dialog = useLab((s) => s.dialog);
  const showPerf = useLab((s) => s.showPerf);
  const inspectorOpen = useLab((s) => s.inspectorOpen);
  const workspace = useLab((s) => s.workspace);
  const sidePanelOpen = useLab((s) => s.sidePanelOpen);
  const [dropping, setDropping] = useState(false);

  useEffect(() => startAutosave(), []);
  useEffect(() => startChemistryWatch(), []);
  useEffect(() => startComputeWatch(), []);
  useEffect(() => startQuantumWatch(), []);

  // On first launch, start from the preset that suits this device; the user's own choice is kept afterwards.
  useEffect(() => {
    if (hasQualityPreference) return;
    const timer = window.setInterval(() => {
      const device = getDeviceInfo();
      if (!device) return;
      window.clearInterval(timer);
      const recommended = recommendQuality(device);
      if (recommended !== lab.get().quality) lab.set({ quality: recommended });
    }, 150);
    return () => window.clearInterval(timer);
  }, [hasQualityPreference]);

  return (
    <div
      className="ml-app"
      data-inspector={inspectorOpen ? 'open' : 'closed'}
      data-workspace={workspace}
      data-side={workspace !== 'architect' && sidePanelOpen ? 'open' : 'closed'}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (file) void importFile(file, 'insert').catch(() => notify('error', 'That file could not be read'));
      }}
    >
      <MatterCanvas />
      <div className="ml-overlay">
        <TopBar>{workspace === 'reactions' ? <ChamberLegend /> : workspace === 'vault' ? <VaultBanner /> : null}</TopBar>
        {workspace === 'architect' && (
          <>
            <ToolRail />
            <Inspector />
            {/* What the stage is showing besides the structure: legends of computed fields, and the performance read-out. */}
            <div className="ml-stage-info">
              <FieldLegend />
              {showPerf && <PerfHud />}
            </div>
          </>
        )}
        {workspace === 'reactions' && <ReactionLab />}
        {workspace === 'vault' && <VaultLab />}
        <div className="ml-gizmo-slot">
          <AxisGizmo />
        </div>
        <div className="ml-bottom">
          <div className="ml-bottom__side">
            <ScaleBar />
          </div>
          <div className="ml-bottom__center">{workspace === 'architect' ? <ContextBar /> : workspace === 'reactions' ? <ChamberControls /> : null}</div>
          <div className="ml-bottom__side ml-bottom__side--end">
            <ViewBar />
          </div>
        </div>
        {showPerf && workspace !== 'architect' && <PerfHud />}
        <Toasts />
        {dropping && (
          <div className="ml-scrim" style={{ pointerEvents: 'none' }}>
            <div className="ml-panel" style={{ padding: '18px 26px', fontSize: 15, fontWeight: 600 }}>
              Drop to add the molecule to this workspace
            </div>
          </div>
        )}
        {dialog === 'periodic-table' && <PeriodicTableDialog />}
        {dialog === 'library' && <LibraryDialog />}
        {dialog === 'export' && <ExportDialog />}
        {dialog === 'shortcuts' && <ShortcutsDialog />}
        {dialog === 'nucleus' && <NucleusDialog />}
      </div>
    </div>
  );
}

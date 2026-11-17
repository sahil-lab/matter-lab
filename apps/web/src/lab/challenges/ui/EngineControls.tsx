import { useState, useSyncExternalStore } from 'react';
import type { RealEngineRuntimeSource } from '../integration/realEngineSource';
import { TITRATION_BENCHMARK } from '../titrationObjective';

/**
 * Manual bench controls for the real `ExperimentEngine` station this surface wires in directly
 * (see `integration/realEngineSource.ts`). Stands in for Agent 02/03/04's real 3D placement,
 * drag-and-drop and stopcock interactions, clearly labelled as such — but every button here
 * dispatches a genuine `LabAction` into Agent 07's real engine and reads back a real observation
 * (Agent 06's real titration solver, or its labelled test double, depending how this runtime was
 * started), so the pH and the whole goal/scoring/notebook pipeline downstream are already real;
 * only the *interaction surface* (a button instead of a dragged 3D burette) is a stand-in.
 */
export function EngineControls({ runtime }: { runtime: RealEngineRuntimeSource }) {
  const readout = useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.readout(),
  );
  const [incrementMl, setIncrementMl] = useState(0.5);

  return (
    <div className="lc-demo">
      <p className="lc-demo__banner">
        Manual bench controls — standing in for Agent 02/03/04's real 3D placement and stopcock interaction until that lands. Every button below dispatches a real action into Agent 07's
        experiment engine; the pH readout comes from whichever real solver client this runtime was started with, never a locally fabricated number.
      </p>
      <div className="lc-demo__grid">
        <button type="button" onClick={() => runtime.placeStand()}>
          Place stand
        </button>
        <button type="button" onClick={() => runtime.placeClamp()}>
          Place clamp
        </button>
        <button type="button" onClick={() => runtime.attachClampToStand()}>
          Attach clamp → stand
        </button>
        <button type="button" onClick={() => runtime.placeBurette()}>
          Place burette
        </button>
        <button type="button" onClick={() => runtime.attachBuretteToClamp()}>
          Attach burette → clamp
        </button>
        <button type="button" onClick={() => runtime.placeFlask()}>
          Place flask
        </button>
        <button type="button" onClick={() => runtime.connectBuretteToFlask()}>
          Connect burette tip → flask
        </button>
        <button type="button" onClick={() => runtime.fillHcl()}>
          Fill flask: {TITRATION_BENCHMARK.aliquotMolarity.toFixed(3)} mol/L HCl
        </button>
        <button type="button" onClick={() => runtime.fillNaoh()}>
          Fill burette: {TITRATION_BENCHMARK.titrantMolarity.toFixed(3)} mol/L NaOH
        </button>
        <button type="button" onClick={() => runtime.setStopcock(0.3)}>
          Open stopcock
        </button>
      </div>
      <div className="lc-demo__titrate">
        <label>
          Increment (mL)
          <input type="number" min={0.1} max={5} step={0.1} value={incrementMl} onChange={(e) => setIncrementMl(Number(e.target.value))} />
        </label>
        <button type="button" onClick={() => runtime.deliverIncrement(incrementMl / 1000)}>
          Deliver {incrementMl} mL
        </button>
        <span className="lc-demo__readout" aria-live="polite">
          Delivered: {(readout.deliveredSinceTrialStartL * 1000).toFixed(2)} mL{readout.latestPh !== null ? `, pH ${readout.latestPh.toFixed(2)}` : ''}
        </span>
        <button type="button" onClick={() => runtime.markEndpoint()} disabled={readout.deliveredSinceTrialStartL <= 0}>
          Mark endpoint here
        </button>
        <button type="button" onClick={() => runtime.startNewTrial()}>
          Start repeat trial
        </button>
        <button type="button" onClick={() => runtime.resetAll()}>
          Reset bench
        </button>
      </div>
    </div>
  );
}

import { useState, useSyncExternalStore } from 'react';
import type { FixtureDemoRuntime } from '../demo';
import { TITRATION_BENCHMARK } from '../titrationObjective';

/**
 * DEMO-ONLY CONTROLS. Stands in for Agent 02/03/04's real 3D placement, drag-and-drop and
 * stopcock interactions, and for Agent 06/07's real chemistry/runtime — clearly labelled so no one
 * mistakes this for the shipping 3D experience. Delete once the real surfaces exist.
 */
export function DemoControls({ runtime }: { runtime: FixtureDemoRuntime }) {
  const snapshot = useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.snapshot(),
  );
  const [incrementMl, setIncrementMl] = useState(0.5);

  return (
    <div className="lc-demo">
      <p className="lc-demo__banner">
        Fixture demo — standing in for the real 3D apparatus (Agents 02–04) and chemistry/runtime (Agents 06–07) until they are integrated. The pH shown uses the same textbook
        strong-acid/strong-base formula as the test fixtures, not a shipped scientific solver.
      </p>
      <div className="lc-demo__grid">
        <button type="button" onClick={() => runtime.placeApparatus('stand')}>
          Place stand
        </button>
        <button type="button" onClick={() => runtime.placeApparatus('clamp')}>
          Place clamp
        </button>
        <button type="button" onClick={() => runtime.attach('clamp', 'stand')}>
          Attach clamp → stand
        </button>
        <button type="button" onClick={() => runtime.placeApparatus('burette')}>
          Place burette
        </button>
        <button type="button" onClick={() => runtime.attach('burette', 'clamp')}>
          Attach burette → clamp
        </button>
        <button type="button" onClick={() => runtime.placeApparatus('flask')}>
          Place flask
        </button>
        <button type="button" onClick={() => runtime.fillHcl()}>
          Fill flask: {TITRATION_BENCHMARK.aliquotMolarity.toFixed(3)} mol/L HCl
        </button>
        <button type="button" onClick={() => runtime.fillNaoh()}>
          Fill burette: {TITRATION_BENCHMARK.titrantMolarity.toFixed(3)} mol/L NaOH
        </button>
        <button type="button" onClick={() => runtime.openStopcock(0.3)}>
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
          Delivered: {(snapshot.deliveredSinceTrialStartL * 1000).toFixed(2)} mL{snapshot.latestPh !== null ? `, pH ${snapshot.latestPh.toFixed(2)}` : ''}
        </span>
        <button type="button" onClick={() => runtime.markEndpoint()} disabled={snapshot.deliveredSinceTrialStartL <= 0}>
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

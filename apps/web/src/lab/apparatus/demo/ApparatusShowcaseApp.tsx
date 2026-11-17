/**
 * Standalone demo harness: a `<Canvas>`, camera controls and an HTML overlay panel listing the
 * live socket-compatibility checks from `sceneAssembly.ts` (the brief's "component demos"
 * deliverable). Mounted by `demo/main.tsx` behind the `apparatus-demo.html` dev-only entry point —
 * nothing here is imported by the shipping application.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useState } from 'react';
import { ApparatusShowcaseScene } from './ApparatusShowcaseScene';
import { buildVerticalSliceAssembly } from './sceneAssembly';

function CheckList() {
  const { checks } = buildVerticalSliceAssembly();
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12, lineHeight: 1.5 }}>
      {checks.map((check) => (
        <li key={check.label} style={{ marginBottom: 6 }}>
          <strong style={{ color: check.compatible ? '#4ade80' : '#f87171' }}>{check.compatible ? '\u2705' : '\u274c'}</strong>{' '}
          <span style={{ opacity: 0.9 }}>{check.label}</span>
          <div style={{ opacity: 0.65, marginLeft: 20 }}>{check.reason}</div>
        </li>
      ))}
    </ul>
  );
}

export function ApparatusShowcaseApp() {
  const [showSockets, setShowSockets] = useState(true);
  const [valve, setValve] = useState(0.35);
  const [speed, setSpeed] = useState(0.6);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#05080e', fontFamily: 'system-ui, sans-serif', color: '#e8edf5' }}>
      <Canvas camera={{ position: [2.6, 2.1, 3.0], fov: 45 }} shadows dpr={[1, 2]}>
        <color attach="background" args={['#05080e']} />
        <ApparatusShowcaseScene showSockets={showSockets} valveOpenFraction={valve} stirrerSpeedFraction={speed} />
        <OrbitControls target={[0.05, 0.85, 0]} makeDefault />
      </Canvas>

      <div style={{ position: 'absolute', top: 16, left: 16, width: 340, background: 'rgba(8,13,24,0.82)', border: '1px solid #233049', borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Agent 03 \u2014 Apparatus Showcase</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
          Bench \u2192 stand \u2192 clamp \u2192 burette; stirrer \u2192 flask under the tip; reagent bottle; pH probe. Every placement below is computed by{' '}
          <code>computeAttachmentPlacement</code>, not hand-tuned per screenshot.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
          <input type="checkbox" checked={showSockets} onChange={(e) => setShowSockets(e.target.checked)} />
          Show socket highlight rings
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
          Stopcock (demo only)
          <input type="range" min={0} max={1} step={0.01} value={valve} onChange={(e) => setValve(Number(e.target.value))} style={{ flex: 1 }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 10 }}>
          Stir speed (demo only)
          <input type="range" min={0} max={1} step={0.01} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ flex: 1 }} />
        </label>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
          Pink/green discs are an <strong>ILLUSTRATIVE</strong>, demo-only liquid-level check (verifies <code>ContainerSpec.fillLevelForVolume</code>
          against the rendered glass) \u2014 not Agent 05's real fluid shader.
        </div>
      </div>

      <div style={{ position: 'absolute', top: 16, right: 16, width: 320, background: 'rgba(8,13,24,0.82)', border: '1px solid #233049', borderRadius: 10, padding: 14, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Socket compatibility checks</div>
        <CheckList />
      </div>
    </div>
  );
}

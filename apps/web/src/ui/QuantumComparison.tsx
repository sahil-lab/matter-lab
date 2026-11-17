import { boundingSphere, HARTREE_TO_KJ_PER_MOL } from '@matterlab/core';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useState } from 'react';
import { AgXToneMapping } from 'three';
import { comparableQuantumSystems, clearQuantumComparisons, useQuantumComparison } from '../compute/comparison';
import type { QuantumSnapshot } from '../compute/comparison';
import { FieldLayer } from '../render/FieldLayer';
import { SceneView } from '../render/SceneView';
import { MODE_STYLES } from '../render/style';
import { Stage } from '../render/Stage';
import { QUALITY } from '../render/quality';
import { Dialog } from './Dialogs';
import { Button, EvidenceBadge } from './kit';

function RecordedGeometry({ snapshot }: { snapshot: QuantumSnapshot }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [layers, setLayers] = useState<{ view: SceneView; fields: FieldLayer } | null>(null);
  useLayoutEffect(() => {
    const view = new SceneView({ sphereDetail: 4, cylinderSegments: 12, clearcoat: 0.2 });
    const fields = new FieldLayer();
    view.setStyle(MODE_STYLES['ball-stick']);
    view.sync(snapshot.record.scene, null);
    fields.setSurfaces(snapshot.fields.surfaces);
    fields.setSlice(snapshot.fields.slice);
    fields.setCloud(snapshot.fields.cloud);
    fields.setVolume(snapshot.fields.volume);
    fields.setCut(snapshot.fields.cut);
    gl.localClippingEnabled = true;
    setLayers({ view, fields });
    invalidate();
    return () => { view.dispose(); fields.dispose(); setLayers(null); };
  }, [snapshot, gl, invalidate]);
  useFrame(({ camera, scene }) => {
    if (layers) layers.fields.prepareVolumeDepth(gl, camera, layers.view.depthMeshes());
    gl.render(scene, camera);
  }, 1);
  return layers && <><primitive object={layers.view.object} dispose={null} /><primitive object={layers.fields.object} dispose={null} /></>;
}

function ComparisonView({ snapshot }: { snapshot: QuantumSnapshot }) {
  const sphere = boundingSphere(snapshot.record.scene);
  const center = sphere?.center ?? [0, 0, 0] as const;
  const distance = Math.max(6, (sphere?.radius ?? 2) * 4.5);
  return <section style={{ minWidth: 0 }} data-testid="quantum-comparison-view">
    <h3 style={{ fontSize: 15, margin: '0 0 5px' }}>{snapshot.title} · {snapshot.formula}</h3>
    <p className="ml-empty" style={{ margin: '0 0 8px' }}>{snapshot.description} · RHF/STO-3G · {snapshot.record.result.nBasis} basis functions</p>
    <div style={{ height: 'clamp(220px, 42vh, 420px)', background: '#081324', borderRadius: 9, overflow: 'hidden' }}>
      <Canvas frameloop="demand" dpr={[0.75, 1.25]} gl={{ antialias: true, toneMapping: AgXToneMapping }}
        camera={{ fov: 35, position: [center[0] + distance * 0.2, center[1] + distance * 0.15, center[2] + distance] }}>
        <OrbitControls makeDefault target={[...center]} />
        <Stage quality={QUALITY.efficient} drift={false} />
        <RecordedGeometry snapshot={snapshot} />
      </Canvas>
    </div>
    <dl className="ml-kv" style={{ marginTop: 10 }}>
      <dt>Total energy</dt><dd>{snapshot.record.result.energy.total.toFixed(8)} Eh</dd>
      <dt>Dipole</dt><dd>{snapshot.record.result.dipole.magnitudeDebye.toFixed(4)} D</dd>
      <dt>Electrons</dt><dd>{snapshot.record.result.nElectrons}</dd>
    </dl>
  </section>;
}

export function QuantumComparisonDialog() {
  const snapshots = useQuantumComparison((state) => state.snapshots);
  const [a, b] = snapshots;
  return <Dialog title="Compare electronic states" subtitle="Pinned computations, with independent orbit and zoom. Display changes cannot modify the molecule." width={1120} height="min(760px, 100%)">
    <div className="ml-actions" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
      <EvidenceBadge level="computed" />
      <Button variant="outline" size="sm" disabled={!snapshots.length} onClick={clearQuantumComparisons}>Clear comparison snapshots</Button>
    </div>
    {snapshots.length ? <div style={{ display: 'grid', gridTemplateColumns: snapshots.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)', gap: 20 }}>
      {snapshots.map((snapshot) => <ComparisonView key={snapshot.id} snapshot={snapshot} />)}
    </div> : <p className="ml-empty">Run a calculation and pin its current view from Compute. Change geometry or field, run again when needed, then pin the second view.</p>}
    {a && !b && <p className="ml-empty">One view is pinned. Add another from Compute for a side-by-side comparison.</p>}
    {a && b && (comparableQuantumSystems(a.record, b.record)
      ? <p data-testid="quantum-energy-difference">Energy difference, right minus left: <b>{((b.record.result.energy.total - a.record.result.energy.total) * HARTREE_TO_KJ_PER_MOL).toFixed(3)} kJ/mol</b>. Same elemental composition and charge, same RHF/STO-3G model; this is not a measured stability or reaction energy.</p>
      : <p className="ml-empty">Different elemental compositions or charges: no geometry-comparison energy difference is reported.</p>)}
    <p className="ml-empty">Snapshots retain the computed fields and geometry from the moment they were pinned. They are session-only comparisons, not independently validated experimental states.</p>
  </Dialog>;
}

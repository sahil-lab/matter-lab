import { ISOTOPE_DATA_SOURCE, NUCLEAR_RADIUS_R0_FM, describeStability, getElement } from '@matterlab/core';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { RotateCcw } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { BackSide, Color, Matrix4, Vector3 } from 'three';
import type { Group, InstancedMesh, Mesh, MeshBasicMaterial, PerspectiveCamera } from 'three';
import { useLab } from '../state/store';
import { Dialog } from '../ui/Dialogs';
import { Button, EvidenceBadge, Note, Section } from '../ui/kit';
import { nucleusApi, resetNucleusApi } from './api';
import { MAX_NUCLEONS, NUCLEON_COLORS, NUCLEON_FACTS, NUCLEON_RADIUS_FM, NUCLEON_SOURCES, buildNucleus, formatLength, nuclideOf, roundLength } from './model';
import type { NucleusModel } from './model';

const FOV = 32;
/** How long the zoom from the atom to its nucleus takes. */
const INTRO_MS = 2600;
/** The scale bar is never longer than this many pixels. */
const SCALE_BAR_MAX_PX = 120;
const SELECTION = '#55e2d1';

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface SceneProps {
  model: NucleusModel;
  /** Radius of the atom the nucleus sits in, femtometre. */
  atomRadiusFm: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** Changes whenever the zoom from the atom is to be played again. */
  replay: number;
  bar: RefObject<HTMLElement | null>;
  label: RefObject<HTMLElement | null>;
  caption: RefObject<HTMLElement | null>;
}

/** What the view shows at each stage of the zoom, by how far the zoom has come (0 to 1). */
function zoomCaption(progress: number, atomRadiusAngstrom: number): string {
  if (progress < 0.22) return `The whole atom, out to its van der Waals radius of ${atomRadiusAngstrom.toFixed(2)} Å.`;
  if (progress < 0.8) return 'The speck marks the nucleus, still far too small to be seen at this scale.';
  return '';
}

function NucleusScene({ model, atomRadiusFm, selected, onSelect, replay, bar, label, caption }: SceneProps) {
  const group = useRef<Group>(null);
  const spheres = useRef<InstancedMesh>(null);
  const shell = useRef<Mesh>(null);
  const speck = useRef<Mesh>(null);
  const started = useRef(performance.now());
  const [hovered, setHovered] = useState<number | null>(null);
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const size = useThree((state) => state.size);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  // Far enough for the whole cluster to be in view with some room around it.
  const distance = (model.extentFm / Math.sin((FOV * Math.PI) / 360)) * 1.22;

  useLayoutEffect(() => {
    const mesh = spheres.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    const color = new Color();
    model.nucleons.forEach((nucleon, i) => {
      matrix.makeTranslation(nucleon.position[0], nucleon.position[1], nucleon.position[2]);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.set(NUCLEON_COLORS[nucleon.kind]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [model, invalidate]);

  useLayoutEffect(() => {
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.near = distance / 200;
    camera.far = distance * 40;
    camera.updateProjectionMatrix();
  }, [camera, distance]);

  useEffect(() => {
    started.current = performance.now();
    nucleusApi.introDone = false;
    invalidate();
  }, [replay, model, invalidate]);

  useEffect(() => {
    nucleusApi.model = model;
    nucleusApi.screenPoint = (index) => {
      const nucleon = model.nucleons[index];
      const holder = group.current;
      if (!nucleon || !holder) return null;
      const point = new Vector3(...nucleon.position).multiplyScalar(holder.scale.x).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return [rect.left + ((point.x + 1) / 2) * rect.width, rect.top + ((1 - point.y) / 2) * rect.height];
    };
    return resetNucleusApi;
  }, [model, camera, gl]);

  useFrame(() => {
    const holder = group.current;
    if (!holder) return;
    const t = Math.min(1, (performance.now() - started.current) / INTRO_MS);
    const e = ease(t);
    // The zoom runs evenly through the powers of ten between the size of the atom and that of the nucleus.
    const scale = (model.extentFm / atomRadiusFm) ** (1 - e);
    holder.scale.setScalar(scale);
    if (shell.current) {
      shell.current.scale.setScalar(atomRadiusFm * scale);
      const opacity = 0.3 * (1 - smoothstep(0.08, 0.5, e));
      (shell.current.material as MeshBasicMaterial).opacity = opacity;
      shell.current.visible = opacity > 0.002;
    }
    if (speck.current) {
      // While the nucleus is smaller than a pixel a speck marks where it is.
      const opacity = 1 - smoothstep(0.3, 0.62, e);
      (speck.current.material as MeshBasicMaterial).opacity = opacity;
      speck.current.visible = opacity > 0.002;
    }

    const eye = camera.position.length();
    const pixelsPerUnit = size.height / (2 * eye * Math.tan((FOV * Math.PI) / 360));
    const femtometrePerPixel = 1 / (pixelsPerUnit * scale);
    const length = roundLength(femtometrePerPixel * SCALE_BAR_MAX_PX);
    const pixels = length / femtometrePerPixel;
    if (bar.current) bar.current.style.width = `${pixels.toFixed(1)}px`;
    if (label.current) label.current.textContent = formatLength(length);
    if (caption.current) {
      const text = zoomCaption(e, atomRadiusFm / 1e5);
      if (caption.current.textContent !== text) caption.current.textContent = text;
    }
    nucleusApi.scaleFm = length;
    nucleusApi.scaleBarPx = pixels;
    nucleusApi.introDone = t >= 1;
    if (t < 1) invalidate();
  });

  const at = (index: number | null): readonly [number, number, number] | null => (index === null ? null : (model.nucleons[index]?.position ?? null));
  const selectedAt = at(selected);
  const hoveredAt = hovered !== null && hovered !== selected ? at(hovered) : null;

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 7, 9]} intensity={2.4} />
      <directionalLight position={[-7, -3, -6]} intensity={0.9} color="#8fb4ff" />
      <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.12} minDistance={distance * 0.35} maxDistance={distance * 3} />
      <mesh ref={shell} renderOrder={2}>
        <sphereGeometry args={[1, 64, 40]} />
        <meshBasicMaterial color="#8c92fc" transparent opacity={0.3} side={BackSide} depthWrite={false} />
      </mesh>
      <mesh ref={speck}>
        <sphereGeometry args={[distance * 0.006, 16, 12]} />
        <meshBasicMaterial color="#ffe3d6" transparent opacity={1} depthWrite={false} />
      </mesh>
      <group ref={group}>
        <instancedMesh
          key={`${model.protons}-${model.neutrons}`}
          ref={spheres}
          args={[undefined, undefined, model.nucleons.length]}
          onClick={(event) => {
            event.stopPropagation();
            if (event.instanceId !== undefined) onSelect(event.instanceId);
          }}
          onPointerMove={(event) => {
            event.stopPropagation();
            if (event.instanceId !== undefined && event.instanceId !== hovered) setHovered(event.instanceId);
          }}
          onPointerOut={() => setHovered(null)}
        >
          <sphereGeometry args={[NUCLEON_RADIUS_FM, 48, 32]} />
          <meshPhysicalMaterial roughness={0.38} metalness={0} clearcoat={0.4} clearcoatRoughness={0.35} />
        </instancedMesh>
        {selectedAt && (
          <mesh position={[selectedAt[0], selectedAt[1], selectedAt[2]]} scale={1.13}>
            <sphereGeometry args={[NUCLEON_RADIUS_FM, 48, 32]} />
            <meshBasicMaterial color={SELECTION} side={BackSide} />
          </mesh>
        )}
        {hoveredAt && (
          <mesh position={[hoveredAt[0], hoveredAt[1], hoveredAt[2]]} scale={1.07}>
            <sphereGeometry args={[NUCLEON_RADIUS_FM, 48, 32]} />
            <meshBasicMaterial color="#e3f1ff" side={BackSide} transparent opacity={0.55} />
          </mesh>
        )}
      </group>
    </>
  );
}

const charge = (value: number): string => (value === 0 ? '0' : `${value > 0 ? '+' : '−'}${Math.abs(value)} e`);

/** The decay-mode codes of the nuclear data, in words. A code not listed here is shown as it is. */
const DECAY_MODES: Readonly<Record<string, string>> = {
  A: 'alpha decay',
  'B-': 'beta-minus decay',
  'B+': 'beta-plus decay',
  EC: 'electron capture',
  'EC+B+': 'electron capture or beta-plus decay',
  IT: 'isomeric transition',
  SF: 'spontaneous fission',
  N: 'neutron emission',
  P: 'proton emission',
  '2B-': 'double beta-minus decay',
  '2B+': 'double beta-plus decay',
  '2EC': 'double electron capture',
  '2N': 'emission of two neutrons',
  '2P': 'emission of two protons',
  'B-N': 'beta-minus decay followed by neutron emission',
  'B-2N': 'beta-minus decay followed by the emission of two neutrons',
  'B-A': 'beta-minus decay followed by alpha emission',
  'B+P': 'beta-plus decay followed by proton emission',
  ECP: 'electron capture followed by proton emission',
  ECSF: 'electron capture followed by fission',
};

/** Arranging a heavy nucleus takes a moment; the arrangement of a nuclide never changes, so it is kept. */
const arranged = new Map<string, NucleusModel>();
function nucleusFor(protons: number, neutrons: number): NucleusModel {
  const key = `${protons}:${neutrons}`;
  let model = arranged.get(key);
  if (!model) {
    model = buildNucleus(protons, neutrons);
    arranged.set(key, model);
  }
  return model;
}

/**
 * The nucleus of the selected atom as a cluster of protons and neutrons that can be turned and
 * picked apart one by one. The view opens with a zoom from the size of the atom to the size of its
 * nucleus, five powers of ten, with a scale bar that follows it.
 */
export function NucleusDialog() {
  const atom = useLab((s) => (s.selectedAtoms.size === 1 ? s.scene.atoms.get([...s.selectedAtoms][0]!) : undefined));
  const protons = atom?.protons ?? null;
  const neutrons = atom ? atom.neutrons : null;
  const nuclide = useMemo(() => (protons === null ? null : nuclideOf(protons, neutrons)), [protons, neutrons]);
  const model = useMemo(() => (nuclide && nuclide.massNumber <= MAX_NUCLEONS ? nucleusFor(nuclide.protons, nuclide.neutrons) : null), [nuclide]);
  const [selected, setSelected] = useState<number | null>(null);
  const [replay, setReplay] = useState(0);
  const bar = useRef<HTMLElement>(null);
  const label = useRef<HTMLElement>(null);
  const caption = useRef<HTMLElement>(null);

  useEffect(() => {
    nucleusApi.selected = selected;
  }, [selected]);

  if (!nuclide || !atom) {
    return (
      <Dialog title="Nucleus" width={520}>
        <p className="ml-empty">Select one atom to look inside its nucleus.</p>
      </Dialog>
    );
  }
  const element = getElement(nuclide.protons);
  const atomRadiusFm = element.vdwRadius * 1e5;
  const picked = model && selected !== null ? (model.nucleons[selected] ?? null) : null;
  const facts = picked ? NUCLEON_FACTS[picked.kind] : null;
  const perNucleon = nuclide.bindingEnergyMeV !== null && nuclide.massNumber > 1 ? nuclide.bindingEnergyMeV / nuclide.massNumber : null;

  return (
    <Dialog
      title={`Nucleus of ${nuclide.name.toLowerCase()}`}
      subtitle={`${nuclide.protons} proton${nuclide.protons === 1 ? '' : 's'} and ${nuclide.neutrons} neutron${nuclide.neutrons === 1 ? '' : 's'}, drawn as spheres`}
      width={1040}
      height="min(680px, 100%)"
      headerExtra={<EvidenceBadge level="illustrative" tipPos="bottom-end" />}
    >
      <div className="ml-nucleus" data-testid="nucleus">
        <div className="ml-nucleus__stage">
          {model ? (
            <>
              <Canvas frameloop="demand" dpr={Math.min(window.devicePixelRatio || 1, 2)} camera={{ fov: FOV, position: [0, 0, 30] }} gl={{ antialias: true, alpha: true }} onPointerMissed={() => setSelected(null)}>
                <NucleusScene model={model} atomRadiusFm={atomRadiusFm} selected={selected} onSelect={setSelected} replay={replay} bar={bar} label={label} caption={caption} />
              </Canvas>
              <p ref={caption as RefObject<HTMLParagraphElement | null>} className="ml-nucleus__caption" data-testid="nucleus-caption" />
              <div className="ml-nucleus__legend" data-testid="nucleus-legend">
                <span>
                  <i className="ml-dot" style={{ background: NUCLEON_COLORS.proton }} /> {nuclide.protons} proton{nuclide.protons === 1 ? '' : 's'}
                </span>
                <span>
                  <i className="ml-dot" style={{ background: NUCLEON_COLORS.neutron }} /> {nuclide.neutrons} neutron{nuclide.neutrons === 1 ? '' : 's'}
                </span>
              </div>
              <div className="ml-nucleus__scale" data-testid="nucleus-scale">
                <i ref={bar} />
                <span ref={label} className="ml-mono" />
              </div>
              <div className="ml-nucleus__replay">
                <Button size="sm" variant="outline" onClick={() => setReplay((n) => n + 1)} data-testid="nucleus-replay">
                  <RotateCcw /> Zoom in from the atom again
                </Button>
              </div>
            </>
          ) : (
            <p className="ml-empty" style={{ padding: 24 }} data-testid="nucleus-too-large">
              With {nuclide.massNumber} nucleons this is beyond anything that has been made; nuclei are drawn for up to {MAX_NUCLEONS}.
            </p>
          )}
        </div>

        <div className="ml-nucleus__side ml-scroll">
          <Note severity="info">
            <span data-testid="nucleus-caveat">
              This is a picture, not a simulation. A nucleus is a quantum system: its protons and neutrons have no positions of their own and are not hard spheres. The picture takes from
              data only how many there are of each, the size of a nucleon and, roughly, the size of the nucleus. Where each sphere sits, and which one is a proton, is arbitrary.
            </span>
          </Note>
          {nuclide.standsForNaturalMix && (
            <p className="ml-empty" style={{ margin: 0 }} data-testid="nucleus-natural">
              This atom states no isotope, so it stands for natural {element.name.toLowerCase()}. Shown is {nuclide.name.toLowerCase()},{' '}
              {nuclide.isotope?.abundance ? 'its most abundant isotope' : 'its longest-lived isotope'}.
            </p>
          )}

          <Section title={picked && facts ? `${facts.name} ${picked.ordinal} of ${picked.kind === 'proton' ? nuclide.protons : nuclide.neutrons}` : 'A proton or a neutron'} right={picked ? <EvidenceBadge level="reference" /> : undefined}>
            {picked && facts ? (
              <>
                <dl className="ml-kv" data-testid="nucleon-facts">
                  <dt>Charge</dt>
                  <dd className="ml-mono">{charge(facts.charge)}</dd>
                  <dt>Mass</dt>
                  <dd className="ml-mono">{facts.massU.toFixed(6)} u</dd>
                  <dt>as energy</dt>
                  <dd className="ml-mono">{facts.massMeV.toFixed(3)} MeV/c²</dd>
                  <dt>Spin</dt>
                  <dd className="ml-mono">{facts.spin}</dd>
                  <dt>Made of</dt>
                  <dd>{facts.quarks}</dd>
                </dl>
                <p className="ml-empty" style={{ margin: 0 }}>
                  {facts.lifetime}
                </p>
                <p className="ml-empty" style={{ margin: 0 }}>
                  The sphere is drawn with a radius of {NUCLEON_RADIUS_FM} fm, the measured charge radius of the proton; a neutron is drawn the same size. Every {facts.name.toLowerCase()} is
                  identical to every other, so “{facts.name.toLowerCase()} {picked.ordinal}” is a label of this picture only.
                </p>
              </>
            ) : (
              <p className="ml-empty" style={{ margin: 0 }} data-testid="nucleon-hint">
                Click a sphere to see what is known about that particle. Drag to turn the nucleus, scroll to move closer.
              </p>
            )}
          </Section>

          <Section title="This nuclide" right={<EvidenceBadge level={nuclide.isotope ? 'reference' : 'rule-based'} />}>
            <dl className="ml-kv" data-testid="nucleus-facts">
              <dt>Mass number</dt>
              <dd className="ml-mono">
                {nuclide.protons} + {nuclide.neutrons} = {nuclide.massNumber}
              </dd>
              {nuclide.isotope ? (
                <>
                  <dt>Stability</dt>
                  <dd>{nuclide.isotope.stability === 'S' ? 'Stable' : nuclide.isotope.halfLifeSeconds === null ? 'Half-life not evaluated' : describeStability({ ...nuclide.isotope, decayMode: null })}</dd>
                  {nuclide.isotope.stability !== 'S' && nuclide.isotope.decayMode && (
                    <>
                      <dt>Main decay</dt>
                      <dd data-testid="nucleus-decay">{DECAY_MODES[nuclide.isotope.decayMode] ?? nuclide.isotope.decayMode}</dd>
                    </>
                  )}
                  {nuclide.bindingEnergyMeV !== null && perNucleon !== null && (
                    <>
                      <dt>Binding energy</dt>
                      <dd className="ml-mono" data-testid="nucleus-binding">
                        {nuclide.bindingEnergyMeV.toFixed(2)} MeV
                      </dd>
                      <dt>per nucleon</dt>
                      <dd className="ml-mono" data-testid="nucleus-binding-per-nucleon">
                        {perNucleon.toFixed(2)} MeV
                      </dd>
                    </>
                  )}
                </>
              ) : (
                <>
                  <dt>Stability</dt>
                  <dd>Not in the evaluated nuclear data: no such nuclide has been characterised.</dd>
                </>
              )}
            </dl>
          </Section>

          <Section title="Size" right={<EvidenceBadge level="rule-based" />}>
            <dl className="ml-kv">
              <dt>
                Nucleus, by R ≈ r<sub>0</sub>A<sup>1/3</sup>
              </dt>
              <dd className="ml-mono">{(NUCLEAR_RADIUS_R0_FM * Math.cbrt(nuclide.massNumber)).toFixed(2)} fm</dd>
              {model && (
                <>
                  <dt>The cluster as drawn</dt>
                  <dd className="ml-mono">{model.extentFm.toFixed(2)} fm</dd>
                </>
              )}
              <dt>Atom (van der Waals)</dt>
              <dd className="ml-mono" style={{ whiteSpace: 'nowrap' }} data-testid="nucleus-atom-radius">
                {element.vdwRadius.toFixed(2)} Å = {Math.round(atomRadiusFm).toLocaleString('en-US')} fm
              </dd>
            </dl>
            {model && (
              <p className="ml-empty" style={{ margin: 0 }} data-testid="nucleus-ratio">
                The atom is about {Number((atomRadiusFm / model.extentFm).toPrecision(2)).toLocaleString('en-US')} times wider than its nucleus. The zoom at the start runs through that whole
                range; the bar at the lower left always shows the scale.
              </p>
            )}
          </Section>

          <div className="ml-explain">
            <h4>Sources</h4>
            {[...NUCLEON_SOURCES, ...(ISOTOPE_DATA_SOURCE.citations ?? [])].map((source, i) => (
              <cite key={i}>
                {source.authors ? `${source.authors}, ` : ''}
                {source.title}
                {source.source ? `. ${source.source}` : ''}
                {source.year ? ` (${source.year})` : ''}
                {source.doi ? `. doi:${source.doi}` : ''}
              </cite>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

import { EXAMPLES, exportMolecule, hillFormula, sortedAtoms, sortedBonds, validateScene } from '@matterlab/core';
import type { AtomId, BondId, FileFormatId } from '@matterlab/core';
import { InteractionController } from './interaction/InteractionController';
import * as colormap from './render/colormap';
import { getDeviceInfo } from './render/MatterCanvas';
import { perfMonitor } from './render/perf';
import { stageApi, stageContents, viewApi } from './render/viewApi';
import * as chem from './science/chem';
import * as jobs from './science/jobs';
import * as qm from './science/quantum';
import * as quantum from './compute/quantum';
import * as compute from './compute/store';
import * as reaction from './reaction/store';
import * as structures from './science/structures';
import * as vaultCatalogue from './vault/catalogue';
import * as build3d from './science/build3d';
import * as library from './science/library';
import { nucleusApi } from './nucleus/api';
import * as vaultLadder from './vault/ladder';
import * as vault from './vault/store';
import * as actions from './state/actions';
import * as commands from './state/commands';
import * as persistence from './state/persistence';
import { lab } from './state/store';

/**
 * A small window onto the running app for automated browser tests and benchmarks. It is installed
 * only in development builds or when the build sets VITE_TEST_API=1; it exposes nothing in a
 * normal production build.
 */
export function installTestApi(): void {
  const api = {
    lab,
    actions,
    commands,
    persistence,
    viewApi,
    perf: perfMonitor,
    chem,
    jobs,
    compute,
    quantum,
    qm,
    colormap,
    reaction,
    structures,
    build3d,
    library,
    nucleus: nucleusApi,
    vault,
    vaultCatalogue,
    vaultLadder,
    device: getDeviceInfo,
    /** What is on the 3D stage besides the structure: sizes and settings, not the bulky arrays. */
    stage() {
      const { surfaces, slice, cloud, volume, cut } = stageContents();
      return {
        surfaces: surfaces.map((s) => ({ id: s.id, vertices: s.positions.length / 3, triangles: s.indices.length / 3, color: s.color, colored: s.colors !== undefined, opacity: s.opacity, finish: s.finish })),
        volume: volume && { dimensions: volume.dimensions, origin: volume.origin, spacing: volume.spacing, samples: volume.values.length, referenceValue: volume.referenceValue, opacity: volume.opacity },
        slice: slice && { center: slice.center, u: slice.u, v: slice.v, width: slice.width, height: slice.height, columns: slice.columns, rows: slice.rows, neutral: slice.neutral, contours: slice.contours },
        cloud: cloud && { dots: cloud.positions.length / 3, signed: cloud.signs !== undefined, size: cloud.size, opacity: cloud.opacity },
        cut,
      };
    },
    /** The raw arrays behind `stage()`, for tests that check the geometry itself. */
    stageContents,
    stageApi,
    /** A compact description of the scene for assertions. */
    summary() {
      const s = lab.get();
      const report = validateScene(s.scene);
      return {
        formula: hillFormula(s.scene, undefined, 'plain'),
        atoms: s.scene.atoms.size,
        bonds: s.scene.bonds.size,
        selectedAtoms: [...s.selectedAtoms],
        selectedBonds: [...s.selectedBonds],
        errors: report.errors,
        warnings: report.warnings,
        undo: s.history.past.length,
        redo: s.history.future.length,
        tool: s.tool,
      };
    },
    atoms() {
      return sortedAtoms(lab.get().scene).map((a) => ({ id: a.id, z: a.protons, n: a.neutrons, e: a.electrons, position: a.position }));
    },
    bonds() {
      return sortedBonds(lab.get().scene).map((b) => ({ id: b.id, a: b.a, b: b.b, order: b.order }));
    },
    /** The built-in example molecules with the SMILES they were generated from. */
    examples() {
      return EXAMPLES.map((e) => ({ id: e.id, name: e.name, smiles: e.smiles }));
    },
    /** Screen position (CSS pixels within the viewport) of an atom. */
    atomPoint(id: AtomId): [number, number] | null {
      const atom = lab.get().scene.atoms.get(id);
      return atom ? viewApi.project(atom.position) : null;
    },
    /** Screen position of the midpoint of a bond. */
    bondPoint(id: BondId): [number, number] | null {
      const scene = lab.get().scene;
      const bond = scene.bonds.get(id);
      if (!bond) return null;
      const a = scene.atoms.get(bond.a)!.position;
      const b = scene.atoms.get(bond.b)!.position;
      return viewApi.project([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    },
    /** What the editor would pick at a point in the viewport, using the same code path as a real click. */
    hitTest(x: number, y: number) {
      return InteractionController.active?.hitTest(x, y) ?? null;
    },
    /** The current structure written in a chemistry file format. */
    exportText(format: FileFormatId): string {
      const s = lab.get();
      return exportMolecule(format, s.scene, s.projectName);
    },
  };
  (window as unknown as { __MATTERLAB__: typeof api }).__MATTERLAB__ = api;
}

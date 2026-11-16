import { BufferAttribute, BufferGeometry, Group, Points, PointsMaterial } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { GhostGeometry } from './viewApi';

const GHOST_COLOR = 0xffb66b;

/**
 * An outline of a second geometry, drawn over the scene so two structures can be compared (for
 * example a molecule before and after optimisation). Bonds are lines and atoms are dots, in one
 * colour, so the ghost can never be mistaken for the structure itself. Lines have a constant
 * width on screen, which keeps them readable at any zoom.
 */
export class GhostOverlay {
  readonly object = new Group();
  private lineGeometry = new LineSegmentsGeometry();
  private readonly pointGeometry = new BufferGeometry();
  // Drawn over the model rather than hidden by it: two geometries often differ by less than the
  // thickness of a drawn bond, and an outline buried inside the model would compare nothing.
  private readonly lineMaterial = new LineMaterial({ color: GHOST_COLOR, linewidth: 2.2, transparent: true, opacity: 0.92, toneMapped: false, fog: false, depthTest: false, depthWrite: false });
  private readonly pointMaterial = new PointsMaterial({ color: GHOST_COLOR, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.95, toneMapped: false, fog: false, depthTest: false, depthWrite: false });
  private readonly lines = new LineSegments2(this.lineGeometry, this.lineMaterial);
  private readonly points = new Points(this.pointGeometry, this.pointMaterial);

  constructor() {
    this.lines.frustumCulled = false;
    this.points.frustumCulled = false;
    // After every surface and plane, since it is not depth-tested.
    this.lines.renderOrder = 60;
    this.points.renderOrder = 61;
    this.object.add(this.lines, this.points);
    this.object.visible = false;
  }

  set(ghost: GhostGeometry | null): void {
    if (!ghost || ghost.positions.length === 0) {
      this.object.visible = false;
      return;
    }
    const { positions, bonds } = ghost;
    const segments = new Float32Array(bonds.length * 3);
    for (let i = 0; i < bonds.length; i++) {
      const atom = bonds[i]! * 3;
      segments[3 * i] = positions[atom]!;
      segments[3 * i + 1] = positions[atom + 1]!;
      segments[3 * i + 2] = positions[atom + 2]!;
    }
    // The instanced line geometry cannot be resized in place, so each comparison gets its own.
    this.lineGeometry.dispose();
    this.lineGeometry = new LineSegmentsGeometry();
    this.lineGeometry.setPositions(segments);
    this.lines.geometry = this.lineGeometry;
    this.lines.visible = bonds.length > 0;
    this.pointGeometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.object.visible = true;
  }

  dispose(): void {
    this.lineGeometry.dispose();
    this.pointGeometry.dispose();
    this.lineMaterial.dispose();
    this.pointMaterial.dispose();
  }
}

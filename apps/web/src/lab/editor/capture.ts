import type { LabCameraController } from '../environment/CameraController';
import type { PointerCaptureTarget } from './types';

export class EditorPointerCapture {
  private active: { target: PointerCaptureTarget; pointerId: number; release: () => void } | null = null;
  constructor(private readonly camera: LabCameraController) {}
  get pointerId(): number | null { return this.active?.pointerId ?? null; }
  begin(target: PointerCaptureTarget, pointerId: number, reason: string): void {
    this.finish();
    const release = this.camera.acquireControlLock(`editor:${reason}`);
    this.active = { target, pointerId, release };
    try {
      target.setPointerCapture(pointerId);
    } catch (error) {
      this.finish();
      throw error;
    }
  }
  finish(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    try {
      if (!active.target.hasPointerCapture || active.target.hasPointerCapture(active.pointerId)) {
        active.target.releasePointerCapture(active.pointerId);
      }
    } catch {
      // Lost/detached DOM targets must never retain the camera lock.
    } finally {
      active.release();
    }
  }
}

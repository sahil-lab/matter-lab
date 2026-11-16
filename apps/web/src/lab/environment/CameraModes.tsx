import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { LabCameraController, CameraSnapshot } from './CameraController';

const CameraContext = createContext<LabCameraController | null>(null);
export function LabCameraProvider({ controller, children }: { controller: LabCameraController; children?: ReactNode }) {
  return <CameraContext.Provider value={controller}>{children}</CameraContext.Provider>;
}
export function useOptionalLabCamera(): LabCameraController | null { return useContext(CameraContext); }
export function useLabCamera(): LabCameraController {
  const controller = useOptionalLabCamera();
  if (!controller) throw new Error('Lab camera commands require LabCanvas or LabCameraProvider.');
  return controller;
}
export function useCameraSnapshot(controller: LabCameraController): CameraSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function useReducedMotion(override?: boolean): boolean {
  const [preferred, setPreferred] = useState(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setPreferred(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  // A caller can additionally reduce motion, but cannot override a user's OS accessibility preference.
  return preferred || override === true;
}

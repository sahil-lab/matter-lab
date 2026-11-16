import type { ApparatusDefinition, ApparatusInstance, ApparatusRuntimeState } from '@matterlab/contracts';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Material } from 'three';
import { Workbench } from '../environment/Workbench';
import type { SceneQualityPreset } from '../environment/types';
import { buildApparatusGeometry } from './geometry';
import type { ApparatusGeometry } from './geometry';
import { acquireApparatusLabels } from './labels';
import { apparatusRegistry } from './registry';

export interface ApparatusModelProps {
  readonly instance: ApparatusInstance;
  readonly definition?: ApparatusDefinition;
  readonly quality?: SceneQualityPreset;
  readonly glassMaterial?: Material;
  readonly state?: ApparatusRuntimeState;
  readonly children?: ReactNode;
  readonly onControlPointerDown?: (controlId: string, event: ThreeEvent<PointerEvent>) => void;
}

function Instrument({ definition, quality, glassMaterial, state, onControlPointerDown }: {
  definition: ApparatusDefinition;
  quality: SceneQualityPreset;
  glassMaterial?: Material;
  state?: ApparatusRuntimeState;
  onControlPointerDown?: ApparatusModelProps['onControlPointerDown'];
}) {
  const invalidate = useThree((root) => root.invalidate);
  const [model, setModel] = useState<ApparatusGeometry | null>(null);
  useLayoutEffect(() => {
    const labels = acquireApparatusLabels();
    let built: ApparatusGeometry;
    try {
      built = buildApparatusGeometry(definition, quality, { glassMaterial, labelMaterial: labels.material });
    } catch (error) {
      labels.release();
      throw error;
    }
    setModel(built);
    return () => {
      built.dispose();
      labels.release();
      setModel(null);
    };
  }, [definition, quality, glassMaterial]);
  useLayoutEffect(() => {
    if (!model) return;
    model.setState(state);
    invalidate();
  }, [model, state, invalidate]);
  return model && <primitive object={model.object} dispose={null} onPointerDown={(event: ThreeEvent<PointerEvent>) => {
    const control = event.object.userData.labControlId;
    if (typeof control === 'string' && onControlPointerDown) {
      event.stopPropagation();
      onControlPointerDown(control, event);
    }
  }} />;
}

/** This is the single application of the canonical world transform; children use vessel-local meters. */
export function ApparatusModel({ instance, definition: supplied, quality = 'balanced', glassMaterial, state, children, onControlPointerDown }: ApparatusModelProps) {
  const definition = supplied ?? apparatusRegistry.getDefinition(instance.definitionId);
  if (!definition) throw new Error(`No apparatus definition exists for ${instance.definitionId}.`);
  if (definition.id !== instance.definitionId) throw new Error('The rendered apparatus definition does not match the instance.');
  return (
    <group position={[...instance.transform.positionM]} quaternion={[...instance.transform.quaternion]} userData={{ apparatusId: instance.id }}>
      {definition.kind === 'BENCH'
        ? <Workbench instanceId={instance.id} stationId={instance.stationId} quality={quality} />
        : <Instrument definition={definition} quality={quality} glassMaterial={glassMaterial} state={state} onControlPointerDown={onControlPointerDown} />}
      {children}
    </group>
  );
}

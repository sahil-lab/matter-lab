import type { ApparatusDefinition, ApparatusInstance } from '@matterlab/contracts';
import type { ReactNode } from 'react';
import { formatNumber } from '../../ui/charts';
import type { EquipmentLibraryItem } from './EquipmentLibrary';
import type { LabProperty } from './LabInspector';

/** Agent10 supplies Agent03's thumbnail component; this adapter never fetches or builds an asset. */
export function equipmentLibraryItem(
  definition: Readonly<ApparatusDefinition>,
  presentation: { readonly thumbnail?: ReactNode; readonly description?: string; readonly unavailableReason?: string } = {},
): EquipmentLibraryItem {
  const facts = [
    { label: 'Definition version', value: definition.version },
    { label: 'Dimensions / m', value: definition.dimensionsM.map((value) => formatNumber(value, 6)).join(' × ') },
    ...(definition.capacityL === undefined ? [] : [{ label: 'Declared capacity', value: `${formatNumber(definition.capacityL, 6)} L` }]),
    ...(definition.massKg === undefined ? [] : [{ label: 'Declared mass', value: `${formatNumber(definition.massKg, 6)} kg` }]),
    ...(definition.visual ? [{ label: 'Asset license', value: definition.visual.license }] : []),
  ];
  return {
    definitionId: definition.id, label: definition.label, category: definition.category,
    capabilities: definition.capabilities, keywords: definition.tags, facts,
    thumbnail: presentation.thumbnail, description: presentation.description,
    unavailableReason: presentation.unavailableReason ?? (definition.visual?.status === 'DEVELOPMENT_PLACEHOLDER' ? 'This asset is marked as a development placeholder.' : undefined),
  };
}

export function apparatusProperties(instance: Readonly<ApparatusInstance>): readonly LabProperty[] {
  return [
    { label: 'Definition', value: instance.definitionId },
    { label: 'Kind', value: instance.kind },
    { label: 'Position [x, y, z]', value: instance.transform.positionM.map((value) => formatNumber(value, 6)).join(', '), unit: 'm' },
    { label: 'Quaternion [x, y, z, w]', value: instance.transform.quaternion.map((value) => formatNumber(value, 6)).join(', '), unit: '1' },
    { label: 'Station', value: instance.stationId },
    { label: 'Revision', value: instance.revision },
  ];
}

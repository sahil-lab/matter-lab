import {
  Beaker,
  CircleDashed,
  CircleGauge,
  Columns3,
  FlaskConical,
  FlaskRound,
  Funnel,
  Gauge,
  Grip,
  Magnet,
  PillBottle,
  Pipette,
  Scale,
  Table2,
  TestTube2,
  TestTubeDiagonal,
  Thermometer,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

/**
 * Maps the placeholder `thumbnailGlyph` names in `demoData.ts` to a `lucide-react` icon. Stands in
 * for Agent 03's rendered apparatus thumbnails; replace wholesale once those are available.
 */
export const APPARATUS_GLYPHS: Readonly<Record<string, ComponentType<SVGProps<SVGSVGElement>>>> = {
  Table2,
  Columns3,
  Grip,
  TestTubeDiagonal,
  FlaskConical,
  PillBottle,
  Magnet,
  Gauge,
  Beaker,
  FlaskRound,
  Pipette,
  TestTube2,
  Funnel,
  CircleDashed,
  Thermometer,
  CircleGauge,
  Scale,
};

export function apparatusGlyph(name: string): ComponentType<SVGProps<SVGSVGElement>> {
  return APPARATUS_GLYPHS[name] ?? CircleDashed;
}

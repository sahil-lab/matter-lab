/**
 * A billboarded label built from `materials/textSprite.ts` — the WebGL-native replacement for
 * drei's `<Html>` used by `GraduationMarks` and `InstrumentReadout` (see that module's header
 * comment for why). `anchor` follows `THREE.Sprite.center` convention: `[0, 0]` is the texture's
 * bottom-left corner sitting at `position`, `[0.5, 0.5]` centers it, `[1, 1]` is the top-right
 * corner. Rebuilds its texture only when the rendered text/style actually changes.
 */
import { useEffect, useMemo } from 'react';
import { buildTextSprite } from '../materials/textSprite';
import type { TextSpriteOptions } from '../materials/textSprite';

export interface TextSpriteProps extends TextSpriteOptions {
  readonly position: readonly [number, number, number];
  readonly anchor?: readonly [number, number];
}

export function TextSprite({ position, anchor = [0, 0.5], lines, fontSizePx, fontFamily, paddingPx, backgroundColor, borderRadiusPx, pixelsPerMeter }: TextSpriteProps) {
  const key = JSON.stringify([lines, fontSizePx, fontFamily, paddingPx, backgroundColor, borderRadiusPx, pixelsPerMeter]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is a deliberate stable fingerprint of every option below.
  const built = useMemo(() => buildTextSprite({ lines, fontSizePx, fontFamily, paddingPx, backgroundColor, borderRadiusPx, pixelsPerMeter }), [key]);

  useEffect(() => () => built.texture.dispose(), [built.texture]);

  return (
    <sprite position={[position[0], position[1], position[2]]} scale={[built.widthM, built.heightM, 1]} center={[anchor[0], anchor[1]]}>
      <spriteMaterial map={built.texture} transparent depthWrite={false} toneMapped={false} />
    </sprite>
  );
}

import type { ScfResult } from '@matterlab/quantum';

/** The customary name of a molecular orbital by its distance from the frontier: HOMO−1, HOMO, LUMO, LUMO+1. */
export function orbitalLabel(result: Pick<ScfResult, 'homoIndex' | 'lumoIndex'>, index: number): string {
  if (index <= result.homoIndex) return index === result.homoIndex ? 'HOMO' : `HOMO−${result.homoIndex - index}`;
  const lumo = result.lumoIndex ?? result.homoIndex + 1;
  return index === lumo ? 'LUMO' : `LUMO+${index - lumo}`;
}

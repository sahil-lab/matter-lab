import type { ExperimentPlugin } from '@matterlab/contracts';
import { createAcidBaseTitrationPlugin } from './titrationPlugin';

export { ACID_BASE_TITRATION_PLUGIN_ID, STRONG_ACID_STRONG_BASE_ASSUMPTIONS, STRONG_ACID_STRONG_BASE_METHOD_ID, createAcidBaseTitrationPlugin } from './titrationPlugin';

/** Every `ExperimentPlugin` this build ships, ready to pass to `ExperimentEngine`'s `plugins` dependency. */
export function createDefaultPlugins(): readonly ExperimentPlugin[] {
  return [createAcidBaseTitrationPlugin()];
}

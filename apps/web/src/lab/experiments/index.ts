/**
 * Public surface of Agent 07's experiment graph / simulation runtime. Other agents' code should
 * import from here (or a specific submodule) rather than reaching into `runtime/*` directly.
 *
 * `./testFixtures` is deliberately **not** re-exported here: it contains a solver test double and
 * scene-assembly helpers for this package's own tests, not production wiring.
 */
export * from './registry';
export * from './runtime';
export * from './plugins';

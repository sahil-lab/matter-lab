import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'quantum',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});

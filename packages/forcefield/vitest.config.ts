import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'forcefield',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});

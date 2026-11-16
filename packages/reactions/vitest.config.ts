import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'reactions',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});

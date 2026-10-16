import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/shared/**/*.test.ts', 'tests/web/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    environment: 'node',
  },
});

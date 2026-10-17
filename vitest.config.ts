import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/shared/**/*.test.ts', 'tests/web/**/*.test.ts', 'tests/worker/**/*.test.ts'],
    environment: 'node',
    // fast-check property tests run close to the 5 s default when the machine is busy.
    testTimeout: 20_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // PGlite boots a Postgres in WebAssembly per test; give it room on slow CI runners.
    testTimeout: 30_000,
  },
});

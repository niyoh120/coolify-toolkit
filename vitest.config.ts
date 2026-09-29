import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Tests must stay offline-reproducible: only local fixtures, no external network.
    pool: 'forks',
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  server: {
    watch: {
      ignored: ['**/data/**', '**/dist/**'],
    },
  },
});

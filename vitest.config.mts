import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    // Integration tests share one Postgres/Redis; run files serially for determinism.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/worker.ts', 'src/tracing.ts'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 70, functions: 70, statements: 70, branches: 60 },
    },
  },
});

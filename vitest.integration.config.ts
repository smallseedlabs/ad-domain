import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Shared isolated PG outbox; parallel files steal SKIP LOCKED rows.
    fileParallelism: false,
    maxWorkers: 1,
  },
});

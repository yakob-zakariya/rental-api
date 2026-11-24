import { defineConfig } from 'vitest/config';
import { TEST_ENV } from './test/test-env.js';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Recreates and migrates the test database once per run (needs `docker compose up -d`).
    globalSetup: ['./test/global-setup.ts'],
    env: TEST_ENV,
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    // Real image processing and real storage calls (SeaweedFS) make some tests slower than
    // Vitest's 5 s default when the whole suite runs; a hung test still fails, just later.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

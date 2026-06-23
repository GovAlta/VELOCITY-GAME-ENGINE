import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * E2E vitest config — runs tests against the real database.
 *
 * Unlike vitest.config.ts (unit tests), this:
 *   - Loads the real .env (so DATABASE_URL points at dev/test Postgres)
 *   - Includes only *-e2e.test.ts files
 *   - Skips the in-memory env mock setup
 *
 * Usage:
 *   npx vitest run --config vitest.e2e.config.ts src/__tests__/services/<name>-e2e.test.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-setup-e2e.ts'],
    include: ['src/**/__tests__/**/*-e2e.test.ts'],
    exclude: ['node_modules/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

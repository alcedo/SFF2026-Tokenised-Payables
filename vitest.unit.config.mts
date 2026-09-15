import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The suite mutation testing is scored against. It excludes tests/db and
// tests/ledger, which exercise SQL rather than the TypeScript being mutated,
// and would cost a database round trip per mutant for nothing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/techniques/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});

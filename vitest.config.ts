import { defineConfig } from 'vitest/config';

// Unit tests only. Browser tests in e2e/ run with Playwright (npm run test:e2e).
export default defineConfig({
  test: { include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'] },
});

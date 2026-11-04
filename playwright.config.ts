import { defineConfig, devices } from '@playwright/test';

// Passkey edge-case lab. Uses Chrome's virtual authenticator (see e2e/helpers.ts),
// so only Chromium is supported.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false, // one dev server, one in-memory database
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5180',
    env: { DB_PATH: ':memory:' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

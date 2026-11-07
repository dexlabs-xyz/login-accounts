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
    launchOptions: { executablePath: process.env.OIDC_CHROMIUM_EXECUTABLE },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev',
      // The API (not just the web app) must be up: it loads Railgun at start-up when the pool is configured.
      url: 'http://127.0.0.1:8787/api/me',
      env: { DB_PATH: ':memory:', OIDC_ENABLED: '1' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm -w @login/server run dev:oidc-client',
      url: 'http://127.0.0.1:5190',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

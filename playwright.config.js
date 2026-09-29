// Phase-0 Playwright smoke configuration.
// The smoke suite asserts that V1 behaviour is preserved across every later phase.
const { defineConfig, devices } = require('@playwright/test'); // eslint-disable-line n/no-unpublished-require -- dev-only config

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        ignoreHTTPSErrors: true,
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: process.env.CI
        ? {
              command: 'node server.js',
              url: BASE_URL,
              reuseExistingServer: false,
              timeout: 60_000,
              env: {
                  NODE_ENV: 'test',
                  PORT: '3000',
                  // PostgreSQL test database for smoke runs.
                  DATABASE_URL:
                      process.env.DATABASE_URL ||
                      'postgres://postgres:postgres@localhost:5432/appdb_test',
              },
          }
        : undefined,
});

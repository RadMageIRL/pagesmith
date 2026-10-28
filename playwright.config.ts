import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`npm run build` first) served by `vite preview`.
// Uses the locally installed Chrome so no browser download is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 45_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1400, height: 900 } }, testIgnore: [/mobile.spec.ts/, /perf.spec.ts/] },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /mobile.spec.ts/ },
    // Timing runs alone (npm run test:perf) so parallel tests don't skew the numbers.
    { name: 'perf', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1400, height: 900 } }, testMatch: /perf.spec.ts/ },
    // Other engines (npm run test:engines; needs `npx playwright install firefox webkit` once).
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 900 } }, testIgnore: [/mobile.spec.ts/, /perf.spec.ts/] },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 900 } }, testIgnore: [/mobile.spec.ts/, /perf.spec.ts/] },
    { name: 'webkit-iphone', use: { ...devices['iPhone 14'] }, testMatch: /mobile.spec.ts/ },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

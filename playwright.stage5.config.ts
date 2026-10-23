import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 5 dedicated browser suite: real production build, isolated profile per test,
 * only the Stage 5 specs (exchange legs + the installed Dexie 2→3 upgrade).
 *
 * `E2E_STAGE5_OUT` may point at an empty directory so a re-run never clears other
 * stages' evidence. The server builds once (`npm run build`) and then serves the
 * production bundle with `vite preview`; the tests never touch a real user profile.
 */
const PORT = Number(process.env.E2E_STAGE5_PORT ?? 4322);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /stage5.*\.spec\.ts/,
  outputDir: process.env.E2E_STAGE5_OUT ?? './test-results-stage5',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});

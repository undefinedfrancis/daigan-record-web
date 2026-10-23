import { defineConfig, devices } from '@playwright/test';

// e2e 使用独立端口，避免与本地 dev/preview 进程冲突。
const PORT = Number(process.env.E2E_PORT ?? 4317);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// 升级测试：可切换 A/B 两份生产构建的独立服务器。
const UPGRADE_PORT = Number(process.env.E2E_UPGRADE_PORT ?? 4318);
const UPGRADE_BASE_URL = `http://127.0.0.1:${UPGRADE_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
      timeout: 180_000,
    },
    {
      command: 'node tests/e2e/build-upgrade-fixtures.mjs && node tests/e2e/upgrade-server.mjs',
      url: `${UPGRADE_BASE_URL}/version.json`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});

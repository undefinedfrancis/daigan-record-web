import { defineConfig, devices } from '@playwright/test';

/**
 * Stage 4 专用：只跑一个聚焦浏览器套件（3 条连贯流程），不耦合升级服务器。
 *
 * 使用独立端口与全新的浏览器上下文（每个 test 自带隔离 profile），不接触任何真实
 * 用户资料。时钟由 `page.clock` 控制，跨"游戏日刷新"时推进的是真实 epoch，而不是
 * 改一个日期字符串。
 */
const PORT = Number(process.env.E2E_STAGE4_PORT ?? 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /stage4\.spec\.ts/,
  // 独立输出目录：不要清空历史 test-results（含其他阶段证据）。
  // 每次运行可用 E2E_STAGE4_OUT 指向一个空目录，避免重复运行时的批量清理。
  outputDir: process.env.E2E_STAGE4_OUT ?? './test-results-stage4',
  timeout: 120_000,
  expect: { timeout: 12_000 },
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
      timeout: 240_000,
    },
  ],
});

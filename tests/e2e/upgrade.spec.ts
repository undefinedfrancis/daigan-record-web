import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 两构建升级生命周期测试：
 * 通过 tests/e2e/upgrade-server.mjs 在同一 origin 上先后发布 A / B 两份生产构建，
 * 验证「检测 → 原子准备 → 用户确认 → 安全激活 → 刷新一次 → 数据保留」全链路。
 * 版本判定以 meta[name=daigan-build] 与 /version.json 为准，不以刷新本身当作升级成功。
 */

const UPGRADE_PORT = Number(process.env.E2E_UPGRADE_PORT ?? 4318);
const UPGRADE_BASE = `http://127.0.0.1:${UPGRADE_PORT}`;

test.use({ baseURL: UPGRADE_BASE });

const BUSY_MESSAGE = '正在处理资料，请完成后再更新。';
const DIRTY_MESSAGE = '请先保存或取消当前编辑，再更新。';
const TABS_MESSAGE = '请先关闭其他打开的本应用页面，再更新。';

/** 1×1 PNG；批量上传时前后填充字节放大体积。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function gotoApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function waitControlled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return Boolean(registration?.active && navigator.serviceWorker.controller);
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** 断言应用外壳已启动（不依赖当前 hash 路由）。 */
async function expectAppLoaded(page: Page) {
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

async function currentBuildId(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(
      () => document.querySelector('meta[name="daigan-build"]')?.getAttribute('content') ?? null,
    );
  } catch {
    // 升级重载瞬间执行上下文被销毁，下一轮再读。
    return null;
  }
}

async function currentBuildLabel(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('meta[name="daigan-build-label"]')?.getAttribute('content') ?? null,
  );
}

async function navCount(page: Page): Promise<number> {
  return page.evaluate(() => Number(sessionStorage.getItem('daigan-e2e-navcount') ?? '0'));
}

async function waitingExists(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.waiting);
  });
}

async function publish(request: APIRequestContext, name: 'a' | 'b') {
  const response = await request.post(`/__e2e/switch?name=${name}`);
  expect(response.ok()).toBeTruthy();
}

async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: '次导航' })
    .getByRole('button', { name: '资料与设置' })
    .click();
  await expect(page.getByRole('heading', { name: '资料与设置' })).toBeVisible();
}

/** 手动「检查更新」并等待出现最终结果文案。 */
async function manualCheck(page: Page) {
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('update-check-result')).toBeVisible();
  await expect
    .poll(async () => (await page.getByTestId('update-check-result').textContent()) ?? '', {
      timeout: 30_000,
    })
    .not.toContain('正在检查更新');
}

/** 发布 B 并确认新版本已完整准备好（出现更新通知）。 */
async function publishBAndWaitReady(page: Page) {
  await publish(page.request, 'b');
  await openSettings(page);
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 30_000 });
  expect(await waitingExists(page)).toBe(true);
}

test.beforeEach(async ({ context, request }) => {
  // 每个用例从「只发布构建 A、无注入故障」的干净服务器状态开始。
  await request.post('/__e2e/heal');
  await request.post('/__e2e/switch?name=a');
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const key = 'daigan-e2e-navcount';
      const value = Number(sessionStorage.getItem(key) ?? '0') + 1;
      sessionStorage.setItem(key, String(value));
    });
  });
});

test('首次安装生效且不误报更新；构建 A 断网可用；缓存响应头符合部署要求', async ({
  page,
  request,
}) => {
  await gotoApp(page);
  await waitControlled(page);

  // 首次安装不提示更新。
  await expect(page.getByTestId('update-banner')).toBeHidden();

  const buildA = await currentBuildId(page);
  expect(buildA).toBeTruthy();
  const version = await (await request.get('/version.json')).json();
  expect(version.buildId).toBe(buildA);
  expect(version.label).toBe('A');

  // 构建 A 离线可用（安装即预缓存全部启动资源）。
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  expect(await currentBuildId(page)).toBe(buildA);
  await page.context().setOffline(false);

  // 本地服务器镜像 vercel.json 缓存规则（生产头无法在本环境实测，见 README）。
  const sw = await request.get('/sw.js');
  expect(sw.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
  const meta = await request.get('/version.json');
  expect(meta.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
  const html = await (await request.get('/')).text();
  const asset = html.match(/assets\/[^"']+\.js/)?.[0];
  expect(asset).toBeTruthy();
  const assetRes = await request.get(`/${asset}`);
  expect(assetRes.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
});

test('发布 B 后仅在准备完成后提示；「稍后」保持 A 且不反复弹出', async ({ page }) => {
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);
  const nav0 = await navCount(page);

  await publishBAndWaitReady(page);

  // 就绪前不自动激活：仍在 A。
  expect(await currentBuildId(page)).toBe(buildA);

  await page.getByTestId('update-dismiss').click();
  await expect(page.getByTestId('update-banner')).toBeHidden();

  // 同一会话同一构建不再反复弹出；设置页仍可手动更新。
  await page.getByTestId('check-update').click();
  await expect
    .poll(async () => (await page.getByTestId('update-check-result').textContent()) ?? '', {
      timeout: 30_000,
    })
    .not.toContain('正在检查更新');
  await expect(page.getByTestId('update-check-result')).toContainText('稍后');
  await expect(page.getByTestId('update-banner')).toBeHidden();
  await expect(page.getByTestId('settings-update-accept')).toBeVisible();

  expect(await currentBuildId(page)).toBe(buildA);
  expect(await navCount(page)).toBe(nav0);
  expect(await waitingExists(page)).toBe(true);
});

test('安全页面接受更新：切换到 B 且仅刷新一次', async ({ page, request }) => {
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);
  const nav0 = await navCount(page);

  await publishBAndWaitReady(page);
  const versionB = await (await request.get('/version.json')).json();
  expect(versionB.buildId).not.toBe(buildA);

  await page.getByTestId('update-accept').click();

  // 升级成功的证据是构建身份变化，而非仅刷新。
  await expect.poll(() => currentBuildId(page), { timeout: 20_000 }).toBe(versionB.buildId);
  await expectAppLoaded(page);
  expect(await currentBuildLabel(page)).toBe('B');
  // 仅刷新一次。
  expect(await navCount(page)).toBe(nav0 + 1);
  await expect(page.getByTestId('update-banner')).toBeHidden();
});

test('未保存的编辑阻止更新且输入保留；关闭后可继续更新', async ({ page, request }) => {
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);
  const nav0 = await navCount(page);

  await publishBAndWaitReady(page);
  const versionB = await (await request.get('/version.json')).json();

  // 打开新建订单表单并输入未保存内容。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '订单' })
    .click();
  await page.getByRole('button', { name: '新建订单' }).first().click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('未保存草稿-勿丢');

  await page.getByTestId('update-accept').click();
  await expect(page.getByText(DIRTY_MESSAGE)).toBeVisible();

  // 不刷新、不丢输入。
  expect(await currentBuildId(page)).toBe(buildA);
  expect(await navCount(page)).toBe(nav0);
  await expect(editor.getByLabel('订单标题')).toHaveValue('未保存草稿-勿丢');

  // 取消表单后重试即可更新。
  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toBeHidden();
  await page.getByTestId('update-accept').click();
  await expect.poll(() => currentBuildId(page), { timeout: 20_000 }).toBe(versionB.buildId);
});

test('进行中的批量截图上传阻止更新；完成后可继续', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);

  // 建单：老板 → 账号 → 订单（附截图上传入口）。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '老板与账号' })
    .click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill('上传老板');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('上传老板').first().click();
  await page.getByRole('button', { name: '添加账号' }).first().click();
  const accountDialog = page.getByRole('dialog', { name: '添加游戏账号' });
  await accountDialog.getByLabel('游戏名称').fill('原神');
  await accountDialog.getByLabel('区服').fill('官服');
  await accountDialog.getByLabel('UID').fill('20002');
  await accountDialog.getByLabel('登录账号').fill('tester');
  await accountDialog.locator('input[type="password"]').fill('secret');
  await accountDialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('上传订单');
  await editor.getByLabel('本期价格（元）').fill('300');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').fill('每日签到');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '上传订单' })).toBeVisible();

  await publishBAndWaitReady(page);
  const versionB = await (await request.get('/version.json')).json();

  // 回到订单详情（发布检查后停在设置页）。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '老板与账号' })
    .click();
  await page.getByText('上传老板').first().click();
  await page.getByText('上传订单').first().click();
  await expect(page.getByRole('heading', { name: '上传订单' })).toBeVisible();

  // 批量上传大量截图（写入临时文件绕过 setInputFiles 的 50MB 缓冲限制），
  // 制造可观察的进行中窗口。
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'daigan-upload-'));
  try {
    const files = Array.from({ length: 150 }, (_, index) => {
      const filePath = path.join(uploadDir, `shot-${index}.png`);
      writeFileSync(filePath, Buffer.concat([PNG, Buffer.alloc(512 * 1024, index % 251)]));
      return filePath;
    });
    await photos.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByTestId('page-busy')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('update-accept').click();
  await expect(page.getByText(BUSY_MESSAGE)).toBeVisible();
  expect(await currentBuildId(page)).toBe(buildA);

  // 操作完成后重试即可更新。
  await expect(page.getByTestId('page-busy')).toBeHidden({ timeout: 120_000 });
  await page.getByTestId('update-accept').click();
  await expect.poll(() => currentBuildId(page), { timeout: 20_000 }).toBe(versionB.buildId);
  } finally {
  execFileSync('rm', ['-rf', uploadDir]);
  }
  });

test('其他应用标签页打开时阻止更新，关闭后可继续', async ({ page, context, request }) => {
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);

  await publishBAndWaitReady(page);
  const versionB = await (await request.get('/version.json')).json();

  const tab2 = await context.newPage();
  await tab2.goto('/');
  await expect(tab2.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await waitControlled(tab2);

  await page.getByTestId('update-accept').click();
  await expect(page.getByText(TABS_MESSAGE)).toBeVisible();
  expect(await currentBuildId(page)).toBe(buildA);

  await tab2.close();
  await page.getByTestId('update-accept').click();
  await expect.poll(() => currentBuildId(page), { timeout: 20_000 }).toBe(versionB.buildId);
});

test('构建 B 资源下载失败时 A 仍可用（含离线）', async ({ page, request }) => {
  await gotoApp(page);
  await waitControlled(page);
  const buildA = await currentBuildId(page);

  await publish(request, 'b');
  // 让 B 的必需资源全部失败，安装必须失败且不产生等待中的更新。
  const breakRes = await request.post('/__e2e/break?prefix=/assets/');
  expect(breakRes.ok()).toBeTruthy();

  await openSettings(page);
  await manualCheck(page);
  await expect(page.getByTestId('update-check-result')).toContainText('下载失败');
  await expect(page.getByTestId('update-banner')).toBeHidden();
  expect(await currentBuildId(page)).toBe(buildA);
  expect(await waitingExists(page)).toBe(false);

  // 失败后 A 离线仍可启动（hash 路由下停在 #/settings 也应正常）。
  await page.context().setOffline(true);
  await page.reload();
  await expectAppLoaded(page);
  expect(await currentBuildId(page)).toBe(buildA);
  await page.context().setOffline(false);
});

test('更新后 B 断网可用；业务资料与偏好保留；不误删其他缓存', async ({ page, request }) => {
  await gotoApp(page);
  await waitControlled(page);

  // 播种业务资料：老板/账号/订单/截图 + 动效偏好 + 无关缓存。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '老板与账号' })
    .click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill('保留老板');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('保留老板').first().click();
  await page.getByRole('button', { name: '添加账号' }).first().click();
  const accountDialog = page.getByRole('dialog', { name: '添加游戏账号' });
  await accountDialog.getByLabel('游戏名称').fill('原神');
  await accountDialog.getByLabel('区服').fill('官服');
  await accountDialog.getByLabel('UID').fill('30003');
  await accountDialog.getByLabel('登录账号').fill('tester');
  await accountDialog.locator('input[type="password"]').fill('secret');
  await accountDialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('保留订单');
  await editor.getByLabel('本期价格（元）').fill('300');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').fill('每日签到');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '保留订单' })).toBeVisible();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  await page
    .getByRole('dialog', { name: '截图', exact: true })
    .locator('input[type=file]')
    .setInputFiles([{ name: 'keep.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(page.getByRole('dialog', { name: '截图', exact: true }).locator('figure')).toHaveCount(1);
  await page.keyboard.press('Escape');

  await openSettings(page);
  await page.locator('input[name="motion"]').nth(1).check();
  await page.evaluate(async () => {
    const cache = await caches.open('unrelated-cache-e2e');
    await cache.put('/__e2e/state', new Response('keep-me'));
  });

  await publishBAndWaitReady(page);
  const versionB = await (await request.get('/version.json')).json();
  await page.getByTestId('update-accept').click();
  await expect.poll(() => currentBuildId(page), { timeout: 20_000 }).toBe(versionB.buildId);

  // B 离线可用。
  await page.context().setOffline(true);
  await page.reload();
  await expectAppLoaded(page);
  expect(await currentBuildId(page)).toBe(versionB.buildId);
  await page.context().setOffline(false);

  // 资料与截图仍在。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '老板与账号' })
    .click();
  await page.getByText('保留老板').first().click();
  await expect(page.getByText('保留订单')).toBeVisible();
  await page.getByText('保留订单').first().click();
  await expect(page.getByRole('heading', { name: '保留订单' })).toBeVisible();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '截图', exact: true }).locator('figure')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // 偏好仍在。
  await openSettings(page);
  await expect(page.locator('input[name="motion"]').nth(1)).toBeChecked();

  // 缓存清理只动本应用缓存。
  const cacheState = await page.evaluate(async () => {
    const keys = await caches.keys();
    const unrelated = await caches.open('unrelated-cache-e2e');
    return {
      appCaches: keys.filter((key) => key.startsWith('daigan-pwa-')),
      unrelatedExists: keys.includes('unrelated-cache-e2e'),
      unrelatedBody: await (await unrelated.match('/__e2e/state'))?.text(),
    };
  });
  expect(cacheState.unrelatedExists).toBe(true);
  expect(cacheState.unrelatedBody).toBe('keep-me');
  expect(cacheState.appCaches).toHaveLength(1);
});

test('手动检查区分已是最新 / 离线 / 检查失败', async ({ page, request }) => {
  await gotoApp(page);
  await waitControlled(page);

  // 离线：不谎报已是最新。
  await page.context().setOffline(true);
  await openSettings(page);
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('update-check-result')).toContainText('离线', { timeout: 15_000 });
  await page.context().setOffline(false);

  // 请求失败：报告检查失败。
  await request.post('/__e2e/break?prefix=/version.json');
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('update-check-result')).toContainText('检查更新失败', {
    timeout: 15_000,
  });

  // 恢复后才是「已是最新」。
  await request.post('/__e2e/heal');
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('update-check-result')).toContainText('已是最新', {
    timeout: 15_000,
  });
});

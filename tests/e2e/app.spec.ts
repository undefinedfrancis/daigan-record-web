import { expect, test, type Page } from '@playwright/test';

/** 1×1 PNG，用于截图上传用例。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function openOwners(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '老板与账号' })
    .click();
  await expect(page.getByRole('heading', { name: '老板与账号' })).toBeVisible();
}

async function createOwner(page: Page, nickname: string) {
  await openOwners(page);
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill(nickname);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(nickname).first()).toBeVisible();
  await page.getByText(nickname).first().click();
  await expect(page.getByRole('heading', { name: nickname })).toBeVisible();
}

async function createAccount(page: Page) {
  await page.getByRole('button', { name: '添加账号' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加游戏账号' });
  await dialog.getByLabel('游戏名称').fill('原神');
  await dialog.getByLabel('区服').fill('官服');
  await dialog.getByLabel('UID').fill('10001');
  await dialog.getByLabel('登录账号').fill('tester');
  await dialog.locator('input[type="password"]').fill('secret');
  await dialog.getByRole('button', { name: '添加资源' }).click();
  await dialog.getByLabel('资源名称').fill('原石');
  await dialog.getByLabel('资源数量').fill('1600');
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
}

test('空账本启动展示今日事项与主导航', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '订单' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '次导航' }).getByRole('button', { name: '资料与设置' }),
  ).toBeVisible();
});

test('账号独立模块：资源记录保存后回显并可再次编辑', async ({ page }) => {
  await page.goto('/');
  await createOwner(page, '测试老板');
  await createAccount(page);

  // 账号模块内分「游戏账号信息」与「订单」，资源记录展示在账号信息下。
  await expect(page.getByText('原石 ×1600')).toBeVisible();
  await expect(page.getByRole('heading', { name: /订单/ })).toBeVisible();
  await expect(page.getByText('该账号还没有订单')).toBeVisible();

  // 回归：再次打开编辑弹窗，资源记录必须回填（此前会被清空）。
  await page.getByRole('button', { name: '编辑' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑游戏账号' });
  await expect(dialog.getByLabel('资源名称')).toHaveValue('原石');
  await expect(dialog.getByLabel('资源数量')).toHaveValue('1600');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
});

test('下单、多张截图上传与老板页账号内订单展示', async ({ page }) => {
  await page.goto('/');
  await createOwner(page, '下单老板');
  await createAccount(page);

  // 账号模块内直接下单。
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('订单标题').fill('三月托管');
  // 每月刷新日 UI（新功能）：切到按月刷新并填写日号。
  await editor.getByLabel('刷新周期').selectOption('monthly');
  const monthDay = editor.getByRole('textbox', { name: '每月日号 1', exact: true });
  await expect(monthDay).toBeVisible();
  await monthDay.fill('15');
  await editor.getByLabel('本期价格（元）').fill('300');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').fill('每日签到');
  await editor.getByRole('button', { name: '创建订单' }).click();

  // 跳转订单详情。
  await expect(page.getByRole('heading', { name: '三月托管' })).toBeVisible();

  // 截图弹窗：一次选择多张，追加展示。
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  await photos.locator('input[type=file]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: PNG },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(photos.locator('figure')).toHaveCount(2);

  // 删除一张后剩余 1 张，关闭再打开仍为 1 张（持久化）。
  await photos.getByRole('button', { name: '删除截图' }).first().click();
  await expect(photos.locator('figure')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(photos).toBeHidden();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '截图', exact: true }).locator('figure'),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');

  // 修改弹窗回填每月刷新日。
  await page.getByRole('button', { name: '修改' }).click();
  const edit = page.getByRole('dialog', { name: '修改订单' });
  await expect(edit.getByLabel('刷新周期')).toHaveValue('monthly');
  await expect(
    edit.getByRole('textbox', { name: '每月日号 1', exact: true }),
  ).toHaveValue('15');
  await page.keyboard.press('Escape');

  // 老板页：订单挂在对应游戏账号模块下。
  await openOwners(page);
  await page.getByText('下单老板').first().click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /订单/ })).toContainText('1 张');
  await expect(page.getByText('三月托管')).toBeVisible();
});

test('弹窗昵称逐键输入不失焦（新建与改昵称）', async ({ page }) => {
  await page.goto('/');
  await openOwners(page);

  await page.getByRole('button', { name: '新建老板' }).first().click();
  const create = page.getByRole('dialog', { name: '新建老板' });
  const nickname = create.getByLabel('昵称');
  await expect(nickname).toBeFocused();
  // 逐键打字：焦点若被弹窗抢走，只会落下第一个字符。
  await nickname.pressSequentially('花生酱的事', { delay: 30 });
  await expect(nickname).toHaveValue('花生酱的事');
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('花生酱的事').first()).toBeVisible();

  await page.getByText('花生酱的事').first().click();
  await page.getByRole('button', { name: '改昵称' }).click();
  const rename = page.getByRole('dialog', { name: '修改老板昵称' });
  const renameInput = rename.getByLabel('昵称');
  await expect(renameInput).toBeFocused();
  await renameInput.fill('');
  await renameInput.pressSequentially('花生酱', { delay: 30 });
  await expect(renameInput).toHaveValue('花生酱');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '花生酱' })).toBeVisible();
});

/** 与业务同口径的「今天」：订单时区 Asia/Shanghai + 默认 05:00 刷新。 */
function gameToday(refreshMinutes = 300): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const base = Date.UTC(pick('year'), pick('month') - 1, pick('day'));
  const beforeRefresh = pick('hour') * 60 + pick('minute') < refreshMinutes;
  return new Date(base - (beforeRefresh ? 86_400_000 : 0)).toISOString().slice(0, 10);
}

function shiftDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

test('老板页订单日期后显示剩余到期天数', async ({ page }) => {
  const today = gameToday();
  const end = shiftDate(today, 40);

  await page.goto('/');
  await createOwner(page, '到期老板');
  await createAccount(page);

  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('四十天托管');
  await editor.getByLabel('服务模式').selectOption('dates');
  await editor.getByLabel('开始日期').fill(today);
  await editor.getByLabel('结束日期').fill(end);
  await editor.getByLabel('本期价格（元）').fill('200');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').fill('每日签到');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '四十天托管' })).toBeVisible();

  // 订单行：至 结束日 · 剩 N 天，N 与日历天数一致（首尾相减，不含起始当天）。
  await openOwners(page);
  await page.getByText('到期老板').first().click();
  const row = page.getByRole('button', { name: /四十天托管/ });
  await expect(row).toContainText(`至 ${end}`);
  await expect(row).toContainText(`剩 40 天`);
});

test('PWA：manifest 可访问、Service Worker 注册且断网可打开', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();

  // manifest 与图标可访问。
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(href).toContain('manifest.webmanifest');
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  const parsed = (await manifest.json()) as { name: string; icons: unknown[] };
  expect(parsed.name).toBe('代肝单据管理系统');
  expect(parsed.icons.length).toBeGreaterThanOrEqual(3);

  // Service Worker 注册并激活。
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.scriptURL ?? null;
      }),
    )
    .toContain('sw.js');

  // 重新加载让 SW 接管并缓存静态资源，然后断网仍可打开应用外壳。
  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await context.setOffline(false);
});

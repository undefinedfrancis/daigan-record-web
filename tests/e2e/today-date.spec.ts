import { expect, test, type Page } from '@playwright/test';

/** 今日事项日期（2026-10-27 用户反馈）：页头与订单卡片都要能看出是哪一天，方便返图。 */
test.use({ timezoneId: 'Asia/Shanghai' });

async function createOrder(page: Page) {
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill('返图老板');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('返图老板').first().click();

  await page.getByRole('button', { name: '添加账号' }).first().click();
  const account = page.getByRole('dialog', { name: '添加游戏账号' });
  await account.getByLabel('游戏名称').fill('绝区零');
  await account.getByLabel('区服').fill('官服');
  await account.getByLabel('UID').fill('3001');
  await account.getByLabel('登录账号').fill('acc-3001');
  await account.locator('input[type="password"]').fill('secret');
  await account.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();

  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('绝区零精托');
  await editor.getByLabel('本期价格（元）').fill('200');
  // 默认勾着「同时记录首笔收款」，金额为空会被校验拦住。
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('周常');
  await editor.getByRole('button', { name: '创建订单' }).click();

  // 创建后落在订单详情，回到今日事项看卡片组头。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '今日事项' })
    .click();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

test('今日事项页头显示公历日期与星期', async ({ page }) => {
  // 上海 2026-03-10 12:00：已过每日刷新时间，公历日与游戏日相同。
  await page.clock.install({ time: new Date('2026-03-10T04:00:00Z') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await expect(page.getByTestId('today-date')).toHaveText('2026年3月10日 星期二');
  await expect(page.getByText(/已完成 0\/0/)).toBeVisible();
});

test('刷新时间之前：日期仍是今天，并说明游戏日算前一天', async ({ page }) => {
  // 上海 2026-03-10 03:00，默认 05:00 刷新 → 游戏日还是 03-09。
  await page.clock.install({ time: new Date('2026-03-09T19:00:00Z') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await expect(page.getByTestId('today-date')).toHaveText('2026年3月10日 星期二');
  await expect(
    page.getByText('游戏日 2026-03-09（未到每日刷新时间，仍计前一天）'),
  ).toBeVisible();
});

test('订单卡片组头也带当天日期，单独截图同样能看出是哪天', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-03-10T04:00:00Z') });
  await page.goto('/');
  await createOrder(page);

  await expect(page.getByRole('button', { name: '绝区零精托' }).first()).toBeVisible();
  await expect(page.getByTestId('order-date').first()).toHaveText('3月10日 周二');
});

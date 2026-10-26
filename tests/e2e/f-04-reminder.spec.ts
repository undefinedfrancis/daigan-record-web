import { expect, test, type Page } from '@playwright/test';

// 设备本地时区固定，datetime-local 与弹窗时间才可断言。
test.use({ timezoneId: 'Asia/Shanghai' });

const GAME_START = new Date('2026-03-10T04:00:00Z'); // 上海 2026-03-10 12:00

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function createOrderWithTask(page: Page) {
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill('提醒老板');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('提醒老板').first().click();
  await page.getByRole('button', { name: '添加账号' }).first().click();
  const account = page.getByRole('dialog', { name: '添加游戏账号' });
  await account.getByLabel('游戏名称').fill('原神');
  await account.getByLabel('区服').fill('官服');
  await account.getByLabel('UID').fill('9602');
  await account.getByLabel('登录账号').fill('acc-9602');
  await account.locator('input[type="password"]').fill('secret');
  await account.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();

  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('开始日期').fill('2026-03-01');
  await editor.getByLabel('结束日期').fill('2026-03-31');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('日常');
  await editor.getByLabel('订单标题').fill('提醒托管');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '提醒托管' })).toBeVisible();
}

test('F-04：设置订单与任务提醒，到点打开网站弹窗，知道了不再重复', async ({ page }) => {
  await boot(page);
  await createOrderWithTask(page);

  // 订单级提醒：5 分钟后提醒收尾款。
  await page.getByRole('button', { name: '设提醒' }).click();
  let dialog = page.getByRole('dialog', { name: '设置提醒' });
  await dialog.getByLabel('提醒对象').selectOption({ label: '整笔订单' });
  await dialog.getByLabel('提醒时间').fill('2026-03-10T12:05');
  await dialog.getByLabel('提醒备注').fill('收尾款');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/已设置提醒/).first()).toBeVisible();
  await expect(page.getByText('未到点').first()).toBeVisible();

  // 任务级提醒：任务行上的铃铛进入，预选该任务。
  await page.getByRole('button', { name: '日常 提醒' }).click();
  dialog = page.getByRole('dialog', { name: '设置提醒' });
  await expect(dialog.getByLabel('提醒对象')).toHaveValue(/.+/);
  await dialog.getByLabel('提醒时间').fill('2026-03-10T12:06');
  await dialog.getByLabel('提醒备注').fill('交任务');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('任务：日常').first()).toBeVisible();

  // 到点后重新打开网站：两条提醒同时弹出。
  await page.clock.fastForward(7 * 60 * 1000);
  await page.reload();
  const due = page.getByRole('dialog', { name: '站内提醒' });
  await expect(due).toBeVisible();
  await expect(due.getByText('收尾款')).toBeVisible();
  await expect(due.getByText('任务：日常')).toBeVisible();
  await due.getByRole('button', { name: '全部知道了' }).click();
  await expect(due).toBeHidden();
  await expect(page.getByText('已提醒').first()).toBeVisible();

  // 已读的提醒不再重复弹出。
  await page.reload();
  await expect(page.getByRole('dialog', { name: '站内提醒' })).toBeHidden();
});

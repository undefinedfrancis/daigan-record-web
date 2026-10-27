import { expect, test, type Page } from '@playwright/test';

/**
 * 2026-10-26 用户反馈修复的浏览器生产路径证据：
 * - F-01：每月任务在其周期内仍可查看，非触发日补录归到触发日；
 * - F-02：收款可预填未来到账时间，到账前显示"待到账"且不冲抵待收；
 * - F-04：本周期任务按**老板**折叠（同一老板的多个归属日不拆组），收起状态本地记忆。
 */

const GAME_START = new Date('2026-03-10T04:00:00Z'); // 上海 12:00 → 游戏日 2026-03-10
const AFTER_TRIGGER = new Date('2026-03-16T04:00:00Z'); // 上海 12:00 → 游戏日 2026-03-16

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function createOwnerWithAccount(page: Page, ownerName: string) {
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill(ownerName);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(ownerName).first()).toBeVisible();
  await page.getByText(ownerName).first().click();
  await expect(page.getByRole('heading', { name: ownerName })).toBeVisible();

  await page.getByRole('button', { name: '添加账号' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加游戏账号' });
  await dialog.getByLabel('游戏名称').fill('原神');
  await dialog.getByLabel('区服').fill('官服');
  await dialog.getByLabel('UID').fill('9601');
  await dialog.getByLabel('登录账号').fill('acc-9601');
  await dialog.locator('input[type="password"]').fill('secret');
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
}

async function openOrderEditor(page: Page) {
  await page.getByRole('button', { name: '下单' }).click();
  const dialog = page.getByRole('dialog', { name: '新建订单' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createMonthlyHosting(page: Page, title: string) {
  const editor = await openOrderEditor(page);
  await editor.getByLabel('结束日期').fill('2026-03-31');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('月度大活动');
  await editor.getByLabel('重复周期').first().selectOption('MONTHLY');
  await editor.getByRole('textbox', { name: '每月日号 1' }).fill('15');
  await editor.getByLabel('订单标题').fill(title);
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

function dayCell(page: Page, day: string) {
  return page.locator('button.day-cell').filter({ hasText: new RegExp(`^${day}$`) });
}

test('F-01：非触发日仍能看到本周期任务，补录归到触发日', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '周老板');
  await createMonthlyHosting(page, '月度托管');

  // 触发日当天是正常任务。
  await dayCell(page, '15').click();
  await expect(page.getByRole('button', { name: /月度大活动/ }).first()).toBeVisible();

  // 推进到 03-16：不是触发日，但仍在 03-15 起的周期窗口内。
  await page.clock.setSystemTime(AFTER_TRIGGER);
  await page.getByRole('button', { name: '刷新' }).first().click();
  await dayCell(page, '16').click();
  const windowTask = page.getByRole('button', { name: /本周期 03-15 · 月度大活动/ });
  await expect(windowTask).toBeVisible();
  await windowTask.click();
  await expect(page.getByRole('button', { name: /✓ 本周期 03-15 · 月度大活动/ })).toBeVisible();

  // 触发日格子也同步为已完成（同一个 occurrence）。
  await dayCell(page, '15').click();
  await expect(page.getByRole('button', { name: /✓ 月度大活动/ })).toBeVisible();
});

/** 一单两个每月任务（触发日 5 号 / 15 号）：验证「本周期任务」不会按归属日拆折叠。 */
async function createTwoMonthlyTasks(page: Page, title: string) {
  const editor = await openOrderEditor(page);
  // 开始日要早于 5 号触发日，否则 03-05 那一期早于期次开始日、根本不会进本周期窗口。
  await editor.getByLabel('开始日期').fill('2026-03-01');
  await editor.getByLabel('结束日期').fill('2026-03-31');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();

  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('月初活动');
  await editor.getByLabel('重复周期').first().selectOption('MONTHLY');
  await editor.getByRole('textbox', { name: '每月日号 1' }).fill('5');

  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').nth(1).fill('月中活动');
  await editor.getByLabel('重复周期').nth(1).selectOption('MONTHLY');
  await editor.getByRole('textbox', { name: '每月日号 1' }).nth(1).fill('15');

  await editor.getByLabel('订单标题').fill(title);
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('F-04：本周期任务按老板折叠（多个归属日同一个折叠），收起状态刷新后保留', async ({
  page,
}) => {
  await boot(page);
  await createOwnerWithAccount(page, '折叠老板');
  await createTwoMonthlyTasks(page, '折叠托管');

  // 03-16：两个触发日（03-05、03-15）都已过，两条任务进入本周期卡片。
  await page.clock.setSystemTime(AFTER_TRIGGER);
  await page.getByRole('button', { name: '今日事项' }).click();
  await expect(page.getByRole('heading', { name: '本周期任务' })).toBeVisible();

  // 一个老板只留一个折叠：不会因为归属日不同被拆成两个。
  const fold = page.getByRole('button', { name: /「#1 折叠老板」本周期任务$/ });
  await expect(fold).toHaveCount(1);
  await expect(fold).toHaveAttribute('aria-expanded', 'true');

  const earlyTask = page.getByRole('checkbox', { name: '月初活动 未达成' });
  const lateTask = page.getByRole('checkbox', { name: '月中活动 未达成' });
  await expect(earlyTask).toBeVisible();
  await expect(lateTask).toBeVisible();
  // 组内仍按「版本 + 归属日」分小标题，避免补录日期看混。
  await expect(page.getByText(/归属 2026-03-05/)).toBeVisible();
  await expect(page.getByText(/归属 2026-03-15/)).toBeVisible();

  // 收起：只剩组头，两条任务都不渲染。
  await fold.click();
  await expect(earlyTask).toHaveCount(0);
  await expect(lateTask).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '本周期任务' })).toBeVisible();

  // 刷新后仍保持收起（localStorage 记忆）。
  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  const reopen = page.getByRole('button', { name: /「#1 折叠老板」本周期任务$/ });
  await expect(reopen).toHaveCount(1);
  await expect(reopen).toHaveAttribute('aria-expanded', 'false');
  await expect(earlyTask).toHaveCount(0);

  // 再点一次恢复展开，任务可继续勾选。
  await reopen.click();
  await expect(earlyTask).toBeVisible();
  await expect(lateTask).toBeVisible();
});

test('F-02：未来到账时间可保存为待到账，不冲抵待收', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '闲鱼老板');
  await createMonthlyHosting(page, '担保交易托管');

  await page.getByRole('button', { name: '记录收款' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('金额（元）').fill('30');
  await dialog.getByLabel('到账时间').fill('2026-04-01T12:00');
  await dialog.getByRole('button', { name: '记录收款' }).click();

  await expect(page.getByText('待到账').first()).toBeVisible();
  await expect(page.getByText(/待到账 ¥30\.00/).first()).toBeVisible();
  await expect(page.getByText(/实收 ¥0\.00 · 待收 ¥100\.00/)).toBeVisible();
});

test('F-03：日历多选一次补录多个日期', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '迁移老板');

  const editor = await openOrderEditor(page);
  await editor.getByLabel('开始日期').fill('2026-03-01');
  await editor.getByLabel('结束日期').fill('2026-03-31');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('每日签到');
  await editor.getByLabel('订单标题').fill('迁移托管');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '迁移托管' })).toBeVisible();

  // 多选三个历史日期（今天是 03-10），一次性补录。
  await page.getByRole('button', { name: '多选日期批量完成' }).click();
  await dayCell(page, '1').click();
  await dayCell(page, '2').click();
  await dayCell(page, '3').click();
  await expect(page.getByText('已选 3 天 · 待完成 3 项')).toBeVisible();
  await page.getByRole('button', { name: /完成所选/ }).click();

  // 时钟被 install 后会冻结 toast 的自动消失，按文本定位本次结果而不是靠 role=status 唯一。
  await expect(page.getByText('已补录 3 天 · 3 项完成')).toBeVisible();
  // 落库后日期格变为已完成，单日面板显示带补录标记的打卡。
  await expect(dayCell(page, '1')).toHaveClass(/day-cell-done/);
  await dayCell(page, '2').click();
  await expect(page.getByRole('button', { name: /✓ 每日签到（补录）/ })).toBeVisible();

  // 全选未完成只挑仍有待做事项的历史/今日日期（03-04～03-10 共 7 天）。
  await page.getByRole('button', { name: '多选日期批量完成' }).click();
  await page.getByRole('button', { name: /全选未完成/ }).click();
  await expect(page.getByText('已选 7 天 · 待完成 7 项')).toBeVisible();
  // 未来日期不可选：03-11 的格子被禁用。
  await expect(dayCell(page, '11')).toBeDisabled();
  await page.getByRole('button', { name: '退出多选' }).click();
  await expect(page.getByText(/已选 .* 天/)).toBeHidden();
});

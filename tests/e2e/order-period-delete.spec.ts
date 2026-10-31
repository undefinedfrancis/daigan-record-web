import { expect, test, type Page } from '@playwright/test';

/**
 * 2026-10-31 用户反馈：「这个续期的第二期能删除吗？没找到」。
 *
 * 浏览器生产路径证据：
 * - 误续期产生的尾部期次可以在「修改订单」里整期删除（含该期任务），保存后期次与今日事项回退；
 * - 该期已有收款时删除入口禁用，避免把收款流水删成悬空。
 */

const GAME_START = new Date('2026-03-10T04:00:00Z'); // 上海 12:00 → 游戏日 2026-03-10

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
  await dialog.getByLabel('UID').fill('9701');
  await dialog.getByLabel('登录账号').fill('acc-9701');
  await dialog.locator('input[type="password"]').fill('secret');
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
}

/** 建一张 03-10 ~ 03-31 的托管单（今日未到期，续期即"提前续期"）。 */
async function createHostingOrder(page: Page, title: string) {
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('结束日期').fill('2026-03-31');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('每日签到');
  await editor.getByLabel('订单标题').fill(title);
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** 续期 30 天：新期从 04-01 开始（今日未到期，属提前续期，不截断当前期）。 */
async function renewThirtyDays(page: Page) {
  await page.getByRole('button', { name: '续期', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '续期' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/续期天数/).fill('30');
  await dialog.getByLabel('新期价格（元）').fill('100');
  await dialog.getByRole('button', { name: '确认续期' }).click();
  await expect(page.getByText('已续期')).toBeVisible();
  await expect(page.getByText(/^2 期$/)).toBeVisible();
}

function editDialog(page: Page) {
  return page.getByRole('dialog', { name: '修改订单' });
}

test('误续期的第二期可以在修改订单里整期删除', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '误续老板');
  await createHostingOrder(page, '误续托管');
  await renewThirtyDays(page);

  await page.getByRole('button', { name: '修改', exact: true }).click();
  const dialog = editDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('第 2 期', { exact: true })).toBeVisible();

  // 删除入口只在最后一期出现，并需要二次确认。
  const remove = dialog.getByRole('button', { name: /删除本期/ });
  await expect(remove).toHaveCount(1);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(dialog.getByText(/将删除第 2 期/)).toBeVisible();
  await dialog.getByRole('button', { name: '确认删除' }).click();
  await expect(dialog.getByText(/已标记删除 1 期/)).toBeVisible();
  await expect(dialog.getByText('第 2 期', { exact: true })).toHaveCount(0);

  // 撤销标记：期次与任务分组原样回来，再删一次并保存。
  await dialog.getByRole('button', { name: '撤销删除' }).click();
  await expect(dialog.getByText('第 2 期', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/已标记删除 1 期/)).toHaveCount(0);
  await dialog.getByRole('button', { name: /删除本期/ }).click();
  await dialog.getByRole('button', { name: '确认删除' }).click();

  await dialog.getByRole('button', { name: '保存修改' }).click();
  await expect(page.getByText('订单已更新')).toBeVisible();

  // 期次回到 1 期，该期任务随期次一起消失。
  await expect(page.getByText(/^1 期$/)).toBeVisible();
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(editDialog(page).getByText('第 2 期', { exact: true })).toHaveCount(0);
  await expect(editDialog(page).getByText('第 1 期', { exact: true })).toBeVisible();

  // 刷新后仍是 1 期（已落库，不是仅前端隐藏）。
  await page.reload();
  await expect(page.getByRole('heading', { name: '误续托管' })).toBeVisible();
  await expect(page.getByText(/^1 期$/)).toBeVisible();
});

test('续期期次已有收款时删除入口禁用', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '收过款老板');
  await createHostingOrder(page, '收款托管');
  await renewThirtyDays(page);

  await page.getByRole('button', { name: '记录收款' }).first().click();
  const receipt = page.getByRole('dialog');
  await receipt.getByLabel('收款期次').selectOption({ index: 1 });
  await receipt.getByLabel('金额（元）').fill('10');
  await receipt.getByRole('button', { name: '记录收款' }).click();
  await expect(receipt).toBeHidden();

  await page.getByRole('button', { name: '修改', exact: true }).click();
  const dialog = editDialog(page);
  const remove = dialog.getByRole('button', { name: /删除本期/ });
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute('title', '本期已有收款，不能删除');
});

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 任务手动排序（2026-10-27 用户反馈）。
 *
 * 反馈原话：同一个任务里内容一样，条目顺序却各不相同，希望能自己排。
 * 这里覆盖三条用户路径：今日事项的按钮排序、今日事项的拖拽排序、订单编辑页排序后回到今日事项。
 */
test.use({ timezoneId: 'Asia/Shanghai' });

const ORDER_TITLE = '铁臂全托';

async function gotoToday(page: Page) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '今日事项' })
    .click();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  // 查询是异步的：卡片出现才代表数据到位，避免读到空列表。
  await expect(card(page)).toBeVisible();
}

async function createOrderWithTasks(page: Page, titles: string[]) {
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill('排序老板');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('排序老板').first().click();

  await page.getByRole('button', { name: '添加账号' }).first().click();
  const account = page.getByRole('dialog', { name: '添加游戏账号' });
  await account.getByLabel('游戏名称').fill('绝区零');
  await account.getByLabel('区服').fill('官服');
  await account.getByLabel('UID').fill('3002');
  await account.getByLabel('登录账号').fill('acc-3002');
  await account.locator('input[type="password"]').fill('secret');
  await account.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();

  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill(ORDER_TITLE);
  await editor.getByLabel('本期价格（元）').fill('200');
  await editor.getByRole('checkbox').uncheck();
  for (let index = 0; index < titles.length; index += 1) {
    await editor.getByRole('button', { name: '添加任务' }).first().click();
  }
  for (let index = 0; index < titles.length; index += 1) {
    await editor.getByLabel('任务标题').nth(index).fill(titles[index]);
  }
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: ORDER_TITLE })).toBeVisible();
  await gotoToday(page);
}

function card(page: Page): Locator {
  return page.getByTestId('today-order-card').filter({ hasText: ORDER_TITLE }).first();
}

async function readTitles(rows: Locator): Promise<string[]> {
  const count = await rows.count();
  const titles: string[] = [];
  for (let index = 0; index < count; index += 1) {
    titles.push((await rows.nth(index).innerText()).split('\n')[0].trim());
  }
  return titles;
}

function normalTitles(page: Page): Promise<string[]> {
  return readTitles(card(page).getByTestId('today-task-row'));
}

function sortTitles(page: Page): Promise<string[]> {
  return readTitles(card(page).getByTestId('today-sort-title'));
}

/** 排序是写库 + 重新查询，断言必须轮询等待，不能读一次 DOM 就下结论。 */
async function expectNormalTitles(page: Page, expected: string[]) {
  await expect.poll(() => normalTitles(page), { timeout: 10_000 }).toEqual(expected);
}

async function expectSortTitles(page: Page, expected: string[]) {
  await expect.poll(() => sortTitles(page), { timeout: 10_000 }).toEqual(expected);
}

test('今日事项：按钮上移后顺序改变，且刷新后仍然保持', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-03-10T04:00:00Z') });
  await page.goto('/');
  await createOrderWithTasks(page, ['体力', '日常', '副本']);

  await expectNormalTitles(page, ['体力', '日常', '副本']);

  await card(page).getByRole('button', { name: `调整「${ORDER_TITLE}」任务顺序` }).click();
  await expectSortTitles(page, ['体力', '日常', '副本']);

  // 把「副本」一路移到最前。
  await card(page).getByRole('button', { name: '副本 上移' }).click();
  await expectSortTitles(page, ['体力', '副本', '日常']);
  await card(page).getByRole('button', { name: '副本 上移' }).click();
  await expectSortTitles(page, ['副本', '体力', '日常']);

  // 退出排序模式，普通行也按新顺序显示。
  await card(page).getByRole('button', { name: `结束「${ORDER_TITLE}」排序` }).click();
  await expectNormalTitles(page, ['副本', '体力', '日常']);

  // 重新加载（IndexedDB 持久化）后顺序不变。
  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await expectNormalTitles(page, ['副本', '体力', '日常']);
});

test('今日事项：拖动条目的手柄即可排序', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-03-10T04:00:00Z') });
  await page.goto('/');
  await createOrderWithTasks(page, ['体力', '日常', '副本']);

  await card(page).getByRole('button', { name: `调整「${ORDER_TITLE}」任务顺序` }).click();
  await expectSortTitles(page, ['体力', '日常', '副本']);

  const handles = card(page).locator('[data-sortable-handle]');
  const rows = card(page).locator('[data-sortable-item]');
  const handleBox = await handles.first().boundingBox();
  const targetBox = await rows.nth(2).boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!handleBox || !targetBox) return;

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  // 拖到第三行中线下：落点应为最后一位。
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    targetBox.y + targetBox.height / 2 + 4,
    { steps: 10 },
  );
  await page.mouse.up();

  await expectSortTitles(page, ['日常', '副本', '体力']);

  await page.reload();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  await expectNormalTitles(page, ['日常', '副本', '体力']);
});

test('订单编辑页调整顺序并保存后，今日事项同步换序', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-03-10T04:00:00Z') });
  await page.goto('/');
  await createOrderWithTasks(page, ['体力', '日常', '副本']);

  await card(page).getByRole('button', { name: ORDER_TITLE, exact: true }).click();
  await expect(page.getByRole('heading', { name: ORDER_TITLE })).toBeVisible();
  await page.getByRole('button', { name: '修改' }).click();
  const edit = page.getByRole('dialog', { name: '修改订单' });
  await expect(edit).toBeVisible();

  await edit.getByRole('button', { name: '下移任务' }).first().click();
  await edit.getByRole('button', { name: '保存修改' }).click();
  await expect(edit).toBeHidden();

  await gotoToday(page);
  await expectNormalTitles(page, ['日常', '体力', '副本']);
});

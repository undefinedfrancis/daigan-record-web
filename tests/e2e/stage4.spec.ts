import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 4 聚焦浏览器套件（六条连贯流程）。
 *
 * - 每条流程使用独立的浏览器上下文（干净的本机资料），不接触真实用户数据；
 * - 时钟用 `page.clock` 控制：跨"每日 05:00 游戏刷新"时推进真实 epoch，
 *   而不是改一个日期字符串；
 * - 流程 4/5 是阶段 4 验收修复（R1–R4）的**生产 UI 路径**证据：
 *   较早日期未取代的观测经历史更正、已移除累计任务按其历史轮次补记与撤回；
 * - 流程 6 是 R5 的**生产 UI 路径**证据：订单与期次的刷新点不同时，累计提交的
 *   归属日取自 scope 自己的日历（订单详情 + 今日事项两条路径）；
 * - 已移除状态与期次刷新快照差异都是安卓端写入的数据（网页端没有对应操作），
 *   因此流程 5/6 的前置条件直接写入隔离的 IndexedDB；被验证的动作本身全部走生产界面。
 * - 只跑这一个套件，不重复跑历史 e2e。
 */

const GAME_START = new Date('2026-03-10T04:00:00Z'); // 上海 12:00 → 游戏日 2026-03-10
const BEFORE_REFRESH = new Date('2026-03-10T20:30:00Z'); // 上海 03-11 04:30 → 仍是游戏日 03-10
const AFTER_REFRESH = new Date('2026-03-10T21:30:00Z'); // 上海 03-11 05:30 → 游戏日 03-11
const BETWEEN_REFRESH = new Date('2026-03-10T19:00:00Z'); // 上海 03-11 03:00 → 落在两个刷新点之间
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage4');

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function openTemplates(page: Page) {
  await page.getByRole('button', { name: '模板库' }).click();
  await expect(page.getByRole('heading', { name: '模板库' })).toBeVisible();
}

async function createTemplateWithTitle(page: Page) {
  await openTemplates(page);
  await page.getByRole('button', { name: '新建模板' }).click();
  const dialog = page.getByRole('dialog', { name: '新建模板' });
  await dialog.getByLabel('游戏名称').fill('原神');
  await dialog.getByLabel(/默认订单标题/).fill('自动带入标题');
  await dialog.getByLabel('任务标题').first().fill('抽卡');
  await dialog.getByLabel('进度类型').first().selectOption('NUMERIC');
  await dialog.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  await dialog.getByLabel('目标').first().fill('100');
  await dialog.getByRole('button', { name: '保存模板' }).click();
  await expect(dialog).toBeHidden();
}

async function createOwnerWithAccount(
  page: Page,
  ownerName: string,
  options: { category?: string; uid?: string } = {},
) {
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
  await dialog.getByLabel('UID').fill(options.uid ?? '9001');
  await dialog.getByLabel('登录账号').fill(`acc-${options.uid ?? '9001'}`);
  await dialog.locator('input[type="password"]').fill('secret');
  if (options.category) {
    await dialog.getByRole('button', { name: '新建账号分类' }).click();
    await dialog.getByLabel('新分类名称').fill(options.category);
    await dialog.getByRole('button', { name: '创建并选用' }).click();
  }
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
}

async function openOrderEditor(page: Page) {
  await page.getByRole('button', { name: '下单' }).click();
  const dialog = page.getByRole('dialog', { name: '新建订单' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 直接读取当前隔离数据集（只用于断言持久化结果，不参与被验证的动作）。 */
async function readDataset(
  page: Page,
  stores: string[],
): Promise<Record<string, Array<Record<string, unknown>>>> {
  return page.evaluate(async (names) => {
    const databases = await indexedDB.databases();
    const name = databases
      .map((database) => database.name ?? '')
      .find((value) => value.startsWith('daigan-data-'));
    if (!name) throw new Error('dataset database not found');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result: Record<string, unknown[]> = {};
    for (const store of names) {
      result[store] = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
    }
    db.close();
    return result as Record<string, Array<Record<string, unknown>>>;
  }, stores);
}

/**
 * 流程 5 的前置条件：把某个任务标记为"已移除"。
 *
 * 网页端没有移除任务的操作（这是安卓端写入的数据），因此这里直接写隔离数据集的
 * `task_definitions.retiredAt`。被验证的补记/撤回动作仍然全部走生产界面。
 */
async function retireTaskByTitle(page: Page, title: string, retiredAt: number): Promise<void> {
  await page.evaluate(
    async ({ taskTitle, stamp }) => {
      const databases = await indexedDB.databases();
      const name = databases
        .map((database) => database.name ?? '')
        .find((value) => value.startsWith('daigan-data-'));
      if (!name) throw new Error('dataset database not found');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('task_definitions', 'readwrite');
        const store = tx.objectStore('task_definitions');
        const request = store.getAll();
        request.onsuccess = () => {
          for (const row of request.result as Array<Record<string, unknown>>) {
            if (row.title === taskTitle) store.put({ ...row, retiredAt: stamp });
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { taskTitle: title, stamp: retiredAt },
  );
}

/**
 * 流程 6 的前置条件：把某订单的**期次**刷新点改成与订单不同的值。
 *
 * 安卓续期/恢复可以留下这种快照差异（期次写自己的 `gameZoneId/dailyRefreshMinutes`），
 * 网页端没有编辑期次刷新点的操作，因此这里直接写隔离数据集。被验证的提交动作仍然
 * 全部走生产界面。
 */
async function patchPeriodRefresh(
  page: Page,
  orderTitle: string,
  minutes: number,
): Promise<void> {
  await page.evaluate(
    async ({ title, refresh }) => {
      const databases = await indexedDB.databases();
      const name = databases
        .map((database) => database.name ?? '')
        .find((value) => value.startsWith('daigan-data-'));
      if (!name) throw new Error('dataset database not found');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const readAll = <T>(store: string) =>
        new Promise<T[]>((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const request = tx.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as T[]);
          request.onerror = () => reject(request.error);
        });
      const orders = await readAll<{ id: string; title: string }>('orders');
      const target = orders.find((row) => row.title === title);
      if (!target) throw new Error(`order not found: ${title}`);
      const periods = await readAll<{ id: string; orderId: string }>('hosting_periods');
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('hosting_periods', 'readwrite');
        const store = tx.objectStore('hosting_periods');
        for (const row of periods) {
          if (row.orderId === target.id) store.put({ ...row, dailyRefreshMinutes: refresh });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { title: orderTitle, refresh: minutes },
  );
}

/** 流程 6：建一张只有一个累计任务、指定每日刷新点的计次订单。 */
async function createCumulativeOrder(
  page: Page,
  options: { title: string; taskTitle: string; dailyRefresh: string },
): Promise<void> {
  const editor = await openOrderEditor(page);
  await editor.getByLabel('每日刷新时间').fill(options.dailyRefresh);
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('50');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill(options.taskTitle);
  await editor.getByLabel('进度类型').first().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').first().fill('100');
  await editor.getByLabel('订单标题').fill(options.title);
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: options.title })).toBeVisible();
}

async function openOrderFromList(page: Page, title: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.getByText(title).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('流程1：模板标题 → 分类账号 → 计次订单 → 跨刷新累计 → 重启 → 加密导出', async ({
  page,
}) => {
  await boot(page);
  await createTemplateWithTitle(page);
  await createOwnerWithAccount(page, '流程老板', { category: '流程分类', uid: '9001' });

  const editor = await openOrderEditor(page);
  await editor.getByLabel('套用模板').selectOption({ label: '原神 · 2026.10' });
  // UF-036：模板默认标题自动带入（来源是显式状态，不是字符串比较）。
  await expect(editor.getByLabel('订单标题')).toHaveValue('自动带入标题');
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('1');
  await editor.getByLabel('本期价格（元）').fill('100');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '自动带入标题' })).toBeVisible();

  // UF-038：输入的是"当前累计总值"，10 之后在**次日**再记 20，结果 20（不是 30）。
  const input = page.getByLabel('抽卡 当前累计总值');
  await input.fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText(/10 \/ 100/).first()).toBeVisible();

  // 跨"游戏日刷新"：先推进到刷新前（仍是 03-10），再推进到刷新后（03-11）。
  await page.clock.setSystemTime(BEFORE_REFRESH);
  await page.getByRole('button', { name: '今日事项' }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText(/游戏日 2026-03-10/)).toBeVisible();
  await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('10');

  await page.clock.setSystemTime(AFTER_REFRESH);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText(/游戏日 2026-03-11/)).toBeVisible();
  // 刷新后值不重置。
  await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('10');

  // 新的一天继续记录当前总值：10 → 20，仍是 20。
  await page.getByRole('button', { name: '自动带入标题' }).first().click();
  await expect(page.getByRole('heading', { name: '自动带入标题' })).toBeVisible();
  await page.getByLabel('抽卡 当前累计总值').fill('20');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();
  await expect(page.getByText(/30 \/ 100/)).toHaveCount(0);

  // 浏览器重启（整页重载）后总值与两天的事件历史仍在。
  await page.reload();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.getByText('自动带入标题').first().click();
  await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('20');
  // 历史行带轮次标签：两天的绝对值快照都能区分归属（R2 起）。
  await expect(page.getByText(/2026-03-10 · 第 1 次打卡 · 记录 · 10/)).toBeVisible();
  await expect(page.getByText(/2026-03-11 · 第 1 次打卡 · 记录 · 20/)).toBeVisible();

  // 生产加密导出：真实下载文件 + 记录哈希（供证据索引）。
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await page.getByRole('button', { name: '资料与设置' }).click();
  await page.getByLabel('密码（可选）').fill('stage4-browser-password');
  await page.getByLabel('确认密码').fill('stage4-browser-password');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出完整备份' }).click(),
  ]);
  const target = path.join(OUTPUT_DIR, 'stage4-browser-encrypted.dgbk');
  await download.saveAs(target);
  const bytes = readFileSync(target);
  expect(bytes.length).toBeGreaterThan(500);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(`browser encrypted export: ${bytes.length} bytes sha256=${sha256}`);
});

test('流程2：累计历史更正/撤销 → 完成态与轮次重新打开', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '更正老板', { uid: '9100' });
  const editor = await openOrderEditor(page);
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('1');
  await editor.getByLabel('本期价格（元）').fill('50');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('抽卡');
  await editor.getByLabel('进度类型').first().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').first().fill('10');
  await editor.getByLabel('订单标题').fill('更正流程');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '更正流程' })).toBeVisible();

  const input = page.getByLabel('抽卡 当前累计总值');
  await input.fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('已达标').first()).toBeVisible();
  await expect(page.getByText(/第 1 次打卡 · .* 已完成/).first()).toBeVisible();

  // 更正为更低值：重开完成态（历史追加，不覆盖）。
  await page.getByRole('button', { name: '更正', exact: true }).first().click();
  await page.getByLabel('更正为').fill('4');
  await page.getByRole('button', { name: '保存更正' }).click();
  await expect(page.getByText('未达标').first()).toBeVisible();
  await expect(page.getByText(/4 \/ 10/).first()).toBeVisible();
  await expect(page.getByText(/第 1 次打卡 · .* 未完成/).first()).toBeVisible();

  // 撤销"更正"这条观测：撤回**不复活**被取代的旧值（契约 D-30），回到起始值 0。
  await page.getByRole('button', { name: '撤销', exact: true }).first().click();
  await expect(page.getByText('未达标').first()).toBeVisible();
  await expect(page.getByText(/0 \/ 10/).first()).toBeVisible();

  // 轮次已按证据重开，可以重新记录当前总值 10 → 完成态再次成立。
  await page.getByLabel('抽卡 当前累计总值').fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('已达标').first()).toBeVisible();
});

test('流程3：分类删除/改派保留账号与订单；窄屏可用', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '分类甲', { category: '长期客户', uid: '9201' });

  // 同一账号下一张订单，用于验证删分类不影响订单。
  const editor = await openOrderEditor(page);
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('80');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('签到');
  await editor.getByLabel('订单标题').fill('分类流程订单');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '分类流程订单' })).toBeVisible();

  await createOwnerWithAccount(page, '分类乙', { uid: '9202' });
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByRole('button', { name: '按账号' }).click();
  await expect(page.getByText(/UID 9201/)).toBeVisible();
  await expect(page.getByText(/UID 9202/)).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: 'UID 9201' }).getByText('长期客户').first(),
  ).toBeVisible();

  // 改派：把 9202 也归入同一分类（行内 Badge 立即反映，身份仍是 accountId）。
  await page
    .locator('li')
    .filter({ hasText: 'UID 9202' })
    .getByLabel('调整 原神 官服 分类')
    .selectOption({ label: '长期客户' });
  await expect(
    page.locator('li').filter({ hasText: 'UID 9202' }).getByText('长期客户').first(),
  ).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: 'UID 9201' }).getByText('长期客户').first(),
  ).toBeVisible();

  // 删除分类：两个账号都保留为未分类，订单仍在。
  await page.getByRole('button', { name: '管理分类' }).click();
  const managing = page.getByRole('dialog', { name: '管理账号分类' });
  await managing.getByRole('button', { name: '删除' }).first().click();
  await managing.getByRole('button', { name: '确认删除' }).click();
  await expect(managing.getByText('还没有分类。')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/UID 9201/)).toBeVisible();
  await expect(page.getByText(/UID 9202/)).toBeVisible();
  // 分类删除后账号仍在，只是分类选择回到未分类（''）。
  await expect(page.getByLabel('调整 原神 官服 分类').first()).toHaveValue('');
  await expect(page.getByLabel('调整 原神 官服 分类').last()).toHaveValue('');

  await page.getByRole('button', { name: '按老板查看' }).click();
  await page.getByText('分类甲').first().click();
  await expect(page.getByText('分类流程订单').first()).toBeVisible();

  // 窄屏检查一次：账号视图与分类操作仍可达，且没有横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('navigation', { name: '底部导航' })
    .getByRole('button', { name: '老板' })
    .click();
  await page.getByRole('button', { name: '按账号' }).click();
  await expect(page.getByText(/UID 9201/)).toBeVisible();
  await expect(page.getByRole('button', { name: '管理分类' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('流程4：较早日期未取代的观测可经历史更正，当前总值仍由更晚的快照决定', async ({
  page,
}) => {
  await boot(page);
  await createOwnerWithAccount(page, '历史老板', { uid: '9301' });
  const editor = await openOrderEditor(page);
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('60');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('抽卡');
  await editor.getByLabel('进度类型').first().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').first().fill('100');
  await editor.getByLabel('订单标题').fill('历史更正流程');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '历史更正流程' })).toBeVisible();

  // 游戏日 day1：记录当前累计总值 10。
  await page.getByLabel('抽卡 当前累计总值').fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 记录 · 10')).toBeVisible();

  // 跨"游戏日刷新"到 day2：同一轮次继续，记录 20（绝对值，不是增量）。
  await page.clock.setSystemTime(AFTER_REFRESH);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.getByText('历史更正流程').first().click();
  await expect(page.getByRole('heading', { name: '历史更正流程' })).toBeVisible();
  await page.getByLabel('抽卡 当前累计总值').fill('20');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-11 · 第 1 次打卡 · 记录 · 20')).toBeVisible();
  await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();

  // day1 的事件已被 day2 的绝对值"盖住"（不再是当前总值），但它从未被取代，
  // 因此仍可在自己的历史行里更正 —— 这正是 R2 修复前的死角。
  const day1Row = page
    .locator('li[data-testid="cumulative-history-row"]')
    .filter({ hasText: '2026-03-10 · 第 1 次打卡 · 记录 · 10' });
  await day1Row.getByRole('button', { name: '更正', exact: true }).click();
  await page.getByLabel('更正为').fill('15');
  await page.getByRole('button', { name: '保存更正' }).click();

  // 历史行改变（新增更正事件、原行标记被取代），当前总值仍是 20。
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 更正 · 15')).toBeVisible();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 记录 · 10')).toBeVisible();
  await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();
  await expect(page.getByLabel('抽卡 当前累计总值')).toHaveValue('20');
  await expect(page.getByText('已被更正').first()).toBeVisible();
  await expect(page.getByText('当前有效').first()).toBeVisible();

  const dataset = await readDataset(page, ['task_progress_events', 'hosting_sessions']);
  const events = dataset.task_progress_events;
  expect(events).toHaveLength(3);
  const correction = events.find((row) => row.kind === 'CORRECT')!;
  expect(correction.gameDate).toBe('2026-03-10');
  expect(correction.totalValue).toBe('15');
  expect(dataset.hosting_sessions).toHaveLength(1);
});

test('流程5：已移除累计任务可按其历史轮次补记首次观测，并可撤回重开', async ({ page }) => {
  await boot(page);
  await createOwnerWithAccount(page, '退休老板', { uid: '9401' });
  const editor = await openOrderEditor(page);
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('70');
  await editor.getByRole('checkbox').uncheck();
  // 打卡任务（保持默认勾选进度类型），用于建立第 1 轮。
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').last().fill('签到');
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').last().fill('抽卡');
  await editor.getByLabel('进度类型').last().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').last().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').last().fill('100');
  await editor.getByLabel('订单标题').fill('退休历史流程');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '退休历史流程' })).toBeVisible();

  // 第 1 轮：只完成打卡任务，累计任务在该轮没有任何观测。
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '今日事项' })
    .click();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  // 自绘勾选框：真实 input 是 sr-only 且受控（写入成功后由刷新回填），
  // 所以直接派发 click，并用可重试断言等待写入 + 刷新完成。
  await page.getByLabel('签到 未达成').dispatchEvent('click');
  await expect(page.getByLabel('签到 已达成')).toHaveCount(1);
  const beforeRetire = await readDataset(page, ['hosting_sessions']);
  expect(beforeRetire.hosting_sessions).toHaveLength(1);
  const retiredSession = beforeRetire.hosting_sessions[0];

  // 前置条件：任务在 day1 被移除（安卓端写入的数据）。
  await retireTaskByTitle(page, '抽卡', GAME_START.getTime());
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '订单', exact: true })
    .click();
  await page.getByText('退休历史流程').first().click();
  await expect(page.getByRole('heading', { name: '退休历史流程' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '已移除任务（历史）' })).toBeVisible();

  // 已移除任务不再提供"按今天/当前轮次"的记录入口。
  await expect(page.getByLabel('抽卡 当前累计总值')).toHaveCount(0);
  await expect(page.getByText('该任务已移除：不能再按当前轮次记录新的总值。').first()).toBeVisible();

  // 历史轮次显示稳定归属日（day1），累计任务给出该轮的首次观测入口。
  const retiredCard = page.locator('li[data-testid="retired-task"]').filter({ hasText: '抽卡' });
  const roundRow = retiredCard.locator('li[data-testid="retired-round-1"]');
  await expect(roundRow.getByText('2026-03-10')).toBeVisible();
  await roundRow.getByLabel('抽卡 第 1 次打卡累计总值').fill('100');
  await roundRow.getByRole('button', { name: '补记', exact: true }).click();
  await expect(page.getByLabel('抽卡 第 1 次打卡累计总值')).toHaveCount(0);
  await expect(roundRow.getByText('已记录').first()).toBeVisible();
  await expect(roundRow.getByText('100/100')).toBeVisible();

  // 精确持久化：只新增该轮该任务的一条 SESSION 事件，没有新轮次、没有 occurrence。
  let dataset = await readDataset(page, [
    'task_progress_events',
    'hosting_sessions',
    'task_occurrences',
    'task_definitions',
  ]);
  expect(dataset.hosting_sessions).toHaveLength(1);
  expect(dataset.hosting_sessions[0].id).toBe(retiredSession.id);
  const cumulativeTask = dataset.task_definitions.find((row) => row.title === '抽卡')!;
  const events = dataset.task_progress_events.filter(
    (row) => row.taskDefinitionId === cumulativeTask.id,
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: 'SUBMIT',
    scopeType: 'SESSION',
    scopeSessionId: retiredSession.id,
    gameDate: '2026-03-10',
    totalValue: '100',
  });
  expect(
    dataset.task_occurrences.filter(
      (row) =>
        row.taskDefinitionId === cumulativeTask.id && row.occurrenceKey === 'N:1',
    ),
  ).toHaveLength(0);
  expect(dataset.hosting_sessions[0].completedAt).not.toBeNull();

  // 撤回（重开）走生产事件链：上方累计进度的历史行 → 撤销。
  const historyRow = page
    .locator('li[data-testid="cumulative-history-row"]')
    .filter({ hasText: '2026-03-10 · 第 1 次打卡 · 记录 · 100' });
  await historyRow.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 撤销')).toBeVisible();
  await expect(roundRow.getByText('未记录').first()).toBeVisible();
  await expect(roundRow.getByText('0/100')).toBeVisible();
  await expect(roundRow.getByText('此前观测已撤回')).toBeVisible();

  dataset = await readDataset(page, ['task_progress_events', 'hosting_sessions']);
  expect(dataset.task_progress_events.filter((row) => row.taskDefinitionId === cumulativeTask.id)).toHaveLength(2);
  expect(dataset.hosting_sessions[0].completedAt).toBeNull();
  expect(dataset.hosting_sessions).toHaveLength(1);

  // 撤回之后该轮仍可再次补记（不是死角）：仍用同一轮次与同一归属日。
  await roundRow.getByLabel('抽卡 第 1 次打卡累计总值').fill('100');
  await roundRow.getByRole('button', { name: '补记', exact: true }).click();
  await expect(roundRow.getByText('已记录').first()).toBeVisible();
  const finalSet = await readDataset(page, ['task_progress_events', 'hosting_sessions']);
  expect(finalSet.hosting_sessions).toHaveLength(1);
  expect(finalSet.hosting_sessions[0].completedAt).not.toBeNull();
});

test('流程6：订单与期次刷新点不一致时，累计提交按 scope 自己的日历归属（详情 + 今日事项）', async ({
  page,
}) => {
  await boot(page);
  await createOwnerWithAccount(page, '偏移老板', { uid: '9501' });

  // 两张订单：A 订单 00:00 刷新、B 订单 05:00 刷新。
  // 期次快照刻意与之相反（A→05:00、B→00:00），模拟安卓续期/恢复写下的差异。
  await createCumulativeOrder(page, { title: '偏移A', taskTitle: '抽卡A', dailyRefresh: '00:00' });
  // 建单后进入订单详情；回到老板详情再下第二单（生产入口）。
  await page.getByRole('button', { name: '老板与账号' }).click();
  await page.getByText('偏移老板').first().click();
  await expect(page.getByRole('heading', { name: '偏移老板' })).toBeVisible();
  await createCumulativeOrder(page, { title: '偏移B', taskTitle: '抽卡B', dailyRefresh: '05:00' });
  await patchPeriodRefresh(page, '偏移A', 300);
  await patchPeriodRefresh(page, '偏移B', 0);

  // 落在两个刷新点之间：上海 03-11 03:00。
  await page.clock.setSystemTime(BETWEEN_REFRESH);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();

  // ---- 方向 A：订单 00:00 / 期次 05:00（订单详情路径）-------------------
  // 订单口径是 03-11，但期次仍停在 03-10：提交必须归属 03-10。
  await openOrderFromList(page, '偏移A');
  await page.getByLabel('抽卡A 当前累计总值').fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 记录 · 10')).toBeVisible();
  await expect(page.getByText(/10 \/ 100/).first()).toBeVisible();
  // 生产控件没有报错（旧实现在这里会被命令层拒绝）。
  await expect(page.locator('p.text-danger')).toHaveCount(0);

  let dataset = await readDataset(page, [
    'task_progress_events',
    'task_definitions',
    'hosting_sessions',
  ]);
  const taskA = dataset.task_definitions.find((row) => row.title === '抽卡A')!;
  const taskB = dataset.task_definitions.find((row) => row.title === '抽卡B')!;
  let eventsA = dataset.task_progress_events.filter((row) => row.taskDefinitionId === taskA.id);
  expect(eventsA).toHaveLength(1);
  expect(eventsA[0]).toMatchObject({
    kind: 'SUBMIT',
    scopeType: 'SESSION',
    gameDate: '2026-03-10',
    totalValue: '10',
  });
  expect(dataset.hosting_sessions).toHaveLength(1);

  // ---- 今日事项路径：一个页面日期不能同时代表两张订单的期次 --------------
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '今日事项' })
    .click();
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  const headerText = await page.getByText(/游戏日 \d{4}-\d{2}-\d{2}/).first().innerText();
  const pageDate = headerText.match(/\d{4}-\d{2}-\d{2}/)![0];

  // 同一页面上：A 的提交归属 03-10，B 的提交归属 03-11。
  const rowA = page.getByLabel('抽卡A 当前累计总值').locator('xpath=ancestor::li[1]');
  await expect(page.getByLabel('抽卡A 当前累计总值')).toHaveValue('10');
  await page.getByLabel('抽卡A 当前累计总值').fill('15');
  await rowA.getByRole('button', { name: '记录总值' }).click();
  await expect(page.locator('p.text-danger')).toHaveCount(0);

  const rowB = page.getByLabel('抽卡B 当前累计总值').locator('xpath=ancestor::li[1]');
  await page.getByLabel('抽卡B 当前累计总值').fill('10');
  await rowB.getByRole('button', { name: '记录总值' }).click();
  await expect(page.locator('p.text-danger')).toHaveCount(0);

  dataset = await readDataset(page, ['task_progress_events', 'hosting_sessions']);
  eventsA = dataset.task_progress_events.filter((row) => row.taskDefinitionId === taskA.id);
  const eventsB = dataset.task_progress_events.filter((row) => row.taskDefinitionId === taskB.id);
  expect(eventsA).toHaveLength(2);
  // 今日事项同样按**期次**日历归属：A 的两条事件都是 03-10，B 的是 03-11。
  expect(eventsA.map((row) => row.gameDate)).toEqual(['2026-03-10', '2026-03-10']);
  expect(eventsB.map((row) => row.gameDate)).toEqual(['2026-03-11']);
  expect([...eventsA, ...eventsB].every((row) => row.scopeType === 'SESSION')).toBe(true);
  // 页头只有一个游戏日，但它最多只与其中一张订单一致：逐条日期不是页面日期派生的。
  const attributed = [...new Set([...eventsA, ...eventsB].map((row) => row.gameDate))];
  expect(attributed.sort()).toEqual(['2026-03-10', '2026-03-11']);
  expect(attributed.filter((date) => date === pageDate)).toHaveLength(1);

  // 今日事项提交后的显示由订单详情回读确认（A 的总值 15、归属仍是 03-10）。
  await openOrderFromList(page, '偏移A');
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 记录 · 15')).toBeVisible();

  // ---- 方向 B（订单详情路径）：订单 05:00 / 期次 00:00 ------------------
  // 订单口径还是 03-10，但期次已经进入 03-11：提交必须归属 03-11。
  await openOrderFromList(page, '偏移B');
  await page.getByLabel('抽卡B 当前累计总值').fill('20');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-11 · 第 1 次打卡 · 记录 · 20')).toBeVisible();
  await expect(page.getByText(/20 \/ 100/).first()).toBeVisible();
  await expect(page.locator('p.text-danger')).toHaveCount(0);

  dataset = await readDataset(page, ['task_progress_events', 'hosting_sessions']);
  const finalB = dataset.task_progress_events.filter((row) => row.taskDefinitionId === taskB.id);
  expect(finalB).toHaveLength(2);
  expect(finalB.map((row) => row.gameDate)).toEqual(['2026-03-11', '2026-03-11']);
  // 两张订单各自只有一轮，没有因为日期换算而新建轮次。
  expect(dataset.hosting_sessions).toHaveLength(2);
});

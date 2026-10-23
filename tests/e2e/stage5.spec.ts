import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 5 — real browser legs of the bidirectional exchange (production UI only).
 *
 * - Flow A (chain 1 receiver): restore the **Android production export** through the
 *   Settings restore UI into an isolated browser profile, verify the persisted rows and
 *   the UI, continue working with real controls, then export the continued dataset.
 * - Flow B (chain 1 no-edit echo): restore the same Android file and export immediately,
 *   so the Android side can prove a no-edit round trip.
 * - Flow C (chain 1 encrypted): the Android AES-GCM file with a **Unicode** password.
 * - Flow D (chain 2 sender): a browser-native dataset built through the UI, exported
 *   plain and encrypted (Unicode password) for the Android receiver.
 * - Flow E: installed **Dexie 2 → 3** upgrade in a real Chromium profile, no restore
 *   action, verified again after a reload.
 *
 * Final legs (restoring the files the Android side produced) live in
 * `stage5.final.spec.ts`, because they can only run after the Android receiver pass.
 */

const GAME_START = new Date('2026-03-10T04:00:00Z'); // Shanghai 12:00 → game day 2026-03-10
const AFTER_REFRESH = new Date('2026-03-10T21:30:00Z'); // Shanghai 03-11 05:30 → game day 03-11
const UNICODE_PASSWORD = 'stage5-互通-Ω-口令';
const ANDROID_FIXTURES = path.resolve(
  process.cwd(),
  '../../代肝记录软件/output/interop-fixtures/stage5',
);
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage5');
const JPEG = path.join(OUTPUT_DIR, 'attachments', 'stage5-valid.jpg');

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function gotoSection(
  page: Page,
  name: '今日事项' | '订单' | '模板库' | '老板与账号' | '资料与设置',
) {
  // 模板库 / 资料与设置 live in the secondary navigation; the rest are primary.
  const nav = name === '资料与设置' || name === '模板库' ? '次导航' : '主导航';
  await page
    .getByRole('navigation', { name: nav })
    .getByRole('button', { name, exact: true })
    .click();
}

async function exportBackup(page: Page, fileName: string, password?: string) {
  await gotoSection(page, '资料与设置');
  await expect(page.getByRole('heading', { name: '资料与设置' })).toBeVisible();
  if (password) {
    await page.getByLabel('密码（可选）').fill(password);
    await page.getByLabel('确认密码').fill(password);
  }
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出完整备份' }).click(),
  ]);
  const target = path.join(OUTPUT_DIR, fileName);
  await download.saveAs(target);
  const bytes = readFileSync(target);
  expect(bytes.length).toBeGreaterThan(500);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(`browser export ${fileName}: ${bytes.length} bytes sha256=${sha256}`);
  return { target, bytes, sha256 };
}

async function restoreBackup(page: Page, filePath: string, password?: string) {
  await gotoSection(page, '资料与设置');
  await page.locator('input[type=file][accept*="dgbk"]').setInputFiles(filePath);
  await expect(page.getByText(/已选择：/)).toBeVisible();
  if (password) await page.getByLabel('备份密码').fill(password);
  await page.getByRole('button', { name: '预览恢复内容' }).click();
  const modal = page.getByRole('dialog', { name: '确认替换本机资料' });
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: '替换本机资料' }).click();
  await expect(page.getByText('已切换到恢复的资料')).toBeVisible({ timeout: 30_000 });
}

/** Reads the active isolated dataset straight from IndexedDB (assert-only). */
async function readDataset(page: Page, stores: string[]) {
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
    return result as Record<string, Record<string, unknown>[]>;
  }, stores);
}

test('流程A：安卓生产导出 → 网页生产恢复 → 继续操作 → 网页生产导出', async ({ page }) => {
  await boot(page);
  await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain1-plain.dgbk'));

  // ---- 持久化数据真的落在隔离的 IndexedDB 里 -------------------------------
  const data = await readDataset(page, [
    'owners',
    'game_accounts',
    'account_categories',
    'game_templates',
    'orders',
    'hosting_periods',
    'hosting_sessions',
    'task_definitions',
    'task_progress_events',
    'attachments',
    'attachmentBlobs',
    'receipts',
  ]);
  expect(data.owners.map((row) => row.nickname).sort()).toEqual(['老板乙', '老板甲']);
  expect(data.game_accounts).toHaveLength(2);
  expect(data.account_categories.map((row) => row.name).sort()).toEqual(['主号', '小号']);
  const template = data.game_templates[0];
  expect(template.defaultOrderTitle).toBe('每日托管');
  expect(data.orders).toHaveLength(3);
  expect(data.hosting_sessions).toHaveLength(3);
  // Round ownership: every session belongs to a period of the same order.
  const periods = new Map(data.hosting_periods.map((row) => [row.id as string, row.orderId as string]));
  for (const session of data.hosting_sessions) {
    const periodId = session.periodId as string;
    expect(periods.get(periodId)).toBe(session.orderId);
  }
  expect(data.task_progress_events.length).toBeGreaterThanOrEqual(6);
  expect(data.attachments).toHaveLength(1);
  // The real JPEG bytes arrived (not a four-byte marker).
  const attachmentSize = data.attachments[0].sizeBytes as number;
  expect(attachmentSize).toBeGreaterThan(512);
  const blobSize = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((value) => value.startsWith('daigan-data-'))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ blob?: Blob }[]>((resolve, reject) => {
      const tx = db.transaction('attachmentBlobs', 'readonly');
      const request = tx.objectStore('attachmentBlobs').getAll();
      request.onsuccess = () => resolve(request.result as { blob?: Blob }[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows[0]?.blob?.size ?? 0;
  });
  expect(blobSize).toBe(attachmentSize);

  // ---- UI usability on restored records -----------------------------------
  await gotoSection(page, '订单');
  await expect(page.getByText('打卡托管').first()).toBeVisible();
  await expect(page.getByText('月度刷新托管').first()).toBeVisible();
  await expect(page.getByText('短期累计').first()).toBeVisible();

  await page.getByText('打卡托管').first().click();
  await expect(page.getByRole('heading', { name: '打卡托管' })).toBeVisible();
  // Three rounds of the count order are reachable, and the cumulative task reads the
  // renewed period's own scope (its own target/price started the day it was created).
  await expect(page.getByText(/第 1 次打卡/).first()).toBeVisible();
  await expect(page.getByText(/第 3 次打卡/).first()).toBeVisible();
  await expect(page.getByLabel('抽数 当前累计总值').first()).toBeVisible();

  // The restored screenshot is really readable (a real <img> whose bytes decode).
  await gotoSection(page, '订单');
  await page.getByText('短期累计').first().click();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  await expect(photos.locator('figure')).toHaveCount(1);
  const naturalWidth = await photos.locator('img').first().evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.naturalWidth;
  });
  expect(naturalWidth).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // ---- Continue working on the browser ------------------------------------
  // UF-037: a browser-created category assigned to a restored account.
  await gotoSection(page, '老板与账号');
  await page.getByRole('button', { name: '按账号' }).click();
  await page.getByRole('button', { name: '管理分类' }).click();
  const managing = page.getByRole('dialog', { name: '管理账号分类' });
  await managing.getByLabel('新建分类').fill('网页续用分类');
  await managing.getByRole('button', { name: '创建', exact: true }).click();
  await expect(
    page.getByLabel('按分类筛选').getByRole('option', { name: /网页续用分类/ }),
  ).toHaveCount(1);
  if (await managing.isVisible()) await page.keyboard.press('Escape');

  const row = page.locator('li').filter({ hasText: /UID 10001/ }).first();
  await row.getByLabel(/分类$/).selectOption({ label: '网页续用分类' });
  await expect(row.getByLabel(/分类$/)).not.toHaveValue('');

  // UF-036: a new order whose title is typed manually (provenance = manual).
  await page.getByRole('button', { name: '按老板查看' }).click();
  await page.getByText('老板甲').first().click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('订单标题').fill('网页续用订单');
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('66');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('网页累计任务');
  await editor.getByLabel('进度类型').first().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').first().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').first().fill('100');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '网页续用订单' })).toBeVisible();

  // UF-038: absolute totals 10 (day 1) then 15 (day 2) = 15, then correct the earlier
  // day's observation to 8: the later effective total must survive.
  await page.getByLabel('网页累计任务 当前累计总值').fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 记录 · 10')).toBeVisible();

  await page.clock.setSystemTime(AFTER_REFRESH);
  await gotoSection(page, '订单');
  await page.getByText('网页续用订单').first().click();
  await expect(page.getByRole('heading', { name: '网页续用订单' })).toBeVisible();
  await page.getByLabel('网页累计任务 当前累计总值').fill('15');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText('2026-03-11 · 第 1 次打卡 · 记录 · 15')).toBeVisible();
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();

  const day1Row = page
    .locator('li[data-testid="cumulative-history-row"]')
    .filter({ hasText: '2026-03-10 · 第 1 次打卡 · 记录 · 10' });
  await day1Row.getByRole('button', { name: '更正', exact: true }).click();
  await page.getByLabel('更正为').fill('8');
  await page.getByRole('button', { name: '保存更正' }).click();
  await expect(page.getByText('2026-03-10 · 第 1 次打卡 · 更正 · 8')).toBeVisible();
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();

  const continued = await readDataset(page, [
    'task_progress_events',
    'hosting_sessions',
    'orders',
    'account_categories',
  ]);
  const corrections = continued.task_progress_events.filter((event) => event.kind === 'CORRECT');
  // The Android fixture's own historical correction (80) survives, and the browser added 8.
  expect(corrections.some((event) => event.totalValue === '80')).toBe(true);
  expect(corrections.some((event) => event.totalValue === '8')).toBe(true);
  expect(continued.account_categories.map((row) => row.name)).toContain('网页续用分类');
  const newOrder = continued.orders.find((row) => row.title === '网页续用订单');
  expect(newOrder).toBeTruthy();
  expect(continued.hosting_sessions.filter((row) => row.orderId === newOrder!.id)).toHaveLength(1);

  // ---- Production export of the restored + modified dataset ---------------
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await exportBackup(page, 'web-chain1-continued.dgbk');
});

test('流程B：同一份安卓导出的无编辑往返（恢复后立即导出）', async ({ page }) => {
  await boot(page);
  await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain1-plain.dgbk'));
  await exportBackup(page, 'web-chain1-noedit.dgbk');
});

test('流程C：安卓加密导出（Unicode 口令）可在网页生产路径恢复', async ({ page }) => {
  await boot(page);
  await restoreBackup(
    page,
    path.join(ANDROID_FIXTURES, 'android-chain1-encrypted.dgbk'),
    UNICODE_PASSWORD,
  );
  const data = await readDataset(page, ['orders', 'hosting_sessions', 'attachments', 'game_templates']);
  expect(data.orders).toHaveLength(3);
  expect(data.hosting_sessions).toHaveLength(3);
  expect(data.attachments).toHaveLength(1);
  expect(data.game_templates[0].defaultOrderTitle).toBe('每日托管');
  await gotoSection(page, '订单');
  await expect(page.getByText('打卡托管').first()).toBeVisible();
});

test('流程D：网页自建数据集（含真实截图）→ 明文/加密（Unicode 口令）生产导出', async ({
  page,
}) => {
  await boot(page);

  // UF-037: two owners whose accounts look identical, both in one category.
  const categories = ['网页主分类', '网页次分类'];
  await gotoSection(page, '老板与账号');
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: '新建老板' }).first().click();
    await page.getByLabel('昵称').fill(index === 0 ? '网页老板甲' : '网页老板乙');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.getByText(index === 0 ? '网页老板甲' : '网页老板乙').first(),
    ).toBeVisible();
    await page.getByText(index === 0 ? '网页老板甲' : '网页老板乙').first().click();
    await page.getByRole('button', { name: '添加账号' }).first().click();
    const dialog = page.getByRole('dialog', { name: '添加游戏账号' });
    await dialog.getByLabel('游戏名称').fill('游戏X');
    await dialog.getByLabel('区服').fill('官服');
    await dialog.getByLabel('UID').fill('10001');
    await dialog.getByLabel('登录账号').fill('synthetic-10001');
    await dialog.locator('input[type="password"]').fill('secret');
    await dialog.getByRole('button', { name: '新建账号分类' }).click();
    await dialog.getByLabel('新分类名称').fill(categories[index]);
    await dialog.getByRole('button', { name: '创建并选用' }).click();
    await dialog.getByRole('button', { name: '保存账号' }).click();
    await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
    if (index === 0) {
      // UF-036: the template carries a default order title.
      await gotoSection(page, '模板库');
      await page.getByRole('button', { name: '新建模板' }).click();
      const templateDialog = page.getByRole('dialog', { name: '新建模板' });
      await templateDialog.getByLabel('游戏名称').fill('游戏X');
      await templateDialog.getByLabel(/默认订单标题/).fill('网页默认标题');
      await templateDialog.getByLabel('任务标题').first().fill('签到');
      await templateDialog.getByRole('button', { name: '保存模板' }).click();
      await expect(templateDialog).toBeHidden();
      await gotoSection(page, '老板与账号');
    }
    // Return to the owners list so the next iteration starts from a known place.
    const backToList = page.getByRole('button', { name: '老板列表' });
    if (await backToList.count()) await backToList.first().click();
  }

  // Order 1: count hosting, two rounds, absolute totals (10 → 15).
  await page.getByText('网页老板甲').first().click();
  await page.getByText('游戏X').first().click();
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await editor.getByLabel('订单标题').fill('网页打卡单');
  await editor.getByLabel('服务模式').selectOption('count');
  await editor.getByLabel('服务次数').fill('2');
  await editor.getByLabel('本期价格（元）').fill('90');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').first().fill('签到');
  await editor.getByRole('button', { name: '添加任务' }).click();
  await editor.getByLabel('任务标题').last().fill('网页抽数');
  await editor.getByLabel('进度类型').last().selectOption('NUMERIC');
  await editor.getByLabel('数值口径').last().selectOption('CUMULATIVE');
  await editor.getByLabel('目标').last().fill('100');
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '网页打卡单' })).toBeVisible();

  await page.getByLabel('网页抽数 当前累计总值').fill('10');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText(/10 \/ 100/).first()).toBeVisible();
  await page.getByLabel('网页抽数 当前累计总值').fill('15');
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();
  await expect(page.getByText(/25 \/ 100/)).toHaveCount(0);

  // Order 2: dated hosting with a first receipt.
  await gotoSection(page, '老板与账号');
  await page.getByText('网页老板乙').first().click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await page.getByRole('button', { name: '下单' }).click();
  const dated = page.getByRole('dialog', { name: '新建订单' });
  await dated.getByLabel('订单标题').fill('网页日期单');
  await dated.getByLabel('服务模式').selectOption('dates');
  await dated.getByLabel('开始日期').fill('2026-03-10');
  await dated.getByLabel('结束日期').fill('2026-03-20');
  await dated.getByLabel('本期价格（元）').fill('88');
  await dated.getByRole('checkbox').uncheck();
  await dated.getByRole('button', { name: '添加任务' }).click();
  await dated.getByLabel('任务标题').first().fill('日常');
  await dated.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '网页日期单' })).toBeVisible();
  await page.getByRole('button', { name: '记录收款' }).click();
  const receipt = page.getByRole('dialog', { name: '记录收款' });
  await receipt.getByLabel('金额（元）').fill('30');
  await receipt.getByRole('button', { name: '记录收款' }).click();
  await expect(page.getByText(/30\.00/).first()).toBeVisible();

  // Order 3: short order with the genuine JPEG attached through the upload control.
  await gotoSection(page, '老板与账号');
  await page.getByText('网页老板甲').first().click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
  await page.getByRole('button', { name: '下单' }).click();
  const short = page.getByRole('dialog', { name: '新建订单' });
  await short.getByLabel('订单类型').selectOption('SHORT_TASK');
  await short.getByLabel('订单标题').fill('网页短期单');
  await short.getByLabel('整单总价（元）').fill('30');
  await short.getByRole('checkbox').uncheck();
  await short.getByRole('button', { name: '添加任务' }).click();
  await short.getByLabel('任务标题').first().fill('刷本');
  await short.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '网页短期单' })).toBeVisible();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  await photos.locator('input[type=file]').setInputFiles(JPEG);
  await expect(photos.locator('figure')).toHaveCount(1);
  const width = await photos.locator('img').first().evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.naturalWidth;
  });
  expect(width).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // The dataset must match the shape the Android receiver asserts.
  const data = await readDataset(page, [
    'owners',
    'game_accounts',
    'account_categories',
    'game_templates',
    'orders',
    'hosting_sessions',
    'task_progress_events',
    'attachments',
    'receipts',
  ]);
  expect(data.owners).toHaveLength(2);
  expect(data.game_accounts).toHaveLength(2);
  expect(data.account_categories.length).toBeGreaterThanOrEqual(2);
  expect(
    data.game_templates.some((row) => row.defaultOrderTitle === '网页默认标题'),
  ).toBe(true);
  expect(data.orders).toHaveLength(3);
  expect(data.hosting_sessions).toHaveLength(1);
  expect(data.task_progress_events.length).toBeGreaterThanOrEqual(2);
  expect(data.attachments).toHaveLength(1);
  expect(data.receipts).toHaveLength(1);

  await exportBackup(page, 'web-chain2-plain.dgbk');
  await exportBackup(page, 'web-chain2-encrypted.dgbk', UNICODE_PASSWORD);
});

test('流程E：已安装的 Dexie 2 库在真实浏览器中升级到 3，无需恢复动作', async ({ page }) => {
  const LEGACY = 'daigan-data-legacy-install';
  // A genuine Dexie v2 profile: IDB version 20 (= Dexie 2), v1 + v2 object stores,
  // legacy rows (C: count keys, order/task colour marks, serviceMode/serviceCount) and
  // the control row that points the app at it. No v3 store exists yet.
  await page.addInitScript((databaseName) => {
    const request = indexedDB.open(databaseName, 20);
    request.onupgradeneeded = () => {
      const db = request.result;
      const create = (name: string, keyPath: string, indexes: [string, string | string[], boolean?][]) => {
        const store = db.createObjectStore(name, { keyPath });
        for (const [indexName, keyPathOrArray, unique] of indexes) {
          store.createIndex(indexName, keyPathOrArray as string, { unique: Boolean(unique) });
        }
        return store;
      };
      create('owners', 'id', [['number', 'number', true], ['archivedAt', 'archivedAt']]);
      create('game_accounts', 'id', [['ownerId', 'ownerId'], ['archivedAt', 'archivedAt']]);
      create('owner_number_sequence', 'id', []);
      create('game_server_options', 'id', [
        ['gameName', 'gameName'],
        ['[gameName+sortOrder]', ['gameName', 'sortOrder']],
      ]);
      create('orders', 'id', [['accountId', 'accountId'], ['type', 'type'], ['cancelledAt', 'cancelledAt']]);
      create('hosting_periods', 'id', [
        ['orderId', 'orderId'],
        ['renewalOperationId', 'renewalOperationId'],
      ]);
      create('order_price_changes', 'id', [
        ['operationId', 'operationId', true],
        ['orderId', 'orderId'],
        ['periodId', 'periodId'],
      ]);
      create('task_definitions', 'id', [['orderId', 'orderId'], ['periodId', 'periodId']]);
      create('task_occurrences', 'id', [
        ['taskDefinitionId', 'taskDefinitionId'],
        ['gameDate', 'gameDate'],
        ['completionBatchId', 'completionBatchId'],
      ]);
      create('completion_batches', 'id', [['operationId', 'operationId', true]]);
      create('completion_batch_items', 'id', [['batchId', 'batchId']]);
      create('attachments', 'id', [
        ['taskDefinitionId', 'taskDefinitionId'],
        ['occurrenceId', 'occurrenceId'],
      ]);
      create('receipts', 'id', [
        ['operationId', 'operationId', true],
        ['orderId', 'orderId'],
        ['periodId', 'periodId'],
      ]);
      create('receipt_corrections', 'id', [
        ['operationId', 'operationId', true],
        ['receiptId', 'receiptId'],
      ]);
      create('order_creation_operations', 'operationId', []);
      create('game_templates', 'id', [['gameName', 'gameName']]);
      create('template_categories', 'id', [['templateId', 'templateId']]);
      create('template_tasks', 'id', [
        ['templateId', 'templateId'],
        ['categoryId', 'categoryId'],
      ]);
      create('template_price_presets', 'id', [['templateId', 'templateId']]);
      create('template_seed_state', 'seedKey', []);
      create('reminder_settings', 'id', []);
      create('attachmentBlobs', 'id', []);
      create('task_color_marks', 'taskId', []);
      create('dataset_meta', 'id', []);
      create('order_color_marks', 'orderId', []);
    };
    request.onsuccess = () => {
      const db = request.result;
      const now = Date.now();
      const tx = db.transaction(
        [
          'owners',
          'game_accounts',
          'game_server_options',
          'orders',
          'hosting_periods',
          'task_definitions',
          'task_occurrences',
          'receipts',
          'order_creation_operations',
          'game_templates',
          'template_categories',
          'template_tasks',
          'reminder_settings',
          'dataset_meta',
          'task_color_marks',
          'order_color_marks',
        ],
        'readwrite',
      );
      const put = (store: string, row: unknown) => tx.objectStore(store).put(row as never);
      put('owners', {
        id: 'legacy-owner',
        number: 1,
        nickname: '旧版老板',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        archiveBatchId: null,
      });
      put('game_accounts', {
        id: 'legacy-account',
        ownerId: 'legacy-owner',
        gameName: '旧版游戏',
        server: '官服',
        uid: '7001',
        loginAccount: 'legacy-login',
        loginMethod: 'VERIFICATION_CODE',
        password: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        archiveBatchId: null,
        defaultTemplateId: null,
        loginDevice: null,
        resourceNotes: null,
      });
      put('game_server_options', {
        id: 'legacy-server',
        gameName: '旧版游戏',
        server: '官服',
        sortOrder: 0,
      });
      // Legacy web count order: order-level target, C:<date> occurrence keys.
      put('orders', {
        id: 'legacy-count-order',
        accountId: 'legacy-account',
        type: 'HOSTING',
        title: '旧版打卡单',
        priceCents: 6000,
        paymentMode: 'INSTALLMENTS',
        deadlineDate: null,
        notes: null,
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 240,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        createdAt: now,
        updatedAt: now,
        cancelledAt: null,
        completedAt: null,
        sourceTemplateId: null,
        sourceTemplateName: null,
        sourceTemplateVersion: null,
      });
      put('hosting_periods', {
        id: 'legacy-period',
        orderId: 'legacy-count-order',
        periodIndex: 0,
        startDate: '2026-03-01',
        endDate: '2026-03-01',
        priceCents: 6000,
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 240,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        createdAt: now,
        renewalOperationId: null,
        serviceDays: null,
        serviceWeekdays: null,
        // web-12 did carry a per-period target; this is what makes the order count-based.
        serviceCount: 3,
      });
      put('task_definitions', {
        id: 'legacy-task-a',
        orderId: 'legacy-count-order',
        periodId: 'legacy-period',
        title: '签到',
        progressType: 'CHECKBOX',
        startValue: '0',
        targetValue: '1',
        currentValue: '0',
        unit: null,
        recurrence: 'DAILY',
        weekdays: null,
        everyNDays: null,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
        monthDay: null,
        monthDays: null,
        sortOrder: 0,
        completionBatchId: null,
      });
      put('task_definitions', {
        id: 'legacy-task-b',
        orderId: 'legacy-count-order',
        periodId: 'legacy-period',
        title: '刷本',
        progressType: 'NUMERIC',
        startValue: '0',
        targetValue: '10',
        currentValue: '4',
        unit: '次',
        recurrence: 'DAILY',
        weekdays: null,
        everyNDays: null,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
        monthDay: null,
        monthDays: null,
        sortOrder: 1,
        completionBatchId: null,
      });
      // Two rounds on the same legacy game day: both tasks finished in round 1, only the
      // checkbox in round 2 (partial progress must survive the C: -> N: migration).
      put('task_occurrences', {
        id: 'legacy-occ-1a',
        taskDefinitionId: 'legacy-task-a',
        occurrenceKey: 'C:2026-03-02',
        gameDate: '2026-03-02',
        windowStart: '2026-03-02',
        windowEnd: '2026-03-02',
        completedAt: now,
        recordedAt: now,
        backfilled: false,
        completionBatchId: null,
        value: null,
        createdAt: now,
      });
      put('task_occurrences', {
        id: 'legacy-occ-1b',
        taskDefinitionId: 'legacy-task-b',
        occurrenceKey: 'C:2026-03-02',
        gameDate: '2026-03-02',
        windowStart: '2026-03-02',
        windowEnd: '2026-03-02',
        completedAt: now,
        recordedAt: now,
        backfilled: false,
        completionBatchId: null,
        value: '10',
        createdAt: now,
      });
      put('task_occurrences', {
        id: 'legacy-occ-2a',
        taskDefinitionId: 'legacy-task-a',
        occurrenceKey: 'C:2026-03-03',
        gameDate: '2026-03-03',
        windowStart: '2026-03-03',
        windowEnd: '2026-03-03',
        completedAt: now,
        recordedAt: now,
        backfilled: false,
        completionBatchId: null,
        value: null,
        createdAt: now,
      });
      put('receipts', {
        id: 'legacy-receipt',
        operationId: 'legacy-payment',
        orderId: 'legacy-count-order',
        periodId: 'legacy-period',
        amountCents: 2000,
        receivedAt: now,
        channel: 'WECHAT',
        note: '旧版部分收款',
        status: 'ACTIVE',
        replacedByReceiptId: null,
        createdAt: now,
      });
      put('game_templates', {
        id: 'legacy-template',
        gameName: '旧版游戏',
        templateVersion: 'v1',
        gameVersionNotes: null,
        zoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 240,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        origin: 'USER',
        builtInKey: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
        serviceMode: 'count',
        serviceCount: 3,
      });
      put('reminder_settings', {
        id: '0',
        shortDeadlineEnabled: false,
        shortDeadlineMinutes: 0,
        hostingExpiryEnabled: false,
        hostingExpiryMinutes: 0,
        unfinishedTasksEnabled: false,
        unfinishedTasksMinutes: 0,
        updatedAt: now,
      });
      put('dataset_meta', { id: 'dataset', datasetId: databaseName, createdAt: now });
      // Legacy local-only colour marks: these must be folded into the business columns.
      put('task_color_marks', { taskId: 'legacy-task-a', color: 'green' });
      put('order_color_marks', { orderId: 'legacy-count-order', color: 'blue' });
      tx.oncomplete = () => db.close();
    };

    // Control database (Dexie v1/v2 shape) pointing at the legacy dataset.
    const control = indexedDB.open('daigan-control', 20);
    control.onupgradeneeded = () => {
      const db = control.result;
      db.createObjectStore('state', { keyPath: 'key' });
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('status', 'status');
    };
    control.onsuccess = () => {
      const db = control.result;
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put({
        key: 'activeDataset',
        value: {
          databaseName,
          generation: 1,
          revision: 0,
          datasetId: databaseName,
          lastRestoreId: null,
          createdAt: Date.now(),
        },
      });
      tx.oncomplete = () => db.close();
    };
  }, LEGACY);

  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  // No restore action: the app itself must run the installed 2 -> 3 upgrade.
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();

  const upgraded = await readDataset(page, [
    'orders',
    'hosting_sessions',
    'task_occurrences',
    'task_progress_events',
    'hosting_periods',
    'account_categories',
    'receipts',
    'game_templates',
    'dataset_meta',
  ]);
  // Legacy business data preserved.
  expect(upgraded.orders).toHaveLength(1);
  expect(upgraded.receipts).toHaveLength(1);
  expect(upgraded.receipts[0].amountCents).toBe(2000);
  expect(upgraded.dataset_meta[0].id).toBe('dataset');
  // C: keys became N: rounds with one row per (order, period, gameDate) group.
  expect(upgraded.hosting_sessions).toHaveLength(2);
  const indexes = upgraded.hosting_sessions.map((row) => row.sessionIndex).sort();
  expect(indexes).toEqual([1, 2]);
  for (const session of upgraded.hosting_sessions) {
    expect(session.periodId).toBe('legacy-period');
  }
  const keys = upgraded.task_occurrences.map((row) => row.occurrenceKey).sort();
  expect(keys).toEqual(['N:1', 'N:1', 'N:2']);
  // Partial round 2 stays partial (the numeric task has no round-2 observation).
  const round2 = upgraded.task_occurrences.filter((row) => row.occurrenceKey === 'N:2');
  expect(round2).toHaveLength(1);
  expect(round2[0].taskDefinitionId).toBe('legacy-task-a');
  // Legacy C: values are never reinterpreted as cumulative totals.
  expect(upgraded.task_progress_events).toHaveLength(0);
  // The per-period target survives, and the order mirror follows the latest count period.
  expect(upgraded.hosting_periods[0].serviceCount).toBe(3);
  expect(upgraded.orders[0].targetSessions).toBe(3);
  expect(upgraded.orders[0].hostingMode).toBe('COUNT_BASED');
  // Legacy colour marks were folded into the portable columns, then removed.
  expect(upgraded.orders[0].orderColor).toBe(4283076825);
  expect(upgraded.account_categories).toHaveLength(0);
  // Template legacy serviceMode/serviceCount became the layered vnext fields.
  const legacyTemplate = upgraded.game_templates.find((row) => row.id === 'legacy-template');
  expect(legacyTemplate).toBeTruthy();
  expect(legacyTemplate!.hostingMode).toBe('COUNT_BASED');
  expect(legacyTemplate!.targetSessions).toBe(3);
  expect(legacyTemplate!.serviceMode).toBe('count');

  // The upgraded data is usable through the UI (rounds + colour).
  await gotoSection(page, '订单');
  await expect(page.getByText('旧版打卡单').first()).toBeVisible();
  await page.getByText('旧版打卡单').first().click();
  await expect(page.getByRole('heading', { name: '旧版打卡单' })).toBeVisible();
  await expect(page.getByText(/第 1 次打卡/).first()).toBeVisible();

  // ... and the upgraded dataset still accepts a business command (a second receipt on the
  // migrated count order), so the upgrade does not leave a read-only ledger.
  await page.getByRole('button', { name: '记录收款' }).click();
  const receiptDialog = page.getByRole('dialog', { name: '记录收款' });
  await receiptDialog.getByLabel('金额（元）').fill('10');
  await receiptDialog.getByRole('button', { name: '记录收款' }).click();
  await expect(page.getByText(/实收 ¥30\.00/).first()).toBeVisible();

  // Upgrade survives a browser reopen.
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await gotoSection(page, '今日事项');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
  const afterReload = await readDataset(page, [
    'orders',
    'hosting_sessions',
    'task_occurrences',
    'receipts',
  ]);
  expect(afterReload.orders).toHaveLength(1);
  expect(afterReload.hosting_sessions.map((row) => row.sessionIndex).sort()).toEqual([1, 2]);
  expect(afterReload.task_occurrences.map((row) => row.occurrenceKey).sort()).toEqual([
    'N:1',
    'N:1',
    'N:2',
  ]);
  expect(afterReload.receipts).toHaveLength(2);
  writeFileSync(
    path.join(OUTPUT_DIR, 'browser-upgrade-summary.json'),
    `${JSON.stringify(
      {
        legacyDatabase: LEGACY,
        idbVersionBefore: 20,
        dexieVersionBefore: 2,
        dexieVersionAfter: 3,
        restoreActionPerformed: false,
        sessions: afterReload.hosting_sessions.length,
        occurrences: afterReload.task_occurrences.map((row) => row.occurrenceKey).sort(),
        upgradeSurvivedReload: true,
        capturedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
});

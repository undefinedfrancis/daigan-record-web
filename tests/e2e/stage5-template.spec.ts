import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 5 — **independent template format 4 exchange**, in a real browser.
 *
 * This is deliberately *not* a full-backup leg: the files here contain only template
 * content (format `daigan-template`, `formatVersion` 4), and no `.dgbk` archive is
 * restored anywhere in this file.
 *
 * - Flow J (chain 1): the Android production template export is imported through the
 *   template library's production picker, its persisted rows are asserted, an order is
 *   created from it with the imported default title, and the template is exported again.
 * - Flow K (chain 2 authoring): a web-native template is authored through the template
 *   editor and exported, producing the input the Android receiver consumes.
 * - Flow L (chain 2 return): Android's re-export of that template is imported again and
 *   used to create an order, then exported once more for the field-level comparison.
 * - Flow M (service-weekday repair): a format-4 template with an explicit
 *   `DATE_RANGE` + Monday/Wednesday/Friday is imported, applied to the real order form,
 *   used to create an order through the actual controls, and the persisted period plus
 *   the displayed service window are asserted before and after a reload.
 *
 * The flows write distinct files; the field-level comparison is done by
 * `tools/interop/compare-templates.mjs`, never by comparing file hashes or formatting.
 */

const GAME_START = new Date('2026-03-10T04:00:00Z'); // Shanghai 12:00 → game day 2026-03-10
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage5');
const ANDROID_TEMPLATE_FIXTURES = path.resolve(
  process.cwd(),
  '../../代肝记录软件/output/interop-fixtures/stage5-templates',
);

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function gotoSection(
  page: Page,
  name: '今日事项' | '订单' | '老板与账号' | '模板库' | '资料与设置',
) {
  const nav = name === '资料与设置' || name === '模板库' ? '次导航' : '主导航';
  await page
    .getByRole('navigation', { name: nav })
    .getByRole('button', { name, exact: true })
    .click();
}

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

/** Imports one template file through the library's production picker path. */
async function importTemplateFile(page: Page, filePath: string, expectedName: string) {
  await gotoSection(page, '模板库');
  await page.locator('input[type=file][accept*="json"]').setInputFiles(filePath);
  await expect(page.getByText(expectedName).first()).toBeVisible({ timeout: 30_000 });
}

/** Selects a template in the library list and downloads it through the production button. */
async function exportTemplateFile(page: Page, templateName: string, fileName: string) {
  await gotoSection(page, '模板库');
  await page.getByText(templateName).first().click();
  await expect(page.getByRole('heading', { name: templateName })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出当前模板' }).click(),
  ]);
  const target = path.join(OUTPUT_DIR, fileName);
  await download.saveAs(target);
  const text = readFileSync(target, 'utf8');
  expect(text).toContain('"formatVersion": 4');
  expect(text).toContain('"format": "daigan-template"');
  console.log(
    `browser template export ${fileName}: ${text.length} bytes sha256=${createHash('sha256').update(text).digest('hex')}`,
  );
  return target;
}

async function createOwnerAccount(page: Page, ownerName: string, gameName: string) {
  await gotoSection(page, '老板与账号');
  await page.getByRole('button', { name: '新建老板' }).first().click();
  await page.getByLabel('昵称').fill(ownerName);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(ownerName).first()).toBeVisible();
  await page.getByText(ownerName).first().click();
  await page.getByRole('button', { name: '添加账号' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加游戏账号' });
  await dialog.getByLabel('游戏名称').fill(gameName);
  await dialog.getByLabel('区服').fill('官服');
  await dialog.getByLabel('UID').fill('10001');
  await dialog.getByLabel('登录账号').fill('synthetic-template');
  await dialog.locator('input[type="password"]').fill('secret');
  await dialog.getByRole('button', { name: '保存账号' }).click();
  await expect(page.getByRole('heading', { name: '游戏账号信息' })).toBeVisible();
}

/** Selects the template in the new-order dialog and returns the resolved option value. */
async function applyTemplateInOrderDialog(page: Page, templateName: string) {
  await page.getByRole('button', { name: '下单' }).click();
  const editor = page.getByRole('dialog', { name: '新建订单' });
  await expect(editor).toBeVisible();
  const templateSelect = editor.getByLabel('套用模板');
  const optionValue = await templateSelect
    .locator('option')
    .filter({ hasText: templateName })
    .first()
    .getAttribute('value');
  expect(optionValue, `模板 ${templateName} 必须在选择列表中`).toBeTruthy();
  await templateSelect.selectOption(optionValue!);
  return { editor, templateSelect, optionValue: optionValue! };
}

test('流程J：安卓模板文件 → 网页生产导入/保存 → 用导入模板建单 → 网页生产导出', async ({
  page,
}) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const androidTemplate = path.join(ANDROID_TEMPLATE_FIXTURES, 'android-template-rich-v4.json');
  const provenance = JSON.parse(
    readFileSync(
      path.join(ANDROID_TEMPLATE_FIXTURES, 'android-template-rich-v4-provenance.json'),
      'utf8',
    ),
  ) as {
    syntheticDataOnly: boolean;
    hardware: string;
    templateFormat: number;
    files: { file: string; sha256: string; sizeBytes: number }[];
  };
  expect(provenance.syntheticDataOnly).toBe(true);
  expect(provenance.hardware).toBe('emulator');
  expect(provenance.templateFormat).toBe(4);
  const declared = provenance.files.find((entry) => entry.file === 'android-template-rich-v4.json')!;
  const bytes = readFileSync(androidTemplate);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(declared.sha256);
  expect(bytes.length).toBe(declared.sizeBytes);

  await boot(page);
  await importTemplateFile(page, androidTemplate, '互通模板游戏');

  // ---- persisted rows written by the production import ---------------------
  const data = await readDataset(page, [
    'game_templates',
    'template_categories',
    'template_tasks',
    'template_price_presets',
    'game_server_options',
  ]);
  const template = data.game_templates.find((row) => row.gameName === '互通模板游戏')!;
  expect(template).toBeTruthy();
  expect(template.defaultOrderTitle).toBe('安卓模板默认标题');
  expect(template.hostingMode).toBe('COUNT_BASED');
  expect(template.targetSessions).toBe(6);
  expect(template.templateVersion).toBe('2026.10-android');
  expect(template.origin).toBe('IMPORTED');
  const categories = data.template_categories
    .filter((row) => row.templateId === template.id)
    .sort((left, right) => (left.sortOrder as number) - (right.sortOrder as number));
  expect(categories.map((row) => row.name)).toEqual(['计次分类', '按日分类']);
  expect(categories.map((row) => row.hostingMode)).toEqual(['COUNT_BASED', 'DATE_RANGE']);
  expect(categories.map((row) => row.targetSessions)).toEqual([4, null]);
  expect(categories.map((row) => row.serviceWeekdays)).toEqual([null, '1,3,5']);
  const tasks = data.template_tasks.filter((row) => row.templateId === template.id);
  expect(tasks.map((row) => row.title).sort()).toEqual(
    ['周常', '指定星期', '每月五日', '隔三天', '限时任务', '签到', '抽数累计'].sort(),
  );
  const cumulative = tasks.find((row) => row.title === '抽数累计')!;
  expect(cumulative.numericMode).toBe('CUMULATIVE');
  expect(Number(cumulative.targetValue)).toBe(120.5);
  expect(cumulative.unit).toBe('抽');
  expect(tasks.find((row) => row.title === '每月五日')!.monthDays).toBe('5,20');
  expect(tasks.find((row) => row.title === '隔三天')!.everyNDays).toBe(3);
  expect(tasks.find((row) => row.title === '指定星期')!.weekdays).toBe('1,4');
  expect(tasks.find((row) => row.title === '限时任务')!.activeFrom).toBe('2026-03-01');
  expect(tasks.find((row) => row.title === '限时任务')!.activeUntil).toBe('2026-03-31');
  expect(
    data.template_price_presets
      .filter((row) => row.templateId === template.id)
      .sort((left, right) => (left.sortOrder as number) - (right.sortOrder as number))
      .map((row) => [row.amountCents, row.label]),
  ).toEqual([
    [3000, '定金'],
    [8850, '全款'],
  ]);
  expect(
    data.game_server_options
      .filter((row) => row.gameName === '互通模板游戏')
      .sort((left, right) => (left.sortOrder as number) - (right.sortOrder as number))
      .map((row) => row.name),
  ).toEqual(['官服', '渠道服']);

  // ---- the imported template survives a reload ----------------------------
  await page.reload();
  await gotoSection(page, '模板库');
  await expect(page.getByText('互通模板游戏').first()).toBeVisible();
  await page.getByText('互通模板游戏').first().click();
  await expect(page.getByRole('heading', { name: '互通模板游戏' })).toBeVisible();
  await expect(page.getByText(/默认订单标题：\s*安卓模板默认标题/)).toBeVisible();

  // ---- create an order from the imported template -------------------------
  await createOwnerAccount(page, '模板老板', '互通模板游戏');
  const { editor, templateSelect, optionValue } =
    await applyTemplateInOrderDialog(page, '互通模板游戏');
  // UF-036: the imported default title fills an untouched form.
  await expect(editor.getByLabel('订单标题')).toHaveValue('安卓模板默认标题');
  await expect(editor.getByLabel('服务模式')).toHaveValue('count');
  await expect(editor.getByLabel('服务次数')).toHaveValue('6');
  expect(
    (
      await editor
        .getByLabel('任务标题')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    ).sort(),
  ).toEqual(['周常', '指定星期', '每月五日', '隔三天', '限时任务', '签到', '抽数累计'].sort());
  // A manual title is never overwritten by re-applying a template...
  await editor.getByLabel('订单标题').fill('手填订单标题');
  await templateSelect.selectOption('');
  await templateSelect.selectOption(optionValue);
  await expect(editor.getByLabel('订单标题')).toHaveValue('手填订单标题');
  // ...while an emptied title accepts the template default again.
  await editor.getByLabel('订单标题').fill('');
  await templateSelect.selectOption(optionValue);
  await expect(editor.getByLabel('订单标题')).toHaveValue('安卓模板默认标题');
  await editor.getByLabel('本期价格（元）').fill('120');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '安卓模板默认标题' })).toBeVisible();

  const created = await readDataset(page, ['orders', 'task_definitions']);
  const order = created.orders.find((row) => row.title === '安卓模板默认标题')!;
  expect(order).toBeTruthy();
  expect(order.hostingMode).toBe('COUNT_BASED');
  expect(order.targetSessions).toBe(6);
  expect(order.sourceTemplateName).toBe('互通模板游戏');
  expect(
    created.task_definitions
      .filter((row) => row.orderId === order.id)
      .map((row) => row.title)
      .sort(),
  ).toEqual(['周常', '指定星期', '每月五日', '隔三天', '限时任务', '签到', '抽数累计'].sort());

  // ---- production export of the imported template -------------------------
  await exportTemplateFile(page, '互通模板游戏', 'web-template-from-android.json');
});

test('流程K：网页生产路径新建模板并导出独立模板文件（链路2 输入）', async ({ page }) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await boot(page);
  await gotoSection(page, '模板库');
  await page.getByRole('button', { name: '新建模板' }).click();
  const dialog = page.getByRole('dialog', { name: '新建模板' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('游戏名称').fill('网页模板游戏');
  await dialog.getByLabel('模板版本').fill('web-1.0');
  await dialog.getByLabel('版本说明').fill('网页侧合成模板：仅用于格式 4 互通验证');
  await dialog.getByLabel('默认订单标题（UF-036）').fill('网页模板标题');
  await dialog.getByLabel('每日刷新时间').fill('04:00');
  await dialog.getByLabel('每周刷新时间').fill('05:00');

  // 区服选项
  await dialog.getByLabel('区服 1', { exact: true }).fill('官服');
  await dialog.getByRole('button', { name: '添加区服' }).click();
  await dialog.getByLabel('区服 2', { exact: true }).fill('渠道服');

  // 价格预设
  await dialog.getByRole('button', { name: '添加预设' }).click();
  await dialog.getByLabel('预设金额（元）').first().fill('12.50');
  await dialog.getByLabel('预设标签').first().fill('定金');
  await dialog.getByRole('button', { name: '添加预设' }).click();
  await dialog.getByLabel('预设金额（元）').nth(1).fill('60.00');
  await dialog.getByLabel('预设标签').nth(1).fill('全款');

  const taskRow = (index: number) =>
    dialog.getByLabel('任务标题').nth(index).locator('xpath=ancestor::li[1]');

  // 分类 1：按次数 3 次
  await dialog.getByLabel('分类名称').first().fill('网页计次分类');
  await dialog.getByLabel('建单默认托管方式').first().selectOption('count');
  await dialog.getByLabel('服务次数').fill('3');
  await dialog.getByLabel('任务标题').first().fill('签到');

  await dialog.getByRole('button', { name: '添加任务' }).first().click();
  await dialog.getByLabel('任务标题').nth(1).fill('抽数');
  await taskRow(1).getByLabel('进度类型').selectOption('NUMERIC');
  await taskRow(1).getByLabel('数值口径').selectOption('CUMULATIVE');
  await taskRow(1).getByLabel('起始').fill('0');
  await taskRow(1).getByLabel('目标').fill('90');
  await taskRow(1).getByLabel('单位').fill('抽');

  // 分类 2：仅工作日 1,3,5
  await dialog.getByRole('button', { name: '添加分类' }).click();
  await dialog.getByLabel('分类名称').nth(1).fill('网页按日分类');
  await dialog.getByLabel('建单默认托管方式').nth(1).selectOption('weekdays');
  await dialog.getByLabel('服务星期').fill('1,3,5');
  await dialog.getByLabel('任务标题').nth(2).fill('周常');
  await taskRow(2).getByLabel('重复周期').selectOption('WEEKLY');

  await dialog.getByRole('button', { name: '添加任务' }).nth(1).click();
  await dialog.getByLabel('任务标题').nth(3).fill('隔天副本');
  await taskRow(3).getByLabel('重复周期').selectOption('EVERY_N_DAYS');
  await taskRow(3).getByLabel('每隔天数').fill('2');

  await dialog.getByRole('button', { name: '添加任务' }).nth(1).click();
  await dialog.getByLabel('任务标题').nth(4).fill('指定星期');
  await taskRow(4).getByLabel('重复周期').selectOption('SELECTED_WEEKDAYS');
  // Switching to "指定星期" pre-selects 1,3,5; a real user click must be able to change it.
  await taskRow(4).getByRole('button', { name: '三', exact: true }).click();
  await taskRow(4).getByRole('button', { name: '五', exact: true }).click();
  await taskRow(4).getByRole('button', { name: '四', exact: true }).click();

  await dialog.getByRole('button', { name: '添加任务' }).nth(1).click();
  await dialog.getByLabel('任务标题').nth(5).fill('限时活动');
  await taskRow(5).getByLabel('任务开始日期（可选）').fill('2026-03-01');
  await taskRow(5).getByLabel('任务结束日期（可选）').fill('2026-03-31');

  await dialog.getByRole('button', { name: '保存模板' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText('网页模板游戏').first()).toBeVisible();

  const data = await readDataset(page, [
    'game_templates',
    'template_categories',
    'template_tasks',
    'template_price_presets',
    'game_server_options',
  ]);
  const template = data.game_templates.find((row) => row.gameName === '网页模板游戏')!;
  expect(template.defaultOrderTitle).toBe('网页模板标题');
  // The two categories disagree, so the template level stores "no opinion" (null) rather
  // than silently picking the first category; each category keeps its own explicit mode.
  expect(template.hostingMode).toBeNull();
  expect(template.targetSessions).toBeNull();
  const categories = data.template_categories
    .filter((row) => row.templateId === template.id)
    .sort((left, right) => (left.sortOrder as number) - (right.sortOrder as number));
  expect(categories.map((row) => row.name)).toEqual(['网页计次分类', '网页按日分类']);
  expect(categories.map((row) => row.hostingMode)).toEqual(['COUNT_BASED', 'DATE_RANGE']);
  expect(categories.map((row) => row.targetSessions)).toEqual([3, null]);
  expect(categories.map((row) => row.serviceWeekdays)).toEqual([null, '1,3,5']);
  const tasks = data.template_tasks.filter((row) => row.templateId === template.id);
  expect(tasks.map((row) => row.title).sort()).toEqual(
    ['签到', '抽数', '周常', '隔天副本', '指定星期', '限时活动'].sort(),
  );
  expect(tasks.find((row) => row.title === '抽数')!.numericMode).toBe('CUMULATIVE');
  expect(tasks.find((row) => row.title === '隔天副本')!.everyNDays).toBe(2);
  expect(tasks.find((row) => row.title === '指定星期')!.weekdays).toBe('1,4');
  expect(tasks.find((row) => row.title === '限时活动')!.activeFrom).toBe('2026-03-01');
  expect(
    data.template_price_presets
      .filter((row) => row.templateId === template.id)
      .map((row) => row.amountCents)
      .sort(),
  ).toEqual([1250, 6000]);
  expect(
    data.game_server_options
      .filter((row) => row.gameName === '网页模板游戏')
      .map((row) => row.name)
      .sort(),
  ).toEqual(['官服', '渠道服'].sort());

  await exportTemplateFile(page, '网页模板游戏', 'web-template-native.json');
});

test('流程L：安卓回传的模板文件 → 网页生产导入/保存 → 再次导出（链路2 收尾）', async ({
  page,
}) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const fromAndroid = path.join(OUTPUT_DIR, 'android-template-from-web.json');
  expect(readFileSync(fromAndroid, 'utf8')).toContain('"formatVersion": 4');
  await boot(page);
  await importTemplateFile(page, fromAndroid, '网页模板游戏');

  const data = await readDataset(page, [
    'game_templates',
    'template_categories',
    'template_tasks',
    'template_price_presets',
    'game_server_options',
  ]);
  const template = data.game_templates.find((row) => row.gameName === '网页模板游戏')!;
  expect(template).toBeTruthy();
  expect(template.defaultOrderTitle).toBe('网页模板标题');
  expect(template.origin).toBe('IMPORTED');
  const categories = data.template_categories
    .filter((row) => row.templateId === template.id)
    .sort((left, right) => (left.sortOrder as number) - (right.sortOrder as number));
  expect(categories.map((row) => row.name)).toEqual(['网页计次分类', '网页按日分类']);
  const tasks = data.template_tasks.filter((row) => row.templateId === template.id);
  expect(tasks.map((row) => row.title).sort()).toEqual(
    ['签到', '抽数', '周常', '隔天副本', '指定星期', '限时活动'].sort(),
  );
  expect(
    data.template_price_presets
      .filter((row) => row.templateId === template.id)
      .map((row) => row.amountCents)
      .sort(),
  ).toEqual([1250, 6000]);

  // The round-tripped template is still a usable creation default, title included.
  await createOwnerAccount(page, '往返老板', '网页模板游戏');
  const { editor } = await applyTemplateInOrderDialog(page, '网页模板游戏');
  await expect(editor.getByLabel('订单标题')).toHaveValue('网页模板标题');
  await expect(editor.getByLabel('任务标题')).toHaveCount(6);
  await editor.getByRole('button', { name: '取消' }).click();

  await exportTemplateFile(page, '网页模板游戏', 'web-template-reimported.json');
});

// ---------------------------------------------------------------------------
// Flow M — service-weekday repair (D-8): explicit template weekdays must survive
// import → template detail → form → create command → persisted hosting period.
// ---------------------------------------------------------------------------

interface WeekdayFixtureCategory {
  name: string;
  hostingMode: 'DATE_RANGE' | 'COUNT_BASED' | null;
  targetSessions?: number | null;
  serviceWeekdays?: string | null;
  tasks: string[];
}

interface WeekdayFixture {
  fileName: string;
  gameName: string;
  defaultOrderTitle: string;
  hostingMode: 'DATE_RANGE' | 'COUNT_BASED';
  targetSessions: number | null;
  serviceWeekdays: string | null;
  categories: WeekdayFixtureCategory[];
}

/**
 * Hand-authored format-4 template file.
 *
 * This is deliberately NOT an export of any app build: the provenance JSON says so, so
 * these fixtures can never be mistaken for a final-source export of either platform.
 */
function writeWeekdayFixture(fixture: WeekdayFixture): { file: string; sha256: string } {
  const key = fixture.fileName.replace(/[^a-z0-9-]/gi, '-');
  const template = {
    id: `synthetic-${key}-template`,
    gameName: fixture.gameName,
    templateVersion: 'weekday-repair-1.0',
    gameVersionNotes: '合成模板：服务星期修复的浏览器验证（非任何构建的导出产物）',
    timeZone: 'Asia/Shanghai',
    dailyRefresh: '04:00',
    weeklyRefreshDay: 'MONDAY',
    weeklyRefreshTime: '05:00',
    hostingMode: fixture.hostingMode,
    targetSessions: fixture.targetSessions,
    serviceWeekdays: fixture.serviceWeekdays,
    defaultOrderTitle: fixture.defaultOrderTitle,
    serverOptions: ['官服'],
    pricePresets: [],
    categories: fixture.categories.map((category, categoryIndex) => ({
      id: `synthetic-${key}-cat-${categoryIndex + 1}`,
      name: category.name,
      hostingMode: category.hostingMode,
      targetSessions: category.targetSessions ?? null,
      serviceWeekdays: category.serviceWeekdays ?? null,
      tasks: category.tasks.map((title, taskIndex) => ({
        id: `synthetic-${key}-cat-${categoryIndex + 1}-task-${taskIndex + 1}`,
        categoryId: `synthetic-${key}-cat-${categoryIndex + 1}`,
        title,
        progressType: 'CHECKBOX',
        startValue: '0',
        targetValue: '1',
        unit: null,
        recurrence: 'DAILY',
        weekdays: [],
        monthDay: null,
        monthDays: [],
        everyNDays: null,
        activeFrom: null,
        activeUntil: null,
        numericMode: null,
      })),
    })),
  };
  const text = `${JSON.stringify(
    { format: 'daigan-template', formatVersion: 4, template },
    null,
    2,
  )}\n`;
  const absolute = path.join(OUTPUT_DIR, fixture.fileName);
  writeFileSync(absolute, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  writeFileSync(
    path.join(OUTPUT_DIR, `${fixture.fileName.replace(/\.json$/, '')}-provenance.json`),
    `${JSON.stringify(
      {
        file: fixture.fileName,
        sha256,
        sizeBytes: Buffer.byteLength(text),
        templateFormat: 4,
        generatedBy: 'web/tests/e2e/stage5-template.spec.ts (flow M)',
        authoredNotExported: true,
        syntheticDataOnly: true,
        note: 'Hand-authored format-4 template for the explicit service-weekday repair. It is not an export of the web or Android build.',
      },
      null,
      2,
    )}\n`,
  );
  return { file: absolute, sha256 };
}

test('流程M：模板显式服务星期（周一/周三/周五）→ 真实表单 → 落库期次 → 刷新后仍正确', async ({
  page,
}) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const restricted = writeWeekdayFixture({
    fileName: 'web-weekday-restricted-v4.json',
    gameName: '星期受限模板',
    defaultOrderTitle: '星期三托管',
    hostingMode: 'DATE_RANGE',
    targetSessions: null,
    serviceWeekdays: '1,3,5',
    categories: [
      { name: '受限分类', hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5', tasks: ['签到'] },
      { name: '无限制分类', hostingMode: 'DATE_RANGE', serviceWeekdays: null, tasks: ['周常'] },
    ],
  });
  const unrestricted = writeWeekdayFixture({
    fileName: 'web-weekday-unrestricted-v4.json',
    gameName: '星期无限制模板',
    defaultOrderTitle: '无限制托管',
    hostingMode: 'DATE_RANGE',
    targetSessions: null,
    serviceWeekdays: null,
    categories: [
      { name: '工作日分类甲', hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5', tasks: ['签到'] },
      { name: '工作日分类乙', hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5', tasks: ['周常'] },
    ],
  });
  const count = writeWeekdayFixture({
    fileName: 'web-weekday-count-v4.json',
    gameName: '星期计次模板',
    defaultOrderTitle: '计次托管',
    hostingMode: 'COUNT_BASED',
    targetSessions: 6,
    serviceWeekdays: null,
    categories: [
      { name: '计次分类', hostingMode: 'COUNT_BASED', targetSessions: 4, tasks: ['签到'] },
      { name: '按日分类', hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5', tasks: ['周常'] },
    ],
  });

  await boot(page);
  // Production import path only: the library's file picker.
  await importTemplateFile(page, restricted.file, '星期受限模板');
  await importTemplateFile(page, unrestricted.file, '星期无限制模板');
  await importTemplateFile(page, count.file, '星期计次模板');

  const imported = await readDataset(page, ['game_templates', 'template_categories']);
  const restrictedRow = imported.game_templates.find((row) => row.gameName === '星期受限模板')!;
  expect(restrictedRow.hostingMode).toBe('DATE_RANGE');
  expect(restrictedRow.serviceWeekdays).toBe('1,3,5');
  expect(restrictedRow.defaultOrderTitle).toBe('星期三托管');
  const unrestrictedRow = imported.game_templates.find((row) => row.gameName === '星期无限制模板')!;
  expect(unrestrictedRow.hostingMode).toBe('DATE_RANGE');
  expect(unrestrictedRow.serviceWeekdays).toBeNull();
  const countRow = imported.game_templates.find((row) => row.gameName === '星期计次模板')!;
  expect(countRow.hostingMode).toBe('COUNT_BASED');
  expect(countRow.targetSessions).toBe(6);
  expect(
    imported.template_categories
      .filter((row) => row.templateId === restrictedRow.id)
      .map((row) => row.serviceWeekdays)
      .sort(),
  ).toEqual(['1,3,5', null].sort());

  await createOwnerAccount(page, '星期老板', '星期受限模板');
  const { editor, templateSelect } = await applyTemplateInOrderDialog(page, '星期受限模板');
  const weekdayGroup = editor.getByRole('group', { name: '服务星期' });
  const optionValueOf = async (name: string) =>
    (await templateSelect
      .locator('option')
      .filter({ hasText: name })
      .first()
      .getAttribute('value'))!;

  // ---- the form shows the exact imported set, not Monday–Friday ----
  await expect(editor.getByLabel('服务模式')).toHaveValue('weekdays');
  await expect(editor.getByLabel('订单标题')).toHaveValue('星期三托管');
  for (const [day, pressed] of [
    ['一', 'true'],
    ['二', 'false'],
    ['三', 'true'],
    ['四', 'false'],
    ['五', 'true'],
    ['六', 'false'],
    ['日', 'false'],
  ] as const) {
    await expect(weekdayGroup.getByRole('button', { name: `服务周${day}` })).toHaveAttribute(
      'aria-pressed',
      pressed,
    );
  }
  await expect(editor.getByText(/当前仅在 周一、周三、周五 提供服务/)).toBeVisible();
  await editor.getByLabel('开始日期', { exact: true }).fill('2026-03-10');
  await editor.getByLabel('累计服务天数').fill('5');
  // Deterministic preview: 03-10 周二 → 03-11(三) 03-13(五) 03-16(一) 03-18(三) 03-20(五)
  await expect(
    editor.getByText(/预计 2026-03-10 至 2026-03-20（含首尾，服务日 周一、周三、周五）/),
  ).toBeVisible();

  // ---- switching templates replaces/clears the applied restriction ----
  await templateSelect.selectOption(await optionValueOf('星期无限制模板'));
  await expect(editor.getByLabel('服务模式')).toHaveValue('dates');
  await expect(editor.getByLabel('订单标题')).toHaveValue('无限制托管');
  await expect(editor.getByRole('group', { name: '服务星期' })).toHaveCount(0);

  await templateSelect.selectOption(await optionValueOf('星期计次模板'));
  await expect(editor.getByLabel('服务模式')).toHaveValue('count');
  await expect(editor.getByLabel('服务次数')).toHaveValue('6');
  await expect(editor.getByLabel('订单标题')).toHaveValue('计次托管');
  await expect(editor.getByRole('group', { name: '服务星期' })).toHaveCount(0);

  await templateSelect.selectOption(await optionValueOf('星期受限模板'));
  await expect(editor.getByLabel('服务模式')).toHaveValue('weekdays');
  await expect(editor.getByLabel('订单标题')).toHaveValue('星期三托管');
  await expect(weekdayGroup.getByRole('button', { name: '服务周三' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(weekdayGroup.getByRole('button', { name: '服务周二' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(editor.getByLabel('开始日期', { exact: true })).toHaveValue('2026-03-10');
  await expect(editor.getByLabel('累计服务天数')).toHaveValue('5');
  await expect(editor.getByText(/预计 2026-03-10 至 2026-03-20/)).toBeVisible();

  await editor.getByLabel('本期价格（元）').fill('120');
  await editor.getByRole('checkbox').uncheck();
  await editor.getByRole('button', { name: '创建订单' }).click();
  await expect(page.getByRole('heading', { name: '星期三托管' })).toBeVisible();

  // ---- persisted outcome (not form state) ----
  const created = await readDataset(page, ['orders', 'hosting_periods', 'task_definitions']);
  const order = created.orders.find((row) => row.title === '星期三托管')!;
  const period = created.hosting_periods.find((row) => row.orderId === order.id)!;
  expect(order.hostingMode).toBe('DATE_RANGE');
  expect(period.serviceDays).toBe(5);
  expect(period.serviceWeekdays).toBe('1,3,5');
  expect(period.serviceCount).toBeNull();
  expect(period.startDate).toBe('2026-03-10');
  expect(period.endDate).toBe('2026-03-20');
  expect(
    created.task_definitions
      .filter((row) => row.orderId === order.id)
      .map((row) => row.title)
      .sort(),
  ).toEqual(['周常', '签到'].sort());

  // ---- displayed service window on the order detail page ----
  await expect(page.getByText(/服务日 周一、周三、周五 · 累计 5 天/)).toBeVisible();
  await expect(page.getByText(/2026-03-10 ~ 2026-03-20/)).toBeVisible();

  // ---- reload: the same persisted configuration is still what is shown ----
  await page.reload();
  await expect(page.getByRole('heading', { name: '星期三托管' })).toBeVisible();
  await expect(page.getByText(/服务日 周一、周三、周五 · 累计 5 天/)).toBeVisible();
  await expect(page.getByText(/2026-03-10 ~ 2026-03-20/)).toBeVisible();
});

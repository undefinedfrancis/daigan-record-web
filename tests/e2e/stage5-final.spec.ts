import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 5 — closing legs of both chains, in a real browser.
 *
 * These run **after** the Android receiver pass, because they consume the archives the
 * Android production export produced from the browser's own data. They restore through
 * the Settings UI and verify the persisted rows, the UI and a business read before
 * exporting again (no manual record creation anywhere).
 *
 * Files consumed:
 * - `android-chain1-continued.dgbk` — Android restored the browser's continuation, wrote
 *   one more absolute total (25) and exported. The browser must see 25 and its own edits.
 * - `android-chain2-noedit-echo.dgbk` — Android restored the browser-native dataset and
 *   re-exported without edits. The browser must see exactly its own dataset.
 * - `android-chain2-continued.dgbk` — Android restored the browser-native dataset, ran the
 *   continuation commands (two absolute totals, one idempotent replay, one new operation,
 *   a correction, category rename/create/assign/delete, a receipt amendment) and exported.
 *   This is the **edited** return leg: it must be restored and verified against
 *   `chain2-continuation-expectations.json` (written before the run), then edited once more
 *   in the browser and exported twice (plain + encrypted). `android-chain2-noedit-echo.dgbk`
 *   only ever proved the no-edit round trip and is kept for that purpose alone.
 */

const GAME_START = new Date('2026-03-11T04:00:00Z'); // Shanghai 12:00 → game day 2026-03-11
/** Game day 2026-03-12; `setFixedTime` makes recordedAt/createdAt exactly this instant. */
const EDIT_TIME = new Date('2026-03-12T04:00:00Z');
const UNICODE_PASSWORD = 'stage5-互通-Ω-口令';
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage5');
const ANDROID_FIXTURES = path.resolve(
  process.cwd(),
  '../../代肝记录软件/output/interop-fixtures/stage5',
);

interface ContainerReport {
  file: string;
  sizeBytes: number;
  sha256: string;
  container: 'zip-plain' | 'daiganbk-envelope' | 'unknown';
  envelope: {
    magic: string;
    envelopeVersion: number;
    kdfId: number;
    iterations: number;
    saltBytes: number;
    nonceBytes: number;
    ciphertextBytes: number;
  } | null;
}

/**
 * Inspects the real bytes instead of trusting a file name: a `.dgbk` is either a ZIP
 * (plain) or a `DAIGANBK` AES-GCM envelope. The recorded Stage-5 continuation artifacts
 * are checked with this, because `android-chain2-encrypted-continued.dgbk` was exported
 * without a password by `continueOnAndroid` and is therefore a plain ZIP.
 */
function inspectContainer(filePath: string): ContainerReport {
  const bytes = readFileSync(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const base = { file: path.basename(filePath), sizeBytes: bytes.length, sha256 };
  if (bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { ...base, container: 'zip-plain', envelope: null };
  }
  const magic = bytes.subarray(0, 8).toString('latin1');
  if (magic !== 'DAIGANBK') return { ...base, container: 'unknown', envelope: null };
  const envelopeVersion = bytes[8];
  const kdfId = bytes[9];
  const iterations = bytes.readInt32BE(10);
  const saltBytes = bytes[14];
  const nonceBytes = bytes[15 + saltBytes];
  const headerBytes = 8 + 1 + 1 + 4 + 1 + saltBytes + 1 + nonceBytes;
  return {
    ...base,
    container: 'daiganbk-envelope',
    envelope: {
      magic,
      envelopeVersion,
      kdfId,
      iterations,
      saltBytes,
      nonceBytes,
      ciphertextBytes: bytes.length - headerBytes,
    },
  };
}

/**
 * Cross-checks a consumed Android artifact against its recorded provenance before use:
 * same bytes, same size, synthetic data only, emulator watermark, schema 15.
 */
function verifyContinuationInput(file: string, provenanceFile: string) {
  const report = inspectContainer(path.join(ANDROID_FIXTURES, file));
  const provenance = JSON.parse(
    readFileSync(path.join(ANDROID_FIXTURES, provenanceFile), 'utf8'),
  ) as {
    generatedBy: string;
    syntheticDataOnly: boolean;
    hardware: string;
    watermark: string;
    portableSchema: number;
    roomSchema: number;
    templateFormat: number;
    files: { file: string; sha256: string; sizeBytes: number }[];
  };
  const declared = provenance.files.find((entry) => entry.file === file);
  expect(declared, `${provenanceFile} must declare ${file}`).toBeTruthy();
  expect(report.sha256).toBe(declared!.sha256);
  expect(report.sizeBytes).toBe(declared!.sizeBytes);
  expect(provenance.syntheticDataOnly).toBe(true);
  expect(provenance.hardware).toBe('emulator');
  expect(provenance.watermark).toBe('emulator-not-physical-device');
  expect(provenance.portableSchema).toBe(15);
  expect(provenance.roomSchema).toBe(15);
  expect(provenance.templateFormat).toBe(4);
  return { report, provenance };
}

function writeReport(name: string, value: unknown) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(path.join(OUTPUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
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

/** SHA-256 of the restored Blob, computed in the browser from the actual bytes. */
async function attachmentDigestInBrowser(page: Page) {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases
      .map((database) => database.name ?? '')
      .find((value) => value.startsWith('daigan-data-'))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ id: string; blob: Blob }[]>((resolve, reject) => {
      const tx = db.transaction('attachmentBlobs', 'readonly');
      const request = tx.objectStore('attachmentBlobs').getAll();
      request.onsuccess = () => resolve(request.result as { id: string; blob: Blob }[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const bytes = new Uint8Array(await rows[0].blob.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      id: rows[0].id,
      size: bytes.length,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  });
}

async function boot(page: Page) {
  await page.clock.install({ time: GAME_START });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日事项' })).toBeVisible();
}

async function gotoSection(
  page: Page,
  name: '今日事项' | '订单' | '老板与账号' | '模板库' | '资料与设置',
) {
  // 模板库 / 资料与设置 live in the secondary navigation.
  const nav = name === '资料与设置' || name === '模板库' ? '次导航' : '主导航';
  await page
    .getByRole('navigation', { name: nav })
    .getByRole('button', { name, exact: true })
    .click();
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

async function exportBackup(page: Page, fileName: string, password?: string) {
  await gotoSection(page, '资料与设置');
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
  console.log(
    `browser export ${fileName}: ${bytes.length} bytes sha256=${createHash('sha256').update(bytes).digest('hex')}`,
  );
}

test('流程F：网页→安卓→网页（链路1收尾）：浏览器看到安卓续写后的 25 与自己的改动', async ({
  page,
}) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await boot(page);
  await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain1-continued.dgbk'));

  // The browser's own continuation edits survived the Android round trip.
  await gotoSection(page, '订单');
  await expect(page.getByText('网页续用订单').first()).toBeVisible();
  await page.getByText('网页续用订单').first().click();
  await expect(page.getByRole('heading', { name: '网页续用订单' })).toBeVisible();
  // Android wrote one more absolute total (25) on the next game day: it must win.
  await expect(page.getByText(/25 \/ 100/).first()).toBeVisible();
  // The historical correction chain is intact (both platforms' corrections).
  await expect(page.getByText(/2026-03-10 · 第 1 次打卡 · 更正 · 8/)).toBeVisible();

  // Category rename performed on Android is visible in the browser.
  await gotoSection(page, '订单');
  const data = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases
      .map((database) => database.name ?? '')
      .find((value) => value.startsWith('daigan-data-'))!;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store: string) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
        request.onerror = () => reject(request.error);
      });
    const rows = {
      categories: await read('account_categories'),
      events: await read('task_progress_events'),
    };
    db.close();
    return rows;
  });
  const categoryNames = data.categories.map((row) => row.name);
  // The browser-created category (assigned to a restored account) survived both hops.
  expect(categoryNames).toContain('网页续用分类');
  expect(categoryNames).toContain('主号');
  // The Android write added exactly one more absolute total; the browser's own event chain
  // (including the earlier-date correction) is intact.
  expect(data.events.some((event) => event.totalValue === '25')).toBe(true);
  expect(data.events.some((event) => event.totalValue === '8')).toBe(true);

  await exportBackup(page, 'web-chain1-final.dgbk');
});

test('流程G：网页→安卓→网页（链路2收尾）：安卓回传的无编辑数据集在浏览器中一致可用', async ({
  page,
}) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  await boot(page);
  await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain2-noedit-echo.dgbk'));

  await gotoSection(page, '订单');
  await expect(page.getByText('网页打卡单').first()).toBeVisible();
  await expect(page.getByText('网页日期单').first()).toBeVisible();
  await expect(page.getByText('网页短期单').first()).toBeVisible();

  // Absolute totals survived the Android round trip unchanged.
  await page.getByText('网页打卡单').first().click();
  await expect(page.getByRole('heading', { name: '网页打卡单' })).toBeVisible();
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();

  // The real JPEG still renders (bytes, not a marker).
  await gotoSection(page, '订单');
  await page.getByText('网页短期单').first().click();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  await expect(photos.locator('figure')).toHaveCount(1);
  const width = await photos.locator('img').first().evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.naturalWidth;
  });
  expect(width).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  await exportBackup(page, 'web-chain2-final.dgbk');
});

test('流程H：链路2的安卓“已编辑”回程产物在网页恢复、校验、再编辑并生产导出', async ({ page }) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const expectations = JSON.parse(
    readFileSync(path.join(OUTPUT_DIR, 'chain2-continuation-expectations.json'), 'utf8'),
  ) as {
    inputs: {
      plainContinuation: { sha256: string; sizeBytes: number };
      encryptedNamedContinuation: { sha256: string };
    };
    unchangedFromBrowserSource: {
      orderIds: string[];
      accountIds: string[];
      periodIds: string[];
      sessionIds: string[];
      taskIds: string[];
      browserSourceEventIds: string[];
      attachment: {
        id: string;
        sizeBytes: number;
        sha256: string;
        relativePath: string;
        mimeType: string;
      };
    };
    androidEdits: {
      cumulativeTask: { id: string; currentValue: string; targetValue: string };
      events: {
        sequence: number;
        id: string;
        operationId: string;
        kind: string;
        scopeType: string;
        gameDate: string;
        totalValue: string;
        correctsEventId: string | null;
      }[];
      eventCount: number;
      scopeSessionId: string;
      categories: { present: { id: string; name: string }[]; absent: string[] };
      accountCategoryAssignment: Record<string, string>;
      receiptAmendment: {
        original: { id: string; amountCents: number; status: string; replacedByReceiptId: string };
        replacement: { id: string; amountCents: number; status: string };
        correction: { kind: string; receiptId: string; newReceiptId: string };
      };
    };
    browserEdit: {
      expectedEvent: {
        sequence: number;
        kind: string;
        scopeSessionId: string;
        gameDate: string;
        totalValue: string;
        recordedAt: number;
        createdAt: number;
      };
      expectedTaskCurrentValue: string;
      expectedEventCount: number;
      expectedUiHistoryRow: string;
    };
  };

  // ---- 输入校验：真实字节、provenance 与容器类型 -------------------------
  const plain = verifyContinuationInput(
    'android-chain2-continued.dgbk',
    'android-chain2-continued-provenance.json',
  );
  const encryptedNamed = verifyContinuationInput(
    'android-chain2-encrypted-continued.dgbk',
    'android-chain2-encrypted-continued-provenance.json',
  );
  expect(plain.report.sha256).toBe(expectations.inputs.plainContinuation.sha256);
  expect(plain.report.sizeBytes).toBe(expectations.inputs.plainContinuation.sizeBytes);
  expect(plain.report.container).toBe('zip-plain');
  // Inspected, not inferred from the name: the "encrypted" continuation artifact is plain.
  expect(encryptedNamed.report.sha256).toBe(
    expectations.inputs.encryptedNamedContinuation.sha256,
  );
  expect(encryptedNamed.report.container).toBe('zip-plain');
  writeReport('chain2-continuation-input-verification.json', {
    capturedAt: new Date().toISOString(),
    inspected: [plain.report, encryptedNamed.report],
    provenanceClaims: [plain.provenance, encryptedNamed.provenance],
    note:
      'Both Android continuation exports are plain ZIP archives. b2 restored the encrypted ' +
      'browser input but re-exported without a password, so no encrypted continuation artifact exists.',
  });

  await boot(page);
  await restoreBackup(page, path.join(ANDROID_FIXTURES, 'android-chain2-continued.dgbk'));

  // ---- 持久化断言：安卓的编辑真的到达了 -----------------------------------
  const data = await readDataset(page, [
    'owners',
    'game_accounts',
    'account_categories',
    'orders',
    'hosting_periods',
    'hosting_sessions',
    'task_definitions',
    'task_progress_events',
    'attachments',
    'receipts',
    'receipt_corrections',
  ]);
  expect(data.owners).toHaveLength(2);
  expect(data.game_accounts.map((row) => row.id as string).sort()).toEqual(
    [...expectations.unchangedFromBrowserSource.accountIds].sort(),
  );
  expect(data.orders.map((row) => row.id as string).sort()).toEqual(
    [...expectations.unchangedFromBrowserSource.orderIds].sort(),
  );
  expect(data.hosting_periods.map((row) => row.id as string).sort()).toEqual(
    [...expectations.unchangedFromBrowserSource.periodIds].sort(),
  );
  expect(data.hosting_sessions.map((row) => row.id as string).sort()).toEqual(
    [...expectations.unchangedFromBrowserSource.sessionIds].sort(),
  );
  expect(data.task_definitions.map((row) => row.id as string).sort()).toEqual(
    [...expectations.unchangedFromBrowserSource.taskIds].sort(),
  );

  // Cumulative chain: every recorded observation, in order, with scope/date/link intact.
  const events = data.task_progress_events
    .slice()
    .sort((left, right) => (left.sequence as number) - (right.sequence as number));
  expect(events).toHaveLength(expectations.androidEdits.eventCount);
  // Project both sides onto the same business facts: the expectation file also carries a
  // prose `origin` per row, which is documentation, not persisted data.
  const expectedEventFacts = expectations.androidEdits.events.map((event) => ({
    sequence: event.sequence,
    id: event.id,
    operationId: event.operationId,
    kind: event.kind,
    scopeType: event.scopeType,
    gameDate: event.gameDate,
    totalValue: event.totalValue,
    correctsEventId: event.correctsEventId,
  }));
  expect(
    events.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      operationId: event.operationId,
      kind: event.kind,
      scopeType: event.scopeType,
      gameDate: event.gameDate,
      totalValue: event.totalValue,
      correctsEventId: event.correctsEventId,
    })),
  ).toEqual(expectedEventFacts);
  for (const event of events) {
    expect(event.taskDefinitionId).toBe(expectations.androidEdits.cumulativeTask.id);
    expect(event.scopeSessionId).toBe(expectations.androidEdits.scopeSessionId);
    expect(event.scopePeriodId).toBeNull();
  }

  const cumulativeTask = data.task_definitions.find(
    (row) => row.id === expectations.androidEdits.cumulativeTask.id,
  )!;
  expect(cumulativeTask.currentValue).toBe(
    expectations.androidEdits.cumulativeTask.currentValue,
  );
  expect(cumulativeTask.targetValue).toBe(expectations.androidEdits.cumulativeTask.targetValue);
  expect(cumulativeTask.numericMode).toBe('CUMULATIVE');

  // Round and order stay open (the checkbox task has no observation).
  const session = data.hosting_sessions[0];
  expect(session.completedAt).toBeNull();
  const countOrder = data.orders.find(
    (row) => row.id === 'df3d6c7f-d01d-4bc4-8b5d-bc1ee1da77ff',
  )!;
  expect(countOrder.completedAt).toBeNull();

  // Categories: rename+delete result, the new category, and the account assignment.
  expect(data.account_categories.map((row) => row.id as string).sort()).toEqual(
    expectations.androidEdits.categories.present.map((entry) => entry.id).sort(),
  );
  const categoryNames = data.account_categories.map((row) => row.name as string);
  for (const name of expectations.androidEdits.categories.absent) {
    expect(categoryNames).not.toContain(name);
  }
  expect(categoryNames).not.toContain('安卓改名分类');
  for (const [accountId, categoryId] of Object.entries(
    expectations.androidEdits.accountCategoryAssignment,
  )) {
    expect(data.game_accounts.find((row) => row.id === accountId)!.categoryId).toBe(categoryId);
  }

  // Receipt amendment keeps both the replaced row and its correction record.
  const amendment = expectations.androidEdits.receiptAmendment;
  const original = data.receipts.find((row) => row.id === amendment.original.id)!;
  expect(original.status).toBe(amendment.original.status);
  expect(original.amountCents).toBe(amendment.original.amountCents);
  expect(original.replacedByReceiptId).toBe(amendment.original.replacedByReceiptId);
  const replacement = data.receipts.find((row) => row.id === amendment.replacement.id)!;
  expect(replacement.status).toBe(amendment.replacement.status);
  expect(replacement.amountCents).toBe(amendment.replacement.amountCents);
  const correction = data.receipt_corrections[0];
  expect(correction.kind).toBe(amendment.correction.kind);
  expect(correction.receiptId).toBe(amendment.correction.receiptId);
  expect(correction.newReceiptId).toBe(amendment.correction.newReceiptId);

  // Attachment identity, metadata and the SHA-256 of the restored bytes.
  expect(data.attachments).toHaveLength(1);
  const attachment = data.attachments[0];
  expect(attachment.id).toBe(expectations.unchangedFromBrowserSource.attachment.id);
  expect(attachment.sizeBytes).toBe(expectations.unchangedFromBrowserSource.attachment.sizeBytes);
  expect(attachment.relativePath).toBe(
    expectations.unchangedFromBrowserSource.attachment.relativePath,
  );
  expect(attachment.mimeType).toBe(expectations.unchangedFromBrowserSource.attachment.mimeType);
  const digest = await attachmentDigestInBrowser(page);
  expect(digest.size).toBe(expectations.unchangedFromBrowserSource.attachment.sizeBytes);
  expect(digest.sha256).toBe(expectations.unchangedFromBrowserSource.attachment.sha256);

  // ---- 界面可用性：恢复后的真实页面 ---------------------------------------
  await gotoSection(page, '订单');
  await expect(page.getByText('网页打卡单').first()).toBeVisible();
  await page.getByText('网页打卡单').first().click();
  await expect(page.getByRole('heading', { name: '网页打卡单' })).toBeVisible();
  await expect(page.getByText(/15 \/ 100/).first()).toBeVisible();
  // The Android continuation is visible as history, including its earlier-date correction.
  await expect(page.getByText(/2026-03-11 · 第 1 次打卡 · 记录 · 10/)).toBeVisible();
  await expect(page.getByText(/2026-03-11 · 第 1 次打卡 · 记录 · 15/).first()).toBeVisible();
  await expect(page.getByText(/2026-03-10 · 第 1 次打卡 · 更正 · 8/)).toBeVisible();

  await gotoSection(page, '老板与账号');
  await page.getByRole('button', { name: '按账号' }).click();
  const categoryFilter = page.getByLabel('按分类筛选');
  await expect(categoryFilter.getByRole('option', { name: '网页次分类' })).toHaveCount(1);
  await expect(categoryFilter.getByRole('option', { name: '安卓新建分类' })).toHaveCount(1);
  await expect(categoryFilter.getByRole('option', { name: '网页主分类' })).toHaveCount(0);

  await gotoSection(page, '订单');
  await page.getByText('网页日期单').first().click();
  await expect(page.getByText(/实收 ¥29\.00/).first()).toBeVisible();
  await expect(page.getByText('已更正').first()).toBeVisible();

  await gotoSection(page, '订单');
  await page.getByText('网页短期单').first().click();
  await page.getByRole('button', { name: '截图', exact: true }).click();
  const photos = page.getByRole('dialog', { name: '截图', exact: true });
  await expect(photos.locator('figure')).toHaveCount(1);
  const width = await photos.locator('img').first().evaluate((image) => {
    const element = image as HTMLImageElement;
    return element.naturalWidth;
  });
  expect(width).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // ---- 无编辑再导出（与 Android 续写产物做 canonical 比较） ----------------
  await exportBackup(page, 'web-chain2-android-edited-noedit.dgbk');

  // ---- 网页再做一个真实业务操作：新的合法累计总值 --------------------------
  await page.clock.setFixedTime(EDIT_TIME);
  await gotoSection(page, '订单');
  await page.getByText('网页打卡单').first().click();
  await expect(page.getByRole('heading', { name: '网页打卡单' })).toBeVisible();
  await page.getByLabel('网页抽数 当前累计总值').fill(expectations.browserEdit.expectedEvent.totalValue);
  await page.getByRole('button', { name: '记录总值' }).click();
  await expect(page.getByText(expectations.browserEdit.expectedUiHistoryRow)).toBeVisible();
  await expect(page.getByText(/40 \/ 100/).first()).toBeVisible();

  const edited = await readDataset(page, ['task_progress_events', 'task_definitions']);
  const editedEvents = edited.task_progress_events
    .slice()
    .sort((left, right) => (left.sequence as number) - (right.sequence as number));
  expect(editedEvents).toHaveLength(expectations.browserEdit.expectedEventCount);
  const created = editedEvents[editedEvents.length - 1];
  const expected = expectations.browserEdit.expectedEvent;
  expect(created.sequence).toBe(expected.sequence);
  expect(created.kind).toBe(expected.kind);
  expect(created.scopeType).toBe('SESSION');
  expect(created.scopeSessionId).toBe(expected.scopeSessionId);
  expect(created.scopePeriodId).toBeNull();
  expect(created.gameDate).toBe(expected.gameDate);
  expect(created.totalValue).toBe(expected.totalValue);
  expect(created.correctsEventId).toBeNull();
  expect(created.recordedAt).toBe(expected.recordedAt);
  expect(created.createdAt).toBe(expected.createdAt);
  expect(created.taskDefinitionId).toBe(expectations.androidEdits.cumulativeTask.id);
  // The created row's identity must be new, not one of the restored rows.
  const knownIds = new Set(expectations.androidEdits.events.map((event) => event.id));
  const knownOperations = new Set(
    expectations.androidEdits.events.map((event) => event.operationId),
  );
  expect(knownIds.has(created.id as string)).toBe(false);
  expect(knownOperations.has(created.operationId as string)).toBe(false);
  expect(
    edited.task_definitions.find(
      (row) => row.id === expectations.androidEdits.cumulativeTask.id,
    )!.currentValue,
  ).toBe(expectations.browserEdit.expectedTaskCurrentValue);

  writeReport('chain2-browser-edit-observation.json', {
    capturedAt: new Date().toISOString(),
    intent: 'one new eligible absolute total 40 on game day 2026-03-12',
    createdEventId: created.id,
    createdOperationId: created.operationId,
    sequence: created.sequence,
    totalEvents: editedEvents.length,
    taskCurrentValue: expectations.browserEdit.expectedTaskCurrentValue,
    note: 'Identities are recorded for the report only; the declared difference set constrains them as fresh values.',
  });

  // ---- 生产导出：明文 + 加密（Unicode 口令） ------------------------------
  await exportBackup(page, 'web-chain2-browser-continued.dgbk');
  await exportBackup(page, 'web-chain2-browser-continued-encrypted.dgbk', UNICODE_PASSWORD);
});

test('流程I：网页导出的加密续写产物（真实 DAIGANBK 信封）可再被网页恢复，业务内容与明文一致', async ({
  page,
}) => {
  const encryptedPath = path.join(OUTPUT_DIR, 'web-chain2-browser-continued-encrypted.dgbk');
  const envelope = inspectContainer(encryptedPath);
  expect(envelope.container).toBe('daiganbk-envelope');
  expect(envelope.envelope!.magic).toBe('DAIGANBK');
  expect(envelope.envelope!.envelopeVersion).toBe(1);
  expect(envelope.envelope!.kdfId).toBe(1);
  expect(envelope.envelope!.iterations).toBe(210_000);
  expect(envelope.envelope!.saltBytes).toBe(16);
  expect(envelope.envelope!.nonceBytes).toBe(12);
  expect(envelope.envelope!.ciphertextBytes).toBeGreaterThan(500);
  // The plain export of the same dataset must NOT be an envelope.
  expect(inspectContainer(path.join(OUTPUT_DIR, 'web-chain2-browser-continued.dgbk')).container).toBe(
    'zip-plain',
  );
  writeReport('chain2-encrypted-continuation-envelope.json', {
    capturedAt: new Date().toISOString(),
    encryptedExport: envelope,
    passwordKind: 'synthetic Unicode password (never a user secret)',
    note: 'Envelope parsed from the actual bytes; the restore below proves the payload decrypts.',
  });

  await boot(page);
  await restoreBackup(page, encryptedPath, UNICODE_PASSWORD);

  const data = await readDataset(page, [
    'task_progress_events',
    'task_definitions',
    'attachments',
    'orders',
  ]);
  expect(data.orders).toHaveLength(3);
  expect(data.task_progress_events).toHaveLength(7);
  expect(
    data.task_progress_events.some((event) => event.totalValue === '40' && event.kind === 'SUBMIT'),
  ).toBe(true);
  expect(data.attachments).toHaveLength(1);
  const digest = await attachmentDigestInBrowser(page);
  expect(digest.size).toBe(1324);
  expect(digest.sha256).toBe('34072e7a69d880c86f989d428b3ef64f856f350758bd60c3d97eebb99a436d3f');

  await gotoSection(page, '订单');
  await page.getByText('网页打卡单').first().click();
  await expect(page.getByText(/40 \/ 100/).first()).toBeVisible();

  await exportBackup(page, 'web-chain2-encrypted-continued-restored.dgbk');
});

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { createServices } from '../../src/application';
import type { BackupDataSet, TableName } from '../../src/contracts/tables';
import { BUSINESS_TABLES } from '../../src/contracts/tables';
import { bytesOf, readArchive, writeArchive } from '../../src/backup/archive';
import { columnsFor } from '../../src/backup/catalog';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';

/**
 * Stage 5 web-side exchange matrix (archive level, production codecs and services).
 *
 * Scope, stated honestly:
 * - the **browser** legs (restore through the Settings UI, UI usability, continued work,
 *   production download, installed Dexie 2→3 upgrade) are in
 *   `tests/e2e/stage5.spec.ts` and `tests/e2e/stage5-final.spec.ts`;
 * - this file consumes the *same* files those runs produced, restores them again through
 *   the production `prepareRestore`/`commitRestore` path, and covers the adverse matrix
 *   and the legacy inputs that are impractical to drive through the UI;
 * - it also writes the canonical business snapshots the host-side comparator uses, so a
 *   comparison never depends on an agent's summary of what "should" be equal.
 */

const ANDROID_FIXTURES = path.resolve(
  process.cwd(),
  '../../代肝记录软件/output/interop-fixtures/stage5',
);
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage5');
const UNICODE_PASSWORD = 'stage5-互通-Ω-口令';

const ANDROID_FILES = [
  'android-chain1-plain.dgbk',
  'android-chain1-encrypted.dgbk',
  'android-chain1-template-v4.json',
  'android-chain1-canonical.json',
  'android-chain1-provenance.json',
  'legacy-android14.dgbk',
  'legacy-android14-provenance.json',
];

const WEB_FILES = [
  'web-chain1-continued.dgbk',
  'web-chain1-noedit.dgbk',
  'web-chain1-final.dgbk',
  'web-chain2-plain.dgbk',
  'web-chain2-encrypted.dgbk',
  'web-chain2-final.dgbk',
  // Chain-2 edited return leg (flow H/I): the browser's own restore of Android's
  // continuation, the continuation after one more recorded total, and the encrypted /
  // re-restored copies of that continuation.
  'web-chain2-android-edited-noedit.dgbk',
  'web-chain2-browser-continued.dgbk',
  'web-chain2-browser-continued-encrypted.dgbk',
  'web-chain2-encrypted-continued-restored.dgbk',
];

/** Encrypted browser artifacts and the synthetic password each was written with. */
const WEB_ENCRYPTED: Record<string, string> = {
  'web-chain2-encrypted.dgbk': UNICODE_PASSWORD,
  'web-chain2-browser-continued-encrypted.dgbk': UNICODE_PASSWORD,
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function fileBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart]);
}

let idCounter = 0;

async function freshEnv() {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-') || name === 'daigan-control') {
      await Dexie.delete(name);
    }
  }
  resetControlDb();
  idCounter = 0;
  const newId = () => `web-s5-${++idCounter}`;
  const runtime = new DatasetRuntime({ newId, now: () => Date.now() });
  const services = createServices(runtime, () => Date.now(), newId);
  await runtime.init();
  const token = await runtime.current();
  return { runtime, services, token };
}

async function restoreFile(
  env: Awaited<ReturnType<typeof freshEnv>>,
  file: string,
  password?: string,
) {
  const preview = await env.services.restore.prepareRestore(blobOf(fileBytes(file)), password);
  const token = await env.services.restore.commitRestore(
    preview.sessionId,
    await env.runtime.current(),
  );
  return { preview, token };
}

function androidFile(name: string): string {
  return path.join(ANDROID_FIXTURES, name);
}

function webFile(name: string): string {
  return path.join(OUTPUT_DIR, name);
}

/**
 * Minimal central-directory reader: returns each entry's compression method. Used to prove
 * the web writer never emits STORED entries with a data descriptor, which Java's
 * `ZipInputStream` (the Android reader) rejects.
 */
function zipEntryMethods(bytes: Uint8Array): { name: string; method: number; flags: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: { name: string; method: number; flags: number }[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('bad central directory header');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('Stage 5 输入夹具（安卓生产导出）', () => {
  it('夹具文件齐全，provenance 声明为合成数据且哈希自洽', () => {
    for (const name of ANDROID_FILES) {
      expect(existsSync(androidFile(name)), `${name} 必须存在`).toBe(true);
    }
    const provenance = JSON.parse(
      readFileSync(androidFile('android-chain1-provenance.json'), 'utf8'),
    ) as {
      syntheticDataOnly: boolean;
      hardware: string;
      portableSchema: number;
      roomSchema: number;
      files: { file: string; sha256: string; sizeBytes: number }[];
      extra: { attachmentSha256: string; attachmentBytes: number; attachmentOwnsTask: string };
    };
    expect(provenance.syntheticDataOnly).toBe(true);
    expect(provenance.hardware).toBe('emulator');
    expect(provenance.portableSchema).toBe(15);
    expect(provenance.roomSchema).toBe(15);
    for (const entry of provenance.files) {
      const bytes = fileBytes(path.join(ANDROID_FIXTURES, entry.file));
      expect(`${entry.file}:${sha256(bytes)}`).toBe(`${entry.file}:${entry.sha256}`);
      expect(bytes.length).toBe(entry.sizeBytes);
    }
    // The attachment is a real JPEG produced by the device encoder, not a four-byte marker.
    expect(provenance.extra.attachmentBytes).toBeGreaterThan(512);
    expect(provenance.extra.attachmentSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('网页生产恢复路径消费安卓 Stage 5 导出', () => {
  it('明文：业务数据、真实截图字节与真实命令在恢复后可用', async () => {
    const env = await freshEnv();
    const { preview, token } = await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    expect(preview.schemaVersion).toBe(15);
    expect(preview.counts.orders).toBe(3);
    expect(preview.counts.accounts).toBe(2);
    // Schema 15 input never triggers the C:→N: migration.
    expect(preview.migrations).toEqual([]);

    const data = await env.runtime.read((ctx) => ctx.data);
    expect(data.owners).toHaveLength(2);
    expect(data.account_categories.length).toBeGreaterThanOrEqual(2);
    expect(data.hosting_sessions).toHaveLength(3);
    expect(data.task_progress_events.length).toBeGreaterThanOrEqual(6);
    expect(data.attachments).toHaveLength(1);
    const attachmentRow = data.attachments[0];
    expect(attachmentRow.sizeBytes).toBeGreaterThan(512);
    // Real bytes, read from the archive itself (the production `readArchive` path).
    // Stage 2 R7 still applies: jsdom/fake-indexeddb cannot round-trip a DOM Blob, so the
    // *IndexedDB* copy is verified by metadata here and by real bytes in the browser
    // flows (`stage5.spec.ts` flow A/G) and by the Android receiver.
    const fromArchive = await readArchive(blobOf(fileBytes(androidFile('android-chain1-plain.dgbk'))));
    const archiveBlob = fromArchive.snapshot.attachments.get(attachmentRow.id);
    expect(archiveBlob).toBeTruthy();
    const archiveBytes = await bytesOf(archiveBlob!);
    expect(archiveBytes.length).toBe(attachmentRow.sizeBytes);
    expect(archiveBytes[0]).toBe(0xff);
    expect(archiveBytes[1]).toBe(0xd8);
    expect(sha256(archiveBytes)).toBe(
      (
        JSON.parse(readFileSync(androidFile('android-chain1-provenance.json'), 'utf8')) as {
          extra: { attachmentSha256: string };
        }
      ).extra.attachmentSha256,
    );

    // UF-038 through the production query/command path on restored data.
    const countOrder = data.orders.find((order) => order.hostingMode === 'COUNT_BASED')!;
    expect(countOrder).toBeTruthy();
    const detail = await env.services.queries.orderDetail(countOrder.id);
    expect(detail!.rounds.map((round) => round.sessionIndex).sort()).toEqual([1, 2, 3]);
    const cumulative = detail!.cumulative[0];
    const { total } = await env.services.progress.currentTotal({
      taskId: cumulative.taskId,
      scope: cumulative.scope!,
    });
    expect(total).toBe(cumulative.currentValue);

    // UF-037: categories still work after the restore (rename + delete keeps accounts).
    const category = data.account_categories[0];
    await env.services.accounts.renameCategory({ categoryId: category.id, name: '网页重命名' }, token);
    const accountsBefore = (await env.runtime.read((ctx) => ctx.data)).game_accounts.length;
    const ordersBefore = (await env.runtime.read((ctx) => ctx.data)).orders.length;
    await env.services.accounts.deleteCategory({ categoryId: category.id }, token);
    const after = await env.runtime.read((ctx) => ctx.data);
    expect(after.account_categories.some((row) => row.id === category.id)).toBe(false);
    expect(after.game_accounts).toHaveLength(accountsBefore);
    expect(after.orders).toHaveLength(ordersBefore);
    expect(after.game_accounts.every((row) => row.categoryId !== category.id)).toBe(true);
  });

  it('加密（Unicode 口令）：同一个生产恢复路径可以打开', async () => {
    const env = await freshEnv();
    const { preview } = await restoreFile(
      env,
      androidFile('android-chain1-encrypted.dgbk'),
      UNICODE_PASSWORD,
    );
    expect(preview.counts.orders).toBe(3);
    expect(preview.counts.attachments).toBe(1);
    const data = await env.runtime.read((ctx) => ctx.data);
    expect(data.hosting_sessions).toHaveLength(3);
    expect(data.game_templates.some((row) => row.defaultOrderTitle === '每日托管')).toBe(true);
  });

  it('旧版兼容：结构化的 schema-14 文件升级后业务数据不丢、也不被虚构', async () => {
    const env = await freshEnv();
    const { preview } = await restoreFile(env, androidFile('legacy-android14.dgbk'));
    expect(preview.schemaVersion).toBe(14);
    expect(preview.targetSchemaVersion).toBe(15);
    const data = await env.runtime.read((ctx) => ctx.data);
    expect(data.owners).toHaveLength(1);
    expect(data.orders).toHaveLength(2);
    // Count rounds were migrated to N: keys with an owning period and a period target.
    expect(data.hosting_sessions).toHaveLength(2);
    const period = data.hosting_periods.find((row) => row.serviceCount !== null)!;
    expect(period.serviceCount).toBe(3);
    expect(data.hosting_sessions.every((row) => row.periodId === period.id)).toBe(true);
    // The legacy fixture completed one task in round 1 and allocated round 2 without
    // writing it, so exactly one N: occurrence exists and no key stays C:.
    expect(data.task_occurrences.map((row) => row.occurrenceKey).sort()).toEqual(['N:1']);
    // Legacy numeric values are never reinterpreted as cumulative totals.
    expect(data.task_progress_events).toHaveLength(0);
    expect(data.account_categories).toHaveLength(0);
    // The order mirror follows the latest count period.
    expect(data.orders.find((row) => row.id === period.orderId)!.targetSessions).toBe(3);
  });
});

/** Builds a synthetic portable-schema-12 archive from a normalised dataset. */
async function writeLegacyArchive(data: BackupDataSet, schemaVersion: number): Promise<Blob> {
  // The column list comes from the real current export (the decoder requires the declared
  // columns to be an ordered subset of the catalog); only the *values* and the declared
  // schema version make the file historical.
  const tables = BUSINESS_TABLES.map((table) => {
    const rows = (data as unknown as Record<string, Record<string, unknown>[]>)[table] ?? [];
    const columns = columnsFor(table);
    return {
      name: table,
      columns,
      rows: rows.map((row) => columns.map((column) => row[column] ?? null)),
    };
  });
  const dataJson = { format: 'daigan-backup-data', formatVersion: 1, schemaVersion, tables };
  const dataBytes = new TextEncoder().encode(JSON.stringify(dataJson));
  const manifest = {
    format: 'daigan-backup',
    formatVersion: 1,
    schemaVersion,
    exportedAt: Date.now(),
    generator: 'stage5-exchange-test/synthetic-legacy',
    dataSha256: sha256(dataBytes),
    tableCounts: Object.fromEntries(
      tables.map((table) => [table.name, table.rows.length]),
    ),
    attachmentTotalBytes: 0,
    attachments: [],
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add(
    'manifest.json',
    new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(manifest))),
    { level: 6 },
  );
  await writer.add('data.json', new Uint8ArrayReader(dataBytes), { level: 6 });
  return new Blob([(await writer.close()) as unknown as BlobPart]);
}

describe('旧版网页（便携 schema 12）输入：计次期次、分配与部分进度', () => {
  it('C: 打卡键迁移为 N: 轮次，期次目标与部分进度、收款归属都保留', async () => {
    const { snapshot } = await readArchive(
      blobOf(fileBytes(androidFile('android-chain1-plain.dgbk'))),
    );
    const legacy = structuredClone(snapshot.data) as BackupDataSet;
    // Keep one count order and one account/owner; everything else is dropped so the
    // legacy shape only contains what a web-12 file could contain.
    const owner = legacy.owners[0];
    const account = legacy.game_accounts[0];
    const countOrder = legacy.orders.find((order) => order.hostingMode === 'COUNT_BASED')!;
    const period = legacy.hosting_periods.find((row) => row.orderId === countOrder.id)!;
    const tasks = legacy.task_definitions.filter((row) => row.orderId === countOrder.id);
    const legacyTasks = tasks.slice(0, 2);
    const day = '2026-03-10';
    const occurrences = legacyTasks.map((task, index) => ({
      ...structuredClone(legacy.task_occurrences[0]),
      id: `legacy-occ-${index}`,
      taskDefinitionId: task.id,
      occurrenceKey: `C:${day}`,
      gameDate: day,
      windowStart: day,
      windowEnd: day,
      completedAt: index === 0 ? 1773108000000 : null,
      recordedAt: index === 0 ? 1773108000000 : null,
      backfilled: 0,
      completionBatchId: null,
      value: index === 0 ? null : '4',
      createdAt: 1773108000000,
    }));
    const receipts = legacy.receipts.filter(
      (row) => row.orderId === countOrder.id && (row.periodId === null || row.periodId === period.id),
    );

    const data: Record<string, unknown[]> = {};
    for (const table of BUSINESS_TABLES) data[table] = [];
    data.owners = [owner];
    data.game_accounts = [{ ...account, categoryId: null }];
    data.orders = [
      { ...countOrder, hostingMode: null, targetSessions: null, monthlyRefreshDays: null },
    ];
    data.hosting_periods = [{ ...period, monthlyRefreshDays: null }];
    data.task_definitions = legacyTasks.map((task) => ({
      ...task,
      numericMode: null,
      colorArgb: null,
      activeUntil: null,
    }));
    data.task_occurrences = occurrences;
    data.receipts = receipts;

    const blob = await writeLegacyArchive(data as unknown as BackupDataSet, 12);
    const env = await freshEnv();
    const preview = await env.services.restore.prepareRestore(blob);
    expect(preview.schemaVersion).toBe(12);
    expect(preview.migrations).toContain('web-count-sessions-from-dates');
    await env.services.restore.commitRestore(preview.sessionId, env.token);

    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(restored.hosting_sessions).toHaveLength(1);
    const session = restored.hosting_sessions[0];
    expect(session.sessionIndex).toBe(1);
    expect(session.periodId).toBe(period.id);
    // The web-12 per-period target has no equivalent column; the order target is preserved
    // and the migration derives the period target from it (never invents extra rounds).
    // The fixture period was the first one (target 2); its own target survives and the
    // order mirror is recomputed from the latest count period, never from the file's mirror.
    expect(restored.hosting_periods[0].serviceCount).toBe(2);
    expect(restored.orders[0].targetSessions).toBe(2);
    expect(restored.orders[0].hostingMode).toBe('COUNT_BASED');
    expect(restored.task_occurrences.map((row) => row.occurrenceKey)).toEqual(['N:1', 'N:1']);
    // Partial progress of the numeric task is untouched (4 of 10), not reinterpreted.
    const numeric = restored.task_occurrences.find((row) => row.value === '4')!;
    expect(numeric.completedAt).toBeNull();
    expect(numeric.value).toBe('4');
    // Receipt allocation survives with its period.
    expect(restored.receipts).toHaveLength(receipts.length);
    expect(restored.receipts[0].periodId).toBe(period.id);
  });
});

/** Re-writes a plain archive without its attachment entries (manifest kept intact). */
async function archiveWithoutAttachments(file: string): Promise<Blob> {
  const bytes = fileBytes(file);
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const entry of entries) {
    if (!entry.filename.startsWith('attachments/')) {
      const data = await (entry as { getData: (writer: Uint8ArrayWriter) => Promise<Uint8Array> }).getData(new Uint8ArrayWriter());
      await writer.add(entry.filename, new Uint8ArrayReader(data), { level: 6 });
    }
  }
  await reader.close();
  const out = await writer.close();
  return blobOf(out);
}

/** Re-writes a plain archive with one attachment byte flipped (manifest untouched). */
async function archiveWithTamperedAttachment(file: string): Promise<Blob> {
  const bytes = fileBytes(file);
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const entries = await reader.getEntries();
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const entry of entries) {
    const data = await (entry as { getData: (writer: Uint8ArrayWriter) => Promise<Uint8Array> }).getData(new Uint8ArrayWriter());
    if (entry.filename.startsWith('attachments/')) {
      data[data.length - 1] = (data[data.length - 1] ^ 0xff) & 0xff;
    }
    await writer.add(entry.filename, new Uint8ArrayReader(data), { level: 6 });
  }
  await reader.close();
  return blobOf(await writer.close());
}

describe('Stage 5 网页侧失败保留矩阵', () => {
  async function liveSnapshot(env: Awaited<ReturnType<typeof freshEnv>>) {
    const token = await env.runtime.current();
    const data = await env.runtime.read((ctx) => ctx.data);
    return { token, owners: data.owners.length, orders: data.orders.length };
  }

  it('错误口令、篡改的加密文件：准备阶段拒绝，当前资料与文件字节都不变', async () => {
    const env = await freshEnv();
    await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    const before = await liveSnapshot(env);
    const encrypted = fileBytes(androidFile('android-chain1-encrypted.dgbk'));
    const originalSha = sha256(encrypted);

    await expect(
      env.services.restore.prepareRestore(blobOf(encrypted), 'wrong-password'),
    ).rejects.toBeTruthy();
    await expect(
      env.services.restore.prepareRestore(blobOf(encrypted), '口令不对'),
    ).rejects.toBeTruthy();

    const tampered = encrypted.slice();
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ^ 0x5a) & 0xff;
    await expect(
      env.services.restore.prepareRestore(blobOf(tampered), UNICODE_PASSWORD),
    ).rejects.toBeTruthy();
    expect(sha256(encrypted)).toBe(originalSha);
    const after = await liveSnapshot(env);
    expect(after.token.databaseName).toBe(before.token.databaseName);
    expect(after.token.generation).toBe(before.token.generation);
    expect(after.owners).toBe(before.owners);
    expect(after.orders).toBe(before.orders);
  });

  it('缺少截图 / 截图字节被改：整份拒绝，候选库不残留', async () => {
    const env = await freshEnv();
    await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    const before = await liveSnapshot(env);
    const databasesBefore = (await Dexie.getDatabaseNames()).filter((name) =>
      name.startsWith('daigan-data-'),
    ).length;

    const missing = await archiveWithoutAttachments(androidFile('android-chain1-plain.dgbk'));
    await expect(env.services.restore.prepareRestore(missing)).rejects.toBeTruthy();

    // Same length, one byte different, manifest still declaring the original digest.
    const tampered = await archiveWithTamperedAttachment(androidFile('android-chain1-plain.dgbk'));
    await expect(env.services.restore.prepareRestore(tampered)).rejects.toBeTruthy();

    const after = await liveSnapshot(env);
    expect(after.token.generation).toBe(before.token.generation);
    expect(
      (await Dexie.getDatabaseNames()).filter((name) => name.startsWith('daigan-data-')).length,
    ).toBe(databasesBefore);
  });

  it('不支持的 schema、伪造的事件归属、悬空的批次目标：都在激活前拒绝（CD-01）', async () => {
    const { snapshot } = await readArchive(
      blobOf(fileBytes(androidFile('android-chain1-plain.dgbk'))),
    );
    const env = await freshEnv();
    await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    const before = await liveSnapshot(env);

    // Unsupported future schema.
    const future = await writeLegacyArchive(structuredClone(snapshot.data), 16);
    await expect(env.services.restore.prepareRestore(future)).rejects.toBeTruthy();

    // A SESSION event pointing at a round that is not in the archive.
    const badScope = structuredClone(snapshot.data);
    const sessionEvent = badScope.task_progress_events.find((row) => row.scopeType === 'SESSION')!;
    sessionEvent.scopeSessionId = 'session-of-another-order';
    await expect(
      env.services.restore.prepareRestore(
        await writeArchive({ data: badScope, attachments: snapshot.attachments }),
      ),
    ).rejects.toBeTruthy();

    // CD-01: an undone batch item whose non-null target does not exist.
    const dangling = structuredClone(snapshot.data);
    const undoneBatch = dangling.completion_batches.find((row) => row.undoneAt !== null)!;
    const item = dangling.completion_batch_items.find((row) => row.batchId === undoneBatch.id)!;
    item.occurrenceId = 'deleted-occurrence-original-123';
    let message = '';
    try {
      await env.services.restore.prepareRestore(
        await writeArchive({ data: dangling, attachments: snapshot.attachments }),
      );
      throw new Error('CD-01 dangling target must be rejected');
    } catch (error) {
      message = String((error as Error).message ?? error);
    }
    expect(message).toContain('UNDONE_BATCH_TARGET_DANGLING');

    const after = await liveSnapshot(env);
    expect(after.token.generation).toBe(before.token.generation);
    expect(after.owners).toBe(before.owners);
  });

  it('CD-01 受支持形态：已撤销批次 + 原本为 null 的目标 + 有效任务引用可以恢复', async () => {
    const { snapshot } = await readArchive(
      blobOf(fileBytes(androidFile('android-chain1-plain.dgbk'))),
    );
    const supported = structuredClone(snapshot.data);
    const undoneBatch = supported.completion_batches.find((row) => row.undoneAt !== null)!;
    const item = supported.completion_batch_items.find((row) => row.batchId === undoneBatch.id)!;
    item.occurrenceId = null;
    expect(item.taskDefinitionId).not.toBeNull();
    const env = await freshEnv();
    const preview = await env.services.restore.prepareRestore(
      await writeArchive({ data: supported, attachments: snapshot.attachments }),
    );
    await env.services.restore.commitRestore(preview.sessionId, env.token);
    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(restored.completion_batch_items.find((row) => row.id === item.id)!.occurrenceId).toBeNull();
  });

  it('写候选库时的存储失败（配额注入）：拒绝且不切换活动资料、不残留候选库', async () => {
    const env = await freshEnv();
    await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    const before = await liveSnapshot(env);
    const databasesBefore = (await Dexie.getDatabaseNames()).filter((name) =>
      name.startsWith('daigan-data-'),
    );

    const proto = IDBObjectStore.prototype as unknown as {
      put: (...args: unknown[]) => IDBRequest;
    };
    const original = proto.put;
    proto.put = function patched(this: IDBObjectStore, ...args: unknown[]) {
      // Only the *candidate* dataset write fails; the live dataset keeps working.
      const isCandidate = this.transaction.db.name !== before.token.databaseName;
      if (isCandidate) throw new DOMException('quota exceeded (injected)', 'QuotaExceededError');
      return original.apply(this, args as never);
    };
    let rejected = false;
    try {
      const preview = await env.services.restore.prepareRestore(
        blobOf(fileBytes(androidFile('android-chain1-plain.dgbk'))),
      ).catch((error: unknown) => {
        rejected = true;
        return error as Error;
      });
      expect(rejected).toBe(true);
      expect(String((preview as Error).message ?? preview)).toMatch(/存储|失败|配额|quota/i);
    } finally {
      proto.put = original;
    }
    const after = await liveSnapshot(env);
    expect(after.token.databaseName).toBe(before.token.databaseName);
    expect(after.token.generation).toBe(before.token.generation);
    expect(after.orders).toBe(before.orders);
    const databasesAfter = (await Dexie.getDatabaseNames()).filter((name) =>
      name.startsWith('daigan-data-'),
    );
    expect(databasesAfter.sort()).toEqual([...databasesBefore].sort());
  });

  it('恢复替换后，替换前打开的旧表单提交被 STALE_DATASET 拒绝且不写入', async () => {
    const env = await freshEnv();
    const { token: restoredToken } = await restoreFile(
      env,
      androidFile('android-chain1-plain.dgbk'),
    );
    const data = await env.runtime.read((ctx) => ctx.data);
    const cumulative = data.task_definitions.find((row) => {
      if (row.numericMode !== 'CUMULATIVE') return false;
      const order = data.orders.find((candidate) => candidate.id === row.orderId);
      return order?.type === 'SHORT_TASK';
    })!;
    expect(cumulative).toBeTruthy();
    // The form captured the dataset identity *before* the next replacement.
    const staleToken = await env.runtime.current();
    await restoreFile(env, androidFile('android-chain1-plain.dgbk'));
    expect((await env.runtime.current()).generation).not.toBe(staleToken.generation);

    let staleMessage = '';
    try {
      await env.services.progress.submit(
        {
          taskId: cumulative.id,
          totalValue: '1',
          gameDate: '2026-03-10',
          operationId: 'stage5-stale-command',
          scope: { kind: 'TASK' },
        },
        staleToken,
      );
      throw new Error('the stale command must be rejected');
    } catch (error) {
      staleMessage = `${(error as { code?: string }).code ?? ''} ${
        (error as Error).message ?? ''
      }`;
    }
    expect(staleMessage).toContain('STALE_DATASET');
    const after = await env.runtime.read((ctx) => ctx.data);
    expect(
      after.task_progress_events.some((row) => row.operationId === 'stage5-stale-command'),
    ).toBe(false);
    expect(restoredToken.databaseName).not.toBe((await env.runtime.current()).databaseName);
  });
});

describe('归档写入的跨端约束', () => {
  it('网页导出的每个条目都是 DEFLATE（STORED + data descriptor 会被安卓拒绝）', async () => {
    for (const name of WEB_FILES) {
      const file = webFile(name);
      if (!existsSync(file)) continue;
      // The encrypted envelope is not a ZIP container; its payload is checked by the
      // restore path instead (see the plain/encrypted restore tests).
      if (WEB_ENCRYPTED[name]) continue;
      const entries = zipEntryMethods(fileBytes(file));
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of entries) {
        expect(`${name}:${entry.name}:${entry.method}`).toBe(`${name}:${entry.name}:8`);
        // Bit 3 (data descriptor) is fine for DEFLATED entries only; assert it stayed set
        // so the guard proves the combination rather than accidentally dropping the flag.
        expect(entry.flags & 0x0008).toBe(0x0008);
      }
    }
  });
});

describe('Canonical 业务快照（供 compare-snapshots.mjs 使用）', () => {
  it('为网页侧每个产物写出可比较的规范化快照（含真实附件摘要）', async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const written: string[] = [];
    for (const name of WEB_FILES) {
      const file = webFile(name);
      if (!existsSync(file)) continue;
      const { snapshot } = await readArchive(
        blobOf(fileBytes(file)),
        WEB_ENCRYPTED[name],
      );
      const tables: Record<string, unknown[]> = {};
      for (const table of BUSINESS_TABLES as readonly TableName[]) {
        // Project onto the portable column list: the reader also materialises local
        // mirrors (`serviceMode`/`serviceCount`) that are not portable business data.
        const columns = columnsFor(table);
        tables[table] = snapshot.data[table].map((row) => {
          const source = row as unknown as Record<string, unknown>;
          return Object.fromEntries(columns.map((column) => [column, source[column] ?? null]));
        });
      }
      const attachmentDigests = [];
      for (const row of snapshot.data.attachments) {
        const blob = snapshot.attachments.get(row.id);
        const bytes = blob ? await bytesOf(blob) : null;
        attachmentDigests.push({
          id: row.id,
          relativePath: row.relativePath,
          mimeType: row.mimeType,
          sizeBytes: bytes ? bytes.length : row.sizeBytes,
          sha256: bytes ? sha256(bytes) : '',
        });
      }
      const canonical = {
        portableSchema: 15,
        templateFormat: 4,
        exportedAt: null,
        tables,
        attachmentDigests,
      };
      const target = path.join(OUTPUT_DIR, name.replace(/\.dgbk$/, '-canonical.json'));
      writeFileSync(target, `${JSON.stringify(canonical, null, 2)}\n`);
      written.push(path.basename(target));
    }
    expect(written.length).toBeGreaterThanOrEqual(4);
    for (const file of written) {
      expect(existsSync(path.join(OUTPUT_DIR, file))).toBe(true);
    }
    // Sanity: the canonical writer covers every business table exactly once.
    const sample = JSON.parse(
      readFileSync(path.join(OUTPUT_DIR, written[0]), 'utf8'),
    ) as { tables: Record<string, unknown[]> };
    expect(Object.keys(sample.tables).sort()).toEqual([...BUSINESS_TABLES].sort());
  });

  it('比较器能检出故意差异（用真实产物验证，不是只写在文档里）', async () => {
    const base = webFile('web-chain2-plain-canonical.json');
    if (!existsSync(base)) return;
    const canonical = JSON.parse(readFileSync(base, 'utf8')) as {
      tables: Record<string, Record<string, unknown>[]>;
    };
    const mutated = JSON.parse(readFileSync(base, 'utf8')) as typeof canonical;
    const order = mutated.tables.orders[0];
    order.title = `${String(order.title)}（故意改动）`;
    const mutatedFile = path.join(OUTPUT_DIR, 'web-chain2-plain-canonical.mutated.json');
    writeFileSync(mutatedFile, `${JSON.stringify(mutated, null, 2)}\n`);

    const { execFileSync } = await import('node:child_process');
    const tool = path.resolve(process.cwd(), '../tools/interop/compare-snapshots.mjs');
    const contract = path.resolve(process.cwd(), '../compat/interop-vnext/contract.json');
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [tool, '--contract', contract, '--expected', base, '--actual', mutatedFile],
        { encoding: 'utf8' },
      );
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 1;
      output = `${(error as { stdout?: string }).stdout ?? ''}`;
    }
    expect(exitCode).toBe(1);
    expect(output).toContain('FIELD_MISMATCH');
    expect(output).toContain('title');
    // The clean pair still passes, so the tool is not simply always failing.
    const clean = execFileSync(
      process.execPath,
      [tool, '--contract', contract, '--expected', base, '--actual', base],
      { encoding: 'utf8' },
    );
    expect(clean).toContain('MATCH');

    const files = readdirSync(OUTPUT_DIR);
    expect(files).toContain('web-chain2-plain-canonical.mutated.json');
  });
});

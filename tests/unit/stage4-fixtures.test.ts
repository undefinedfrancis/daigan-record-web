import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type { BackupDataSet, TableName } from '../../src/contracts/tables';
import { BUSINESS_TABLES } from '../../src/contracts/tables';
import { bytesOf, readArchive, writeArchive } from '../../src/backup/archive';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { gameDateAt } from '../../src/domain/gameCalendar';
import type { CreateOrderCommand, TemplateTaskDraft } from '../../src/application/contracts';

/**
 * Stage 4 证据：安卓阶段 3 生产夹具 → 网页**生产恢复路径** → 网页生产导出。
 *
 * 说明（不要夸大）：
 * - 这里消费的是安卓 `Stage3FixtureGeneratorTest` 生成的真实 `.dgbk`（合成数据），
 *   不是手写文件；哈希与 `stage3-provenance.json` 及 `03-android.md` 记录一致；
 * - 本文件只证明"安卓导出可被网页生产路径读取并继续使用"，**不**证明双向验收
 *   （网页导出回安卓=阶段 5）；
 * - 产物写到 `output/interop-uf036-038/stage4/`，每次运行的 `exportedAt` 会变化，
 *   因此 `.dgbk` 的哈希每轮不同（语义不变）；provenance 记录本轮实际哈希。
 */

const FIXTURE_DIR = path.resolve(
  process.cwd(),
  '../../代肝记录软件/output/interop-fixtures/stage3',
);
const OUTPUT_DIR = path.resolve(process.cwd(), '../output/interop-uf036-038/stage4');

const FIXTURE_HASHES: Record<string, string> = {
  'stage3-plain.dgbk': 'c684e2e451d437fe8e1762944685669cc41e929516f5e0ba908ac22e87d4a935',
  'stage3-encrypted.dgbk': '042bd0b3253a8a5798bcd2ab95926254e1d8088873dd411bd82b1f79b533d5ec',
  'stage3-template-v4.json': '26577611822227ebcdc9257bc80812151e9c5ccbc720c9d5590a56346af9aa8b',
  'stage3-expected-snapshot.json': '0b072367339e8ed69dd0c2382caf501643da72675982ecf700208f586b5be170',
  'stage3-provenance.json': '3e3a26c8e1d5ee197d78eaa94dcddd6368f89f66ffcf107b07719e670eca0e51',
};
const ENCRYPTED_PASSWORD = 'stage3-fixture-password';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

function fixtureBlob(name: string): Blob {
  return new Blob([fixtureBytes(name) as unknown as BlobPart]);
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
  const newId = () => `web-s4-${++idCounter}`;
  const runtime = new DatasetRuntime({ newId, now: () => Date.now() });
  const services = createServices(runtime, () => Date.now(), newId);
  await runtime.init();
  const token = await runtime.current();
  return { runtime, services, token };
}

async function restoreFixture(
  env: Awaited<ReturnType<typeof freshEnv>>,
  file: string,
  password?: string,
) {
  const preview = await env.services.restore.prepareRestore(fixtureBlob(file), password);
  const token = await env.services.restore.commitRestore(preview.sessionId, env.token);
  return { preview, token };
}

describe('安卓阶段 3 夹具的哈希与来源', () => {
  it('五个夹具与 provenance/交接记录逐字节一致，且确实是合成数据', () => {
    const provenance = JSON.parse(readFileSync(fixturePath('stage3-provenance.json'), 'utf8')) as {
      generatedBy: string;
      appVersionName: string;
      portableSchema: number;
      templateFormat: number;
      syntheticDataOnly: boolean;
      encryptedFixturePassword: string;
      files: { file: string; sha256: string; sizeBytes: number }[];
      rowCounts: Record<string, number>;
      attachments: { file: string; sha256: string; sizeBytes: number }[];
    };
    expect(provenance.syntheticDataOnly).toBe(true);
    expect(provenance.generatedBy).toContain('Stage3FixtureGeneratorTest');
    expect(provenance.appVersionName).toBe('1.8.4');
    expect(provenance.portableSchema).toBe(15);
    expect(provenance.templateFormat).toBe(4);
    expect(provenance.encryptedFixturePassword).toBe(ENCRYPTED_PASSWORD);

    for (const [name, expected] of Object.entries(FIXTURE_HASHES)) {
      const bytes = fixtureBytes(name);
      expect(`${name}:${sha256(bytes)}`).toBe(`${name}:${expected}`);
    }
    for (const entry of provenance.files) {
      expect(sha256(fixtureBytes(entry.file))).toBe(entry.sha256);
      expect(fixtureBytes(entry.file).length).toBe(entry.sizeBytes);
    }
    // 行数声明与真实数据一致（恢复后逐表核对）。
    expect(provenance.rowCounts.hosting_sessions).toBe(3);
    expect(provenance.rowCounts.task_progress_events).toBe(7);
    expect(provenance.rowCounts.account_categories).toBe(2);
  });
});

describe('网页生产恢复路径消费安卓明文/加密夹具', () => {
  it('明文夹具：分类、模板默认标题、计次轮次、累计事件都能被读模型与命令使用', async () => {
    const env = await freshEnv();
    // commitRestore 后必须使用新的数据集代号写命令（旧 token = STALE_DATASET）。
    const { preview, token } = await restoreFixture(env, 'stage3-plain.dgbk');
    expect(preview.schemaVersion).toBe(15);
    expect(preview.targetSchemaVersion).toBe(15);
    // 已经是 schema 15：不执行 C:→N: 迁移。
    expect(preview.migrations).toEqual([]);

    const data = await env.runtime.read((ctx) => ctx.data);
    expect(data.account_categories).toHaveLength(2);
    expect(data.hosting_sessions).toHaveLength(3);
    expect(data.task_progress_events).toHaveLength(7);
    expect(data.game_accounts[0].categoryId).not.toBeNull();
    const template = data.game_templates[0];
    expect(template.defaultOrderTitle).not.toBeNull();
    expect(data.template_tasks.some((task) => task.numericMode === 'CUMULATIVE')).toBe(true);

    const countOrder = data.orders.find((order) => order.hostingMode === 'COUNT_BASED')!;
    expect(countOrder).toBeTruthy();
    const detail = await env.services.queries.orderDetail(countOrder.id);
    expect(detail!.rounds.length).toBe(3);
    expect(detail!.rounds.map((round) => round.sessionIndex).sort()).toEqual([1, 2, 3]);
    expect(detail!.cumulative.length).toBeGreaterThan(0);
    // 轮次必须归属各自期次（跨期次不串）。
    const periodIds = new Set(
      data.hosting_periods.filter((row) => row.orderId === countOrder.id).map((row) => row.id),
    );
    for (const round of detail!.rounds) expect(periodIds.has(round.periodId)).toBe(true);

    // 累计读数走生产查询命令：scope 由读模型给出，值与事件一致。
    const cumulative = detail!.cumulative.find((task) => task.scope !== null)!;
    expect(cumulative).toBeTruthy();
    const { total } = await env.services.progress.currentTotal({
      taskId: cumulative.taskId,
      scope: cumulative.scope!,
    });
    expect(total).toBe(cumulative.currentValue);

    // 恢复后的数据可继续写入：新建分类并指派给恢复的账号。
    const account = data.game_accounts[0];
    const { categoryId } = await env.services.accounts.createCategory(
      { name: '网页补充分类' },
      token,
    );
    await env.services.accounts.setAccountCategory(
      { accountId: account.id, categoryId },
      token,
    );
    const rows = await env.services.accounts.accountView({ categoryId });
    expect(rows.map((row) => row.accountId)).toEqual([account.id]);

    // 恢复后的数据可继续建单并累计（生产命令，不是测试替身）。
    const ownerId = data.owners[0].id;
    const task: TemplateTaskDraft = {
      title: '网页累计校验',
      progressType: 'NUMERIC',
      startValue: '0',
      targetValue: '20',
      unit: '次',
      recurrence: 'DAILY',
      weekdays: null,
      everyNDays: null,
      monthDay: null,
      numericMode: 'CUMULATIVE',
    };
    const command: CreateOrderCommand = {
      operationId: 'web-s4-op-1',
      ownerId,
      accountId: account.id,
      type: 'HOSTING',
      title: '网页端恢复后新建',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      priceCents: null,
      deadlineDate: null,
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      startDate: null,
      endDate: null,
      periodPriceCents: 5000,
      serviceCount: 1,
      tasks: [task],
      firstReceipt: null,
      sourceTemplateId: null,
      sourceTemplateName: null,
      sourceTemplateVersion: null,
    };
    const created = await env.services.orders.create(command, token);
    const createdDetail = await env.services.queries.orderDetail(created.orderId);
    const createdTask = createdDetail!.cumulative[0];
    const submitted = await env.services.progress.submit(
      {
        taskId: createdTask.taskId,
        totalValue: '12',
        gameDate: gameDateAt(Date.now(), 'Asia/Shanghai', 300),
        operationId: 'web-s4-cum-1',
        scope: { kind: 'SESSION' },
      },
      token,
    );
    expect(submitted.currentTotal).toBe('12');
  });

  it('加密夹具用 provenance 记录的合成口令可恢复', async () => {
    const env = await freshEnv();
    const { preview } = await restoreFixture(
      env,
      'stage3-encrypted.dgbk',
      ENCRYPTED_PASSWORD,
    );
    expect(preview.counts.orders).toBe(3);
    expect(preview.counts.accounts).toBe(1);
    const data = await env.runtime.read((ctx) => ctx.data);
    expect(data.hosting_sessions).toHaveLength(3);
    expect(data.task_progress_events).toHaveLength(7);

    // 错误口令在准备阶段拒绝，现有数据集保持不变。
    const before = await env.runtime.current();
    await expect(
      env.services.restore.prepareRestore(fixtureBlob('stage3-encrypted.dgbk'), 'wrong-password'),
    ).rejects.toBeTruthy();
    expect((await env.runtime.current()).generation).toBe(before.generation);
  });
});

describe('CD-01：已撤销批次目标的可表达性（用真实夹具验证）', () => {
  async function decodedFixture() {
    const { snapshot } = await readArchive(fixtureBlob('stage3-plain.dgbk'));
    return snapshot;
  }

  it('受支持的无目标历史（null + 任务引用）可以恢复', async () => {
    const snapshot = await decodedFixture();
    const data = structuredClone(snapshot.data) as BackupDataSet;
    const batch = data.completion_batches.find((row) => row.undoneAt !== null)!;
    const item = data.completion_batch_items.find((row) => row.batchId === batch.id)!;
    item.occurrenceId = null;
    expect(item.taskDefinitionId).not.toBeNull();
    const blob = await writeArchive({ data, attachments: snapshot.attachments });

    const env = await freshEnv();
    const preview = await env.services.restore.prepareRestore(blob);
    await env.services.restore.commitRestore(preview.sessionId, env.token);
    const restored = await env.runtime.read((ctx) => ctx.data);
    const restoredItem = restored.completion_batch_items.find((row) => row.id === item.id)!;
    expect(restoredItem.occurrenceId).toBeNull();
    expect(restoredItem.taskDefinitionId).toBe(item.taskDefinitionId);
    expect(restored.completion_batches.find((row) => row.id === batch.id)!.undoneAt).not.toBeNull();
  });

  it('已知但悬空的非空目标在激活前拒绝，且当前数据集不变', async () => {
    const snapshot = await decodedFixture();
    const data = structuredClone(snapshot.data) as BackupDataSet;
    const batch = data.completion_batches.find((row) => row.undoneAt !== null)!;
    const item = data.completion_batch_items.find((row) => row.batchId === batch.id)!;
    item.occurrenceId = 'deleted-occurrence-never-existed';
    const blob = await writeArchive({ data, attachments: snapshot.attachments });

    const env = await freshEnv();
    const token = await env.token;
    await expect(env.services.restore.prepareRestore(blob)).rejects.toBeTruthy();
    const current = await env.runtime.current();
    expect(current.databaseName).toBe(token.databaseName);
    expect(current.generation).toBe(token.generation);
    // 不落候选库。
    const names = await Dexie.getDatabaseNames();
    expect(names.filter((name) => name.startsWith('daigan-data-')).length).toBe(1);
    const live = await env.runtime.read((ctx) => ctx.data);
    expect(live.owners).toHaveLength(0);
  });
});

describe('网页生产导出（Stage 4 产物）', () => {
  it('导出明文/加密 .dgbk、模板格式 4、规范化快照与来源清单', async () => {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const env = await freshEnv();
    const { token } = await restoreFixture(env, 'stage3-plain.dgbk');

    // 在恢复后的隔离数据集上应用网页命令，使导出的产物同时覆盖 UF-036/037/038 的字段。
    const live = await env.runtime.read((ctx) => ctx.data);
    const template = live.game_templates[0];
    const templateDraft = await env.services.queries.templateDetail(template.id);
    expect(templateDraft?.defaultOrderTitle).not.toBeNull();
    const { categoryId } = await env.services.accounts.createCategory(
      { name: '阶段4合成分类' },
      token,
    );
    await env.services.accounts.setAccountCategory(
      { accountId: live.game_accounts[0].id, categoryId },
      token,
    );

    // 已知环境限制（阶段 2 R7）：jsdom/fake-indexeddb 不能在 IndexedDB 里往返 DOM Blob，
    // `exportCurrent` 读附件字节时会拿到非 Blob。这里用**同一个生产编码器**
    // `writeArchive`，附件字节取自源夹具（id 相同），并在 provenance 里如实记录；
    // 真实浏览器的完整导出由 Stage 4 浏览器流程（真实下载）覆盖。
    const sourceAttachments = (
      await readArchive(fixtureBlob('stage3-plain.dgbk'))
    ).snapshot.attachments;
    const liveData = await env.runtime.read((ctx) => ctx.data);
    const plainBlob = await writeArchive({
      data: liveData,
      attachments: sourceAttachments,
    });
    const encryptedBlob = await writeArchive(
      { data: liveData, attachments: sourceAttachments },
      'stage4-fixture-password',
    );
    const templateBlob = await env.services.templates.exportFile(template.id);

    const plainBytes = await bytesOf(plainBlob);
    const encryptedBytes = await bytesOf(encryptedBlob);
    const templateBytes = await bytesOf(templateBlob);
    writeFileSync(path.join(OUTPUT_DIR, 'stage4-web-plain.dgbk'), Buffer.from(plainBytes));
    writeFileSync(
      path.join(OUTPUT_DIR, 'stage4-web-encrypted.dgbk'),
      Buffer.from(encryptedBytes),
    );
    writeFileSync(
      path.join(OUTPUT_DIR, 'stage4-web-template-v4.json'),
      Buffer.from(templateBytes),
    );

    // 规范化业务快照：逐表按主键排序 + 附件摘要（直接读生产导出，而不是内存对象）。
    const exported = await readArchive(
      new Blob([plainBytes as unknown as BlobPart]),
    );
    const tables: Record<string, unknown[]> = {};
    for (const table of BUSINESS_TABLES as readonly TableName[]) {
      const rows = [...(exported.snapshot.data[table] as unknown as Record<string, unknown>[])];
      rows.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
      tables[table] = rows;
    }
    const attachmentManifest = await Promise.all(
      exported.snapshot.data.attachments.map(async (row) => {
        const blob = exported.snapshot.attachments.get(row.id)!;
        const bytes = await bytesOf(blob);
        return {
          id: row.id,
          relativePath: row.relativePath,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          sha256: sha256(bytes),
        };
      }),
    );
    const canonical = {
      portableSchema: 15,
      templateFormat: 4,
      exportedAt: Date.now(),
      tables,
      attachmentManifest,
    };
    const canonicalText = `${JSON.stringify(canonical, null, 2)}\n`;
    writeFileSync(path.join(OUTPUT_DIR, 'stage4-web-expected-snapshot.json'), canonicalText);

    const provenance = {
      generator: 'web/tests/unit/stage4-fixtures.test.ts',
      generatorKind: 'vitest production-path fixture run (web application services)',
      appPackageVersion: '0.1.0',
      generatedAt: new Date().toISOString(),
      portableSchema: 15,
      templateFormat: 4,
      dexieVersion: 3,
      syntheticDataOnly: true,
      sources: Object.entries(FIXTURE_HASHES).map(([file, sha256]) => ({
        file: `代肝记录软件/output/interop-fixtures/stage3/${file}`,
        sha256,
      })),
      commands: [
        'npx vitest run tests/unit/stage4-fixtures.test.ts',
        'restore.prepareRestore(stage3-plain.dgbk) → restore.commitRestore',
        'restore.prepareRestore(stage3-encrypted.dgbk, stage3-fixture-password)',
        'accounts.createCategory / accounts.setAccountCategory',
        'progress.submit (SESSION scope, absolute total)',
        'writeArchive(live data + source attachment bytes) — same production encoder as exportCurrent',
        'writeArchive(..., "stage4-fixture-password") for the encrypted artifact',
        'templates.exportFile(templateFormat 4)',
      ],
      syntheticScenarioIds: [
        'S-27 (android schema 15 into web production restore)',
        'S-30/S-50 (count rounds with N: keys and period ownership)',
        'S-33/S-34 (category defaults and explicit override)',
        'S-36/S-38/S-42 (cumulative submit/correction/asOf on restored data)',
        'S2-R7 / CD-01 (undone batch target expressiveness)',
      ],
      artifacts: [
        {
          file: 'stage4-web-plain.dgbk',
          sha256: sha256(plainBytes),
          sizeBytes: plainBytes.length,
        },
        {
          file: 'stage4-web-encrypted.dgbk',
          sha256: sha256(encryptedBytes),
          sizeBytes: encryptedBytes.length,
          password: 'stage4-fixture-password',
        },
        {
          file: 'stage4-web-template-v4.json',
          sha256: sha256(templateBytes),
          sizeBytes: templateBytes.length,
        },
        {
          file: 'stage4-web-expected-snapshot.json',
          sha256: sha256(new TextEncoder().encode(canonicalText)),
          sizeBytes: new TextEncoder().encode(canonicalText).length,
        },
      ],
      rowCounts: Object.fromEntries(
        BUSINESS_TABLES.map((table) => [table, exported.snapshot.data[table].length]),
      ),
      limitations: [
        'Only Android → web was consumed here; web → Android restore is Stage 5.',
        'exportedAt/zip timestamps change per run, so .dgbk hashes differ between runs.',
        'No physical Android device participated in this run.',
        'jsdom/fake-indexeddb cannot round-trip DOM Blob through IndexedDB (Stage 2 R7), so these artifacts were encoded with the production writeArchive using the source fixture attachment bytes; the full exportCurrent path with a real browser download is covered by tests/e2e/stage4.spec.ts flow 1.',
      ],
    };
    writeFileSync(
      path.join(OUTPUT_DIR, 'stage4-web-provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    // 产物自身可被生产读取路径接受（加密的用合成口令）。
    const reread = await env.services.restore.prepareRestore(
      new Blob([plainBytes as unknown as BlobPart]),
    );
    await env.services.restore.cancelRestore(reread.sessionId);
    const rereadEncrypted = await env.services.restore.prepareRestore(
      new Blob([encryptedBytes as unknown as BlobPart]),
      'stage4-fixture-password',
    );
    await env.services.restore.cancelRestore(rereadEncrypted.sessionId);
    expect(reread.counts.orders).toBe(provenance.rowCounts.orders);
  });
});

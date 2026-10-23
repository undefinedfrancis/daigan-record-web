import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import { createRestoreService } from '../../src/backup/restoreService';
import { createExportService } from '../../src/backup/exportService';
import { bytesOf, writeArchive } from '../../src/backup/archive';
import { emptyDataSet } from '../../src/backup/catalog';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';

const NOW = Date.UTC(2026, 1, 10, 4, 0);

function makeEnv() {
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const runtime = new DatasetRuntime({ newId, now: () => NOW });
  const services = createServices(runtime, () => NOW, newId);
  const restore = createRestoreService({ runtime, newId, now: () => NOW });
  const exporter = createExportService({ runtime, now: () => NOW });
  return { runtime, services, restore, exporter };
}

async function freshEnv() {
  await Dexie.delete('daigan-control');
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-')) await Dexie.delete(name);
  }
  resetControlDb();
  const env = makeEnv();
  await env.runtime.init();
  const token = await env.runtime.current();
  return { ...env, token };
}

beforeEach(async () => {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('s2-restore-')) await Dexie.delete(name);
  }
});

describe('恢复安全：候选数据集不合法时当前资料保持可用', () => {
  it('严格校验失败不会替换、删除或部分修改现有数据集', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板甲' }, env.token);
    await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '原神',
        server: '官服',
        uid: '1',
        loginAccount: 'acc',
        loginMethod: 'PASSWORD',
        password: 'secret',
      },
      env.token,
    );
    const before = await env.runtime.read((ctx) => ctx.data);
    const beforeToken = await env.runtime.current();

    // 候选数据集带着悬空的批次明细：必须拒绝。
    const data = emptyDataSet();
    data.completion_batch_items.push({
      id: 'bi1',
      batchId: 'missing-batch',
      itemType: 'OCCURRENCE',
      occurrenceId: null,
      taskDefinitionId: null,
      previousCompletedAt: null,
      previousRecordedAt: null,
      previousBackfilled: null,
      previousValue: null,
      previousCompletionBatchId: null,
      appliedCompletedAt: null,
      appliedRecordedAt: null,
      appliedBackfilled: null,
      appliedValue: null,
      appliedCompletionBatchId: null,
    });
    const blob = await writeArchive({ data, attachments: new Map() });
    await expect(env.restore.prepareRestore(blob)).rejects.toThrow();

    const after = await env.runtime.read((ctx) => ctx.data);
    const afterToken = await env.runtime.current();
    expect(afterToken.databaseName).toBe(beforeToken.databaseName);
    expect(afterToken.generation).toBe(beforeToken.generation);
    expect(after.owners).toHaveLength(1);
    expect(after.owners[0].nickname).toBe('老板甲');
    expect(after.game_accounts).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('未知格式版本的文件在预览阶段即被拒绝', async () => {
    const env = await freshEnv();
    const before = await env.runtime.read((ctx) => ctx.data);
    const blob = new Blob([new TextEncoder().encode('not an archive')]);
    await expect(env.restore.prepareRestore(blob)).rejects.toThrow();
    expect(await env.runtime.read((ctx) => ctx.data)).toEqual(before);
  });

  it('成功恢复后本机颜色随业务列往返（不再有独立颜色表）', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板乙' }, env.token);
    const accountId = await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '原神',
        server: '官服',
        uid: '2',
        loginAccount: 'acc2',
        loginMethod: 'PASSWORD',
        password: 'secret',
      },
      env.token,
    );
    const orderId = await env.services.orders.create(
      {
        operationId: 'op-1',
        ownerId,
        accountId,
        type: 'HOSTING',
        title: '托管',
        notes: null,
        paymentMode: 'INSTALLMENTS',
        priceCents: null,
        deadlineDate: null,
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        startDate: '2026-02-01',
        endDate: '2026-02-28',
        periodPriceCents: 30000,
        tasks: [
          {
            title: '签到',
            progressType: 'CHECKBOX',
            startValue: '0',
            targetValue: '1',
            unit: null,
            recurrence: 'DAILY',
            weekdays: null,
            everyNDays: null,
            monthDay: null,
          },
        ],
        firstReceipt: null,
        sourceTemplateId: null,
        sourceTemplateName: null,
        sourceTemplateVersion: null,
      },
      env.token,
    ).then((result) => result.orderId);
    await env.services.orders.setOrderColor(orderId, 'red', env.token);

    const exported = await env.exporter.exportCurrent();
    const preview = await env.restore.prepareRestore(exported.blob);
    expect(preview.targetSchemaVersion).toBe(15);
    await env.restore.commitRestore(preview.sessionId, preview.baseToken);

    const orders = await env.runtime.read((ctx) => ctx.data.orders);
    expect(orders).toHaveLength(1);
    // 4292437084 = 红色（不透明 ARGB），随 orders.orderColor 一起往返。
    expect(orders[0].orderColor).toBe(4292437084);
  });
});

describe('模板分层默认值持久化', () => {
  it('显式 serviceWeekdays 与计次目标在保存与模板文件中都保留', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(
      {
        gameName: '分层模板',
        templateVersion: '1.0',
        gameVersionNotes: null,
        zoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        hostingMode: 'COUNT_BASED',
        targetSessions: 12,
        defaultOrderTitle: '托管 12 次',
        categories: [
          {
            name: '仅工作日',
            hostingMode: 'DATE_RANGE',
            targetSessions: null,
            serviceWeekdays: '1,3,5',
            tasks: [
              {
                title: '签到',
                progressType: 'CHECKBOX',
                startValue: '0',
                targetValue: '1',
                unit: null,
                recurrence: 'DAILY',
                weekdays: null,
                everyNDays: null,
                monthDay: null,
              },
            ],
          },
        ],
        pricePresets: [],
        serverOptions: [],
      },
      env.token,
    );

    const rows = await env.runtime.read((ctx) => ({
      template: ctx.data.game_templates.find((row) => row.id === templateId)!,
      category: ctx.data.template_categories.find((row) => row.templateId === templateId)!,
    }));
    expect(rows.template.hostingMode).toBe('COUNT_BASED');
    expect(rows.template.targetSessions).toBe(12);
    expect(rows.template.defaultOrderTitle).toBe('托管 12 次');
    expect(rows.category.hostingMode).toBe('DATE_RANGE');
    expect(rows.category.serviceWeekdays).toBe('1,3,5');

    const file = await env.services.templates.exportFile(templateId);
    const text = new TextDecoder().decode(await bytesOf(file));
    expect(text).toContain('"formatVersion": 4');
    expect(text).toContain('"serviceWeekdays": "1,3,5"');
    expect(text).toContain('"defaultOrderTitle": "托管 12 次"');
  });
});

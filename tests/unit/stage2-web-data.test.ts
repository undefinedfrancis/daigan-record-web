import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { LOCAL_SCHEMA_V1, LOCAL_SCHEMA_V2, openBusinessDb } from '../../src/storage/businessDb';
import { emptyDataSet } from '../../src/backup/catalog';
import { decodeData, encodeData } from '../../src/backup/dataCodec';
import { normalizeDecodedDataset } from '../../src/backup/normalize';
import { validateSnapshot } from '../../src/backup/validateSnapshot';
import { parseDecimal, formatDecimal } from '../../src/domain/decimal';
import {
  resolveScopeTotal,
  validateProgressEvents,
  type EventChainContext,
  type ProgressScope,
} from '../../src/domain/progressEvents';
import {
  resolveActiveCountSession,
  selectActiveSession,
  nextOrderGlobalSessionIndex,
  taskScopeCache,
} from '../../src/domain/countSessions';
import {
  parseTemplateFile,
  serializeTemplate,
  TEMPLATE_FORMAT_VERSION,
} from '../../src/backup/templateCodec';
import type {
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
  TaskProgressEventRow,
} from '../../src/contracts/tables';
import { CURRENT_SCHEMA } from '../../src/contracts/tables';

const NOW = 1_760_000_000_000;

/** 只声明 v1/v2 的旧库，用来真实模拟"已安装用户的 Dexie 2 数据"。 */
class LegacyV2Database extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores(LOCAL_SCHEMA_V1);
    this.version(2).stores(LOCAL_SCHEMA_V2);
  }
}

function order(overrides: Partial<OrderRow> & Pick<OrderRow, 'id'>): OrderRow {
  return {
    accountId: 'ac1',
    type: 'HOSTING',
    title: '订单',
    priceCents: null,
    paymentMode: 'INSTALLMENTS',
    deadlineDate: null,
    notes: null,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    cancelledAt: null,
    archivedAt: null,
    hostingMode: null,
    targetSessions: null,
    orderColor: null,
    monthlyRefreshDays: null,
    ...overrides,
  };
}

function period(overrides: Partial<HostingPeriodRow> & Pick<HostingPeriodRow, 'id' | 'orderId'>): HostingPeriodRow {
  return {
    periodIndex: 0,
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    priceCents: 30000,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: NOW,
    renewalOperationId: null,
    serviceDays: null,
    serviceWeekdays: null,
    monthlyRefreshDays: null,
    serviceCount: null,
    ...overrides,
  };
}

function task(
  overrides: Partial<TaskDefinitionRow> & Pick<TaskDefinitionRow, 'id' | 'orderId' | 'periodId'>,
): TaskDefinitionRow {
  return {
    title: '任务',
    progressType: 'CHECKBOX',
    startValue: '0',
    targetValue: '1',
    currentValue: '0',
    unit: null,
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    sortOrder: 0,
    completedAt: null,
    completionBatchId: null,
    createdAt: NOW,
    updatedAt: NOW,
    monthDay: null,
    monthDays: null,
    retiredAt: null,
    activeFrom: null,
    activeUntil: null,
    numericMode: null,
    colorArgb: null,
    ...overrides,
  };
}

function occurrence(
  overrides: Partial<TaskOccurrenceRow> &
    Pick<TaskOccurrenceRow, 'id' | 'taskDefinitionId' | 'occurrenceKey' | 'gameDate'>,
): TaskOccurrenceRow {
  return {
    windowStart: null,
    windowEnd: null,
    completedAt: NOW + 1000,
    recordedAt: NOW + 1000,
    backfilled: 0,
    completionBatchId: null,
    value: null,
    createdAt: NOW,
    ...overrides,
  };
}

function baseAccount(): Record<string, unknown> {
  return {
    id: 'ac1',
    ownerId: 'ow1',
    gameName: '游戏',
    server: '官服',
    uid: '1',
    loginAccount: 'acc',
    loginMethod: 'PASSWORD',
    password: 'p',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    archiveBatchId: null,
    defaultTemplateId: null,
    loginDevice: null,
    resourceNotes: null,
    categoryId: null,
  };
}

async function seedLegacyDb(name: string): Promise<void> {
  const db = new LegacyV2Database(name);
  await db.open();
  await db.table('owners').add({
    id: 'ow1',
    number: 1,
    nickname: '老板',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    archiveBatchId: null,
  });
  await db.table('owner_number_sequence').add({ id: 0, nextNumber: 2 });
  await db.table('game_accounts').add(baseAccount());
  // 两个订单共享同一游戏日：各自从 1 开始编号。
  await db.table('orders').bulkAdd([
    {
      ...order({ id: 'o1', hostingMode: 'COUNT_BASED', targetSessions: 5 }),
    },
    {
      ...order({ id: 'o2', hostingMode: 'COUNT_BASED', targetSessions: 3 }),
    },
  ]);
  await db.table('hosting_periods').bulkAdd([
    { ...period({ id: 'o1p1', orderId: 'o1', serviceCount: 5 }), periodIndex: 0 },
    { ...period({ id: 'o1p2', orderId: 'o1', serviceCount: 4, startDate: '2026-03-01', endDate: '2026-03-31' }), periodIndex: 1 },
    { ...period({ id: 'o2p1', orderId: 'o2', serviceCount: 3 }), periodIndex: 0 },
  ]);
  await db.table('task_definitions').bulkAdd([
    task({ id: 't1', orderId: 'o1', periodId: 'o1p1' }),
    task({ id: 't2', orderId: 'o1', periodId: 'o1p1', sortOrder: 1 }),
    task({ id: 't3', orderId: 'o1', periodId: 'o1p2' }),
    task({ id: 't4', orderId: 'o2', periodId: 'o2p1' }),
  ]);
  // o1：同一天两个任务（必须共用一轮）；跨期次同一天（必须是两轮）；o2 同一天独立从 1 开始。
  await db.table('task_occurrences').bulkAdd([
    occurrence({ id: 'oc1', taskDefinitionId: 't1', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
    occurrence({ id: 'oc2', taskDefinitionId: 't2', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
    occurrence({ id: 'oc3', taskDefinitionId: 't1', occurrenceKey: 'C:2026-02-03', gameDate: '2026-02-03' }),
    occurrence({
      id: 'oc4',
      taskDefinitionId: 't3',
      occurrenceKey: 'C:2026-02-02',
      gameDate: '2026-02-02',
      completedAt: null,
      recordedAt: null,
    }),
    occurrence({ id: 'oc5', taskDefinitionId: 't4', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
  ]);
  await db.table('receipts').add({
    id: 'r1',
    operationId: 'op-r1',
    orderId: 'o1',
    periodId: 'o1p1',
    amountCents: 10000,
    receivedAt: NOW,
    channel: 'WECHAT',
    note: null,
    status: 'ACTIVE',
    replacedByReceiptId: null,
    createdAt: NOW,
  });
  await db.table('attachments').add({
    id: 'at1',
    taskDefinitionId: null,
    occurrenceId: 'oc1',
    relativePath: 'at1.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAt: NOW,
  });
  await db.table('attachmentBlobs').add({
    id: 'at1',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
  });
  await db.table('task_color_marks').bulkAdd([
    { taskId: 't1', color: 'red' },
    { taskId: 't2', color: 'blue', source: 'order' },
  ]);
  await db.table('order_color_marks').add({ orderId: 'o1', color: 'blue' });
  await db.table('game_templates').add({
    id: 'gt1',
    gameName: '游戏',
    templateVersion: '1.0',
    gameVersionNotes: null,
    zoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    origin: 'USER',
    builtInKey: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    serviceMode: 'count',
    serviceCount: 12,
  });
  await db.table('template_categories').bulkAdd([
    { id: 'tc1', templateId: 'gt1', name: '日常', sortOrder: 0, serviceMode: null, serviceCount: null },
    { id: 'tc2', templateId: 'gt1', name: '周常', sortOrder: 1 },
  ]);
  await db.close();
}

beforeEach(async () => {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('s2-')) await Dexie.delete(name);
  }
});

describe('已安装网页库升级（Dexie 2 → 3，不导入任何备份）', () => {
  it('一次升级完成业务迁移、轮次迁移与颜色迁移', async () => {
    const name = 's2-upgrade';
    await seedLegacyDb(name);
    const db = openBusinessDb(name);
    try {
      await db.open();
      const sessions = (await db.table('hosting_sessions').toArray()) as HostingSessionRow[];
      // o1: 期次 o1p1 的 02-02、02-03 + 期次 o1p2 的 02-02 → 全局 1,2,3；o2 独立 → 1
      expect(sessions.map((row) => `${row.orderId}#${row.sessionIndex}:${row.periodId}`).sort()).toEqual([
        'o1#1:o1p1',
        'o1#2:o1p1',
        'o1#3:o1p2',
        'o2#1:o2p1',
      ]);
      const occurrences = (await db.table('task_occurrences').toArray()) as TaskOccurrenceRow[];
      const keyOf = (id: string) => occurrences.find((row) => row.id === id)!.occurrenceKey;
      // 组内多任务共用同一 N: 号
      expect(keyOf('oc1')).toBe('N:1');
      expect(keyOf('oc2')).toBe('N:1');
      expect(keyOf('oc3')).toBe('N:2');
      // 同一日期跨期次 → 不同号
      expect(keyOf('oc4')).toBe('N:3');
      expect(keyOf('oc5')).toBe('N:1');

      // 完成度按历史应做集重建：o1p1/02-02 的两个任务都完成 → 取最晚完成时刻
      const session1 = sessions.find((row) => row.orderId === 'o1' && row.sessionIndex === 1)!;
      expect(session1.completedAt).toBe(NOW + 1000);
      // 02-03 只有 t1 一行，t2 没有行 → 不完成
      const session2 = sessions.find((row) => row.orderId === 'o1' && row.sessionIndex === 2)!;
      expect(session2.completedAt).toBeNull();

      // 颜色：订单色进 orders.orderColor；任务自身色保留，跟随标记丢弃
      const orders = (await db.table('orders').toArray()) as OrderRow[];
      expect(orders.find((row) => row.id === 'o1')!.orderColor).toBe(4283076825);
      const tasks = (await db.table('task_definitions').toArray()) as TaskDefinitionRow[];
      expect(tasks.find((row) => row.id === 't1')!.colorArgb).toBe(4292437084);
      expect(tasks.find((row) => row.id === 't2')!.colorArgb).toBeNull();

      // 分类默认值分层：tc1 存 null → 显式 DATE_RANGE；tc2 缺列 → 固化模板值（count 12）
      const categories = (await db.table('template_categories').toArray()) as Record<string, unknown>[];
      const tc1 = categories.find((row) => row.id === 'tc1')!;
      expect(tc1.hostingMode).toBe('DATE_RANGE');
      expect(tc1.targetSessions).toBeNull();
      const tc2 = categories.find((row) => row.id === 'tc2')!;
      expect(tc2.hostingMode).toBe('COUNT_BASED');
      expect(tc2.targetSessions).toBe(12);
      // 模板行成为分类共识镜像（分歧 → 全 null）
      const templates = (await db.table('game_templates').toArray()) as Record<string, unknown>[];
      expect(templates[0].hostingMode).toBeNull();
      expect(templates[0].targetSessions).toBeNull();

      // 累计事件表为空：绝不把旧 occurrence 值解释成增量/总值
      expect(await db.table('task_progress_events').count()).toBe(0);
      // 引用与金融记录原样保留
      const receipts = (await db.table('receipts').toArray()) as Record<string, unknown>[];
      expect(receipts[0].periodId).toBe('o1p1');
      const attachments = (await db.table('attachments').toArray()) as Record<string, unknown>[];
      expect(attachments[0].occurrenceId).toBe('oc1');
      expect(await db.table('attachmentBlobs').count()).toBe(1);
      // 旧颜色表已退役
      expect(db.tables.map((table) => table.name)).not.toContain('task_color_marks');
      expect(db.tables.map((table) => table.name)).not.toContain('order_color_marks');
    } finally {
      db.close();
    }
  });

  it('未知颜色 token 让整次升级回滚，旧库仍以 v2 打开且数据不变', async () => {
    const name = 's2-bad-colour';
    await seedLegacyDb(name);
    const legacy = new LegacyV2Database(name);
    await legacy.open();
    await legacy.table('task_color_marks').put({ taskId: 't1', color: 'chartreuse' });
    await legacy.close();

    const db = openBusinessDb(name);
    await expect(db.open()).rejects.toThrow();
    db.close();

    const reopened = new LegacyV2Database(name);
    await reopened.open();
    expect(reopened.verno).toBe(2);
    const marks = await reopened.table('task_color_marks').toArray();
    expect(marks).toHaveLength(2);
    const occurrences = (await reopened.table('task_occurrences').toArray()) as TaskOccurrenceRow[];
    expect(occurrences.every((row) => row.occurrenceKey.startsWith('C:'))).toBe(true);
    await reopened.close();
  });
});

describe('legacy 文件解码与规范化', () => {
  it('网页 12 的 C: 数据迁移为 N:，每个分组只建一行', () => {
    const data = emptyDataSet();
    data.orders.push(order({ id: 'o1' }));
    data.hosting_periods.push(period({ id: 'p1', orderId: 'o1', serviceCount: 2 }));
    data.task_definitions.push(
      task({ id: 't1', orderId: 'o1', periodId: 'p1' }),
      task({ id: 't2', orderId: 'o1', periodId: 'p1', sortOrder: 1 }),
    );
    data.task_occurrences.push(
      occurrence({ id: 'oc1', taskDefinitionId: 't1', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
      occurrence({ id: 'oc2', taskDefinitionId: 't2', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
    );
    const result = normalizeDecodedDataset({
      data,
      columnsByTable: { hosting_sessions: null, game_templates: null, template_categories: null },
      schemaVersion: 12,
    });
    expect(result.report.counts.sessionsCreated).toBe(1);
    expect(result.report.counts.occurrencesRewritten).toBe(2);
    expect(data.hosting_sessions).toHaveLength(1);
    expect(data.hosting_sessions[0].sessionIndex).toBe(1);
    expect(data.hosting_sessions[0].periodId).toBe('p1');
    expect(data.orders[0].hostingMode).toBe('COUNT_BASED');
    expect(data.orders[0].targetSessions).toBe(2);
  });

  it('同一订单混合 C: 与 N: 时拒绝，绝不部分重编号', () => {
    const data = emptyDataSet();
    data.orders.push(order({ id: 'o1', hostingMode: 'COUNT_BASED', targetSessions: 3 }));
    data.hosting_periods.push(period({ id: 'p1', orderId: 'o1', serviceCount: 3 }));
    data.task_definitions.push(task({ id: 't1', orderId: 'o1', periodId: 'p1' }));
    data.task_occurrences.push(
      occurrence({ id: 'oc1', taskDefinitionId: 't1', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }),
      occurrence({ id: 'oc2', taskDefinitionId: 't1', occurrenceKey: 'N:1', gameDate: '2026-02-03' }),
    );
    data.hosting_sessions.push({
      id: 'existing',
      orderId: 'o1',
      sessionIndex: 1,
      createdAt: NOW,
      completedAt: null,
      completionBatchId: null,
      periodId: 'p1',
    });
    expect(() =>
      normalizeDecodedDataset({
        data,
        columnsByTable: { hosting_sessions: ['id', 'orderId', 'sessionIndex', 'createdAt', 'completedAt', 'completionBatchId', 'periodId'] },
        schemaVersion: 14,
      }),
    ).toThrow(/UNSUPPORTED_MIXED_C_N_INPUT/);
    // 拒绝后没有任何改写
    expect(data.task_occurrences[0].occurrenceKey).toBe('C:2026-02-02');
  });

  it('安卓 13/14 计次订单：恰一个期次时可证归属；多个期次即中止', () => {
    const owned = emptyDataSet();
    owned.orders.push(order({ id: 'o1', hostingMode: 'COUNT_BASED', targetSessions: 6 }));
    owned.hosting_periods.push(period({ id: 'p1', orderId: 'o1' }));
    owned.hosting_sessions.push({
      id: 's1',
      orderId: 'o1',
      sessionIndex: 1,
      createdAt: NOW,
      completedAt: null,
      completionBatchId: null,
      periodId: null as unknown as string,
    });
    owned.task_definitions.push(task({ id: 't1', orderId: 'o1', periodId: 'p1' }));
    owned.task_occurrences.push(occurrence({ id: 'oc1', taskDefinitionId: 't1', occurrenceKey: 'N:1', gameDate: '2026-02-02' }));
    normalizeDecodedDataset({
      data: owned,
      columnsByTable: { hosting_sessions: ['id', 'orderId', 'sessionIndex', 'createdAt', 'completedAt', 'completionBatchId'] },
      schemaVersion: 14,
    });
    expect(owned.hosting_periods[0].serviceCount).toBe(6);
    expect(owned.hosting_sessions[0].periodId).toBe('p1');

    const ambiguous = emptyDataSet();
    ambiguous.orders.push(order({ id: 'o1', hostingMode: 'COUNT_BASED', targetSessions: 6 }));
    ambiguous.hosting_periods.push(period({ id: 'p1', orderId: 'o1' }), period({ id: 'p2', orderId: 'o1', periodIndex: 1 }));
    ambiguous.hosting_sessions.push({
      id: 's1',
      orderId: 'o1',
      sessionIndex: 1,
      createdAt: NOW,
      completedAt: null,
      completionBatchId: null,
      periodId: null as unknown as string,
    });
    expect(() =>
      normalizeDecodedDataset({
        data: ambiguous,
        columnsByTable: { hosting_sessions: ['id', 'orderId', 'sessionIndex', 'createdAt', 'completedAt', 'completionBatchId'] },
        schemaVersion: 14,
      }),
    ).toThrow(/COUNT_PERIOD_AMBIGUOUS/);
  });

  it('规范化后的数据集可以通过严格校验并完整往返', () => {
    const data = emptyDataSet();
    data.owners.push({
      id: 'ow1',
      number: 1,
      nickname: '老板',
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      archiveBatchId: null,
    });
    data.owner_number_sequence.push({ id: 0, nextNumber: 2 });
    data.game_accounts.push(baseAccount() as never);
    data.orders.push(order({ id: 'o1' }));
    data.hosting_periods.push(period({ id: 'p1', orderId: 'o1', serviceCount: 1 }));
    data.task_definitions.push(task({ id: 't1', orderId: 'o1', periodId: 'p1' }));
    data.task_occurrences.push(occurrence({ id: 'oc1', taskDefinitionId: 't1', occurrenceKey: 'C:2026-02-02', gameDate: '2026-02-02' }));
    normalizeDecodedDataset({
      data,
      columnsByTable: { hosting_sessions: null, game_templates: null, template_categories: null },
      schemaVersion: 12,
    });
    expect(() => validateSnapshot({ data, attachments: new Map() })).not.toThrow();
    const decoded = decodeData(encodeData(data), CURRENT_SCHEMA).data;
    expect(decoded.task_occurrences[0].occurrenceKey).toBe('N:1');
    expect(() => validateSnapshot({ data: decoded, attachments: new Map() })).not.toThrow();
  });
});

describe('模板文件格式 4', () => {
  const v4 = {
    format: 'daigan-template',
    formatVersion: 4,
    template: {
      id: 'tpl',
      gameName: '游戏',
      templateVersion: '1.0',
      gameVersionNotes: null,
      timeZone: 'Asia/Shanghai',
      dailyRefresh: '05:00',
      weeklyRefreshDay: 'MONDAY',
      weeklyRefreshTime: '05:00',
      hostingMode: 'COUNT_BASED',
      targetSessions: 10,
      serviceWeekdays: null,
      defaultOrderTitle: '托管 10 次',
      categories: [
        {
          id: 'c1',
          name: '日常',
          hostingMode: 'DATE_RANGE',
          targetSessions: null,
          serviceWeekdays: '1,2,3,4,5',
          tasks: [
            {
              id: 't1',
              categoryId: 'c1',
              title: '签到',
              progressType: 'CHECKBOX',
              startValue: '0',
              targetValue: '1',
              unit: null,
              recurrence: 'DAILY',
              weekdays: [],
              everyNDays: null,
              monthDay: null,
              monthDays: [],
              activeFrom: '2026-02-01',
              activeUntil: null,
              numericMode: null,
            },
          ],
        },
      ],
    },
  };

  it('读取 4 并把分层默认值映射到草稿', () => {
    const draft = parseTemplateFile(JSON.stringify(v4));
    expect(draft.hostingMode).toBe('COUNT_BASED');
    expect(draft.targetSessions).toBe(10);
    expect(draft.defaultOrderTitle).toBe('托管 10 次');
    expect(draft.categories[0].hostingMode).toBe('DATE_RANGE');
    expect(draft.categories[0].serviceWeekdays).toBe('1,2,3,4,5');
    expect(draft.categories[0].serviceMode).toBe('weekdays');
    expect(draft.categories[0].tasks[0].activeFrom).toBe('2026-02-01');
  });

  it('写出 4 并可无损读回（不写账号分类）', () => {
    const draft = parseTemplateFile(JSON.stringify(v4));
    const text = serializeTemplate(draft);
    const doc = JSON.parse(text) as Record<string, unknown> & { formatVersion: number };
    expect(doc.formatVersion).toBe(TEMPLATE_FORMAT_VERSION);
    expect(text).not.toContain('categoryId": "acc');
    expect(JSON.parse(text).template.categories[0].hostingMode).toBe('DATE_RANGE');
    const again = parseTemplateFile(text);
    expect(again.hostingMode).toBe('COUNT_BASED');
    expect(again.targetSessions).toBe(10);
    expect(again.categories[0].serviceWeekdays).toBe('1,2,3,4,5');
  });

  it('拒绝未知键（各层一致）', () => {
    const withRoot = { ...v4, extra: 1 };
    expect(() => parseTemplateFile(JSON.stringify(withRoot))).toThrow(/不支持的字段/);
    const withTemplate = { ...v4, template: { ...v4.template, ghost: true } };
    expect(() => parseTemplateFile(JSON.stringify(withTemplate))).toThrow(/不支持的字段/);
    const withCategory = {
      ...v4,
      template: {
        ...v4.template,
        categories: [{ ...v4.template.categories[0], ghost: 1 }],
      },
    };
    expect(() => parseTemplateFile(JSON.stringify(withCategory))).toThrow(/不支持的字段/);
  });

  it('读取历史格式 1（无价格预设、任务无 monthDay）', () => {
    const legacy = {
      format: 'daigan-template',
      formatVersion: 1,
      template: {
        id: 'tpl',
        gameName: '游戏',
        templateVersion: '1.0',
        gameVersionNotes: null,
        timeZone: 'Asia/Shanghai',
        dailyRefresh: '05:00',
        weeklyRefreshDay: 'MONDAY',
        weeklyRefreshTime: '05:00',
        categories: [
          {
            id: 'c1',
            name: '日常',
            tasks: [
              {
                id: 't1',
                categoryId: 'c1',
                title: '签到',
                progressType: 'CHECKBOX',
                startValue: '0',
                targetValue: '1',
                unit: null,
                recurrence: 'DAILY',
                weekdays: [],
                everyNDays: null,
              },
            ],
          },
        ],
      },
    };
    const draft = parseTemplateFile(JSON.stringify(legacy));
    expect(draft.categories[0].tasks[0].monthDay).toBeNull();
    expect(draft.categories[0].serviceMode).toBeUndefined();
    expect(draft.hostingMode).toBeNull();
  });

  it('历史网页格式 2 的 serviceMode 被显式规范化', () => {
    const legacy = {
      format: 'daigan-template',
      formatVersion: 2,
      template: {
        id: 'tpl',
        gameName: '游戏',
        templateVersion: '1.0',
        gameVersionNotes: null,
        timeZone: 'Asia/Shanghai',
        dailyRefresh: '05:00',
        weeklyRefreshDay: 'MONDAY',
        weeklyRefreshTime: '05:00',
        serviceMode: 'count',
        serviceCount: 9,
        categories: [
          {
            id: 'c1',
            name: '日常',
            serviceMode: null,
            tasks: [
              {
                id: 't1',
                categoryId: 'c1',
                title: '签到',
                progressType: 'CHECKBOX',
                startValue: '0',
                targetValue: '1',
                unit: null,
                recurrence: 'DAILY',
                weekdays: [],
                everyNDays: null,
                monthDay: null,
                activeFrom: null,
                activeUntil: null,
              },
            ],
          },
        ],
      },
    };
    const draft = parseTemplateFile(JSON.stringify(legacy));
    // 模板：count → COUNT_BASED/9
    expect(draft.hostingMode).toBe('COUNT_BASED');
    expect(draft.targetSessions).toBe(9);
    // 分类：显式 null → 显式 DATE_RANGE（不是继承）
    expect(draft.categories[0].serviceMode).toBe('dates');
  });
});

describe('十进制共享边界（绝对值 1e12 / 缩放单位 1e15）', () => {
  it('接受上界并拒绝超出 0.001', () => {
    expect(formatDecimal(parseDecimal('1000000000000'))).toBe('1000000000000');
    expect(parseDecimal('1000000000000.000').units).toBe(1_000_000_000_000_000n);
    expect(() => parseDecimal('1000000000000.001')).toThrow(/超出允许范围/);
    expect(() => parseDecimal('-1000000000000.001')).toThrow(/超出允许范围/);
  });

  it('保留历史非规范文本，写出时规范化', () => {
    expect(parseDecimal('010.50').units).toBe(10_500n);
    expect(formatDecimal(parseDecimal('010.500'))).toBe('10.5');
  });
});

describe('累计事件的 scope 与链校验', () => {
  const sessionById = new Map([['s1', { orderId: 'o1', periodId: 'p1' }]]);
  const taskById = new Map<string, TaskDefinitionRow>([
    ['tCount', task({ id: 'tCount', orderId: 'o1', periodId: 'p1', progressType: 'NUMERIC', targetValue: '100', numericMode: 'CUMULATIVE' })],
    ['tDate', task({ id: 'tDate', orderId: 'o2', periodId: null, progressType: 'NUMERIC', targetValue: '100', numericMode: 'CUMULATIVE' })],
  ]);
  const context: EventChainContext = {
    taskById,
    orderById: new Map([
      ['o1', { type: 'HOSTING' as const, hostingMode: 'COUNT_BASED' as const }],
      ['o2', { type: 'SHORT_TASK' as const, hostingMode: null }],
    ]),
    periodById: new Map([
      [
        'p1',
        {
          orderId: 'o1',
          serviceCount: 2,
          startDate: '2026-02-01',
          endDate: '2026-02-28',
          serviceStart: '2026-02-01',
        },
      ],
    ]),
    sessionById,
  };

  function event(overrides: Partial<TaskProgressEventRow> & Pick<TaskProgressEventRow, 'id' | 'taskDefinitionId' | 'sequence' | 'operationId'>): TaskProgressEventRow {
    return {
      kind: 'SUBMIT',
      scopeType: 'SESSION',
      scopePeriodId: null,
      scopeSessionId: 's1',
      gameDate: '2026-02-02',
      totalValue: '10',
      correctsEventId: null,
      recordedAt: NOW,
      createdAt: NOW,
      ...overrides,
    };
  }

  it('scope 矩阵：计次任务用 PERIOD 一律拒绝', () => {
    const violations = validateProgressEvents(
      [event({ id: 'e1', taskDefinitionId: 'tCount', sequence: 1, operationId: 'op1', scopeType: 'PERIOD', scopePeriodId: 'p1', scopeSessionId: null })],
      context,
    );
    expect(violations.map((item) => item.code)).toContain('SCOPE_NOT_ALLOWED');
  });

  it('scope 归属：轮次必须属于同一订单', () => {
    const violations = validateProgressEvents(
      [event({ id: 'e1', taskDefinitionId: 'tDate', sequence: 1, operationId: 'op1', scopeType: 'SESSION', scopeSessionId: 's1' })],
      context,
    );
    expect(violations.map((item) => item.code)).toContain('SCOPE_OWNERSHIP_INVALID');
  });

  it('更正必须同任务/同 scope/同日，且单后继', () => {
    const base = event({ id: 'e1', taskDefinitionId: 'tCount', sequence: 1, operationId: 'op1' });
    const changedDate = event({
      id: 'e2',
      taskDefinitionId: 'tCount',
      sequence: 2,
      operationId: 'op2',
      kind: 'CORRECT',
      correctsEventId: 'e1',
      gameDate: '2026-02-03',
    });
    expect(validateProgressEvents([base, changedDate], context).map((item) => item.code)).toContain(
      'CORRECTION_DATE_CHANGED',
    );
    const ok = { ...changedDate, gameDate: '2026-02-02' };
    expect(validateProgressEvents([base, ok], context)).toHaveLength(0);
    const second = event({
      id: 'e3',
      taskDefinitionId: 'tCount',
      sequence: 3,
      operationId: 'op3',
      kind: 'CORRECT',
      correctsEventId: 'e1',
      totalValue: '30',
    });
    expect(validateProgressEvents([base, ok, second], context).map((item) => item.code)).toContain(
      'SUPERSEDED_EVENT',
    );
  });

  it('更正环与不可能的序号被拒绝', () => {
    const a = event({ id: 'a', taskDefinitionId: 'tCount', sequence: 2, operationId: 'opa', kind: 'CORRECT', correctsEventId: 'b' });
    const b = event({ id: 'b', taskDefinitionId: 'tCount', sequence: 1, operationId: 'opb', kind: 'CORRECT', correctsEventId: 'a' });
    const codes = validateProgressEvents([a, b], context).map((item) => item.code);
    expect(codes).toContain('CORRECTION_CYCLE');
  });

  it('resolveScopeTotal：取最大游戏日、同日最大序号，撤回不复活旧值', () => {
    const scope: ProgressScope = { kind: 'SESSION', sessionId: 's1' };
    const submit1 = event({ id: 'e1', taskDefinitionId: 'tCount', sequence: 1, operationId: 'op1', totalValue: '10' });
    const submit2 = event({ id: 'e2', taskDefinitionId: 'tCount', sequence: 2, operationId: 'op2', totalValue: '15', gameDate: '2026-02-03' });
    expect(resolveScopeTotal([submit1, submit2], 'tCount', scope, '0')).toBe('15');
    expect(resolveScopeTotal([submit1, submit2], 'tCount', scope, '0', '2026-02-02')).toBe('10');
    const retract = event({
      id: 'e3',
      taskDefinitionId: 'tCount',
      sequence: 3,
      operationId: 'op3',
      kind: 'RETRACT',
      totalValue: null,
      correctsEventId: 'e2',
      gameDate: '2026-02-03',
    });
    // 撤回后 e2 被取代且 e3 非有效观测 → 回到 e1，绝不复活 e2
    expect(resolveScopeTotal([submit1, submit2, retract], 'tCount', scope, '0')).toBe('10');
  });
});

describe('轮次状态与缓存重建（含待建行）', () => {
  const p1: HostingPeriodRow = period({ id: 'p1', orderId: 'o1', serviceCount: 2 });
  const sessions: HostingSessionRow[] = [
    { id: 's1', orderId: 'o1', sessionIndex: 1, createdAt: NOW, completedAt: NOW, completionBatchId: null, periodId: 'p1' },
  ];

  it('新号 = 全订单最大号 + 1，判满后为 PERIOD_FULL', () => {
    expect(nextOrderGlobalSessionIndex(sessions)).toBe(2);
    expect(selectActiveSession(sessions, 'p1', 2)).toEqual({ kind: 'ALLOCATE_NEW', sessionIndex: 2 });
    const full: HostingSessionRow[] = [
      ...sessions,
      { id: 's2', orderId: 'o1', sessionIndex: 2, createdAt: NOW, completedAt: NOW, completionBatchId: null, periodId: 'p1' },
    ];
    expect(selectActiveSession(full, 'p1', 2)).toEqual({ kind: 'PERIOD_FULL' });
  });

  it('待建行的缓存取 startValue，且不继承上一轮完成时刻', () => {
    const state = resolveActiveCountSession('o1', [p1], sessions);
    expect(state).toEqual({ kind: 'AWAITING_SESSION_ROW', periodId: 'p1', sessionIndex: 2 });
    const row = task({ id: 't1', orderId: 'o1', periodId: 'p1', progressType: 'NUMERIC', startValue: '5', targetValue: '50' });
    const cache = taskScopeCache(row, state, [p1], sessions, []);
    expect(cache.state).toBe('AWAITING_SESSION_ROW');
    if (cache.state === 'AWAITING_SESSION_ROW') {
      expect(cache.currentValue).toBe('5');
      expect(cache.completedAt).toBeNull();
      expect(cache.reachedTarget).toBe(false);
    }
  });

  it('startValue 已达标也只是 reachedTarget，不自动完成空轮次', () => {
    const state = resolveActiveCountSession('o1', [p1], sessions);
    const row = task({ id: 't1', orderId: 'o1', periodId: 'p1', progressType: 'NUMERIC', startValue: '60', targetValue: '50' });
    const cache = taskScopeCache(row, state, [p1], sessions, []);
    if (cache.state === 'AWAITING_SESSION_ROW') {
      expect(cache.reachedTarget).toBe(true);
      expect(cache.completedAt).toBeNull();
    }
  });

  it('后期次没有行时降级为 TASK_PERIOD_TERMINAL，不指向别的期次', () => {
    const other = period({ id: 'p0', orderId: 'o1', periodIndex: 0, serviceCount: 1 });
    const activeState = resolveActiveCountSession('o1', [other, p1], [
      { id: 's0', orderId: 'o1', sessionIndex: 1, createdAt: NOW, completedAt: NOW, completionBatchId: null, periodId: 'p0' },
    ]);
    expect(activeState.kind).toBe('AWAITING_SESSION_ROW');
    const row = task({ id: 'tOld', orderId: 'o1', periodId: 'p0', progressType: 'NUMERIC', startValue: '0', targetValue: '50' });
    const cache = taskScopeCache(row, activeState, [other, p1], [
      { id: 's0', orderId: 'o1', sessionIndex: 1, createdAt: NOW, completedAt: NOW, completionBatchId: null, periodId: 'p0' },
    ], []);
    expect(cache.state).toBe('TASK_PERIOD_TERMINAL');
    if (cache.state === 'TASK_PERIOD_TERMINAL') {
      expect(cache.periodId).toBe('p0');
      expect(cache.lastScope?.sessionId).toBe('s0');
    }
  });

  it('全部期次完成 → ORDER_TERMINAL', () => {
    const full: HostingSessionRow[] = [
      ...sessions,
      { id: 's2', orderId: 'o1', sessionIndex: 2, createdAt: NOW, completedAt: NOW, completionBatchId: null, periodId: 'p1' },
    ];
    expect(resolveActiveCountSession('o1', [p1], full)).toEqual({ kind: 'ALL_PERIODS_COMPLETE' });
  });
});

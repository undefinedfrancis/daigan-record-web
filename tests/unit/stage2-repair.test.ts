import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { createServices } from '../../src/application';
import { createExportService } from '../../src/backup/exportService';
import { createRestoreService } from '../../src/backup/restoreService';
import { emptyDataSet } from '../../src/backup/catalog';
import { readArchive, writeArchive } from '../../src/backup/archive';
import { encodeData } from '../../src/backup/dataCodec';
import { sha256Hex } from '../../src/backup/crypto';
import { normalizeDecodedDataset } from '../../src/backup/normalize';
import { NormalizationError } from '../../src/backup/normalize/diagnostics';
import { validateSnapshot } from '../../src/backup/validateSnapshot';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { controlDb, resetControlDb } from '../../src/storage/controlDb';
import { BUSINESS_TABLES } from '../../src/contracts/tables';
import type { Snapshot } from '../../src/contracts/backup';
import type { BackupDataSet } from '../../src/contracts/tables';
import type {
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
  TaskProgressEventRow,
} from '../../src/contracts/tables';
import { gameDateAt } from '../../src/domain/gameCalendar';
import { reconstructDerivedState } from '../../src/domain/derivedState';
import { resolveScopeTotal, type ProgressScope } from '../../src/domain/progressEvents';
import { taskScopeCache, type ActiveCountState } from '../../src/domain/countSessions';

const NOW = Date.UTC(2026, 1, 10, 4, 0);
const ZONE = 'Asia/Shanghai';
const TODAY = gameDateAt(NOW, ZONE, 300);

// ------------------------------------------------------------------ 环境与夹具

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

type Env = Awaited<ReturnType<typeof freshEnv>>;

async function seedOwnerAndAccount(env: Env): Promise<{ ownerId: string; accountId: string }> {
  const ownerId = await env.services.accounts.saveOwner({ nickname: '老板甲' }, env.token);
  const accountId = await env.services.accounts.saveAccount(
    {
      ownerId,
      gameName: '原神',
      server: '官服',
      uid: '1001',
      loginAccount: 'acc',
      loginMethod: 'PASSWORD',
      password: 'secret',
    },
    env.token,
  );
  return { ownerId, accountId };
}

const CHECKBOX_TASK = {
  title: '签到',
  progressType: 'CHECKBOX' as const,
  startValue: '0',
  targetValue: '1',
  unit: null,
  recurrence: 'DAILY' as const,
  weekdays: null,
  everyNDays: null,
  monthDay: null,
};

const NUMERIC_TASK = {
  title: '刷本',
  progressType: 'NUMERIC' as const,
  startValue: '0',
  targetValue: '20',
  unit: '次',
  recurrence: 'DAILY' as const,
  weekdays: null,
  everyNDays: null,
  monthDay: null,
  numericMode: 'CUMULATIVE' as const,
};

/**
 * 建一个计次托管订单并落到当前资料库。
 *
 * 计次轮次（`N:` 键 + `hosting_sessions`）目前只能通过导入产生：网页的计次订单写入路径
 * 仍产出按日期的 `C:` 键（轮次写入属于 Stage 3），因此这里用合成数据集走完整恢复路径。
 */
async function createCountOrder(
  env: Env,
  ids: { ownerId: string; accountId: string },
  options: {
    serviceCount: number;
    tasks: {
      title: string;
      progressType?: 'CHECKBOX' | 'NUMERIC';
      targetValue?: string;
      numericMode?: 'CUMULATIVE' | null;
      activeFrom?: string | null;
    }[];
    operationId: string;
  },
): Promise<string> {
  void ids;
  void options.operationId;
  const data = baseData();
  data.orders.push({
    ...dateOrderRow('o1'),
    hostingMode: 'COUNT_BASED',
    targetSessions: options.serviceCount,
  });
  data.hosting_periods.push({ ...periodRow('p1', 'o1'), serviceCount: options.serviceCount });
  options.tasks.forEach((task, index) => {
    data.task_definitions.push({
      ...taskRow(`t${index + 1}`, 'o1', 'p1'),
      title: task.title,
      progressType: task.progressType ?? 'NUMERIC',
      targetValue: task.targetValue ?? '20',
      numericMode:
        (task.progressType ?? 'NUMERIC') === 'NUMERIC'
          ? task.numericMode === undefined
            ? 'CUMULATIVE'
            : task.numericMode
          : null,
      activeFrom: task.activeFrom ?? null,
    });
  });
  await restoreSnapshot(env, { data, attachments: new Map() });
  return 'o1';
}

async function createDateOrder(
  env: Env,
  ids: { ownerId: string; accountId: string },
  operationId: string,
): Promise<string> {
  const result = await env.services.orders.create(
    {
      operationId,
      ownerId: ids.ownerId,
      accountId: ids.accountId,
      type: 'HOSTING',
      title: '按日期托管',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      priceCents: null,
      deadlineDate: null,
      gameZoneId: ZONE,
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      startDate: TODAY,
      endDate: TODAY,
      periodPriceCents: 30000,
      tasks: [CHECKBOX_TASK as never],
      firstReceipt: null,
      sourceTemplateId: null,
      sourceTemplateName: null,
      sourceTemplateVersion: null,
    },
    env.token,
  );
  return result.orderId;
}

/** 通过生产导出路径拿到快照，供测试注入历史/异常数据。 */
async function exportSnapshot(env: Env): Promise<Snapshot> {
  const exported = await env.exporter.exportCurrent();
  const { snapshot } = await readArchive(exported.blob);
  if (!snapshot) throw new Error('缺少快照');
  return snapshot;
}

async function restoreSnapshot(env: Env, snapshot: Snapshot) {
  const blob = await writeArchive(snapshot);
  const preview = await env.restore.prepareRestore(blob);
  await env.restore.commitRestore(preview.sessionId, preview.baseToken);
  return preview;
}

function sessionRow(
  overrides: Partial<HostingSessionRow> & Pick<HostingSessionRow, 'id' | 'orderId' | 'periodId'>,
): HostingSessionRow {
  return {
    sessionIndex: 1,
    createdAt: NOW,
    completedAt: null,
    completionBatchId: null,
    ...overrides,
  };
}

function eventRow(
  overrides: Partial<TaskProgressEventRow> &
    Pick<TaskProgressEventRow, 'id' | 'taskDefinitionId' | 'operationId' | 'sequence'>,
): TaskProgressEventRow {
  return {
    kind: 'SUBMIT',
    scopeType: 'SESSION',
    scopePeriodId: null,
    scopeSessionId: null,
    gameDate: TODAY,
    totalValue: '0',
    correctsEventId: null,
    recordedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function occurrenceRow(
  overrides: Partial<TaskOccurrenceRow> &
    Pick<TaskOccurrenceRow, 'id' | 'taskDefinitionId' | 'occurrenceKey'>,
): TaskOccurrenceRow {
  return {
    gameDate: TODAY,
    windowStart: null,
    windowEnd: null,
    completedAt: NOW,
    recordedAt: NOW,
    backfilled: 0,
    completionBatchId: null,
    value: null,
    createdAt: NOW,
    ...overrides,
  };
}

function findTask(data: BackupDataSet, orderId: string, title: string): TaskDefinitionRow {
  const task = data.task_definitions.find((row) => row.orderId === orderId && row.title === title);
  if (!task) throw new Error(`缺少任务 ${title}`);
  return task;
}

function findPeriod(data: BackupDataSet, orderId: string): HostingPeriodRow {
  const period = data.hosting_periods.find((row) => row.orderId === orderId);
  if (!period) throw new Error('缺少期次');
  return period;
}

function findOrder(data: BackupDataSet, orderId: string): OrderRow {
  const order = data.orders.find((row) => row.id === orderId);
  if (!order) throw new Error('缺少订单');
  return order;
}

/** 一份能通过严格校验的最小数据集（老板 + 账号）。 */
function baseData(): BackupDataSet {
  const data = emptyDataSet();
  data.owners.push({
    id: 'ow1',
    number: 1,
    nickname: '老板甲',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    archiveBatchId: null,
  });
  data.owner_number_sequence.push({ id: 0, nextNumber: 2 });
  data.game_accounts.push({
    id: 'ac1',
    ownerId: 'ow1',
    gameName: '原神',
    server: '官服',
    uid: '1',
    loginAccount: 'acc',
    loginMethod: 'PASSWORD',
    password: 'secret',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    archiveBatchId: null,
    defaultTemplateId: null,
    loginDevice: null,
    resourceNotes: null,
    categoryId: null,
  });
  return data;
}

/**
 * 合成一份合法的计次托管数据集。
 *
 * 计次轮次（`N:` 键 + `hosting_sessions`）目前只能通过导入/迁移产生：网页的计次订单
 * 写入路径仍产出按日期的 `C:` 键（Stage 3 才接入轮次），因此这里直接构造导入数据。
 */
function countData(spec: {
  serviceCount: number;
  tasks: { id: string; title: string; numeric?: boolean; target?: string; activeFrom?: string }[];
  periods?: { id: string; index: number; serviceCount?: number | null }[];
}): { data: BackupDataSet; orderId: string; periodIds: string[] } {
  const data = baseData();
  const orderId = 'o1';
  data.orders.push({
    ...dateOrderRow(orderId),
    hostingMode: 'COUNT_BASED',
    targetSessions: spec.serviceCount,
  });
  const periods = spec.periods ?? [{ id: 'p1', index: 0 }];
  for (const item of periods) {
    data.hosting_periods.push({
      ...periodRow(item.id, orderId),
      periodIndex: item.index,
      serviceCount: item.serviceCount === undefined ? spec.serviceCount : item.serviceCount,
    });
  }
  for (const task of spec.tasks) {
    const base = taskRow(task.id, orderId, periods[0].id);
    data.task_definitions.push(
      task.numeric === false
        ? { ...base, title: task.title, activeFrom: task.activeFrom ?? null }
        : {
            ...base,
            title: task.title,
            progressType: 'NUMERIC',
            targetValue: task.target ?? '20',
            numericMode: 'CUMULATIVE',
            activeFrom: task.activeFrom ?? null,
          },
    );
  }
  return { data, orderId, periodIds: periods.map((item) => item.id) };
}

beforeEach(async () => {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-')) await Dexie.delete(name);
  }
});

// ---------------------------------------------------------------------- S2-R1

describe('S2-R1 任务级累计隔离（领域层）', () => {
  const scope: ProgressScope = { kind: 'SESSION', sessionId: 's1' };
  const e1 = eventRow({
    id: 'e1',
    taskDefinitionId: 't1',
    operationId: 'op1',
    sequence: 1,
    totalValue: '10',
    scopeSessionId: 's1',
  });
  const e2 = eventRow({
    id: 'e2',
    taskDefinitionId: 't2',
    operationId: 'op2',
    sequence: 1,
    totalValue: '20',
    gameDate: '2026-02-11',
    scopeSessionId: 's1',
  });

  it('两个任务共享一个 SESSION 时互不影响（10 而不是 20）', () => {
    expect(resolveScopeTotal([e1, e2], 't1', scope, '0')).toBe('10');
    expect(resolveScopeTotal([e1, e2], 't2', scope, '0')).toBe('20');
    expect(resolveScopeTotal([e1, e2], 't1', scope, '0', '2026-02-10')).toBe('10');
  });

  it('缓存函数按传入的整个数据集事件集合也不会串任务', () => {
    const p1 = {
      id: 'p1',
      orderId: 'o1',
      periodIndex: 0,
      startDate: TODAY,
      endDate: TODAY,
      priceCents: 30000,
      gameZoneId: ZONE,
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      createdAt: NOW,
      renewalOperationId: null,
      serviceDays: null,
      serviceWeekdays: null,
      monthlyRefreshDays: null,
      serviceCount: 2,
    } as HostingPeriodRow;
    const s1 = sessionRow({ id: 's1', orderId: 'o1', periodId: 'p1' });
    const t1 = {
      id: 't1',
      orderId: 'o1',
      periodId: 'p1',
      title: 'A',
      progressType: 'NUMERIC',
      startValue: '0',
      targetValue: '20',
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
      numericMode: 'CUMULATIVE',
      colorArgb: null,
    } as TaskDefinitionRow;
    const state: ActiveCountState = {
      kind: 'ACTIVE_SESSION',
      periodId: 'p1',
      sessionIndex: 1,
      sessionId: 's1',
    };
    expect(taskScopeCache(t1, state, [p1], [s1], [e1, e2]).currentValue).toBe('10');
  });
});

// ---------------------------------------------------------------------- S2-R2

describe('S2-R2 事件归属与资格校验（恢复路径）', () => {
  /**
   * 三个计次订单：o1（两期、一个累计任务 + 一个勾选任务）、o2（另一订单）、o3（勾选任务）。
   * 计次轮次只能通过导入产生，因此这里直接构造导入数据走完整恢复路径。
   */
  async function countOrderEnv() {
    const env = await freshEnv();
    const data = baseData();
    data.orders.push(
      { ...dateOrderRow('o1'), hostingMode: 'COUNT_BASED', targetSessions: 2 },
      { ...dateOrderRow('o2'), hostingMode: 'COUNT_BASED', targetSessions: 1 },
      { ...dateOrderRow('o3'), hostingMode: 'COUNT_BASED', targetSessions: 1 },
    );
    data.hosting_periods.push(
      { ...periodRow('p1', 'o1'), periodIndex: 0, serviceCount: 2 },
      {
        ...periodRow('p2', 'o1'),
        startDate: '2026-03-01',
        endDate: '2026-03-01',
        periodIndex: 1,
        serviceCount: 2,
      },
      { ...periodRow('p3', 'o2'), periodIndex: 0, serviceCount: 1 },
      { ...periodRow('p4', 'o3'), periodIndex: 0, serviceCount: 1 },
    );
    data.task_definitions.push(
      {
        ...taskRow('t1', 'o1', 'p1'),
        title: '刷本',
        progressType: 'NUMERIC',
        targetValue: '20',
        numericMode: 'CUMULATIVE',
      },
      { ...taskRow('t2', 'o1', 'p1'), title: '签到' },
      {
        ...taskRow('t3', 'o2', 'p3'),
        title: '刷本乙',
        progressType: 'NUMERIC',
        targetValue: '20',
        numericMode: 'CUMULATIVE',
      },
      { ...taskRow('t4', 'o3', 'p4'), title: '签到丙' },
    );
    await restoreSnapshot(env, { data, attachments: new Map() });
    return {
      env,
      ids: { ownerId: 'ow1', accountId: 'ac1' },
      orderId: 'o1',
      otherOrderId: 'o2',
      checkboxOrderId: 'o3',
    };
  }

  it('同订单错期次的事件被拒绝（不静默接受）', async () => {
    const { env, orderId } = await countOrderEnv();
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const task = findTask(data, orderId, '刷本');
    // t1 属于 p1；事件却指向同一订单的另一期 p2 的轮次。
    data.hosting_sessions.push(sessionRow({ id: 's-per', orderId, periodId: 'p2' }));
    data.task_progress_events.push(
      eventRow({
        id: 'ev',
        taskDefinitionId: task.id,
        operationId: 'op-ev',
        sequence: 1,
        totalValue: '5',
        scopeSessionId: 's-per',
      }),
    );
    await expect(restoreSnapshot(env, snapshot)).rejects.toThrow(/SCOPE_SESSION_PERIOD_MISMATCH/);
  });

  it('跨订单的轮次被拒绝', async () => {
    const { env, orderId, otherOrderId } = await countOrderEnv();
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    data.hosting_sessions.push(sessionRow({ id: 's-other', orderId: otherOrderId, periodId: 'p3' }));
    const task = findTask(data, orderId, '刷本');
    data.task_progress_events.push(
      eventRow({
        id: 'ev',
        taskDefinitionId: task.id,
        operationId: 'op-ev',
        sequence: 1,
        totalValue: '5',
        scopeSessionId: 's-other',
      }),
    );
    await expect(restoreSnapshot(env, snapshot)).rejects.toThrow(/SCOPE_OWNERSHIP_INVALID/);
  });

  it('勾选任务不允许携带累计事件', async () => {
    const { env, checkboxOrderId } = await countOrderEnv();
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const task = findTask(data, checkboxOrderId, '签到丙');
    data.hosting_sessions.push(
      sessionRow({ id: 's-chk', orderId: checkboxOrderId, periodId: 'p4' }),
    );
    data.task_progress_events.push(
      eventRow({
        id: 'ev',
        taskDefinitionId: task.id,
        operationId: 'op-ev',
        sequence: 1,
        totalValue: '1',
        scopeSessionId: 's-chk',
      }),
    );
    await expect(restoreSnapshot(env, snapshot)).rejects.toThrow(/TASK_NOT_CUMULATIVE/);
  });

  it('合法的历史记录可以通过恢复', async () => {
    const { env, orderId } = await countOrderEnv();
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const task = findTask(data, orderId, '刷本');
    data.hosting_sessions.push(
      sessionRow({ id: 's-ok', orderId, periodId: 'p1', completedAt: NOW }),
    );
    data.task_progress_events.push(
      eventRow({
        id: 'ev',
        taskDefinitionId: task.id,
        operationId: 'op-ev',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's-ok',
      }),
    );
    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data.task_progress_events);
    expect(restored).toHaveLength(1);
    expect(restored[0].totalValue).toBe('20');
  });
});

// ---------------------------------------------------------------------- S2-R3

describe('S2-R3 恢复期派生状态重建', () => {
  /** 走生产恢复路径：解码 → 归一 → 权威校验 → 派生重建 → 候选校验 → 候选库 → 激活。 */
  async function restore(data: BackupDataSet, env: Env) {
    return restoreSnapshot(env, { data, attachments: new Map() });
  }

  it('陈旧的累计缓存、轮次与订单投影在恢复后按事件重建', async () => {
    const env = await freshEnv();
    const { data, orderId, periodIds } = countData({
      serviceCount: 2,
      tasks: [
        { id: 't1', title: '刷本' },
        { id: 't2', title: '签到', numeric: false },
      ],
    });
    // 文件里的派生值全部是陈旧的：轮次被标成已完成、缓存是旧值、订单已完成。
    data.hosting_sessions.push(
      sessionRow({ id: 's1', orderId, periodId: periodIds[0], completedAt: NOW + 500 }),
    );
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: 't1',
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
        recordedAt: NOW,
      }),
    );
    findTask(data, orderId, '刷本').currentValue = '3';
    findOrder(data, orderId).completedAt = NOW + 999;

    const preview = await restore(data, env);
    // 应做集里有勾选任务却没有任何打卡证据 → 该轮次必须被重新打开（不能虚判完成）。
    expect(preview.reconstruction.sessionsReopened).toBe(1);
    expect(preview.reconstruction.sessionsCompleted).toBe(0);
    expect(preview.reconstruction.taskCachesRefreshed).toBeGreaterThan(0);

    const restored = await env.runtime.read((ctx) => ctx.data);
    const session = restored.hosting_sessions.find((row) => row.id === 's1');
    expect(session?.completedAt).toBeNull();
    // 活动轮次就是 s1，缓存必须等于事件解析值（20），而不是文件里的 3。
    expect(findTask(restored, orderId, '刷本').currentValue).toBe('20');
    expect(findOrder(restored, orderId).completedAt).toBeNull();
  });

  it('同一轮次的两个累计任务各自重建，不互相污染', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 1,
      tasks: [
        { ...NUMERIC_TASK, title: '任务甲', targetValue: '10' },
        { ...NUMERIC_TASK, title: '任务乙', targetValue: '20' },
      ],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const a = findTask(data, orderId, '任务甲');
    const b = findTask(data, orderId, '任务乙');
    data.hosting_sessions.push(sessionRow({ id: 's1', orderId, periodId: period.id }));
    data.task_progress_events.push(
      eventRow({
        id: 'ev-a',
        taskDefinitionId: a.id,
        operationId: 'op-a',
        sequence: 1,
        totalValue: '10',
        scopeSessionId: 's1',
      }),
      eventRow({
        id: 'ev-b',
        taskDefinitionId: b.id,
        operationId: 'op-b',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
        gameDate: TODAY,
        recordedAt: NOW + 120_000,
      }),
    );
    a.currentValue = '9';
    b.currentValue = '9';

    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(findTask(restored, orderId, '任务甲').currentValue).toBe('10');
    expect(findTask(restored, orderId, '任务乙').currentValue).toBe('20');
    expect(restored.hosting_sessions[0].completedAt).toBe(NOW + 120_000);
  });

  it('已完成轮次之后的待做轮次从 startValue 开始，不继承上一轮完成度', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 3,
      tasks: [NUMERIC_TASK],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const numeric = findTask(data, orderId, '刷本');
    data.hosting_sessions.push(
      sessionRow({ id: 's1', orderId, periodId: period.id, sessionIndex: 1, completedAt: NOW }),
      sessionRow({ id: 's2', orderId, periodId: period.id, sessionIndex: 2 }),
    );
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
      }),
    );

    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(findTask(restored, orderId, '刷本').currentValue).toBe('0');
    expect(restored.hosting_sessions.find((row) => row.id === 's1')?.completedAt).toBe(NOW);
    expect(restored.hosting_sessions.find((row) => row.id === 's2')?.completedAt).toBeNull();
  });

  it('历史更正撤回后，早期轮次被重新打开', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 1,
      tasks: [NUMERIC_TASK],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const numeric = findTask(data, orderId, '刷本');
    data.hosting_sessions.push(
      sessionRow({ id: 's1', orderId, periodId: period.id, completedAt: NOW }),
    );
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
      }),
      eventRow({
        id: 'ev2',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev2',
        sequence: 2,
        kind: 'RETRACT',
        totalValue: null,
        correctsEventId: 'ev1',
        scopeSessionId: 's1',
      }),
    );

    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(restored.hosting_sessions[0].completedAt).toBeNull();
    expect(findTask(restored, orderId, '刷本').currentValue).toBe('0');
  });

  it('不同期次的任务名册不同：晚生效任务只影响其后轮次', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 2,
      tasks: [
        { ...NUMERIC_TASK, title: '常驻' },
        { ...NUMERIC_TASK, title: '后加', activeFrom: '2999-01-01' },
      ],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const always = findTask(data, orderId, '常驻');
    data.hosting_sessions.push(sessionRow({ id: 's1', orderId, periodId: period.id }));
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: always.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
      }),
    );

    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data);
    // 后加任务在该轮次还没生效，不进入应做集，因此轮次仍然完整。
    expect(restored.hosting_sessions[0].completedAt).toBe(NOW);
  });

  it('空应做集与部分完成都不被虚判为完成', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 2,
      tasks: [NUMERIC_TASK, CHECKBOX_TASK],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const numeric = findTask(data, orderId, '刷本');
    data.hosting_sessions.push(
      sessionRow({ id: 's-empty', orderId, periodId: period.id, sessionIndex: 1, completedAt: NOW }),
      sessionRow({ id: 's-partial', orderId, periodId: period.id, sessionIndex: 2, completedAt: NOW }),
    );
    // 第 1 轮：没有任何归属观测。第 2 轮：只有累计任务达标，勾选任务缺失。
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's-partial',
      }),
    );

    await restoreSnapshot(env, snapshot);
    const restored = await env.runtime.read((ctx) => ctx.data);
    expect(restored.hosting_sessions.find((row) => row.id === 's-empty')?.completedAt).toBeNull();
    expect(restored.hosting_sessions.find((row) => row.id === 's-partial')?.completedAt).toBeNull();
  });

  it('重建失败时当前数据集保持不变', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 1,
      tasks: [NUMERIC_TASK],
      operationId: 'op-order',
    });
    const beforeToken = await env.runtime.current();
    const before = await env.runtime.read((ctx) => ctx.data);
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const numeric = findTask(data, orderId, '刷本');
    // 引用不存在的轮次：必须在激活前失败。
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's-missing',
      }),
    );
    await expect(restoreSnapshot(env, snapshot)).rejects.toThrow();
    const afterToken = await env.runtime.current();
    expect(afterToken.databaseName).toBe(beforeToken.databaseName);
    expect(await env.runtime.read((ctx) => ctx.data)).toEqual(before);
  });

  it('重建是幂等的：连续两次得到相同语义结果', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createCountOrder(env, ids, {
      serviceCount: 1,
      tasks: [NUMERIC_TASK, CHECKBOX_TASK],
      operationId: 'op-order',
    });
    const snapshot = await exportSnapshot(env);
    const data = snapshot.data;
    const period = findPeriod(data, orderId);
    const numeric = findTask(data, orderId, '刷本');
    data.hosting_sessions.push(sessionRow({ id: 's1', orderId, periodId: period.id }));
    data.task_progress_events.push(
      eventRow({
        id: 'ev1',
        taskDefinitionId: numeric.id,
        operationId: 'op-ev1',
        sequence: 1,
        totalValue: '20',
        scopeSessionId: 's1',
      }),
    );
    data.task_occurrences.push(
      occurrenceRow({
        id: 'oc-idem',
        taskDefinitionId: findTask(data, orderId, '签到').id,
        occurrenceKey: 'N:1',
        completedAt: NOW,
      }),
    );
    const first = reconstructDerivedState(data);
    const once = JSON.stringify({
      tasks: data.task_definitions.map((row) => [row.id, row.currentValue, row.completedAt]),
      sessions: data.hosting_sessions.map((row) => [row.id, row.completedAt]),
      orders: data.orders.map((row) => [row.id, row.completedAt]),
    });
    const second = reconstructDerivedState(data);
    const twice = JSON.stringify({
      tasks: data.task_definitions.map((row) => [row.id, row.currentValue, row.completedAt]),
      sessions: data.hosting_sessions.map((row) => [row.id, row.completedAt]),
      orders: data.orders.map((row) => [row.id, row.completedAt]),
    });
    expect(twice).toBe(once);
    expect(second.sessionsCompleted).toBe(0);
    expect(first.sessionsCompleted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------- S2-R4

describe('S2-R4 批量补建链接与恢复后撤销', () => {
  it('补建的打卡记录在同一事务里带上批次明细引用', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const snapshot = await env.runtime.read((ctx) => ctx.data);
    const items = snapshot.completion_batch_items.filter((row) => row.batchId === batchId);
    const occurrences = snapshot.task_occurrences;
    expect(items).toHaveLength(1);
    expect(items[0].occurrenceId).not.toBeNull();
    expect(occurrences.find((row) => row.id === items[0].occurrenceId)).toBeDefined();
    expect(items[0].occurrenceId).toBe(occurrences[0].id);
    expect(occurrences[0].completionBatchId).toBe(batchId);
    // 新写入的批次必须是规范形状，导出后能被自己的读取路径接受。
    const batch = snapshot.completion_batches.find((row) => row.id === batchId)!;
    expect(batch.targetId).toBe(orderId);
    expect(batch.gameDate).toBe(TODAY);
    await expect(restoreSnapshot(env, await exportSnapshot(env))).resolves.toBeTruthy();
  });

  it('导出→恢复→撤销：补建的打卡记录保持可撤销', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const restoredPreview = await restoreSnapshot(env, await exportSnapshot(env));
    expect(restoredPreview.reconstruction.sessionsCompleted).toBe(0);
    const token = await env.runtime.current();
    const restoredBefore = await env.runtime.read((ctx) => ctx.data);
    const restoredBatch = restoredBefore.completion_batches.find(
      (row) => row.operationId === 'op-batch',
    )!;
    expect(restoredBatch.id).toBe(batchId);

    const result = await env.services.tasks.undoBatch(restoredBatch.id, token);
    expect(result).toEqual({ restored: 1, conflicts: 0 });

    const after = await env.runtime.read((ctx) => ctx.data);
    const undoBatch = after.completion_batches.find((row) => row.id === restoredBatch.id)!;
    expect(undoBatch.undoneAt).not.toBeNull();
    const item = after.completion_batch_items.find((row) => row.batchId === restoredBatch.id)!;
    expect(item.occurrenceId).not.toBeNull();
    const occurrence = after.task_occurrences.find((row) => row.id === item.occurrenceId)!;
    // 撤销回退完成态；打卡记录行保留（批次明细以 RESTRICT 引用它）。
    expect(occurrence.completedAt).toBeNull();
    expect(occurrence.completionBatchId).toBeNull();
    expect(after.task_occurrences).toHaveLength(restoredBefore.task_occurrences.length);
    // 无关数据不变。
    expect(after.orders).toEqual(restoredBefore.orders);
    expect(after.task_definitions).toEqual(
      restoredBefore.task_definitions.map((row) => ({ ...row, completedAt: null, completionBatchId: null })),
    );
    // 再次导出仍然能被读取路径接受（不留悬空引用）。
    await expect(restoreSnapshot(env, await exportSnapshot(env))).resolves.toBeTruthy();
  });

  it('已存在的打卡记录只被更新完成态，撤销后回到原值', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const firstBatch = await env.services.tasks.completeBatch(
      { operationId: 'op-batch-1', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const token = await env.runtime.current();
    await env.services.tasks.undoBatch(firstBatch, token);
    const before = await env.runtime.read((ctx) => ctx.data);
    expect(before.task_occurrences).toHaveLength(1);

    const secondBatch = await env.services.tasks.completeBatch(
      { operationId: 'op-batch-2', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const afterComplete = await env.runtime.read((ctx) => ctx.data);
    // 复用同一行，不新增重复记录。
    expect(afterComplete.task_occurrences).toHaveLength(1);
    const item = afterComplete.completion_batch_items.find((row) => row.batchId === secondBatch)!;
    expect(item.occurrenceId).toBe(before.task_occurrences[0].id);
    expect(item.previousCompletedAt).toBeNull();
    expect(item.appliedCompletedAt).not.toBeNull();
  });

  it('一个批次多个任务时每条明细各自指向自己的打卡记录', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const result = await env.services.orders.create(
      {
        operationId: 'op-order',
        ownerId: ids.ownerId,
        accountId: ids.accountId,
        type: 'HOSTING',
        title: '多任务',
        notes: null,
        paymentMode: 'INSTALLMENTS',
        priceCents: null,
        deadlineDate: null,
        gameZoneId: ZONE,
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        startDate: TODAY,
        endDate: TODAY,
        periodPriceCents: 30000,
        tasks: [CHECKBOX_TASK as never, { ...CHECKBOX_TASK, title: '领取' } as never],
        firstReceipt: null,
        sourceTemplateId: null,
        sourceTemplateName: null,
        sourceTemplateVersion: null,
      },
      env.token,
    );
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: result.orderId, gameDate: TODAY },
      env.token,
    );
    const data = await env.runtime.read((ctx) => ctx.data);
    const items = data.completion_batch_items.filter((row) => row.batchId === batchId);
    expect(items).toHaveLength(2);
    const ids2 = items.map((row) => row.occurrenceId);
    expect(new Set(ids2).size).toBe(2);
    for (const item of items) {
      const occurrence = data.task_occurrences.find((row) => row.id === item.occurrenceId)!;
      expect(occurrence.taskDefinitionId).toBe(item.taskDefinitionId);
      expect(occurrence.completionBatchId).toBe(batchId);
    }
    const token = await env.runtime.current();
    const undo = await env.services.tasks.undoBatch(batchId, token);
    expect(undo).toEqual({ restored: 2, conflicts: 0 });
  });

  it('重复撤销不重复回滚，且不产生冲突', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    await env.services.tasks.undoBatch(batchId, env.token);
    const again = await env.services.tasks.undoBatch(batchId, env.token);
    expect(again).toEqual({ restored: 0, conflicts: 0 });
  });

  it('部分冲突时只报告冲突项，其他项照常回滚', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const result = await env.services.orders.create(
      {
        operationId: 'op-order',
        ownerId: ids.ownerId,
        accountId: ids.accountId,
        type: 'HOSTING',
        title: '多任务',
        notes: null,
        paymentMode: 'INSTALLMENTS',
        priceCents: null,
        deadlineDate: null,
        gameZoneId: ZONE,
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        startDate: TODAY,
        endDate: TODAY,
        periodPriceCents: 30000,
        tasks: [CHECKBOX_TASK as never, { ...CHECKBOX_TASK, title: '领取' } as never],
        firstReceipt: null,
        sourceTemplateId: null,
        sourceTemplateName: null,
        sourceTemplateVersion: null,
      },
      env.token,
    );
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: result.orderId, gameDate: TODAY },
      env.token,
    );
    const token = await env.runtime.current();
    const items = await env.runtime.read((ctx) =>
      ctx.data.completion_batch_items.filter((row) => row.batchId === batchId),
    );
    // 人为制造一个冲突：把第一条打卡记录的完成时刻改掉。
    await env.runtime.write(token, async (ctx) => {
      const occurrence = ctx.data.task_occurrences.find((row) => row.id === items[0].occurrenceId)!;
      await ctx.table('task_occurrences').put({ ...occurrence, completedAt: NOW - 5_000 });
    });
    const undo = await env.services.tasks.undoBatch(batchId, token);
    expect(undo).toEqual({ restored: 1, conflicts: 1 });
  });

  it('明细的任务引用与打卡记录不一致时拒绝恢复', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const snapshot = await exportSnapshot(env);
    snapshot.data.completion_batch_items[0].taskDefinitionId = 'other-task';
    await expect(restoreSnapshot(env, snapshot)).rejects.toThrow(/任务引用/);
  });

  it('唯一可辩护的历史链接被补回；歧义的历史链接被拒绝', async () => {
    const data = emptyDataSet();
    data.orders.push(dateOrderRow('o1'));
    data.hosting_periods.push(periodRow('p1', 'o1'));
    data.task_definitions.push(taskRow('t1', 'o1', 'p1'));
    data.completion_batches.push(batchRow('b1', 'HOSTING_ORDER', 'o1', '2026-02-10'));
    data.completion_batch_items.push(batchItemRow('i1', 'b1', 't1', null));
    data.task_occurrences.push(
      occurrenceRow({
        id: 'oc1',
        taskDefinitionId: 't1',
        occurrenceKey: 'D:2026-02-10',
        completionBatchId: 'b1',
        gameDate: '2026-02-10',
      }),
    );
    normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 });
    expect(data.completion_batch_items[0].occurrenceId).toBe('oc1');

    const ambiguous = emptyDataSet();
    ambiguous.orders.push(dateOrderRow('o1'));
    ambiguous.hosting_periods.push(periodRow('p1', 'o1'));
    ambiguous.task_definitions.push(taskRow('t1', 'o1', 'p1'));
    // HOSTING_ALL 横跨订单，历史游戏日不能用于收窄候选：两条记录都可辩护 → 必须拒绝。
    ambiguous.completion_batches.push(batchRow('b1', 'HOSTING_ALL', 'all', '2026-02-10'));
    ambiguous.completion_batch_items.push(batchItemRow('i1', 'b1', 't1', null));
    ambiguous.task_occurrences.push(
      occurrenceRow({
        id: 'oc1',
        taskDefinitionId: 't1',
        occurrenceKey: 'D:2026-02-10',
        completionBatchId: 'b1',
        gameDate: '2026-02-10',
      }),
      occurrenceRow({
        id: 'oc2',
        taskDefinitionId: 't1',
        occurrenceKey: 'D:2026-02-11',
        completionBatchId: 'b1',
        gameDate: '2026-02-11',
      }),
    );
    expect(() =>
      normalizeDecodedDataset({
        data: ambiguous,
        columnsByTable: {},
        schemaVersion: 12,
      }),
    ).toThrow(/LEGACY_BATCH_LINK_AMBIGUOUS/);
    // 拒绝后数据集保持原样。
    expect(ambiguous.completion_batch_items[0].occurrenceId).toBeNull();
  });

  it('已撤销的历史批次不会为了满足引用而臆造打卡记录', async () => {
    const data = emptyDataSet();
    data.orders.push(dateOrderRow('o1'));
    data.hosting_periods.push(periodRow('p1', 'o1'));
    data.task_definitions.push(taskRow('t1', 'o1', 'p1'));
    data.completion_batches.push({ ...batchRow('b1', 'HOSTING_ORDER', 'o1', '2026-02-10'), undoneAt: NOW + 1 });
    data.completion_batch_items.push(batchItemRow('i1', 'b1', 't1', null));
    normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 });
    expect(data.task_occurrences).toHaveLength(0);
    expect(data.completion_batch_items[0].occurrenceId).toBeNull();
  });
});

// ---------------------------------------------------------------------- S2-R5

describe('S2-R5 历史 HOSTING_ALL 归一', () => {
  it('legacy 哨兵与游戏日被归一为 null/null，并保留其余字段', () => {
    const data = emptyDataSet();
    data.orders.push(dateOrderRow('o1'));
    data.hosting_periods.push(periodRow('p1', 'o1'));
    data.task_definitions.push(taskRow('t1', 'o1', 'p1'));
    data.completion_batches.push({
      ...batchRow('b1', 'HOSTING_ALL', 'all', '2026-02-10'),
      createdAt: NOW - 10,
      operationId: 'op-legacy',
    });
    data.completion_batch_items.push(batchItemRow('i1', 'b1', 't1', null));
    data.task_occurrences.push(
      occurrenceRow({
        id: 'oc1',
        taskDefinitionId: 't1',
        occurrenceKey: 'D:2026-02-10',
        completionBatchId: 'b1',
        gameDate: '2026-02-10',
      }),
    );

    const result = normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 });
    expect(result.report.counts.hostingAllBatchesNormalized).toBe(1);
    const normalized = data.completion_batches[0];
    expect(normalized.targetId).toBeNull();
    expect(normalized.gameDate).toBeNull();
    expect(normalized.id).toBe('b1');
    expect(normalized.operationId).toBe('op-legacy');
    expect(normalized.createdAt).toBe(NOW - 10);
    // 链接修复仍然依赖保留的历史游戏日。
    expect(data.completion_batch_items[0].occurrenceId).toBe('oc1');
  });

  it('多订单不同游戏日的打卡记录各自归属正确', () => {
    const data = emptyDataSet();
    data.orders.push(dateOrderRow('o1'), dateOrderRow('o2'));
    data.hosting_periods.push(periodRow('p1', 'o1'), periodRow('p2', 'o2'));
    data.task_definitions.push(taskRow('t1', 'o1', 'p1'), taskRow('t2', 'o2', 'p2'));
    data.completion_batches.push(batchRow('b1', 'HOSTING_ALL', 'all', '2026-02-10'));
    data.completion_batch_items.push(
      batchItemRow('i1', 'b1', 't1', null),
      batchItemRow('i2', 'b1', 't2', null),
    );
    data.task_occurrences.push(
      occurrenceRow({
        id: 'oc1',
        taskDefinitionId: 't1',
        occurrenceKey: 'D:2026-02-10',
        completionBatchId: 'b1',
        gameDate: '2026-02-10',
      }),
      occurrenceRow({
        id: 'oc2',
        taskDefinitionId: 't2',
        occurrenceKey: 'D:2026-02-11',
        completionBatchId: 'b1',
        gameDate: '2026-02-11',
      }),
    );
    normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 });
    const byId = new Map(data.completion_batch_items.map((row) => [row.id, row.occurrenceId]));
    expect(byId.get('i1')).toBe('oc1');
    expect(byId.get('i2')).toBe('oc2');
  });

  it('未知的 legacy 目标形状被拒绝', () => {
    const data = emptyDataSet();
    data.completion_batches.push(batchRow('b1', 'HOSTING_ALL', 'weird', '2026-02-10'));
    expect(() =>
      normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 }),
    ).toThrow(/UNSUPPORTED_LEGACY_BATCH_SHAPE/);
    expect(data.completion_batches[0].targetId).toBe('weird');
  });

  it('非规范的 schema 15 输入不会被静默改写，而是被校验拒绝', async () => {
    const data = emptyDataSet();
    data.completion_batches.push(batchRow('b1', 'HOSTING_ALL', 'all', '2026-02-10'));
    expect(() =>
      normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 15 }),
    ).not.toThrow();
    expect(data.completion_batches[0].targetId).toBe('all');
    expect(() => validateSnapshot({ data, attachments: new Map() })).toThrow(/HOSTING_ALL/);
  });

  it('新写入的 HOSTING_ALL 批次是规范的 null/null，并能导出→恢复→撤销', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-all', scope: 'HOSTING_ALL', targetId: null, gameDate: null },
      env.token,
    );
    const written = await env.runtime.read((ctx) => ctx.data);
    const batch = written.completion_batches.find((row) => row.id === batchId)!;
    expect(batch.targetId).toBeNull();
    expect(batch.gameDate).toBeNull();
    expect(batch.scope).toBe('HOSTING_ALL');

    await restoreSnapshot(env, await exportSnapshot(env));
    const token = await env.runtime.current();
    const restored = await env.runtime.read((ctx) => ctx.data);
    const restoredBatch = restored.completion_batches.find((row) => row.operationId === 'op-all')!;
    expect(restoredBatch.targetId).toBeNull();
    expect(restoredBatch.gameDate).toBeNull();
    const undo = await env.services.tasks.undoBatch(restoredBatch.id, token);
    expect(undo).toEqual({ restored: 1, conflicts: 0 });
    const after = await env.runtime.read((ctx) => ctx.data);
    const item = after.completion_batch_items.find((row) => row.batchId === restoredBatch.id)!;
    expect(after.task_occurrences.find((row) => row.id === item.occurrenceId)?.completedAt).toBeNull();
    expect(orderId).toBeTruthy();
  });
});

// ------------------------------------------------------------------ 行构造器

function dateOrderRow(id: string): OrderRow {
  return {
    id,
    accountId: 'ac1',
    type: 'HOSTING',
    title: '订单',
    priceCents: null,
    paymentMode: 'INSTALLMENTS',
    deadlineDate: null,
    notes: null,
    gameZoneId: ZONE,
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
    hostingMode: 'DATE_RANGE',
    targetSessions: null,
    orderColor: null,
    monthlyRefreshDays: null,
  };
}

function periodRow(id: string, orderId: string, startDate = '2026-02-10'): HostingPeriodRow {
  return {
    id,
    orderId,
    periodIndex: 0,
    startDate,
    endDate: startDate,
    priceCents: 30000,
    gameZoneId: ZONE,
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: NOW,
    renewalOperationId: null,
    serviceDays: null,
    serviceWeekdays: null,
    monthlyRefreshDays: null,
    serviceCount: null,
  };
}

function taskRow(id: string, orderId: string, periodId: string | null): TaskDefinitionRow {
  return {
    id,
    orderId,
    periodId,
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
  };
}

function batchRow(
  id: string,
  scope: 'HOSTING_ALL' | 'HOSTING_ORDER' | 'SHORT_ORDER',
  targetId: string | null,
  gameDate: string | null,
) {
  return {
    id,
    operationId: `op-${id}`,
    scope,
    targetId,
    gameDate,
    createdAt: NOW,
    undoneAt: null,
  };
}

function batchItemRow(
  id: string,
  batchId: string,
  taskDefinitionId: string | null,
  occurrenceId: string | null,
) {
  return {
    id,
    batchId,
    itemType: 'OCCURRENCE' as const,
    occurrenceId,
    taskDefinitionId,
    previousCompletedAt: null,
    previousRecordedAt: null,
    previousBackfilled: null,
    previousValue: null,
    previousCompletionBatchId: null,
    appliedCompletedAt: NOW,
    appliedRecordedAt: NOW,
    appliedBackfilled: 0,
    appliedValue: null,
    appliedCompletionBatchId: batchId,
  };
}

// ------------------------------------------------------- S2-R6 / S2-R7 行构造器

function shortOrderRow(id: string): OrderRow {
  return {
    ...dateOrderRow(id),
    type: 'SHORT_TASK',
    priceCents: 30000,
    hostingMode: null,
    targetSessions: null,
  };
}

function shortTaskRow(
  id: string,
  orderId: string,
  numeric: boolean,
  target = '20',
): TaskDefinitionRow {
  const base = taskRow(id, orderId, null);
  if (!numeric) return { ...base, title: '普通任务', currentValue: '1' };
  return {
    ...base,
    title: '累计任务',
    progressType: 'NUMERIC',
    startValue: '0',
    targetValue: target,
    currentValue: '0',
    unit: '次',
    numericMode: 'CUMULATIVE',
  };
}

function shortData(tasks: TaskDefinitionRow[]): BackupDataSet {
  const data = baseData();
  data.orders.push(shortOrderRow('o1'));
  data.task_definitions.push(...tasks);
  return data;
}

function byId<T extends { id: string }>(rows: T[], id: string): T {
  const row = rows.find((item) => item.id === id);
  if (!row) throw new Error(`缺少行 ${id}`);
  return row;
}

async function restoreAndRead(env: Env, snapshot: Snapshot) {
  const preview = await restoreSnapshot(env, snapshot);
  const restored = await env.runtime.read((ctx) => ctx.data);
  return { preview, restored };
}

function taskEvent(
  overrides: Partial<TaskProgressEventRow> &
    Pick<TaskProgressEventRow, 'id' | 'taskDefinitionId' | 'operationId' | 'sequence'>,
): TaskProgressEventRow {
  return eventRow({ scopeType: 'TASK', ...overrides });
}

function periodEvent(
  overrides: Partial<TaskProgressEventRow> &
    Pick<TaskProgressEventRow, 'id' | 'taskDefinitionId' | 'operationId' | 'sequence' | 'scopePeriodId'>,
): TaskProgressEventRow {
  return eventRow({ scopeType: 'PERIOD', ...overrides });
}

// ---------------------------------------------------------------------- S2-R6

describe('S2-R6 非轮次累计 scope 的权威重建（产品恢复路径）', () => {
  it('短期单累计任务达标：完成时刻来自事件，而不是文件里的空值', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: NOW + 60_000,
      }),
    );
    byId(data.task_definitions, 't1').currentValue = '999';

    const { preview, restored } = await restoreAndRead(env, { data, attachments: new Map() });
    const task = byId(restored.task_definitions, 't1');
    expect(task.currentValue).toBe('20');
    expect(task.completedAt).toBe(NOW + 60_000);
    expect(byId(restored.orders, 'o1').completedAt).toBe(NOW + 60_000);
    expect(preview.reconstruction.taskCompletionsChanged).toBeGreaterThan(0);
    expect(preview.reconstruction.orderFlagsChanged).toBe(1);
  });

  it('短期单累计任务未达标：陈旧的任务与订单完成时刻都被清除', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '5',
      }),
    );
    byId(data.task_definitions, 't1').completedAt = NOW + 5;
    byId(data.orders, 'o1').completedAt = NOW + 5;

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('5');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(restored.orders, 'o1').completedAt).toBeNull();
  });

  it('零事件的短期单累计任务：陈旧缓存与完成标志一律重置为权威值', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    byId(data.task_definitions, 't1').currentValue = '999';
    byId(data.task_definitions, 't1').completedAt = NOW + 100;
    byId(data.orders, 'o1').completedAt = NOW + 100;

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('0');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(restored.orders, 'o1').completedAt).toBeNull();
  });

  it('撤回唯一有效观测：任务与订单一起重开，事件不被删除', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: NOW + 60_000,
      }),
      taskEvent({
        id: 'e2',
        taskDefinitionId: 't1',
        operationId: 'op-e2',
        sequence: 2,
        kind: 'RETRACT',
        totalValue: null,
        correctsEventId: 'e1',
      }),
    );

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('0');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(restored.orders, 'o1').completedAt).toBeNull();
    expect(restored.task_progress_events).toHaveLength(2);
  });

  it('更正到目标以下：已完成任务重开，快照与事件都保留', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: NOW + 60_000,
      }),
      taskEvent({
        id: 'e2',
        taskDefinitionId: 't1',
        operationId: 'op-e2',
        sequence: 2,
        kind: 'CORRECT',
        totalValue: '5',
        correctsEventId: 'e1',
        recordedAt: NOW + 90_000,
      }),
    );
    byId(data.task_definitions, 't1').completedAt = NOW + 60_000;
    byId(data.orders, 'o1').completedAt = NOW + 60_000;

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('5');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(restored.orders, 'o1').completedAt).toBeNull();
    expect(restored.task_progress_events).toHaveLength(2);
  });

  it('多个短期任务：普通任务的完成历史被保留，累计任务决定订单完成', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true), shortTaskRow('t2', 'o1', false)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: NOW + 60_000,
      }),
    );
    const ordinary = byId(data.task_definitions, 't2');
    ordinary.completedAt = NOW - 1_000;
    ordinary.currentValue = '1';

    const first = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(first.restored.task_definitions, 't2').completedAt).toBe(NOW - 1_000);
    expect(byId(first.restored.orders, 'o1').completedAt).toBe(NOW + 60_000);

    // 撤回累计任务的有效观测：订单重开，普通任务的完成历史不受影响。
    const exported = await exportSnapshot(env);
    exported.data.task_progress_events.push(
      taskEvent({
        id: 'e-undo',
        taskDefinitionId: 't1',
        operationId: 'op-e-undo',
        sequence: 2,
        kind: 'RETRACT',
        totalValue: null,
        correctsEventId: 'e1',
      }),
    );
    const second = await restoreAndRead(env, exported);
    expect(byId(second.restored.task_definitions, 't2').completedAt).toBe(NOW - 1_000);
    expect(byId(second.restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(second.restored.orders, 'o1').completedAt).toBeNull();
  });

  it('按日期托管的累计任务：期次总值按 PERIOD scope 重建，不新建轮次', async () => {
    const env = await freshEnv();
    const data = baseData();
    data.orders.push(dateOrderRow('o1'));
    data.hosting_periods.push(periodRow('p1', 'o1'));
    const task = taskRow('t1', 'o1', 'p1');
    data.task_definitions.push({
      ...task,
      progressType: 'NUMERIC',
      startValue: '0',
      targetValue: '20',
      currentValue: '1',
      unit: '次',
      numericMode: 'CUMULATIVE',
      // 存储规则：托管任务不留任务级完成时刻；文件里的陈旧值必须被清掉。
      completedAt: NOW + 7,
    });
    data.task_progress_events.push(
      periodEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        scopePeriodId: 'p1',
        totalValue: '7',
      }),
    );

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('7');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(restored.hosting_sessions).toHaveLength(0);
  });

  it('按日期托管的累计任务：零事件也把陈旧缓存重置为 startValue，且绝不造轮次', async () => {
    const env = await freshEnv();
    const data = baseData();
    data.orders.push(dateOrderRow('o1'));
    data.hosting_periods.push(periodRow('p1', 'o1'));
    const task = taskRow('t1', 'o1', 'p1');
    data.task_definitions.push({
      ...task,
      progressType: 'NUMERIC',
      startValue: '0',
      targetValue: '20',
      currentValue: '999',
      unit: '次',
      numericMode: 'CUMULATIVE',
      completedAt: NOW + 9,
    });

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('0');
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(restored.hosting_sessions).toHaveLength(0);
  });


  it('非正数的观测时刻不被当成完成证据：总值照算、完成时刻留空', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: 0,
      }),
    );

    const { restored } = await restoreAndRead(env, { data, attachments: new Map() });
    expect(byId(restored.task_definitions, 't1').currentValue).toBe('20');
    // 0 不是可用时刻：绝不写 0（安卓校验要求完成时刻为正数），也不编造恢复时刻。
    expect(byId(restored.task_definitions, 't1').completedAt).toBeNull();
    expect(byId(restored.orders, 'o1').completedAt).toBeNull();
  });

  it('重复恢复：存储证据导出的时间戳保持稳定', async () => {
    const env = await freshEnv();
    const data = shortData([shortTaskRow('t1', 'o1', true)]);
    data.task_progress_events.push(
      taskEvent({
        id: 'e1',
        taskDefinitionId: 't1',
        operationId: 'op-e1',
        sequence: 1,
        totalValue: '20',
        recordedAt: NOW + 60_000,
      }),
    );
    const first = await restoreAndRead(env, { data, attachments: new Map() });
    const firstTask = byId(first.restored.task_definitions, 't1').completedAt;
    const firstOrder = byId(first.restored.orders, 'o1').completedAt;

    const second = await restoreAndRead(env, await exportSnapshot(env));
    expect(byId(second.restored.task_definitions, 't1').completedAt).toBe(firstTask);
    expect(byId(second.restored.orders, 'o1').completedAt).toBe(firstOrder);
    expect(second.preview.reconstruction.taskCompletionsChanged).toBe(0);
    expect(second.preview.reconstruction.orderFlagsChanged).toBe(0);
    expect(second.restored.task_progress_events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------- S2-R7

/**
 * 写一份**历史便携 schema**的归档（manifest 与 data.json 都声明旧版本）。
 *
 * 生产写路径永远写当前 schema，所以历史文件的构造只能在测试里显式完成；这里不做任何
 * 归一，让 `prepareRestore` 走真实的解码 + 归一 + 校验 + 候选库链路。
 */
async function writeLegacyArchive(snapshot: Snapshot, schemaVersion: number): Promise<Blob> {
  const parsed = JSON.parse(encodeData(snapshot.data)) as { schemaVersion: number };
  parsed.schemaVersion = schemaVersion;
  const dataBytes = new TextEncoder().encode(JSON.stringify(parsed));
  const tableCounts: Record<string, number> = {};
  for (const table of BUSINESS_TABLES) tableCounts[table] = snapshot.data[table].length;
  const manifest = {
    format: 'daigan-backup',
    formatVersion: 1,
    schemaVersion,
    exportedAt: NOW,
    generator: 'stage2-repair-test/legacy',
    dataSha256: await sha256Hex(dataBytes),
    tableCounts,
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
  const bytes = await writer.close();
  return new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
}

/** jsdom 的 Blob 没有 arrayBuffer()：统一走 FileReader（与生产读取路径同一机制）。 */
function bytesOfBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('读取归档字节失败'));
    reader.readAsArrayBuffer(blob);
  });
}

async function createHostingOrderInZone(
  env: Env,
  ids: { ownerId: string; accountId: string },
  options: { operationId: string; zone: string; title: string; startDate: string; endDate: string },
): Promise<string> {
  const result = await env.services.orders.create(
    {
      operationId: options.operationId,
      ownerId: ids.ownerId,
      accountId: ids.accountId,
      type: 'HOSTING',
      title: options.title,
      notes: null,
      paymentMode: 'INSTALLMENTS',
      priceCents: null,
      deadlineDate: null,
      gameZoneId: options.zone,
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      startDate: options.startDate,
      endDate: options.endDate,
      periodPriceCents: 30000,
      tasks: [CHECKBOX_TASK as never],
      firstReceipt: null,
      sourceTemplateId: null,
      sourceTemplateName: null,
      sourceTemplateVersion: null,
    },
    env.token,
  );
  return result.orderId;
}

/** 历史（schema 12）数据：一个已撤销批次，明细的目标记录不存在。 */
function legacyUndoneBatchData(options: {
  occurrenceId: string | null;
  undone: boolean;
}): BackupDataSet {
  const data = baseData();
  data.orders.push(dateOrderRow('o1'));
  data.hosting_periods.push(periodRow('p1', 'o1'));
  data.task_definitions.push(taskRow('t1', 'o1', 'p1'));
  data.completion_batches.push({
    ...batchRow('b1', 'HOSTING_ORDER', 'o1', '2026-02-10'),
    createdAt: NOW - 10_000,
    undoneAt: options.undone ? NOW - 5_000 : null,
  });
  data.completion_batch_items.push({
    ...batchItemRow('i1', 'b1', 't1', options.occurrenceId),
    previousCompletedAt: null,
    previousRecordedAt: null,
    previousBackfilled: null,
    previousValue: null,
    previousCompletionBatchId: null,
    appliedCompletedAt: NOW - 10_000,
    appliedRecordedAt: NOW - 10_000,
    appliedBackfilled: 0,
    appliedValue: null,
    appliedCompletionBatchId: 'b1',
  });
  return data;
}

describe('S2-R7 已撤销批次目标的可表达性（CD-01）', () => {
  it('批次补建的打卡记录：导出→恢复→撤销→再导出→再恢复→重复撤销', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const created = await env.runtime.read((ctx) => ctx.data);
    const item = created.completion_batch_items.find((row) => row.batchId === batchId)!;
    expect(item.occurrenceId).not.toBeNull();
    const occurrenceId = item.occurrenceId as string;

    // 导出 → 恢复
    await restoreSnapshot(env, await exportSnapshot(env));
    let token = await env.runtime.current();
    let live = await env.runtime.read((ctx) => ctx.data);
    expect(byId(live.completion_batch_items, item.id).occurrenceId).toBe(occurrenceId);
    expect(byId(live.task_occurrences, occurrenceId).completedAt).not.toBeNull();

    // 撤销：只回退完成态，打卡记录行保留（附件与其它审计引用仍然成立）。
    expect(await env.services.tasks.undoBatch(batchId, token)).toEqual({ restored: 1, conflicts: 0 });
    live = await env.runtime.read((ctx) => ctx.data);
    expect(byId(live.task_occurrences, occurrenceId).completedAt).toBeNull();
    expect(byId(live.completion_batches, batchId).undoneAt).not.toBeNull();

    // 再导出 → 再恢复
    await restoreSnapshot(env, await exportSnapshot(env));
    token = await env.runtime.current();
    live = await env.runtime.read((ctx) => ctx.data);
    expect(byId(live.completion_batches, batchId).undoneAt).not.toBeNull();
    expect(byId(live.completion_batch_items, item.id).occurrenceId).toBe(occurrenceId);
    expect(byId(live.task_occurrences, occurrenceId).completedAt).toBeNull();
    // 受支持的"目标仍存在"历史：审计快照逐列保持（previous/applied 时刻与批次引用）。
    expect(byId(live.completion_batch_items, item.id).previousCompletedAt).toBe(item.previousCompletedAt);
    expect(byId(live.completion_batch_items, item.id).previousCompletionBatchId).toBe(
      item.previousCompletionBatchId,
    );
    expect(byId(live.completion_batch_items, item.id).appliedCompletedAt).toBe(item.appliedCompletedAt);
    expect(byId(live.completion_batch_items, item.id).appliedCompletionBatchId).toBe(batchId);
    expect(byId(live.completion_batch_items, item.id).taskDefinitionId).toBe(item.taskDefinitionId);
    // 重复撤销不再回滚，也不产生冲突。
    expect(await env.services.tasks.undoBatch(batchId, token)).toEqual({ restored: 0, conflicts: 0 });
  });

  it('已存在的打卡记录：撤销回到原值，往返后仍可撤销', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const tasks = await env.runtime.read((ctx) => ctx.data.task_definitions);
    await env.services.tasks.setProgress(
      { taskId: tasks[0].id, gameDate: TODAY, value: null, completed: false, backfilled: false },
      env.token,
    );
    const before = await env.runtime.read((ctx) => ctx.data);
    expect(before.task_occurrences).toHaveLength(1);
    const occurrenceId = before.task_occurrences[0].id;

    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    await restoreSnapshot(env, await exportSnapshot(env));
    const token = await env.runtime.current();
    expect(await env.services.tasks.undoBatch(batchId, token)).toEqual({ restored: 1, conflicts: 0 });
    const restored = await env.runtime.read((ctx) => ctx.data);
    const occurrence = byId(restored.task_occurrences, occurrenceId);
    expect(occurrence.completedAt).toBeNull();
    expect(occurrence.completionBatchId).toBeNull();
    // 撤销后重新导出仍可再次恢复（不能出现悬空引用）。
    await restoreSnapshot(env, await exportSnapshot(env));
    const again = await env.runtime.read((ctx) => ctx.data);
    expect(byId(again.task_occurrences, occurrenceId).completedAt).toBeNull();
  });

  it('HOSTING_ALL：每个订单用自己的游戏日，撤销后逐条回滚', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const shanghai = await createHostingOrderInZone(env, ids, {
      operationId: 'op-sh',
      zone: ZONE,
      title: '上海',
      startDate: '2026-02-08',
      endDate: '2026-02-12',
    });
    const newYork = await createHostingOrderInZone(env, ids, {
      operationId: 'op-ny',
      zone: 'America/New_York',
      title: '纽约',
      startDate: '2026-02-08',
      endDate: '2026-02-12',
    });
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-all', scope: 'HOSTING_ALL', targetId: null, gameDate: null },
      env.token,
    );
    const live = await env.runtime.read((ctx) => ctx.data);
    const items = live.completion_batch_items.filter((row) => row.batchId === batchId);
    expect(items).toHaveLength(2);
    const dates = items.map((row) => byId(live.task_occurrences, row.occurrenceId as string).gameDate);
    expect(dates.sort()).toEqual(
      [gameDateAt(NOW, ZONE, 300), gameDateAt(NOW, 'America/New_York', 300)].sort(),
    );
    expect(new Set(dates).size).toBe(2);
    expect(shanghai).not.toBe(newYork);

    await restoreSnapshot(env, await exportSnapshot(env));
    const token = await env.runtime.current();
    expect(await env.services.tasks.undoBatch(batchId, token)).toEqual({ restored: 2, conflicts: 0 });
    const after = await env.runtime.read((ctx) => ctx.data);
    for (const row of after.completion_batch_items.filter((item) => item.batchId === batchId)) {
      expect(byId(after.task_occurrences, row.occurrenceId as string).completedAt).toBeNull();
    }
  });

  it('受支持的无目标历史：prepare/commit 恢复→导出→再恢复逐列保持，重复撤销不再变更', async () => {
    const env = await freshEnv();
    const data = legacyUndoneBatchData({ occurrenceId: null, undone: true });
    const blob = await writeLegacyArchive({ data, attachments: new Map() }, 12);
    const preview = await env.restore.prepareRestore(blob);
    expect(preview.schemaVersion).toBe(12);
    // 原始为 null 的无目标历史是受支持形态：只计数，不改写。
    expect(preview.migrationCounts.undoneTargetsWithoutReference).toBe(1);
    await env.restore.commitRestore(preview.sessionId, preview.baseToken);

    let live = await env.runtime.read((ctx) => ctx.data);
    const firstItem = byId(live.completion_batch_items, 'i1');
    expect(firstItem.occurrenceId).toBeNull();
    expect(firstItem.taskDefinitionId).toBe('t1');
    expect(firstItem.appliedCompletionBatchId).toBe('b1');
    expect(firstItem.appliedCompletedAt).toBe(NOW - 10_000);
    expect(firstItem.previousCompletedAt).toBeNull();
    expect(byId(live.completion_batches, 'b1').undoneAt).toBe(NOW - 5_000);
    expect(live.task_occurrences).toHaveLength(0);

    // 生产导出路径 → 再恢复：null 目标、任务引用、前后快照与 undoneAt 全部逐列保持。
    await restoreSnapshot(env, await exportSnapshot(env));
    live = await env.runtime.read((ctx) => ctx.data);
    expect(byId(live.completion_batch_items, 'i1')).toEqual(firstItem);
    expect(byId(live.completion_batches, 'b1').undoneAt).toBe(NOW - 5_000);
    expect(live.task_occurrences).toHaveLength(0);

    // 重复撤销：批次已是撤销态，是 no-op，且不产生任何行级变更。
    const token = await env.runtime.current();
    const beforeUndo = await env.runtime.read((ctx) => ctx.data);
    expect(await env.services.tasks.undoBatch('b1', token)).toEqual({ restored: 0, conflicts: 0 });
    expect(await env.runtime.read((ctx) => ctx.data)).toEqual(beforeUndo);
  });

  it('已撤销批次的已知悬空目标被拒绝：诊断保留原 id，输入不被改写', () => {
    const data = legacyUndoneBatchData({
      occurrenceId: 'deleted-occurrence-original-123',
      undone: true,
    });
    const itemsBefore = JSON.stringify(data.completion_batch_items);
    let thrown: unknown;
    try {
      normalizeDecodedDataset({ data, columnsByTable: {}, schemaVersion: 12 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NormalizationError);
    const diagnostics = (thrown as NormalizationError).diagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('UNDONE_BATCH_TARGET_DANGLING');
    expect(diagnostics[0].objects).toMatchObject({
      itemId: 'i1',
      batchId: 'b1',
      originalOccurrenceId: 'deleted-occurrence-original-123',
      taskDefinitionId: 't1',
    });
    expect(diagnostics[0].reason).toContain('deleted-occurrence-original-123');
    // 原 id 不被清空、不臆造打卡记录、不删除明细。
    expect(JSON.stringify(data.completion_batch_items)).toBe(itemsBefore);
    expect(data.completion_batch_items[0].occurrenceId).toBe('deleted-occurrence-original-123');
    expect(data.task_occurrences).toHaveLength(0);
  });

  it('已知悬空目标在 prepareRestore 提交前被拒绝：当前数据集、归档字节与候选状态不变', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    await createDateOrder(env, ids, 'op-order');
    const beforeToken = await env.runtime.current();
    const beforeData = await env.runtime.read((ctx) => ctx.data);
    const data = legacyUndoneBatchData({
      occurrenceId: 'deleted-occurrence-original-123',
      undone: true,
    });
    const blob = await writeLegacyArchive({ data, attachments: new Map() }, 12);
    const bytesBefore = await sha256Hex(await bytesOfBlob(blob));

    await expect(env.restore.prepareRestore(blob)).rejects.toThrow(
      /UNDONE_BATCH_TARGET_DANGLING/,
    );
    await expect(env.restore.prepareRestore(blob)).rejects.toThrow(
      /deleted-occurrence-original-123/,
    );

    // 归档字节未被就地修改。
    expect(await sha256Hex(await bytesOfBlob(blob))).toBe(bytesBefore);
    // 当前数据集（token + 行）不变，也没有残留的预览会话或候选库。
    const afterToken = await env.runtime.current();
    expect(afterToken.databaseName).toBe(beforeToken.databaseName);
    expect(afterToken.generation).toBe(beforeToken.generation);
    expect(await env.runtime.read((ctx) => ctx.data)).toEqual(beforeData);
    expect(await controlDb().sessions.count()).toBe(0);
    const names = await Dexie.getDatabaseNames();
    expect(names.filter((name) => name.startsWith('daigan-data-'))).toHaveLength(1);
  });

  it('未撤销批次的悬空目标在激活前被拒绝，当前数据集不变', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    void ids;
    const beforeToken = await env.runtime.current();
    const before = await env.runtime.read((ctx) => ctx.data);
    const data = legacyUndoneBatchData({ occurrenceId: 'oc-gone', undone: false });
    const blob = await writeLegacyArchive({ data, attachments: new Map() }, 12);
    await expect(env.restore.prepareRestore(blob)).rejects.toThrow(/BATCH_TARGET_DANGLING/);
    const afterToken = await env.runtime.current();
    expect(afterToken.databaseName).toBe(beforeToken.databaseName);
    expect(afterToken.generation).toBe(beforeToken.generation);
    expect(await env.runtime.read((ctx) => ctx.data)).toEqual(before);
  });

  it('附件与批次审计引用在撤销与往返后保持完整', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const snapshot = await exportSnapshot(env);
    const item = snapshot.data.completion_batch_items.find((row) => row.batchId === batchId)!;
    const occurrenceId = item.occurrenceId as string;
    // 截图挂在批次补建的打卡记录上：撤销不能让这条引用失效（RESTRICT 引用的行必须留下）。
    snapshot.data.attachments.push({
      id: 'at1',
      taskDefinitionId: null,
      occurrenceId,
      relativePath: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      createdAt: NOW,
    });
    snapshot.attachments.set(
      'at1',
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
    );

    await restoreSnapshot(env, snapshot);
    const restoredToken = await env.runtime.current();
    expect(await env.services.tasks.undoBatch(batchId, restoredToken)).toEqual({
      restored: 1,
      conflicts: 0,
    });
    const final = await env.runtime.read(async (ctx) => ({
      data: ctx.data,
      blob: await ctx.db.attachmentBlobs.get('at1'),
    }));
    expect(byId(final.data.attachments, 'at1').occurrenceId).toBe(occurrenceId);
    expect(final.blob).toBeTruthy();
    // 打卡记录行必须保留（附件与批次明细都以它为目标），只回退完成态。
    expect(byId(final.data.task_occurrences, occurrenceId).completedAt).toBeNull();
    expect(byId(final.data.task_occurrences, occurrenceId).completionBatchId).toBeNull();
    expect(byId(final.data.completion_batch_items, item.id).occurrenceId).toBe(occurrenceId);
    // 撤销后的数据集必须仍能通过严格校验：附件 XOR、附件字节数与引用都在校验范围内。
    const bytes = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    expect(() =>
      validateSnapshot({ data: final.data, attachments: new Map([['at1', bytes]]) }),
    ).not.toThrow();
  });

  it('部分冲突后仍可导出并再次恢复（表示保持稳定）', async () => {
    const env = await freshEnv();
    const ids = await seedOwnerAndAccount(env);
    const orderId = await createDateOrder(env, ids, 'op-order');
    const batchId = await env.services.tasks.completeBatch(
      { operationId: 'op-batch', scope: 'HOSTING_ORDER', targetId: orderId, gameDate: TODAY },
      env.token,
    );
    const token = await env.runtime.current();
    const live = await env.runtime.read((ctx) => ctx.data);
    const item = live.completion_batch_items.find((row) => row.batchId === batchId)!;
    await env.runtime.write(token, async (ctx) => {
      const occurrence = byId(ctx.data.task_occurrences, item.occurrenceId as string);
      await ctx.table('task_occurrences').put({ ...occurrence, completedAt: NOW - 7_000 });
    });
    // 冲突项不回滚，但批次仍被标记为已撤销：表示必须仍然可导出、可再次恢复。
    expect(await env.services.tasks.undoBatch(batchId, token)).toEqual({ restored: 0, conflicts: 1 });
    await restoreSnapshot(env, await exportSnapshot(env));
    const after = await env.runtime.read((ctx) => ctx.data);
    expect(byId(after.completion_batches, batchId).undoneAt).not.toBeNull();
    expect(byId(after.completion_batch_items, item.id).occurrenceId).toBe(item.occurrenceId);
  });
});

import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type {
  CreateOrderCommand,
  TemplateTaskDraft,
  TodayTaskItem,
} from '../../src/application/contracts';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { validateSnapshot } from '../../src/backup/validateSnapshot';
import { isSingleShotTask, onceSlotFor, slotFor } from '../../src/domain/occurrences';
import type { HostingPeriodRow, TaskDefinitionRow } from '../../src/contracts/tables';

/**
 * 2026-10-30 用户反馈：托管单的任务也要能选「一次性」。
 *
 * 语义（已确认）：本期只做一次，哪天打卡都算；完成后从今日事项消失，
 * 不算每日应做、也不拖累轮次/整单完成。
 */

/** 上海 2026-02-10 12:00（每日 05:00 刷新 → 游戏日 2026-02-10）。 */
const NOW = Date.UTC(2026, 1, 10, 4, 0);

function makeEnv() {
  let counter = 0;
  const newId = () => `h-${++counter}`;
  let clock = NOW;
  const runtime = new DatasetRuntime({ newId, now: () => clock });
  const services = createServices(runtime, () => clock, newId);
  return {
    runtime,
    services,
    newId,
    setClock(value: number) {
      clock = value;
    },
  };
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
  await env.services.templates.ensureBuiltIns();
  return { ...env, token };
}

const CHECKBOX_DAILY: TemplateTaskDraft = {
  title: '每日签到',
  progressType: 'CHECKBOX',
  startValue: '0',
  targetValue: '1',
  unit: null,
  recurrence: 'DAILY',
  weekdays: null,
  everyNDays: null,
  monthDay: null,
};

const CHECKBOX_ONCE: TemplateTaskDraft = {
  ...CHECKBOX_DAILY,
  title: '改名一次',
  recurrence: 'ONE_TIME',
};

async function seedOrder(
  env: Awaited<ReturnType<typeof freshEnv>>,
  tasks: TemplateTaskDraft[],
  overrides: Partial<CreateOrderCommand> = {},
) {
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
  const command: CreateOrderCommand = {
    operationId: 'op-once-1',
    ownerId,
    accountId,
    type: 'HOSTING',
    title: '二月托管',
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
    tasks,
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
  const result = await env.services.orders.create(command, env.token);
  return result.orderId;
}

function onceItemOf(items: TodayTaskItem[]) {
  return items.find((item) => item.title === '改名一次');
}

describe('托管单「一次性」任务：领域规则', () => {
  const period: HostingPeriodRow = {
    id: 'p1',
    orderId: 'o1',
    periodIndex: 0,
    startDate: '2026-02-01',
    endDate: '2026-02-28',
    priceCents: 30000,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: 0,
    renewalOperationId: null,
    serviceDays: null,
    serviceWeekdays: null,
    monthlyRefreshDays: null,
    serviceCount: null,
  };

  function task(overrides: Partial<TaskDefinitionRow>): TaskDefinitionRow {
    return {
      id: 't1',
      orderId: 'o1',
      periodId: 'p1',
      title: '任务',
      progressType: 'CHECKBOX',
      startValue: '0',
      targetValue: '1',
      currentValue: '0',
      unit: null,
      numericMode: null,
      recurrence: 'ONE_TIME',
      weekdays: null,
      everyNDays: null,
      monthDay: null,
      monthDays: null,
      activeFrom: null,
      activeUntil: null,
      retiredAt: null,
      completedAt: null,
      completionBatchId: null,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      colorArgb: null,
      ...overrides,
    };
  }

  it('普通一次性任务在托管期内任意一天都有 `O:<date>` 槽', () => {
    expect(isSingleShotTask(task({}))).toBe(true);
    const slot = slotFor(task({}), period, '2026-02-11');
    expect(slot).toMatchObject({ key: 'O:2026-02-11', gameDate: '2026-02-11' });
    // 期次外没有槽。
    expect(slotFor(task({}), period, '2026-03-01')).toBeNull();
  });

  it('累计口径的一次性任务仍由事件链判定，不给打卡槽', () => {
    const cumulative = task({
      progressType: 'NUMERIC',
      numericMode: 'CUMULATIVE',
      startValue: '0',
      targetValue: '3',
    });
    expect(isSingleShotTask(cumulative)).toBe(false);
    expect(slotFor(cumulative, period, '2026-02-11')).toBeNull();
  });

  it('生效起止日期与服务星期同样约束一次性任务', () => {
    const restricted = task({ activeFrom: '2026-02-10', activeUntil: '2026-02-12' });
    expect(onceSlotFor(restricted, period, '2026-02-09')).toBeNull();
    expect(onceSlotFor(restricted, period, '2026-02-10')).not.toBeNull();
    expect(onceSlotFor(restricted, period, '2026-02-13')).toBeNull();

    // 仅工作日托管（周一至周五）：周六不给槽。
    const weekdayPeriod: HostingPeriodRow = {
      ...period,
      serviceDays: 20,
      serviceWeekdays: '1,2,3,4,5',
    };
    expect(onceSlotFor(task({}), weekdayPeriod, '2026-02-14')).toBeNull();
    expect(onceSlotFor(task({}), weekdayPeriod, '2026-02-13')).not.toBeNull();
  });
});

describe('托管单「一次性」任务：按日期托管', () => {
  it('建单即出现在今日事项；打一次卡后消失，日历只留那一天', async () => {
    const env = await freshEnv();
    const orderId = await seedOrder(env, [CHECKBOX_DAILY, CHECKBOX_ONCE]);

    const first = await env.services.queries.today({});
    const item = onceItemOf(first.hosting);
    expect(item).toMatchObject({ singleShot: true, completed: false, gameDate: '2026-02-10' });
    // 不属于"本周期任务"折叠组，也不额外铺每日打卡行。
    expect(first.periodic).toHaveLength(0);
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const onceTask = detail.tasks.find((row) => row.title === '改名一次')!;
    expect(detail.calendar.every((day) => day.tasks.every((t) => t.taskId !== onceTask.id))).toBe(
      true,
    );

    await env.services.tasks.setProgress(
      {
        taskId: onceTask.id,
        gameDate: '2026-02-10',
        value: '1',
        completed: true,
        backfilled: false,
      },
      env.token,
    );

    const after = await env.services.queries.today({});
    expect(onceItemOf(after.hosting)).toBeUndefined();
    // 每日任务不受影响。
    expect(after.hosting.map((row) => row.title)).toEqual(['每日签到']);

    const calendarDays = (await env.services.queries.orderDetail(orderId))!.calendar
      .filter((day) => day.tasks.some((t) => t.taskId === onceTask.id))
      .map((day) => day.gameDate);
    expect(calendarDays).toEqual(['2026-02-10']);
  });

  it('哪天打卡都算：换一天再打会被拒绝，撤销后可以重新出现', async () => {
    const env = await freshEnv();
    const orderId = await seedOrder(env, [CHECKBOX_ONCE]);
    const onceTask = (await env.services.queries.orderDetail(orderId))!.tasks[0];

    await env.services.tasks.setProgress(
      { taskId: onceTask.id, gameDate: '2026-02-08', value: '1', completed: true, backfilled: true },
      env.token,
    );
    await expect(
      env.services.tasks.setProgress(
        {
          taskId: onceTask.id,
          gameDate: '2026-02-10',
          value: '1',
          completed: true,
          backfilled: false,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 撤销落在同一条行上：任务重新回到今日事项。
    await env.services.tasks.setProgress(
      { taskId: onceTask.id, gameDate: '2026-02-08', value: null, completed: false, backfilled: false },
      env.token,
    );
    const reopened = await env.services.queries.today({});
    expect(onceItemOf(reopened.hosting)).toMatchObject({ completed: false });
  });

  it('「整单完成」不会顺带勾掉一次性任务，并给出理由', async () => {
    const env = await freshEnv();
    const orderId = await seedOrder(env, [CHECKBOX_DAILY, CHECKBOX_ONCE]);

    const result = await env.services.tasks.completeBatchDetailed(
      {
        operationId: 'op-batch-order',
        scope: 'HOSTING_ORDER',
        targetId: orderId,
        gameDate: '2026-02-10',
      },
      env.token,
    );
    expect(result.batchId).not.toBeNull();
    expect(result.skipped.map((row) => row.title)).toEqual(['改名一次']);
    const today = await env.services.queries.today({});
    expect(onceItemOf(today.hosting)).toMatchObject({ completed: false });
  });

  it('导出快照能通过网页自己的校验（`O:` 键 + 托管一次性任务）', async () => {
    const env = await freshEnv();
    const orderId = await seedOrder(env, [CHECKBOX_ONCE]);
    const onceTask = (await env.services.queries.orderDetail(orderId))!.tasks[0];
    await env.services.tasks.setProgress(
      { taskId: onceTask.id, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );

    const snapshot = await env.services.exportSnapshot();
    const rows = snapshot.data.task_occurrences.filter(
      (row) => row.taskDefinitionId === onceTask.id,
    );
    expect(rows.map((row) => row.occurrenceKey)).toEqual(['O:2026-02-10']);
    expect(() => validateSnapshot(snapshot)).not.toThrow();
  });
});

describe('托管单「一次性」任务：按次数托管', () => {
  it('一次性任务独立于轮次：出现在今日事项、完成不建轮次行，整单完成也不动它', async () => {
    const env = await freshEnv();
    const orderId = await seedOrder(env, [CHECKBOX_DAILY, CHECKBOX_ONCE], {
      operationId: 'op-once-count',
      serviceCount: 3,
      startDate: null,
      endDate: null,
    });

    const first = await env.services.queries.today({});
    const item = onceItemOf(first.hosting);
    expect(item).toMatchObject({ singleShot: true, sessionId: null, sessionIndex: null });

    await env.services.tasks.setProgress(
      {
        taskId: item!.taskId,
        gameDate: '2026-02-10',
        value: '1',
        completed: true,
        backfilled: false,
      },
      env.token,
    );

    // 没有为一次性任务建轮次行；未完成的每日任务仍在。
    const detail = (await env.services.queries.orderDetail(orderId))!;
    expect(detail.rounds).toHaveLength(0);
    const after = await env.services.queries.today({});
    expect(onceItemOf(after.hosting)).toBeUndefined();
    expect(after.hosting.map((row) => row.title)).toEqual(['每日签到']);

    // 整单完成只处理本轮应做的每日任务。
    const batch = await env.services.tasks.completeBatchDetailed(
      {
        operationId: 'op-batch-count',
        scope: 'HOSTING_ORDER',
        targetId: orderId,
        gameDate: '2026-02-10',
      },
      env.token,
    );
    expect(batch.batchId).not.toBeNull();
    expect(batch.skipped.map((row) => row.title)).not.toContain('改名一次');
  });
});

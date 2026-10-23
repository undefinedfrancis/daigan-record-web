import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type {
  CreateOrderCommand,
  TemplateDraft,
  TemplateTaskDraft,
} from '../../src/application/contracts';
import type { BackupDataSet } from '../../src/contracts/tables';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { reconstructDerivedState } from '../../src/domain/derivedState';
import { applyTemplateTitle, editedTitle } from '../../src/domain/templateTitle';
import { clearPendingOperation, cumulativeOperationPayload, operationIdFor } from '../../src/features/orders/pendingOperations';
import type { ProgressScope } from '../../src/domain/progressEvents';

/**
 * Stage 4（网页端 UF-036 / UF-037 / UF-038 与计次轮次）。
 *
 * 全部用例使用**隔离的合成数据集**（每次新建 `daigan-data-*` 库）与可控时钟，
 * 覆盖跨日刷新、同日两轮、历史更正、退休任务恢复、事务守卫与"增量 == 重建"。
 */

const DAY_MS = 86_400_000;
const ZONE = 'Asia/Shanghai';
const REFRESH = 300;
/** 上海 2026-03-10 12:00 → 游戏日 2026-03-10。 */
const START = Date.UTC(2026, 2, 10, 4, 0);
const DAY1 = '2026-03-10';
const DAY2 = '2026-03-11';

let clock = START;
let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `s4-${idCounter}`;
}

async function freshEnv() {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-') || name === 'daigan-control') {
      await Dexie.delete(name);
    }
  }
  resetControlDb();
  clock = START;
  idCounter = 0;
  const runtime = new DatasetRuntime({ newId, now: () => clock });
  const services = createServices(runtime, () => clock, newId);
  await runtime.init();
  const token = await runtime.current();
  await services.templates.ensureBuiltIns();
  return {
    runtime,
    services,
    token,
    nextDay() {
      clock += DAY_MS;
    },
    at(epoch: number) {
      clock = epoch;
    },
  };
}

type Env = Awaited<ReturnType<typeof freshEnv>>;

async function seedAccount(env: Env, nickname = '老板甲', uid = '1001') {
  const ownerId = await env.services.accounts.saveOwner({ nickname }, env.token);
  const accountId = await env.services.accounts.saveAccount(
    {
      ownerId,
      gameName: '原神',
      server: '官服',
      uid,
      loginAccount: `acc-${uid}`,
      loginMethod: 'PASSWORD',
      password: 'secret',
    },
    env.token,
  );
  return { ownerId, accountId };
}

function checkbox(title: string): TemplateTaskDraft {
  return {
    title,
    progressType: 'CHECKBOX',
    startValue: '0',
    targetValue: '1',
    unit: null,
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    monthDay: null,
  };
}

function cumulative(title: string, target = '100'): TemplateTaskDraft {
  return {
    title,
    progressType: 'NUMERIC',
    startValue: '0',
    targetValue: target,
    unit: '次',
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    monthDay: null,
    numericMode: 'CUMULATIVE',
  };
}

function orderCommand(
  ids: { ownerId: string; accountId: string },
  overrides: Partial<CreateOrderCommand> = {},
): CreateOrderCommand {
  return {
    operationId: `op-${Math.random().toString(36).slice(2, 9)}`,
    ownerId: ids.ownerId,
    accountId: ids.accountId,
    type: 'HOSTING',
    title: '打卡托管',
    notes: null,
    paymentMode: 'INSTALLMENTS',
    priceCents: null,
    deadlineDate: null,
    gameZoneId: ZONE,
    dailyRefreshMinutes: REFRESH,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    startDate: null,
    endDate: null,
    periodPriceCents: 30000,
    serviceCount: 2,
    tasks: [checkbox('每日签到')],
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
}

async function countOrder(
  env: Env,
  tasks: TemplateTaskDraft[],
  serviceCount = 2,
): Promise<{ orderId: string; periodId: string }> {
  const ids = await seedAccount(env);
  const result = await env.services.orders.create(
    orderCommand(ids, { serviceCount, tasks }),
    env.token,
  );
  const detail = await env.services.queries.orderDetail(result.orderId);
  return { orderId: result.orderId, periodId: detail!.periods[0].id };
}

async function dateOrder(
  env: Env,
  tasks: TemplateTaskDraft[],
  startDate = DAY1,
  endDate = DAY2,
): Promise<{ orderId: string; periodId: string }> {
  const ids = await seedAccount(env, '老板乙', '2002');
  const result = await env.services.orders.create(
    orderCommand(ids, {
      serviceCount: null,
      startDate,
      endDate,
      periodPriceCents: 20000,
      tasks,
    }),
    env.token,
  );
  const detail = await env.services.queries.orderDetail(result.orderId);
  return { orderId: result.orderId, periodId: detail!.periods[0].id };
}

async function readData(env: Env): Promise<BackupDataSet> {
  return env.runtime.read((ctx) => ctx.data);
}

describe('UF-038 累计总值：跨日、同日两轮与懒建轮次', () => {
  it('读操作不建轮次行；10 → 15 仍是 15，跨日刷新不重置', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡'), checkbox('签到')], 2);

    let today = await env.services.queries.today({});
    const item = today.hosting.find((row) => row.orderId === orderId && row.cumulative)!;
    expect(item.sessionIndex).toBe(1);
    expect(item.awaitingSession).toBe(true);
    expect(item.currentValue).toBe('0');
    let data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(0);

    await env.services.progress.submit(
      {
        taskId: item.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-cum-1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    today = await env.services.queries.today({});
    expect(today.hosting.find((row) => row.taskId === item.taskId)!.currentValue).toBe('10');
    data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(1);

    env.nextDay();
    today = await env.services.queries.today({});
    expect(today.gameDate).toBe(DAY2);
    const day2Item = today.hosting.find((row) => row.taskId === item.taskId)!;
    // 同一轮次跨日继续，值不重置。
    expect(day2Item.currentValue).toBe('10');
    expect(day2Item.sessionIndex).toBe(1);

    await env.services.progress.submit(
      {
        taskId: item.taskId,
        totalValue: '15',
        gameDate: DAY2,
        operationId: 'op-cum-2',
        scope: { kind: 'SESSION', sessionId: day2Item.sessionId! },
      },
      env.token,
    );
    const { total } = await env.services.progress.currentTotal({
      taskId: item.taskId,
      scope: { kind: 'SESSION', sessionId: day2Item.sessionId! },
    });
    expect(total).toBe('15');
    data = await readData(env);
    expect(data.task_progress_events).toHaveLength(2);
  });

  it('同一游戏日两轮互不干扰：第 2 轮从起始值开始', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡', '10'), checkbox('签到')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const check = detail!.tasks.find((task) => task.progressType === 'CHECKBOX')!;

    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-round1-cum',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    let data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(1);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();

    // 同日再打卡：新的第 2 轮，不复用已完成的轮次。
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(2);
    expect(data.hosting_sessions.map((row) => row.sessionIndex).sort()).toEqual([1, 2]);
    const round2 = data.hosting_sessions.find((row) => row.sessionIndex === 2)!;
    expect(round2.completedAt).toBeNull();
    const round2Occurrences = data.task_occurrences.filter(
      (row) => row.occurrenceKey === 'N:2',
    );
    expect(round2Occurrences).toHaveLength(1);
    // 第 2 轮的累计值从 startValue 开始，不继承第 1 轮。
    const today = await env.services.queries.today({});
    const cumItem = today.hosting.find((row) => row.taskId === cum.taskId)!;
    expect(cumItem.sessionIndex).toBe(2);
    expect(cumItem.currentValue).toBe('0');
  });

  it('相同 operationId 重试只写一次；载荷不同则拒绝', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const command = {
      taskId: cum.taskId,
      totalValue: '10',
      gameDate: DAY1,
      operationId: 'op-idem',
      scope: { kind: 'SESSION' } as const,
    };
    const first = await env.services.progress.submit(command, env.token);
    const second = await env.services.progress.submit(command, env.token);
    expect(second.alreadyApplied).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect((await readData(env)).task_progress_events).toHaveLength(1);

    await expect(
      env.services.progress.submit({ ...command, totalValue: '11' }, env.token),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('UF-038 更正、撤销与历史真值', () => {
  it('更正较早日期不覆盖更晚的总值；asOf 使用更正后真值；被取代事件不可再更正', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 3);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];

    const day1 = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '40',
        gameDate: DAY1,
        operationId: 'op-d1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const sessionId = (day1.scope as { sessionId: string }).sessionId;
    env.nextDay();
    const day2 = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '60',
        gameDate: DAY2,
        operationId: 'op-d2',
        scope: { kind: 'SESSION', sessionId },
      },
      env.token,
    );

    const corrected = await env.services.progress.correct(
      {
        operationId: 'op-c1',
        correctsEventId: day1.eventId,
        kind: 'CORRECT',
        totalValue: '80',
        gameDate: DAY1,
        scope: { kind: 'SESSION', sessionId },
      },
      env.token,
    );
    expect(corrected.currentTotal).toBe('60');
    const asOf = await env.services.progress.totalAsOf({
      taskId: cum.taskId,
      scope: { kind: 'SESSION', sessionId },
      asOfGameDate: DAY1,
    });
    expect(asOf.total).toBe('80');
    const now = await env.services.progress.currentTotal({
      taskId: cum.taskId,
      scope: { kind: 'SESSION', sessionId },
    });
    expect(now.total).toBe('60');

    // 被更正过的事件不能再被更正（单后继）。
    await expect(
      env.services.progress.correct(
        {
          operationId: 'op-c2',
          correctsEventId: day1.eventId,
          kind: 'CORRECT',
          totalValue: '90',
          gameDate: DAY1,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'SUPERSEDED_EVENT' });

    // 撤回更晚的观测后，回落到更正后的日 1 真值。
    const retracted = await env.services.progress.correct(
      {
        operationId: 'op-r1',
        correctsEventId: day2.eventId,
        kind: 'RETRACT',
        totalValue: null,
        gameDate: DAY2,
      },
      env.token,
    );
    expect(retracted.currentTotal).toBe('80');
    // 更正不得改归属日期。
    await expect(
      env.services.progress.correct(
        {
          operationId: 'op-c3',
          correctsEventId: corrected.eventId,
          kind: 'CORRECT',
          totalValue: '99',
          gameDate: DAY2,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('降低/撤回达标值会重开轮次与订单', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡', '50')], 1);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const submitted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '50',
        gameDate: DAY1,
        operationId: 'op-reach',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    let data = await readData(env);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();
    expect(data.orders[0].completedAt).not.toBeNull();

    await env.services.progress.correct(
      {
        operationId: 'op-lower',
        correctsEventId: submitted.eventId,
        kind: 'CORRECT',
        totalValue: '30',
        gameDate: DAY1,
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    data = await readData(env);
    expect(data.hosting_sessions[0].completedAt).toBeNull();
    expect(data.orders[0].completedAt).toBeNull();
    const detailAfter = await env.services.queries.orderDetail(orderId);
    expect(detailAfter!.cumulative[0].completed).toBe(false);
    expect(detailAfter!.cumulative[0].reachedTarget).toBe(false);
  });
});

describe('UF-038 scope 矩阵、日期与服务窗口守卫', () => {
  it('每种订单模式只允许一种 scope', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrder(env, [cumulative('抽卡')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY1,
          operationId: 'op-wrong-scope',
          scope: { kind: 'PERIOD', periodId },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });

    const dateEnv = await freshEnv();
    const dated = await dateOrder(dateEnv, [cumulative('抽卡')]);
    const datedDetail = await dateEnv.services.queries.orderDetail(dated.orderId);
    const datedCum = datedDetail!.cumulative[0];
    expect(datedDetail!.cumulative[0].scope).toEqual({
      kind: 'PERIOD',
      periodId: dated.periodId,
    });
    await expect(
      dateEnv.services.progress.submit(
        {
          taskId: datedCum.taskId,
          totalValue: '10',
          gameDate: DAY1,
          operationId: 'op-wrong-scope-2',
          scope: { kind: 'SESSION' },
        },
        dateEnv.token,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
  });

  it('未来日期、服务起点之前与退休/归档/作废都被拒绝', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrder(env, [cumulative('抽卡')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];

    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: '2026-03-20',
          operationId: 'op-future',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 期次服务起点之前（同一订单的期次被同日续期推到明天时仍以创建日为准）。
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: '2026-03-09',
          operationId: 'op-before',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_RANGE' });

    await env.services.orders.cancel(orderId, env.token);
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY1,
          operationId: 'op-cancelled',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
    void periodId;
  });

  it('恢复替换后的旧表单提交被 STALE_DATASET 拒绝', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const staleToken = env.token;
    // 模拟"恢复替换了数据集"：活动指针切到一个新库，旧 token 的代际不再匹配。
    await env.runtime.createEmptyDataset();
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY1,
          operationId: 'op-stale',
          scope: { kind: 'SESSION' },
        },
        staleToken,
      ),
    ).rejects.toMatchObject({ code: 'STALE_DATASET' });
  });
});

describe('计次轮次：期次目标、同日续期与 ensure 重放', () => {
  it('续期后 orders.targetSessions 只镜像最新计次期次', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrder(env, [checkbox('签到')], 1);
    await env.services.orders.renew(
      { operationId: 'op-renew', orderId, durationDays: 3, priceCents: 20000 },
      env.token,
    );
    const data = await readData(env);
    const order = data.orders.find((row) => row.id === orderId)!;
    expect(order.targetSessions).toBe(3);
    const periods = data.hosting_periods
      .filter((row) => row.orderId === orderId)
      .sort((left, right) => left.periodIndex - right.periodIndex);
    expect(periods.map((row) => row.serviceCount)).toEqual([1, 3]);
    expect(periods[0].id).toBe(periodId);
  });

  it('同日续期：锚点被推到明天，但续期当天仍可写累计总值', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡', '10')], 1);
    const first = await env.services.queries.orderDetail(orderId);
    const cum = first!.cumulative[0];
    // 该期次只有一个累计任务：达标即完成本轮（空轮次不自动完成，达标仍需一次观测）。
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-p1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const dataAfterFirst = await readData(env);
    expect(dataAfterFirst.hosting_sessions[0].completedAt).not.toBeNull();

    await env.services.orders.renew(
      { operationId: 'op-renew-same-day', orderId, durationDays: 2, priceCents: 10000 },
      env.token,
    );
    // 模拟安卓的同日续期：唯一约束把存储锚点推到次日。
    const token = env.token;
    await env.runtime.write(token, async (ctx) => {
      const renewed = ctx.data.hosting_periods
        .filter((row) => row.orderId === orderId)
        .sort((left, right) => right.periodIndex - left.periodIndex)[0];
      await ctx
        .table('hosting_periods')
        .put({ ...renewed, startDate: DAY2, endDate: DAY2 });
    });

    const today = await env.services.queries.today({});
    const item = today.hosting.find((row) => row.orderId === orderId)!;
    const detail = await env.services.queries.orderDetail(orderId);
    const renewedTask = detail!.cumulative.find((task) => task.taskId === item.taskId)!;
    expect(renewedTask.scope).toBeNull();
    expect(item.sessionIndex).toBe(2);
    // 续期当天（游戏日 DAY1）写入必须被接受：下界取 createdAt 的游戏日。
    await expect(
      env.services.progress.submit(
        {
          taskId: renewedTask.taskId,
          totalValue: '5',
          gameDate: DAY1,
          operationId: 'op-renewed-day1',
          scope: { kind: 'SESSION' },
        },
        token,
      ),
    ).resolves.toMatchObject({ currentTotal: '5' });
    // 续期的新 scope 从起始值重新开始。
    expect(item.currentValue).toBe('0');
  });

  it('ensure 重放在订单完成后仍返回原轮次，但保留归档守卫', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrder(env, [checkbox('签到')], 1);
    const first = await env.services.progress.ensureSession(
      { orderId, periodId },
      env.token,
    );
    expect(first.created).toBe(true);
    await env.services.tasks.setProgress(
      { taskId: (await readData(env)).task_definitions[0].id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    let data = await readData(env);
    expect(data.orders[0].completedAt).not.toBeNull();

    const replay = await env.services.progress.ensureSession(
      { orderId, periodId, requestedSessionIndex: first.sessionIndex },
      env.token,
    );
    expect(replay.created).toBe(false);
    expect(replay.sessionId).toBe(first.sessionId);

    await expect(
      env.services.progress.ensureSession({ orderId, periodId }, env.token),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await env.runtime.write(env.token, async (ctx) => {
      const order = ctx.data.orders.find((row) => row.id === orderId)!;
      await ctx.table('orders').put({ ...order, archivedAt: Date.now() });
    });
    await expect(
      env.services.progress.ensureSession(
        { orderId, periodId, requestedSessionIndex: first.sessionIndex },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'ARCHIVED_ORDER' });
  });
});

describe('UF-038 历史补记与退休任务恢复', () => {
  it('已移除的普通数值任务按正常完成语义补记，撤销恢复到空值', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(
      env,
      [checkbox('签到'), { ...cumulative('抽卡'), numericMode: null, unit: null }],
      2,
    );
    const detail = await env.services.queries.orderDetail(orderId);
    const numeric = detail!.tasks.find((task) => task.progressType === 'NUMERIC')!;
    const check = detail!.tasks.find((task) => task.progressType === 'CHECKBOX')!;
    // 第 1 轮只完成打卡任务；数值任务留空。
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    // 模拟"移除任务"（安卓写入 retiredAt；网页端恢复的就是这种数据）。
    await env.runtime.write(env.token, async (ctx) => {
      const row = ctx.data.task_definitions.find((task) => task.id === numeric.id)!;
      await ctx.table('task_definitions').put({ ...row, retiredAt: clock });
    });

    const today = await env.services.queries.today({});
    expect(today.hosting.some((row) => row.taskId === numeric.id)).toBe(false);

    const afterRetire = await env.services.queries.orderDetail(orderId);
    const historical = afterRetire!.historicalTasks.find((task) => task.taskId === numeric.id)!;
    expect(historical.rounds).toHaveLength(1);
    expect(historical.rounds[0]).toMatchObject({
      sessionIndex: 1,
      attributedDate: DAY1,
      completed: false,
      hasObservation: false,
    });
    expect(afterRetire!.rounds[0].completedAt).toBeNull();

    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: numeric.id, completed: true },
      env.token,
    );
    let data = await readData(env);
    const occurrence = data.task_occurrences.find(
      (row) => row.taskDefinitionId === numeric.id && row.occurrenceKey === 'N:1',
    )!;
    expect(occurrence.value).toBe('100');
    expect(occurrence.gameDate).toBe(DAY1);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();

    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: numeric.id, completed: false },
      env.token,
    );
    data = await readData(env);
    const reopened = data.task_occurrences.find((row) => row.id === occurrence.id)!;
    expect(reopened.completedAt).toBeNull();
    expect(reopened.value).toBeNull();
    expect(data.hosting_sessions[0].completedAt).toBeNull();
  });

  it('退休日之后的轮次不能补记；历史更正不创建新轮次', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), cumulative('抽卡', '10')], 3);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const check = detail!.tasks.find((task) => task.progressType === 'CHECKBOX')!;
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-r1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    env.nextDay();
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY2, value: null, completed: true, backfilled: false },
      env.token,
    );
    // 退休在 day1：day2 的轮次归属日已晚于退休日。
    await env.runtime.write(env.token, async (ctx) => {
      const row = ctx.data.task_definitions.find((task) => task.id === check.id)!;
      await ctx.table('task_definitions').put({ ...row, retiredAt: START });
    });
    await expect(
      env.services.tasks.setHistoricalRoundCompletion(
        { orderId, sessionIndex: 2, taskId: check.id, completed: true },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      env.services.tasks.setHistoricalRoundCompletion(
        { orderId, sessionIndex: 9, taskId: check.id, completed: true },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(2);
  });
});

describe('批量和普通周期行为', () => {
  it('批量完成跳过未达标累计目标且不虚构进度', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), cumulative('抽卡', '100')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '40',
        gameDate: DAY1,
        operationId: 'op-bulk-cum',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const result = await env.services.tasks.completeBatchDetailed(
      {
        operationId: 'op-bulk',
        scope: 'HOSTING_ORDER',
        targetId: orderId,
        gameDate: DAY1,
      },
      env.token,
    );
    expect(result.batchId).not.toBeNull();
    expect(result.skipped[0].taskId).toBe(cum.taskId);
    expect(result.skipped[0].reason).toContain('未达标');
    const data = await readData(env);
    expect(data.task_progress_events).toHaveLength(1);
    expect(data.task_progress_events[0].totalValue).toBe('40');
    // 轮次仍不完整（累计未达标）；批量不会把空轮次判完成。
    expect(data.hosting_sessions[0].completedAt).toBeNull();
  });

  it('普通每日数值任务仍按周期重置，不累计', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, [
      {
        title: '每日副本',
        progressType: 'NUMERIC',
        startValue: '0',
        targetValue: '10',
        unit: '次',
        recurrence: 'DAILY',
        weekdays: null,
        everyNDays: null,
        monthDay: null,
      },
    ]);
    const detail = await env.services.queries.orderDetail(orderId);
    const task = detail!.tasks[0];
    await env.services.tasks.setProgress(
      { taskId: task.id, gameDate: DAY1, value: '10', completed: true, backfilled: false },
      env.token,
    );
    env.nextDay();
    const today = await env.services.queries.today({});
    const item = today.hosting.find((row) => row.taskId === task.id)!;
    expect(item.completed).toBe(false);
    expect(item.currentValue).toBe('0');
    const data = await readData(env);
    const occurrences = data.task_occurrences.filter(
      (row) => row.taskDefinitionId === task.id,
    );
    expect(occurrences.map((row) => row.occurrenceKey).sort()).toEqual([
      `D:${DAY1}`,
      `D:${DAY2}`,
    ]);
  });
});

describe('UF-037 账号分类与账号视图', () => {
  it('跨老板同名账号不合并；删分类保留账号与订单', async () => {
    const env = await freshEnv();
    const ownerA = await env.services.accounts.saveOwner({ nickname: '老板A' }, env.token);
    const ownerB = await env.services.accounts.saveOwner({ nickname: '老板B' }, env.token);
    const accountA = await env.services.accounts.saveAccount(
      {
        ownerId: ownerA,
        gameName: '原神',
        server: '官服',
        uid: '1001',
        loginAccount: 'a',
        loginMethod: 'PASSWORD',
        password: 'x',
      },
      env.token,
    );
    const accountB = await env.services.accounts.saveAccount(
      {
        ownerId: ownerB,
        gameName: '原神',
        server: '官服',
        uid: '1001',
        loginAccount: 'b',
        loginMethod: 'PASSWORD',
        password: 'x',
      },
      env.token,
    );
    const { categoryId } = await env.services.accounts.createCategory(
      { name: '长期客户' },
      env.token,
    );
    await env.services.accounts.setAccountCategory(
      { accountId: accountA, categoryId },
      env.token,
    );

    let rows = await env.services.accounts.accountView({});
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.accountId)).size).toBe(2);
    expect(rows.find((row) => row.accountId === accountA)?.categoryName).toBe('长期客户');
    expect(rows.find((row) => row.accountId === accountB)?.categoryName).toBeNull();
    expect(rows.find((row) => row.accountId === accountB)?.ownerName).toBe('老板B');

    // 同名（trim 后）分类拒绝。
    await expect(
      env.services.accounts.createCategory({ name: '  长期客户 ' }, env.token),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // 建单后删除分类：账号与订单都保留，只置为未分类。
    const order = await env.services.orders.create(
      orderCommand({ ownerId: ownerA, accountId: accountA }, { tasks: [checkbox('签到')] }),
      env.token,
    );
    const deleted = await env.services.accounts.deleteCategory({ categoryId }, env.token);
    expect(deleted.unclassifiedAccounts).toBe(1);
    const data = await readData(env);
    expect(data.account_categories).toHaveLength(0);
    expect(data.game_accounts.find((row) => row.id === accountA)?.categoryId).toBeNull();
    expect(data.orders.find((row) => row.id === order.orderId)).toBeTruthy();
    rows = await env.services.accounts.accountView({ categoryId: null });
    expect(rows.map((row) => row.accountId).sort()).toEqual([accountA, accountB].sort());
  });

  it('分类重命名保持归属；分类随完整备份往返，模板文件不携带账号分类', async () => {
    const env = await freshEnv();
    const ids = await seedAccount(env);
    const { categoryId } = await env.services.accounts.createCategory(
      { name: '新客' },
      env.token,
    );
    await env.services.accounts.setAccountCategory(
      { accountId: ids.accountId, categoryId },
      env.token,
    );
    await env.services.accounts.renameCategory({ categoryId, name: '老客' }, env.token);
    const rows = await env.services.accounts.accountView({ categoryId });
    expect(rows[0].categoryName).toBe('老客');

    const templateId = await env.services.templates.save(
      {
        gameName: '原神',
        templateVersion: '2026.10',
        gameVersionNotes: null,
        zoneId: ZONE,
        dailyRefreshMinutes: REFRESH,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        defaultOrderTitle: '  原神每日托管  ',
        categories: [
          {
            name: '日常',
            hostingMode: 'DATE_RANGE',
            targetSessions: null,
            serviceWeekdays: null,
            tasks: [cumulative('抽卡', '50')],
          },
        ],
      } satisfies TemplateDraft,
      env.token,
    );
    const detail = await env.services.queries.templateDetail(templateId);
    expect(detail?.defaultOrderTitle).toBe('原神每日托管');
    expect(detail?.categories[0].tasks[0].numericMode).toBe('CUMULATIVE');

    const templateBlob = await env.services.templates.exportFile(templateId);
    // jsdom 的 Blob 没有 text()：走与生产读取同一机制的 FileReader 兜底。
    const templateText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsText(templateBlob);
    });
    // 模板任务自身的分类 id 属于模板结构；账号分类（新客/老客）绝不进入模板文件。
    expect(templateText).not.toContain('老客');
    expect(templateText).not.toContain('account_categories');
    expect(templateText).toContain('原神每日托管');
    expect(templateText).toContain('"numericMode": "CUMULATIVE"');

    // 完整备份：分类与归属往返。
    const snapshot = await env.services.exportBackup.exportCurrent();
    const preview = await env.services.restore.prepareRestore(snapshot.blob);
    const nextToken = await env.services.restore.commitRestore(preview.sessionId, env.token);
    const restored = await env.services.accounts.accountView({});
    expect(restored[0].categoryName).toBe('老客');
    void nextToken;
  });
});

describe('UF-036 模板默认订单标题', () => {
  it('手填标题不被模板覆盖；自动值跟随；清空后可再次带入', () => {
    const manual = editedTitle('手动标题');
    expect(applyTemplateTitle(manual, '模板甲方')).toEqual(manual);
    expect(applyTemplateTitle(manual, '模板乙方')).toEqual(manual);

    let auto = applyTemplateTitle(editedTitle(''), '模板甲方');
    expect(auto).toEqual({ value: '模板甲方', provenance: 'auto' });
    auto = applyTemplateTitle(auto, '模板乙方');
    expect(auto).toEqual({ value: '模板乙方', provenance: 'auto' });

    const cleared = applyTemplateTitle(auto, '');
    expect(cleared).toEqual({ value: '', provenance: 'none' });
    expect(applyTemplateTitle(cleared, '模板丙方')).toEqual({
      value: '模板丙方',
      provenance: 'auto',
    });
  });

  it('更新模板默认标题不会改名已有订单', async () => {
    const env = await freshEnv();
    const ids = await seedAccount(env);
    const templateId = await env.services.templates.save(
      {
        gameName: '原神',
        templateVersion: '2026.10',
        gameVersionNotes: null,
        zoneId: ZONE,
        dailyRefreshMinutes: REFRESH,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        defaultOrderTitle: '原神托管 A',
        categories: [
          {
            name: '日常',
            hostingMode: 'DATE_RANGE',
            targetSessions: null,
            serviceWeekdays: null,
            tasks: [checkbox('签到')],
          },
        ],
      } satisfies TemplateDraft,
      env.token,
    );
    await env.services.templates.save(
      {
        id: templateId,
        gameName: '原神',
        templateVersion: '2026.10',
        gameVersionNotes: null,
        zoneId: ZONE,
        dailyRefreshMinutes: REFRESH,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        defaultOrderTitle: '原神托管 B',
        categories: [
          {
            name: '日常',
            hostingMode: 'DATE_RANGE',
            targetSessions: null,
            serviceWeekdays: null,
            tasks: [checkbox('签到')],
          },
        ],
      } satisfies TemplateDraft,
      env.token,
    );
    const created = await env.services.orders.create(
      orderCommand(ids, {
        title: '原神托管 A',
        tasks: [checkbox('签到')],
        sourceTemplateId: templateId,
      }),
      env.token,
    );
    await env.services.templates.save(
      {
        id: templateId,
        gameName: '原神',
        templateVersion: '2026.11',
        gameVersionNotes: null,
        zoneId: ZONE,
        dailyRefreshMinutes: REFRESH,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        defaultOrderTitle: '原神托管 C',
        categories: [
          {
            name: '日常',
            hostingMode: 'DATE_RANGE',
            targetSessions: null,
            serviceWeekdays: null,
            tasks: [checkbox('签到')],
          },
        ],
      } satisfies TemplateDraft,
      env.token,
    );
    const detail = await env.services.queries.orderDetail(created.orderId);
    expect(detail!.order.title).toBe('原神托管 A');
    expect((await env.services.queries.templateDetail(templateId))!.defaultOrderTitle).toBe(
      '原神托管 C',
    );
  });
});

describe('UF-038 数值口径切换与重建一致性', () => {
  it('已有历史的任务禁止就地切换口径；无历史可切换', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), cumulative('抽卡', '10')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const check = detail!.tasks.find((task) => task.progressType === 'CHECKBOX')!;

    await expect(
      env.services.progress.updateNumericMode(
        { taskId: cum.taskId, mode: 'PER_OCCURRENCE' },
        env.token,
      ),
    ).resolves.toBeUndefined();
    await expect(
      env.services.progress.updateNumericMode(
        { taskId: check.id, mode: 'CUMULATIVE' },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 先切回累计，再产生历史，然后切换必须被拒绝。
    await env.services.progress.updateNumericMode(
      { taskId: cum.taskId, mode: 'CUMULATIVE' },
      env.token,
    );
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '5',
        gameDate: DAY1,
        operationId: 'op-mode-history',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await expect(
      env.services.progress.updateNumericMode(
        { taskId: cum.taskId, mode: 'PER_OCCURRENCE' },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('增量写入的派生状态与全量重建逐字段一致', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), cumulative('抽卡', '30')], 2);
    const detail = await env.services.queries.orderDetail(orderId);
    const cum = detail!.cumulative[0];
    const check = detail!.tasks.find((task) => task.progressType === 'CHECKBOX')!;
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '30',
        gameDate: DAY1,
        operationId: 'op-eq-1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    env.nextDay();
    const submitted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '30',
        gameDate: DAY2,
        operationId: 'op-eq-2',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await env.services.progress.correct(
      {
        operationId: 'op-eq-c1',
        correctsEventId: submitted.eventId,
        kind: 'CORRECT',
        totalValue: '20',
        gameDate: DAY2,
        scope: { kind: 'SESSION' },
      },
      env.token,
    );

    const live = await readData(env);
    const clone = structuredClone(live) as BackupDataSet;
    reconstructDerivedState(clone);
    expect(clone.hosting_sessions.map((row) => row.completedAt)).toEqual(
      live.hosting_sessions.map((row) => row.completedAt),
    );
    expect(clone.hosting_sessions.map((row) => row.sessionIndex)).toEqual(
      live.hosting_sessions.map((row) => row.sessionIndex),
    );
    expect(clone.task_definitions.map((row) => row.currentValue)).toEqual(
      live.task_definitions.map((row) => row.currentValue),
    );
    expect(clone.orders.map((row) => row.completedAt)).toEqual(
      live.orders.map((row) => row.completedAt),
    );
  });
});

describe('累计命令的待重试身份', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('同载荷复用 operationId，改载荷换新键，成功后清除', () => {
    const first = operationIdFor('t1:submit', 'SUBMIT|t1|10');
    expect(operationIdFor('t1:submit', 'SUBMIT|t1|10')).toBe(first);
    const changed = operationIdFor('t1:submit', 'SUBMIT|t1|15');
    expect(changed).not.toBe(first);
    clearPendingOperation('t1:submit');
    expect(operationIdFor('t1:submit', 'SUBMIT|t1|15')).not.toBe(changed);
  });

  it('重试身份绑定 scope 与归属日：换日期或换轮次必然换新键', () => {
    const session1: ProgressScope = { kind: 'SESSION', sessionId: 's1' };
    const session2: ProgressScope = { kind: 'SESSION', sessionId: 's2' };
    const base = {
      kind: 'SUBMIT' as const,
      taskId: 't1',
      scope: session1,
      gameDate: DAY1,
      value: '10',
    };
    const first = operationIdFor('t1:submit', cumulativeOperationPayload(base));
    // 同一份载荷：复用（刷新后仍可安全重试）。
    expect(operationIdFor('t1:submit', cumulativeOperationPayload({ ...base }))).toBe(first);
    // 只改归属日：不能复用。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...base, gameDate: DAY2 })),
    ).not.toBe(first);
    // 只改轮次：不能复用。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...base, scope: session2 })),
    ).not.toBe(first);
    // "当前轮次（事务内 ensure）"与某个具体轮次是两种载荷。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...base, scope: null })),
    ).not.toBe(first);
    // 更正命令把被更正事件也算进载荷。
    const correction = {
      kind: 'CORRECT' as const,
      taskId: 't1',
      scope: session1,
      gameDate: DAY1,
      value: '15',
      targetId: 'e1',
    };
    const correctId = operationIdFor('t1:correct:e1', cumulativeOperationPayload(correction));
    expect(
      operationIdFor(
        't1:correct:e1',
        cumulativeOperationPayload({ ...correction, targetId: 'e2' }),
      ),
    ).not.toBe(correctId);
  });

  // R5：组件提交时用同一套 payload 生成 operationId（今日与详情都走
  // `cumulativeOperationPayload`），因此"命令种类"与"取值"也必须参与身份。
  it('命令种类与取值参与身份：同一任务/轮次/日期也不会误用同一把钥匙', () => {
    const scope: ProgressScope = { kind: 'SESSION', sessionId: 's1' };
    const submit = {
      kind: 'SUBMIT' as const,
      taskId: 't1',
      scope,
      gameDate: DAY1,
      value: '10',
    };
    const submitId = operationIdFor('t1:submit', cumulativeOperationPayload(submit));
    expect(operationIdFor('t1:submit', cumulativeOperationPayload({ ...submit }))).toBe(submitId);
    // 值变了 → 新命令。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...submit, value: '15' })),
    ).not.toBe(submitId);
    // 种类变了（同样是 t1/日期/值）→ 新命令。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...submit, kind: 'CORRECT' })),
    ).not.toBe(submitId);
    // 待建轮次（null = 事务内 ensure）不会与已知轮次共用身份。
    expect(
      operationIdFor('t1:submit', cumulativeOperationPayload({ ...submit, scope: null })),
    ).not.toBe(submitId);
  });
});

/* ------------------------------------------------------------------ *
 * 阶段 4 验收修复（R1–R4）
 *
 * R1 累计命令资格：数值边界、退休日、服务日、scope 快照、失败回滚；
 * R2 历史更正与退休累计恢复的可达性（服务层契约，UI 见 e2e）；
 * R3 历史补记的应做集与稳定归属日；
 * R4 更正重放先过安全守卫。
 * ------------------------------------------------------------------ */

async function retireTask(env: Env, taskId: string, retiredAt: number): Promise<void> {
  await env.runtime.write(env.token, async (ctx) => {
    const row = ctx.data.task_definitions.find((task) => task.id === taskId)!;
    await ctx.table('task_definitions').put({ ...row, retiredAt });
  });
}

async function patchPeriod(
  env: Env,
  periodId: string,
  patch: Partial<BackupDataSet['hosting_periods'][number]>,
): Promise<void> {
  await env.runtime.write(env.token, async (ctx) => {
    const row = ctx.data.hosting_periods.find((period) => period.id === periodId)!;
    await ctx.table('hosting_periods').put({ ...row, ...patch });
  });
}

/** 上海 2026-03-09 12:00（周一）→ 游戏日 2026-03-09。 */
const MONDAY = Date.UTC(2026, 2, 9, 4, 0);
const DAY0 = '2026-03-09';
const FRI = '2026-03-13';
const SAT = '2026-03-14';

describe('R1 累计命令资格：数值边界、退休日、服务日与 scope 快照', () => {
  it('负数 SUBMIT/CORRECT 被拒绝，且不留下事件或轮次行', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 2);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];

    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '-5',
          gameDate: DAY1,
          operationId: 'op-negative',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    let data = await readData(env);
    expect(data.task_progress_events).toHaveLength(0);
    expect(data.hosting_sessions).toHaveLength(0);

    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-positive',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    await expect(
      env.services.progress.correct(
        {
          operationId: 'op-negative-correct',
          correctsEventId: accepted.eventId,
          kind: 'CORRECT',
          totalValue: '-1',
          gameDate: DAY1,
          scope: accepted.scope,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    data = await readData(env);
    expect(data.task_progress_events).toHaveLength(1);
    expect(data.task_progress_events[0].totalValue).toBe('10');
  });

  it('零、上限、超上限与过多小数位（SUBMIT 与 CORRECT 同一套边界）', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡', '1000000000000')], 2);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    const submit = (totalValue: string, operationId: string) =>
      env.services.progress.submit(
        { taskId: cum.taskId, totalValue, gameDate: DAY1, operationId, scope: { kind: 'SESSION' } },
        env.token,
      );

    const zero = await submit('0', 'op-zero');
    expect(zero.currentTotal).toBe('0');
    await expect(submit('10.0001', 'op-scale')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(submit('1000000000001', 'op-over')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      env.services.progress.correct(
        {
          operationId: 'op-correct-over',
          correctsEventId: zero.eventId,
          kind: 'CORRECT',
          totalValue: '1000000000000.5',
          gameDate: DAY1,
          scope: zero.scope,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const precise = await submit('1.234', 'op-precise');
    expect(precise.currentTotal).toBe('1.234');
    const max = await env.services.progress.correct(
      {
        operationId: 'op-correct-max',
        correctsEventId: zero.eventId,
        kind: 'CORRECT',
        totalValue: '1000000000000',
        gameDate: DAY1,
        scope: zero.scope,
      },
      env.token,
    );
    expect(max.currentTotal).toBe('1000000000000');
    // 零值提交 + 精度提交 + 一次更正 = 3 条追加式事件。
    expect((await readData(env)).task_progress_events).toHaveLength(3);
  });

  it('退休日当天仍可归属，次日拒绝；退休前的更正与撤销仍成功', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡'), checkbox('签到')], 2);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];

    const day1 = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-r1-d1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    env.nextDay();
    const day2 = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '20',
        gameDate: DAY2,
        operationId: 'op-r1-d2',
        scope: day1.scope,
      },
      env.token,
    );

    // 退休就在 DAY2（时钟仍在 DAY2）。
    await retireTask(env, cum.taskId, clock);

    // 退休日当天（= 历史归属日）的更正仍然合法。
    const corrected = await env.services.progress.correct(
      {
        operationId: 'op-r1-correct-day2',
        correctsEventId: day2.eventId,
        kind: 'CORRECT',
        totalValue: '25',
        gameDate: DAY2,
        scope: day1.scope,
      },
      env.token,
    );
    expect(corrected.currentTotal).toBe('25');
    // 更早日期（退休前）的更正同样合法。
    const earlier = await env.services.progress.correct(
      {
        operationId: 'op-r1-correct-day1',
        correctsEventId: day1.eventId,
        kind: 'CORRECT',
        totalValue: '15',
        gameDate: DAY1,
        scope: day1.scope,
      },
      env.token,
    );
    expect(earlier.currentTotal).toBe('25');
    // 撤销退休日当天的观测：回到更早日期的更正真值。
    const retracted = await env.services.progress.correct(
      {
        operationId: 'op-r1-retract-day2',
        correctsEventId: corrected.eventId,
        kind: 'RETRACT',
        totalValue: null,
        gameDate: DAY2,
        scope: day1.scope,
      },
      env.token,
    );
    expect(retracted.currentTotal).toBe('15');

    // 退休日之后是新的归属：拒绝，且不落库。
    env.nextDay();
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '30',
          gameDate: '2026-03-12',
          operationId: 'op-r1-after-retire',
          scope: day1.scope,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_RANGE' });
    const data = await readData(env);
    // 2 次提交 + 2 次更正 + 1 次撤销；被拒的退休后提交没有落库。
    expect(data.task_progress_events).toHaveLength(5);
  });

  it('非服务星期被拒；任务的重复触发日不参与资格判定', async () => {
    const env = await freshEnv();
    env.at(MONDAY);
    // 日期式托管：03-09 ~ 03-15（含周末），期次快照声明只在周一至周五服务。
    const { orderId, periodId } = await dateOrder(env, [
      {
        ...cumulative('抽卡'),
        recurrence: 'SELECTED_WEEKDAYS',
        weekdays: '6',
      },
    ], DAY0, '2026-03-15');
    await patchPeriod(env, periodId, { serviceWeekdays: '1,2,3,4,5' });

    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    env.at(Date.UTC(2026, 2, 14, 4, 0)); // 上海 03-14 12:00 → 周六

    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: SAT,
          operationId: 'op-sat',
          scope: { kind: 'PERIOD', periodId },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_RANGE' });

    // 周五是服务日：即使任务自身的重复触发日是周六，也必须接受。
    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: FRI,
        operationId: 'op-fri',
        scope: { kind: 'PERIOD', periodId },
      },
      env.token,
    );
    expect(accepted.currentTotal).toBe('10');
  });

  it('期次快照决定"今天"，而不是订单口径', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrder(env, [cumulative('抽卡')], 2);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    // 订单 05:00 刷新，期次 10:00 刷新（安卓续期/恢复可能带来的快照差异）。
    await patchPeriod(env, periodId, { dailyRefreshMinutes: 600 });
    env.at(Date.UTC(2026, 2, 10, 23, 0)); // 上海 03-11 07:00：订单日 03-11、期次日 03-10

    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY2,
          operationId: 'op-order-calendar',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-period-calendar',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    expect(accepted.currentTotal).toBe('10');
  });

  it('退休游戏日按 scope 快照换算（不是订单口径）', async () => {
    const env = await freshEnv();
    const ids = await seedAccount(env, '老板丙', '3003');
    // 订单 00:00 刷新；期次沿用 05:00 刷新。
    const created = await env.services.orders.create(
      orderCommand(ids, {
        serviceCount: 2,
        dailyRefreshMinutes: 0,
        weeklyRefreshMinutes: 0,
        tasks: [cumulative('抽卡')],
      }),
      env.token,
    );
    const createdDetail = (await env.services.queries.orderDetail(created.orderId))!;
    // 期次快照仍是 05:00（建单时套用的是订单默认刷新点，这里显式固定为差异值）。
    await patchPeriod(env, createdDetail.periods[0].id, { dailyRefreshMinutes: REFRESH });
    const cum = createdDetail.cumulative[0];
    // retiredAt = 上海 03-11 03:00：期次口径的退休游戏日是 03-10，订单口径是 03-11。
    await retireTask(env, cum.taskId, Date.UTC(2026, 2, 10, 19, 0));
    env.at(Date.UTC(2026, 2, 11, 4, 0)); // 上海 03-11 12:00（两个口径的"今天"都是 03-11）

    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-retire-day',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    expect(accepted.currentTotal).toBe('10');
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '20',
          gameDate: DAY2,
          operationId: 'op-retire-next-day',
          scope: accepted.scope,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_RANGE' });
    expect((await readData(env)).task_progress_events).toHaveLength(1);
  });

  it('资格失败时事务回滚：不留下自动分配的轮次行', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 2);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY0,
          operationId: 'op-rollback',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_SERVICE_RANGE' });
    const data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(0);
    expect(data.task_progress_events).toHaveLength(0);
  });
});

describe('R2 历史更正与退休累计恢复（服务层契约）', () => {
  it('较早日期未被取代的观测可更正，当前总值仍由更晚的日期决定', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 3);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    const day1 = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-h-day1',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    env.nextDay();
    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '20',
        gameDate: DAY2,
        operationId: 'op-h-day2',
        scope: day1.scope,
      },
      env.token,
    );

    let history = await env.services.progress.history(cum.taskId);
    const firstEntry = history.find((entry) => entry.id === day1.eventId)!;
    // day1 的绝对值不再是当前总值的决定者，但它仍然可以被更正。
    expect(firstEntry.effective).toBe(false);
    expect(firstEntry.correctable).toBe(true);
    expect(firstEntry.scopeLabel).toBe('第 1 次打卡');
    expect(firstEntry.gameDate).toBe(DAY1);

    await env.services.progress.correct(
      {
        operationId: 'op-h-correct-day1',
        correctsEventId: day1.eventId,
        kind: 'CORRECT',
        totalValue: '15',
        gameDate: DAY1,
        scope: day1.scope,
      },
      env.token,
    );
    history = await env.services.progress.history(cum.taskId);
    expect(history.find((entry) => entry.id === day1.eventId)!.supersededBy).not.toBeNull();
    const correction = history.find((entry) => entry.correctsEventId === day1.eventId)!;
    expect(correction.correctable).toBe(true);
    expect(correction.totalValue).toBe('15');
    const total = await env.services.progress.currentTotal({
      taskId: cum.taskId,
      scope: { kind: 'SESSION', sessionId: (day1.scope as { sessionId: string }).sessionId },
    });
    expect(total.total).toBe('20');
    const asOf = await env.services.progress.totalAsOf({
      taskId: cum.taskId,
      scope: day1.scope,
      asOfGameDate: DAY1,
    });
    expect(asOf.total).toBe('15');
  });

  it('退休累计任务无观测的历史轮次：按该轮归属日首次观测，且不新建轮次', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), cumulative('抽卡', '100')], 2);
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const cum = detail.cumulative[0];
    const check = detail.tasks.find((task) => task.progressType === 'CHECKBOX')!;
    // 第 1 轮只完成打卡任务：累计任务在该轮没有任何观测。
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    await retireTask(env, cum.taskId, clock);

    // 时钟推进 3 天后，轮次归属日仍然稳定为 DAY1（不使用"今天"）。
    env.at(START + 3 * DAY_MS);
    const afterRetire = (await env.services.queries.orderDetail(orderId))!;
    const historical = afterRetire.historicalTasks.find((task) => task.taskId === cum.taskId)!;
    expect(historical.retiredDate).toBe(DAY1);
    expect(historical.rounds).toHaveLength(1);
    expect(historical.rounds[0]).toMatchObject({
      sessionIndex: 1,
      attributedDate: DAY1,
      hasObservation: false,
      completed: false,
    });
    // 退休任务不出现在当前打卡列表里。
    const today = await env.services.queries.today({});
    expect(today.hosting.some((row) => row.taskId === cum.taskId)).toBe(false);

    const recorded = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '100',
        gameDate: historical.rounds[0].attributedDate as string,
        operationId: 'op-retired-first-observation',
        scope: { kind: 'SESSION', sessionId: historical.rounds[0].sessionId },
      },
      env.token,
    );
    const data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(1);
    const event = data.task_progress_events.find((row) => row.id === recorded.eventId)!;
    expect(event).toMatchObject({
      taskDefinitionId: cum.taskId,
      scopeType: 'SESSION',
      scopeSessionId: historical.rounds[0].sessionId,
      gameDate: DAY1,
      totalValue: '100',
    });
    // 累计任务不写 occurrence，也不会凭空创建轮次。
    expect(
      data.task_occurrences.filter(
        (row) => row.taskDefinitionId === cum.taskId && row.occurrenceKey === 'N:1',
      ),
    ).toHaveLength(0);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();

    // 已有观测之后走事件链：撤销会重开该轮。
    await env.services.progress.correct(
      {
        operationId: 'op-retired-retract',
        correctsEventId: recorded.eventId,
        kind: 'RETRACT',
        totalValue: null,
        gameDate: DAY1,
        scope: recorded.scope,
      },
      env.token,
    );
    const reopened = await readData(env);
    expect(reopened.hosting_sessions[0].completedAt).toBeNull();
    const afterRetract = (await env.services.queries.orderDetail(orderId))!;
    const historicalAfter = afterRetract.historicalTasks.find(
      (task) => task.taskId === cum.taskId,
    )!;
    // 撤回只追加事件（原始行仍在），因此 hasObservation 仍是 true；有效观测已消失，
    // 这一轮重新可以按该轮归属日补记首次观测。
    expect(historicalAfter.rounds[0]).toMatchObject({
      completed: false,
      hasObservation: true,
      hasEffectiveObservation: false,
      currentValue: '0',
    });
    const reRecorded = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '100',
        gameDate: historicalAfter.rounds[0].attributedDate as string,
        operationId: 'op-retired-rerecord',
        scope: { kind: 'SESSION', sessionId: historicalAfter.rounds[0].sessionId },
      },
      env.token,
    );
    expect(reRecorded.currentTotal).toBe('100');
    expect((await readData(env)).hosting_sessions[0].completedAt).not.toBeNull();
    expect((await readData(env)).hosting_sessions).toHaveLength(1);
  });
});

describe('R3 历史补记的应做集与稳定归属日', () => {
  it('未生效、已过期与一次性任务在该轮都不应做', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(
      env,
      [
        checkbox('签到'),
        { ...checkbox('迟到的任务'), activeFrom: DAY2 },
        { ...checkbox('提前结束的任务'), activeUntil: DAY0 },
        { ...checkbox('一次性任务'), recurrence: 'ONE_TIME' },
        { ...cumulative('抽卡'), numericMode: null, unit: null, recurrence: 'ONE_TIME' },
      ],
      2,
    );
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const check = detail.tasks.find((task) => task.title === '签到')!;
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    const others = detail.tasks.filter((task) => task.id !== check.id);
    for (const task of others) await retireTask(env, task.id, clock);

    for (const task of others) {
      await expect(
        env.services.tasks.setHistoricalRoundCompletion(
          { orderId, sessionIndex: 1, taskId: task.id, completed: true },
          env.token,
        ),
        `${task.title} 必须被应做集拒绝`,
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    const data = await readData(env);
    expect(
      data.task_occurrences.filter((row) => row.occurrenceKey === 'N:1'),
    ).toHaveLength(1);
  });

  it('被移除的打卡/普通数值任务可在自己的轮次补记并撤销；一次性不在应做集内', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(
      env,
      [checkbox('签到'), { ...checkbox('补签'), activeFrom: DAY1 }, { ...cumulative('抽卡'), numericMode: null, unit: null }],
      2,
    );
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const check = detail.tasks.find((task) => task.title === '签到')!;
    const backfill = detail.tasks.find((task) => task.title === '补签')!;
    const numeric = detail.tasks.find((task) => task.progressType === 'NUMERIC')!;
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    await retireTask(env, backfill.id, clock);
    await retireTask(env, numeric.id, clock);

    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: backfill.id, completed: true },
      env.token,
    );
    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: numeric.id, completed: true },
      env.token,
    );
    let data = await readData(env);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();
    expect(
      data.task_occurrences.find(
        (row) => row.taskDefinitionId === numeric.id && row.occurrenceKey === 'N:1',
      )!.value,
    ).toBe('100');

    // 撤销按普通路径的语义重置该行，轮次重新打开。
    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: numeric.id, completed: false },
      env.token,
    );
    data = await readData(env);
    const reopened = data.task_occurrences.find(
      (row) => row.taskDefinitionId === numeric.id && row.occurrenceKey === 'N:1',
    )!;
    expect(reopened.completedAt).toBeNull();
    expect(reopened.value).toBeNull();
    expect(data.hosting_sessions[0].completedAt).toBeNull();
  });

  it('无观测的轮次用 createdAt 的稳定归属日（跨时钟变化不漂移）', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [checkbox('签到'), { ...checkbox('补签'), activeFrom: DAY0 }], 2);
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const check = detail.tasks.find((task) => task.title === '签到')!;
    const backfill = detail.tasks.find((task) => task.title === '补签')!;
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    await retireTask(env, backfill.id, clock);

    // 三天后补记：归属日仍是轮次创建日 DAY1，不是"今天"。
    env.at(START + 3 * DAY_MS);
    await env.services.tasks.setHistoricalRoundCompletion(
      { orderId, sessionIndex: 1, taskId: backfill.id, completed: true },
      env.token,
    );
    const data = await readData(env);
    const occurrence = data.task_occurrences.find(
      (row) => row.taskDefinitionId === backfill.id && row.occurrenceKey === 'N:1',
    )!;
    expect(occurrence.gameDate).toBe(DAY1);
  });

  it('错误的任务/期次/轮次归属被拒绝', async () => {
    const env = await freshEnv();
    const first = await countOrder(env, [checkbox('签到'), checkbox('补签')], 2);
    const secondIds = await seedAccount(env, '别人', '9999');
    const second = await env.services.orders.create(
      orderCommand(secondIds, { serviceCount: 2, tasks: [checkbox('别人的任务')] }),
      env.token,
    );
    const firstDetail = (await env.services.queries.orderDetail(first.orderId))!;
    const check = firstDetail.tasks.find((task) => task.title === '签到')!;
    const otherTask = firstDetail.tasks.find((task) => task.title === '补签')!;
    const foreign = (await env.services.queries.orderDetail(second.orderId))!.tasks[0];
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    await retireTask(env, otherTask.id, clock);
    await retireTask(env, foreign.id, clock);

    // 别的订单的任务
    await expect(
      env.services.tasks.setHistoricalRoundCompletion(
        { orderId: first.orderId, sessionIndex: 1, taskId: foreign.id, completed: true },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 不存在的轮次（历史更正不创建轮次）
    await expect(
      env.services.tasks.setHistoricalRoundCompletion(
        { orderId: first.orderId, sessionIndex: 7, taskId: otherTask.id, completed: true },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 期次归属伪造：把任务挂到别的期次
    await env.runtime.write(env.token, async (ctx) => {
      const row = ctx.data.task_definitions.find((task) => task.id === otherTask.id)!;
      await ctx.table('task_definitions').put({ ...row, periodId: null });
    });
    await expect(
      env.services.tasks.setHistoricalRoundCompletion(
        { orderId: first.orderId, sessionIndex: 1, taskId: otherTask.id, completed: true },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await readData(env)).hosting_sessions).toHaveLength(1);
  });
});

describe('R4 更正重放先过安全守卫', () => {
  it('同载荷更正重放返回原结果且不追加事件；事件已有后继仍可重放', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 3);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    const submitted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-replay-submit',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const command = {
      operationId: 'op-replay-correct',
      correctsEventId: submitted.eventId,
      kind: 'CORRECT' as const,
      totalValue: '15',
      gameDate: DAY1,
      scope: submitted.scope,
    };
    const first = await env.services.progress.correct(command, env.token);
    const replay = await env.services.progress.correct({ ...command }, env.token);
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.eventId).toBe(first.eventId);
    expect((await readData(env)).task_progress_events).toHaveLength(2);

    // 让这次更正拥有后继：原命令的重放仍然返回首次结果，不触发 SUPERSEDED_EVENT。
    await env.services.progress.correct(
      {
        operationId: 'op-replay-successor',
        correctsEventId: first.eventId,
        kind: 'CORRECT',
        totalValue: '18',
        gameDate: DAY1,
        scope: submitted.scope,
      },
      env.token,
    );
    const replayAfterSuccessor = await env.services.progress.correct({ ...command }, env.token);
    expect(replayAfterSuccessor.alreadyApplied).toBe(true);
    expect(replayAfterSuccessor.eventId).toBe(first.eventId);
    expect((await readData(env)).task_progress_events).toHaveLength(3);
    expect(replayAfterSuccessor.currentTotal).toBe('18');

    // 同 operationId、不同载荷：拒绝。
    await expect(
      env.services.progress.correct({ ...command, totalValue: '99' }, env.token),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('作废/归档订单与归档老板、账号拒绝重放', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 3);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    const submitted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-guard-submit',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const command = {
      operationId: 'op-guard-correct',
      correctsEventId: submitted.eventId,
      kind: 'CORRECT' as const,
      totalValue: '15',
      gameDate: DAY1,
      scope: submitted.scope,
    };
    await env.services.progress.correct(command, env.token);

    await env.runtime.write(env.token, async (ctx) => {
      const order = ctx.data.orders.find((row) => row.id === orderId)!;
      await ctx.table('orders').put({ ...order, archivedAt: clock });
    });
    await expect(
      env.services.progress.correct({ ...command }, env.token),
    ).rejects.toMatchObject({ code: 'ARCHIVED_ORDER' });

    const env2 = await freshEnv();
    const second = await countOrder(env2, [cumulative('抽卡')], 3);
    const cum2 = (await env2.services.queries.orderDetail(second.orderId))!.cumulative[0];
    const submitted2 = await env2.services.progress.submit(
      {
        taskId: cum2.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-guard2-submit',
        scope: { kind: 'SESSION' },
      },
      env2.token,
    );
    const command2 = {
      operationId: 'op-guard2-correct',
      correctsEventId: submitted2.eventId,
      kind: 'CORRECT' as const,
      totalValue: '15',
      gameDate: DAY1,
      scope: submitted2.scope,
    };
    await env2.services.progress.correct(command2, env2.token);
    await env2.runtime.write(env2.token, async (ctx) => {
      const account = ctx.data.game_accounts[0];
      await ctx.table('game_accounts').put({ ...account, archivedAt: clock });
    });
    await expect(
      env2.services.progress.correct({ ...command2 }, env2.token),
    ).rejects.toMatchObject({ code: 'ARCHIVED_ACCOUNT' });
    await env2.runtime.write(env2.token, async (ctx) => {
      const account = ctx.data.game_accounts[0];
      await ctx.table('game_accounts').put({ ...account, archivedAt: null });
      const owner = ctx.data.owners[0];
      await ctx.table('owners').put({ ...owner, archivedAt: clock });
    });
    await expect(
      env2.services.progress.correct({ ...command2 }, env2.token),
    ).rejects.toMatchObject({ code: 'ARCHIVED_OWNER' });
    await env2.runtime.write(env2.token, async (ctx) => {
      const owner = ctx.data.owners[0];
      await ctx.table('owners').put({ ...owner, archivedAt: null });
      const order = ctx.data.orders.find((row) => row.id === second.orderId)!;
      await ctx.table('orders').put({ ...order, cancelledAt: clock });
    });
    await expect(
      env2.services.progress.correct({ ...command2 }, env2.token),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
    // 守卫只做读取：重放失败没有追加事件。
    expect((await readData(env2)).task_progress_events).toHaveLength(2);
  });

  it('陈旧数据集拒绝更正重放', async () => {
    const env = await freshEnv();
    const { orderId } = await countOrder(env, [cumulative('抽卡')], 3);
    const cum = (await env.services.queries.orderDetail(orderId))!.cumulative[0];
    const submitted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-stale-submit',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const command = {
      operationId: 'op-stale-correct',
      correctsEventId: submitted.eventId,
      kind: 'CORRECT' as const,
      totalValue: '15',
      gameDate: DAY1,
      scope: submitted.scope,
    };
    const stale = env.token;
    await env.services.progress.correct(command, env.token);
    await env.runtime.createEmptyDataset();
    await expect(
      env.services.progress.correct({ ...command }, stale),
    ).rejects.toMatchObject({ code: 'STALE_DATASET' });
  });
});

/* ------------------------------------------------------------------ *
 * R5 累计提交归属日：UI 必须与命令层用同一个 scope 日历
 *
 * 命令层按期次快照判定"今天"（R1），而 UI 曾固定用订单快照算日期。订单与期次的
 * 刷新点不同（安卓续期/恢复可以留下这种差异）时，UI 会生成一个命令层不承认的
 * 游戏日：要么被拒绝，要么把进度静默记到更早的一天。这里覆盖两个不一致方向，
 * 并确认读模型给出的就是组件实际使用的那份日历。
 * ------------------------------------------------------------------ */

/** 上海 2026-03-11 03:00：订单 00:00 口径是 03-11，期次 05:00 口径仍是 03-10。 */
const SHANGHAI_0300 = Date.UTC(2026, 2, 10, 19, 0);

async function countOrderWithRefresh(
  env: Env,
  orderRefresh: number,
  nickname: string,
  uid: string,
  tasks: TemplateTaskDraft[],
  serviceCount = 2,
): Promise<{ orderId: string; periodId: string }> {
  const ids = await seedAccount(env, nickname, uid);
  const created = await env.services.orders.create(
    orderCommand(ids, {
      serviceCount,
      dailyRefreshMinutes: orderRefresh,
      weeklyRefreshMinutes: orderRefresh,
      tasks,
    }),
    env.token,
  );
  const detail = (await env.services.queries.orderDetail(created.orderId))!;
  return { orderId: created.orderId, periodId: detail.periods[0].id };
}

describe('R5 累计提交归属日与 scope 日历', () => {
  it('订单 00:00 / 期次 05:00：03:00 的提交归属到期的上一游戏日并成功', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrderWithRefresh(
      env,
      0,
      '偏移老板',
      '7001',
      [cumulative('抽卡')],
    );
    // 订单 00:00；期次快照仍是 05:00（安卓续期/恢复可能留下的差异）。
    await patchPeriod(env, periodId, { dailyRefreshMinutes: REFRESH });
    env.at(SHANGHAI_0300);

    // 读操作不建轮次行。
    expect((await readData(env)).hosting_sessions).toHaveLength(0);

    const today = await env.services.queries.today({});
    // 页面级日期是订单口径（03-11）：它绝不能当作提交日期。
    expect(today.gameDate).toBe(DAY2);
    const item = today.hosting.find((row) => row.orderId === orderId && row.cumulative)!;
    expect(item.awaitingSession).toBe(true);
    expect(item.gameDate).toBe(DAY1);
    expect(item.calendar).toEqual({ gameZoneId: ZONE, dailyRefreshMinutes: REFRESH });

    const detail = (await env.services.queries.orderDetail(orderId))!;
    const cum = detail.cumulative[0];
    expect(cum.gameDate).toBe(DAY1);
    expect(cum.calendar).toEqual({ gameZoneId: ZONE, dailyRefreshMinutes: REFRESH });
    expect((await readData(env)).hosting_sessions).toHaveLength(0);

    // 旧缺陷：UI 用订单口径的 03-11，而期次仍停在 03-10 → 命令层拒绝。
    await expect(
      env.services.progress.submit(
        {
          taskId: cum.taskId,
          totalValue: '10',
          gameDate: DAY2,
          operationId: 'op-r5-order-calendar',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // 修复后：UI 提交期次快照下的 03-10 → 成功，事件归属日就是 03-10。
    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: cum.gameDate,
        operationId: 'op-r5-period-calendar',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    expect(accepted.currentTotal).toBe('10');
    const after = await readData(env);
    expect(after.hosting_sessions).toHaveLength(1);
    expect(after.task_progress_events).toHaveLength(1);
    expect(after.task_progress_events[0]).toMatchObject({
      scopeType: 'SESSION',
      scopeSessionId: after.hosting_sessions[0].id,
      gameDate: DAY1,
      totalValue: '10',
    });
  });

  it('订单 05:00 / 期次 00:00：03:00 的提交归属到期次的当前游戏日（不落到前一天）', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrderWithRefresh(
      env,
      REFRESH,
      '反向老板',
      '7002',
      [cumulative('抽卡')],
    );
    await patchPeriod(env, periodId, { dailyRefreshMinutes: 0 });
    env.at(SHANGHAI_0300);

    const today = await env.services.queries.today({});
    // 订单口径仍是前一天（03-10）：这正是"静默记到更早一天"的诱因。
    expect(today.gameDate).toBe(DAY1);
    const item = today.hosting.find((row) => row.orderId === orderId && row.cumulative)!;
    expect(item.gameDate).toBe(DAY2);
    expect(item.calendar.dailyRefreshMinutes).toBe(0);

    const detail = (await env.services.queries.orderDetail(orderId))!;
    const cum = detail.cumulative[0];
    expect(cum.gameDate).toBe(DAY2);

    const accepted = await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '10',
        gameDate: cum.gameDate,
        operationId: 'op-r5-reverse-period-calendar',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    expect(accepted.currentTotal).toBe('10');
    const events = (await readData(env)).task_progress_events;
    expect(events).toHaveLength(1);
    // 归属日必须是期次的 03-11，而不是订单口径的 03-10。
    expect(events[0].gameDate).toBe(DAY2);
  });

  it('TASK 继续使用订单日历（短期单没有期次快照）', async () => {
    const env = await freshEnv();
    const ids = await seedAccount(env, '短单老板', '7003');
    const created = await env.services.orders.create(
      orderCommand(ids, {
        type: 'SHORT_TASK',
        serviceCount: null,
        startDate: null,
        endDate: null,
        priceCents: 20000,
        dailyRefreshMinutes: 0,
        weeklyRefreshMinutes: 0,
        tasks: [cumulative('抽卡')],
      }),
      env.token,
    );
    env.at(SHANGHAI_0300);

    const today = await env.services.queries.today({});
    const item = today.shortTasks.find((row) => row.orderId === created.orderId)!;
    expect(item.periodId).toBeNull();
    expect(item.sessionId).toBeNull();
    expect(item.gameDate).toBe(DAY2);
    expect(item.calendar).toEqual({ gameZoneId: ZONE, dailyRefreshMinutes: 0 });

    const cum = (await env.services.queries.orderDetail(created.orderId))!.cumulative[0];
    expect(cum.scope).toEqual({ kind: 'TASK' });
    expect(cum.gameDate).toBe(DAY2);

    await env.services.progress.submit(
      {
        taskId: cum.taskId,
        totalValue: '5',
        gameDate: cum.gameDate,
        operationId: 'op-r5-task-scope',
        scope: { kind: 'TASK' },
      },
      env.token,
    );
    expect((await readData(env)).task_progress_events[0]).toMatchObject({
      scopeType: 'TASK',
      gameDate: DAY2,
    });
  });

  it('等待中的轮次用活动期次的日历算归属日，且读操作不建轮次行', async () => {
    const env = await freshEnv();
    const ids = await seedAccount(env, '多期老板', '7004');
    // 订单 00:00；第 1 期只服务 1 次，完成整轮后即可续期。
    const created = await env.services.orders.create(
      orderCommand(ids, {
        serviceCount: 1,
        dailyRefreshMinutes: 0,
        weeklyRefreshMinutes: 0,
        tasks: [checkbox('签到'), cumulative('抽卡', '10')],
      }),
      env.token,
    );
    let detail = (await env.services.queries.orderDetail(created.orderId))!;
    const period1 = detail.periods[0].id;
    const draw1 = detail.cumulative[0];
    await env.services.progress.submit(
      {
        taskId: draw1.taskId,
        totalValue: '10',
        gameDate: DAY1,
        operationId: 'op-r5-multi-first-round',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const check = detail.tasks.find((task) => task.progressType === 'CHECKBOX')!;
    await env.services.tasks.setProgress(
      { taskId: check.id, gameDate: DAY1, value: null, completed: true, backfilled: false },
      env.token,
    );
    let data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(1);
    expect(data.hosting_sessions[0].completedAt).not.toBeNull();

    // 两次续期：期次 1 满员 → 活动期次是**期次 2**；期次 3 只是"最新展示"的那一期。
    const period2 = await env.services.orders.renew(
      { operationId: 'op-r5-renew-1', orderId: created.orderId, durationDays: 1, priceCents: 10000 },
      env.token,
    );
    const period3 = await env.services.orders.renew(
      { operationId: 'op-r5-renew-2', orderId: created.orderId, durationDays: 1, priceCents: 10000 },
      env.token,
    );
    await patchPeriod(env, period1, { dailyRefreshMinutes: 0 });
    await patchPeriod(env, period2, { dailyRefreshMinutes: REFRESH });
    await patchPeriod(env, period3, { dailyRefreshMinutes: 0 });
    env.at(SHANGHAI_0300);

    // 03:00 时：订单/期次 1/期次 3 口径是 03-11，活动期次（期次 2）口径是 03-10。
    const today = await env.services.queries.today({});
    expect(today.gameDate).toBe(DAY2);
    const item = today.hosting.find((row) => row.orderId === created.orderId && row.cumulative)!;
    expect(item).toMatchObject({
      periodId: period2,
      sessionId: null,
      sessionIndex: 2,
      awaitingSession: true,
      gameDate: DAY1,
    });
    expect(item.calendar.dailyRefreshMinutes).toBe(REFRESH);

    // 读操作没有为了算日期而建第 2 轮。
    data = await readData(env);
    expect(data.hosting_sessions).toHaveLength(1);

    detail = (await env.services.queries.orderDetail(created.orderId))!;
    const viewOf = (taskId: string) => detail.cumulative.find((row) => row.taskId === taskId)!;
    const taskOfPeriod = (periodId: string) =>
      data.task_definitions.find(
        (task) => task.periodId === periodId && task.title === '抽卡',
      )!;
    // 每个任务按自己期次的快照给出归属日：同一份详情里可以有两个不同日期。
    expect(viewOf(taskOfPeriod(period1).id).gameDate).toBe(DAY2);
    expect(viewOf(taskOfPeriod(period2).id).gameDate).toBe(DAY1);
    expect(viewOf(taskOfPeriod(period3).id).gameDate).toBe(DAY2);

    // 用订单口径/最新期次的 03-11 提交会被命令层拒绝（活动期次仍在前一天）。
    await expect(
      env.services.progress.submit(
        {
          taskId: viewOf(taskOfPeriod(period2).id).taskId,
          totalValue: '5',
          gameDate: DAY2,
          operationId: 'op-r5-multi-order-date',
          scope: { kind: 'SESSION' },
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await readData(env)).hosting_sessions).toHaveLength(1);

    const accepted = await env.services.progress.submit(
      {
        taskId: viewOf(taskOfPeriod(period2).id).taskId,
        totalValue: '5',
        gameDate: viewOf(taskOfPeriod(period2).id).gameDate,
        operationId: 'op-r5-multi-period-date',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );
    const after = await readData(env);
    const round2 = after.hosting_sessions.find((row) => row.sessionIndex === 2)!;
    expect(round2.periodId).toBe(period2);
    const event = after.task_progress_events.find((row) => row.id === accepted.eventId)!;
    expect(event).toMatchObject({ scopeSessionId: round2.id, gameDate: DAY1 });
  });

  it('多个按日期期次并存时，每个任务用自己的期次快照（页面日期不覆盖期次日期）', async () => {
    const env = await freshEnv();
    const { orderId, periodId: period1 } = await dateOrder(env, [cumulative('抽卡')], DAY1, DAY2);
    await patchPeriod(env, period1, { dailyRefreshMinutes: 0 });
    const period2 = await env.services.orders.renew(
      { operationId: 'op-r5-date-renew', orderId, durationDays: 2, priceCents: 20000 },
      env.token,
    );
    await patchPeriod(env, period2, { dailyRefreshMinutes: REFRESH });
    env.at(SHANGHAI_0300);

    const detail = (await env.services.queries.orderDetail(orderId))!;
    const data = await readData(env);
    const taskOfPeriod = (periodId: string) =>
      data.task_definitions.find((task) => task.periodId === periodId && task.title === '抽卡')!;
    const p1 = detail.cumulative.find((row) => row.taskId === taskOfPeriod(period1).id)!;
    const p2 = detail.cumulative.find((row) => row.taskId === taskOfPeriod(period2).id)!;
    // 期次 1 是 00:00（03-11），期次 2 是 05:00（03-10）；订单是 05:00（03-10）。
    expect(p1).toMatchObject({ scope: { kind: 'PERIOD', periodId: period1 }, gameDate: DAY2 });
    expect(p2).toMatchObject({ scope: { kind: 'PERIOD', periodId: period2 }, gameDate: DAY1 });
    expect(p1.calendar.dailyRefreshMinutes).toBe(0);
    expect(p2.calendar.dailyRefreshMinutes).toBe(REFRESH);

    // 今日列表同样逐条给出自己期次的日期，而不是页面级那一个日期。
    const today = await env.services.queries.today({});
    const p1Item = today.hosting.find((row) => row.taskId === p1.taskId)!;
    expect(p1Item.gameDate).toBe(DAY2);
    expect(today.gameDate).toBe(DAY1);

    const accepted = await env.services.progress.submit(
      {
        taskId: p1.taskId,
        totalValue: '5',
        gameDate: p1.gameDate,
        operationId: 'op-r5-date-period1',
        scope: { kind: 'PERIOD', periodId: period1 },
      },
      env.token,
    );
    const events = (await readData(env)).task_progress_events;
    const event = events.find((row) => row.id === accepted.eventId)!;
    expect(event).toMatchObject({ scopePeriodId: period1, gameDate: DAY2 });
  });

  it('历史更正与退休轮次首次观测保留原归属日，不随"今天"改写', async () => {
    const env = await freshEnv();
    const { orderId, periodId } = await countOrderWithRefresh(
      env,
      0,
      '历史偏移老板',
      '7005',
      [cumulative('抽卡'), cumulative('素材')],
      5,
    );
    await patchPeriod(env, periodId, { dailyRefreshMinutes: REFRESH });
    env.at(SHANGHAI_0300); // 期次口径的"今天"是 03-10
    let detail = (await env.services.queries.orderDetail(orderId))!;
    const draw = detail.cumulative.find((row) => row.title === '抽卡')!;
    const material = detail.cumulative.find((row) => row.title === '素材')!;
    expect(draw.gameDate).toBe(DAY1);

    const first = await env.services.progress.submit(
      {
        taskId: draw.taskId,
        totalValue: '10',
        gameDate: draw.gameDate,
        operationId: 'op-r5-history-first',
        scope: { kind: 'SESSION' },
      },
      env.token,
    );

    // 时钟推进两天：期次的"今天"变了，历史归属日不能跟着走。
    env.at(SHANGHAI_0300 + 2 * DAY_MS);
    const corrected = await env.services.progress.correct(
      {
        operationId: 'op-r5-history-correct',
        correctsEventId: first.eventId,
        kind: 'CORRECT',
        totalValue: '15',
        gameDate: DAY1,
        scope: first.scope,
      },
      env.token,
    );
    expect(corrected.currentTotal).toBe('15');
    const history = await env.services.progress.history(draw.taskId);
    expect(history.map((entry) => entry.gameDate)).toEqual([DAY1, DAY1]);

    // 退休的累计任务：历史轮次的首次观测沿用该轮归属日。
    await retireTask(env, material.taskId, clock);
    detail = (await env.services.queries.orderDetail(orderId))!;
    const historical = detail.historicalTasks.find((task) => task.taskId === material.taskId)!;
    const round = historical.rounds[0];
    expect(round.attributedDate).toBe(DAY1);
    expect(round.hasObservation).toBe(false);

    const recorded = await env.services.progress.submit(
      {
        taskId: material.taskId,
        totalValue: '100',
        gameDate: round.attributedDate as string,
        operationId: 'op-r5-history-retired-first',
        scope: { kind: 'SESSION', sessionId: round.sessionId },
      },
      env.token,
    );
    const data = await readData(env);
    const event = data.task_progress_events.find((row) => row.id === recorded.eventId)!;
    expect(event).toMatchObject({
      scopeType: 'SESSION',
      scopeSessionId: round.sessionId,
      gameDate: DAY1,
      totalValue: '100',
    });
    expect(data.hosting_sessions).toHaveLength(1);
  });
});

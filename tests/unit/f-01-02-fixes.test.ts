import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type { CreateOrderCommand, TemplateTaskDraft } from '../../src/application/contracts';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { coverageSlotFor, slotFor } from '../../src/domain/occurrences';
import type { HostingPeriodRow, TaskDefinitionRow } from '../../src/contracts/tables';

/**
 * 2026-10-26 用户反馈的两条修复：
 * - F-01 每月 / 每 N 天任务在周期窗口内仍能看到状态（读取用覆盖槽，写入仍只在触发日）；
 * - F-02 允许预填未来到账时间（闲鱼担保交易），到账前记为在途、不冲抵待收。
 */

const DAY = 86_400_000;
/** 上海 2026-02-10 12:00。 */
const NOW = Date.UTC(2026, 1, 10, 4, 0);

function makeEnv() {
  let counter = 0;
  const newId = () => `f-${++counter}`;
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

async function seedHosting(
  env: Awaited<ReturnType<typeof freshEnv>>,
  tasks: TemplateTaskDraft[],
  operationId = 'op-create-1',
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
    operationId,
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
  };
  const result = await env.services.orders.create(command, env.token);
  return { ownerId, accountId, ...result };
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
    recurrence: 'DAILY',
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

describe('F-01 周期任务覆盖展示', () => {
  it('每月任务在窗口内每天返回同一条槽，键与归属日仍是触发日', () => {
    const monthly = task({ recurrence: 'MONTHLY', monthDay: 15 });
    expect(coverageSlotFor(monthly, period, '2026-02-15')).toMatchObject({
      key: 'M:2026-02-15',
      gameDate: '2026-02-15',
      windowStart: '2026-02-15',
    });
    expect(coverageSlotFor(monthly, period, '2026-02-20')).toMatchObject({
      key: 'M:2026-02-15',
      gameDate: '2026-02-15',
      windowStart: '2026-02-15',
      windowEnd: '2026-02-28',
    });
    // 触发日早于期次开始日：那条 occurrence 无法写入，因此不展示（避免看得到点不动）。
    expect(coverageSlotFor(monthly, period, '2026-02-14')).toBeNull();
  });

  it('每 N 天任务按间隔窗口覆盖，写入口径不变', () => {
    const every = task({ recurrence: 'EVERY_N_DAYS', everyNDays: 3 });
    expect(coverageSlotFor(every, period, '2026-02-05')).toMatchObject({
      key: 'E:2026-02-04',
      gameDate: '2026-02-04',
      windowStart: '2026-02-04',
      windowEnd: '2026-02-06',
    });
    expect(coverageSlotFor(every, period, '2026-02-07')?.key).toBe('E:2026-02-07');
    expect(slotFor(every, period, '2026-02-05')).toBeNull();
  });

  it('触发日早于任务生效起始日时不提供覆盖展示（避免看得到写不进去）', () => {
    const monthly = task({ recurrence: 'MONTHLY', monthDay: 5, activeFrom: '2026-02-10' });
    expect(coverageSlotFor(monthly, period, '2026-02-12')).toBeNull();
    expect(coverageSlotFor(monthly, period, '2026-03-05')).toBeNull();
  });

  it('日历与今日事项展示本周期状态，补录仍归到触发日', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, [
      {
        title: '月度大活动',
        progressType: 'CHECKBOX',
        startValue: '0',
        targetValue: '1',
        unit: null,
        recurrence: 'MONTHLY',
        weekdays: null,
        everyNDays: null,
        monthDay: 5,
      },
    ]);
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const monthlyTask = detail.tasks[0];
    const day5 = detail.calendar.find((day) => day.gameDate === '2026-02-05')!;
    const day6 = detail.calendar.find((day) => day.gameDate === '2026-02-06')!;
    expect(day5.tasks[0]).toMatchObject({ inWindow: false, attributedDate: '2026-02-05' });
    expect(day6.tasks[0]).toMatchObject({ inWindow: true, attributedDate: '2026-02-05' });

    const today = await env.services.queries.today({});
    const periodic = today.periodic.find((item) => item.taskId === monthlyTask.id)!;
    expect(periodic.gameDate).toBe('2026-02-05');
    expect(periodic.completed).toBe(false);

    await env.services.tasks.setProgress(
      {
        taskId: monthlyTask.id,
        gameDate: periodic.gameDate,
        value: null,
        completed: true,
        backfilled: true,
      },
      env.token,
    );
    const after = (await env.services.queries.orderDetail(orderId))!;
    expect(after.calendar.find((day) => day.gameDate === '2026-02-06')!.tasks[0].completed).toBe(
      true,
    );
    const afterToday = await env.services.queries.today({});
    expect(afterToday.periodic.find((item) => item.taskId === monthlyTask.id)?.completed).toBe(
      true,
    );
  });
});

describe('F-02 未来到账时间与在途款', () => {
  it('允许未来到账时间，但在到账前不计实收、不冲抵待收', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, [CHECKBOX_DAILY]);
    const periodId = (await env.services.queries.orderDetail(orderId))!.periods[0].id;
    await env.services.receipts.record(
      {
        operationId: 'op-future-receipt',
        orderId,
        periodId,
        amountCents: 10000,
        receivedAt: NOW + 10 * DAY,
        channel: 'OTHER',
        note: '闲鱼定金，确认收货后到账',
      },
      env.token,
    );

    const detail = (await env.services.queries.orderDetail(orderId))!;
    expect(detail.order.paidCents).toBe(0);
    expect(detail.order.outstandingCents).toBe(30000);
    expect(detail.periods[0]).toMatchObject({ paidCents: 0, pendingCents: 10000 });
    expect(detail.receipts[0]).toMatchObject({ pending: true, amountCents: 10000 });

    const ledger = await env.services.queries.ledger({ month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(ledger.receivedCents).toBe(0);
    expect(ledger.pendingCents).toBe(10000);
    expect(ledger.pending).toHaveLength(1);
    expect(ledger.outstandingCents).toBe(30000);
  });

  it('到账时间到达后自动计入实收', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, [CHECKBOX_DAILY]);
    const periodId = (await env.services.queries.orderDetail(orderId))!.periods[0].id;
    await env.services.receipts.record(
      {
        operationId: 'op-clock-receipt',
        orderId,
        periodId,
        amountCents: 10000,
        receivedAt: NOW + DAY,
        channel: 'WECHAT',
        note: null,
      },
      env.token,
    );
    expect((await env.services.queries.orderDetail(orderId))!.order.paidCents).toBe(0);

    env.setClock(NOW + 2 * DAY);
    const after = (await env.services.queries.orderDetail(orderId))!;
    expect(after.order.paidCents).toBe(10000);
    expect(after.order.outstandingCents).toBe(20000);
    expect(after.receipts[0].pending).toBe(false);
  });

  it('未来时间最多一年', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, [CHECKBOX_DAILY]);
    const periodId = (await env.services.queries.orderDetail(orderId))!.periods[0].id;
    await expect(
      env.services.receipts.record(
        {
          operationId: 'op-too-far',
          orderId,
          periodId,
          amountCents: 1000,
          receivedAt: NOW + 400 * DAY,
          channel: 'WECHAT',
          note: null,
        },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('托管单不允许一次性任务', async () => {
    const env = await freshEnv();
    await expect(
      seedHosting(env, [
        {
          ...CHECKBOX_DAILY,
          title: '一次性任务',
          recurrence: 'ONE_TIME',
        },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type { CreateOrderCommand, TemplateTaskDraft } from '../../src/application/contracts';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { orderExpiryBadge } from '../../src/features/orders/orderExpiry';

/**
 * 2026-10-30 用户反馈：订单开始时间可以是未来的某一时间（预定单）。
 *
 * 数据层本来就允许（契约不禁止未来期次）；这次补齐网页端的表达：
 * 今日事项给出「预定中」而不是静默消失、列表显示"未开始/距开始 N 天"、
 * 订单详情不再把未生效任务标成"今日未完成"。
 */

const DAY = 86_400_000;
/** 上海 2026-02-10 12:00（刷新 05:00 → 游戏日 2026-02-10）。 */
const NOW = Date.UTC(2026, 1, 10, 4, 0);

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

function makeEnv() {
  let counter = 0;
  const newId = () => `p-${++counter}`;
  let clock = NOW;
  const runtime = new DatasetRuntime({ newId, now: () => clock });
  const services = createServices(runtime, () => clock, newId);
  return {
    services,
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
  await env.services.runtime.init();
  const token = await env.services.runtime.current();
  await env.services.templates.ensureBuiltIns();
  return { ...env, token };
}

async function seedHosting(
  env: Awaited<ReturnType<typeof freshEnv>>,
  patch: Partial<CreateOrderCommand> = {},
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
    operationId: 'op-preorder-1',
    ownerId,
    accountId,
    type: 'HOSTING',
    title: '三月预订单',
    notes: null,
    paymentMode: 'INSTALLMENTS',
    priceCents: null,
    deadlineDate: null,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    startDate: '2026-03-01',
    endDate: '2026-03-30',
    periodPriceCents: 30000,
    tasks: [CHECKBOX_DAILY],
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...patch,
  };
  const result = await env.services.orders.create(command, env.token);
  return result.orderId;
}

describe('预定单（未来开始的托管期次）', () => {
  it('建单成功，但今天不产生任务：改为「预定中」提示', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env);

    const today = await env.services.queries.today({});
    expect(today.hosting).toHaveLength(0);
    // 不是"需要处理"，而是明确的预定中。
    expect(today.staleOrders).toHaveLength(0);
    expect(today.upcoming).toEqual([
      {
        orderId,
        title: '三月预订单',
        ownerName: '#1 老板甲',
        accountName: '原神 · 官服',
        startDate: '2026-03-01',
        endDate: '2026-03-30',
        taskCount: 1,
        daysUntilStart: 19,
      },
    ]);
  });

  it('订单详情与期次都标「未开始」，日历仍可预览', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env);

    const detail = (await env.services.queries.orderDetail(orderId))!;
    expect(detail.status).toBe('NOT_STARTED');
    expect(detail.periods[0].status).toBe('NOT_STARTED');
    // 预排仍是 30 天，只是不能打卡。
    expect(detail.calendar).toHaveLength(30);
    expect(detail.calendar[0].gameDate).toBe('2026-03-01');
  });

  it('开始前打卡与批量补录都被拒绝（不产生任何打卡行）', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env);
    const detail = (await env.services.queries.orderDetail(orderId))!;
    const taskId = detail.tasks[0].id;

    await expect(
      env.services.tasks.setProgress(
        { taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
        env.token,
      ),
    ).rejects.toThrow(/不在服务期限内/);
    // 批量补录不报错，但绝不写入：全部日期被跳过并给出原因。
    const batch = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-10'] },
      env.token,
    );
    expect(batch.recorded).toBe(0);
    expect(batch.skipped[0].reason).toContain('不在服务期限内');
    expect((await env.services.queries.orderDetail(orderId))!.status).toBe('NOT_STARTED');
  });

  it('开始后自动进入今日事项，预定提示消失', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env);

    env.setClock(NOW + 19 * DAY); // 游戏日 2026-03-01
    const started = await env.services.queries.today({});
    expect(started.upcoming).toHaveLength(0);
    expect(started.hosting.map((item) => item.title)).toEqual(['每日签到']);
    expect(started.hosting[0].gameDate).toBe('2026-03-01');

    const detail = (await env.services.queries.orderDetail(orderId))!;
    expect(detail.status).toBe('ACTIVE');
    expect(detail.periods[0].status).toBe('ACTIVE');
  });

  it('列表徽章：未开始时说「预定 X 开始 · 距开始 N 天」，开始后回到剩余天数', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env);
    const summary = (await env.services.queries.orders({})).find((row) => row.id === orderId)!;
    expect(summary.currentPeriodStart).toBe('2026-03-01');

    expect(orderExpiryBadge(summary, NOW)).toMatchObject({
      notStarted: true,
      daysLeft: 19,
      label: '预定 2026-03-01 开始 · 距开始 19 天',
    });
    expect(orderExpiryBadge(summary, NOW + 19 * DAY)?.notStarted).toBe(false);
  });

  it('提前续期产生的未来期次不会把进行中的订单误判成未开始', async () => {
    const env = await freshEnv();
    const orderId = await seedHosting(env, {
      operationId: 'op-preorder-active',
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    await env.services.orders.renew(
      { operationId: 'op-preorder-renew', orderId, durationDays: 10, priceCents: 20000 },
      env.token,
    );

    const summary = (await env.services.queries.orders({})).find((row) => row.id === orderId)!;
    // 开始日取"今天所在期次"，结束日仍是最新期次（既有口径）。
    expect(summary.currentPeriodStart).toBe('2026-02-01');
    expect(summary.currentPeriodEnd).toBe('2026-03-10');
    expect(orderExpiryBadge(summary, NOW)?.notStarted).toBe(false);
    expect((await env.services.queries.orderDetail(orderId))!.status).toBe('ACTIVE');
  });
});

import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import type { CreateOrderCommand } from '../../src/application/contracts';

const NOW = Date.UTC(2026, 1, 10, 4, 0); // 上海 2026-02-10 12:00

function makeEnv() {
  let counter = 0;
  const newId = () => `cbd-${++counter}`;
  const runtime = new DatasetRuntime({ newId, now: () => NOW });
  const services = createServices(runtime, () => NOW, newId);
  return { runtime, services, newId };
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

type Env = Awaited<ReturnType<typeof freshEnv>>;

async function seedHosting(env: Env, overrides: Partial<CreateOrderCommand> = {}) {
  const ownerId = await env.services.accounts.saveOwner({ nickname: '批量老板' }, env.token);
  const accountId = await env.services.accounts.saveAccount(
    {
      ownerId,
      gameName: '原神',
      server: '官服',
      uid: '2002',
      loginAccount: 'acc',
      loginMethod: 'PASSWORD',
      password: 'secret',
    },
    env.token,
  );
  const dailyTask = {
    title: '日常',
    progressType: 'CHECKBOX' as const,
    startValue: '0',
    targetValue: '1',
    unit: null,
    recurrence: 'DAILY' as const,
    weekdays: null,
    everyNDays: null,
    monthDay: null,
  };
  const command: CreateOrderCommand = {
    operationId: 'cbd-create-1',
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
    tasks: [dailyTask, { ...dailyTask, title: '体力' }],
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
  const result = await env.services.orders.create(command, env.token);
  return { ownerId, accountId, command, ...result };
}

function calendarRows(detail: Awaited<ReturnType<Env['services']['queries']['orderDetail']>>) {
  return new Map(
    (detail?.calendar ?? []).map((day) => [
      day.gameDate,
      day.tasks.filter((task) => !task.inWindow),
    ]),
  );
}

describe('日历多选补录 completeDates', () => {
  it('一次补录多个日期：逐日写入各应做任务的完成打卡', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);

    const result = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-05', '2026-02-03', '2026-02-04'] },
      env.token,
    );
    expect(result.recorded).toBe(6);
    expect(result.dates).toBe(3);
    expect(result.skipped).toEqual([]);

    const rows = calendarRows(await env.services.queries.orderDetail(orderId));
    for (const date of ['2026-02-03', '2026-02-04', '2026-02-05']) {
      const tasks = rows.get(date) ?? [];
      expect(tasks.map((task) => task.title).sort()).toEqual(['体力', '日常']);
      expect(tasks.every((task) => task.completed)).toBe(true);
      // 历史日期必须标记为补录，报表才能区分当日记录与后补。
      expect(tasks.every((task) => task.backfilled)).toBe(true);
    }
  });

  it('今日的批量打卡不标补录', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);

    await env.services.tasks.completeDates({ orderId, dates: ['2026-02-10'] }, env.token);
    const rows = calendarRows(await env.services.queries.orderDetail(orderId));
    const tasks = rows.get('2026-02-10') ?? [];
    expect(tasks.every((task) => task.completed)).toBe(true);
    expect(tasks.every((task) => task.backfilled)).toBe(false);
  });

  it('重复提交幂等：已完成的行保持原样，不重复写入', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);

    const first = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-04', '2026-02-05'] },
      env.token,
    );
    expect(first.recorded).toBe(4);
    const second = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-04', '2026-02-05'] },
      env.token,
    );
    expect(second.recorded).toBe(0);
    expect(second.dates).toBe(0);

    const rows = calendarRows(await env.services.queries.orderDetail(orderId));
    expect((rows.get('2026-02-04') ?? []).every((task) => task.completed)).toBe(true);
  });

  it('未来日期整批拒绝，且不留下部分写入', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);

    await expect(
      env.services.tasks.completeDates({ orderId, dates: ['2026-02-03', '2026-02-11'] }, env.token),
    ).rejects.toThrow(/未来日期/);

    const rows = calendarRows(await env.services.queries.orderDetail(orderId));
    expect((rows.get('2026-02-03') ?? []).some((task) => task.completed)).toBe(false);
  });

  it('累计任务跳过并给出原因，其余普通任务照常补录', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, {
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
        {
          title: '刷材料',
          progressType: 'NUMERIC',
          startValue: '0',
          targetValue: '5',
          unit: '次',
          recurrence: 'DAILY',
          weekdays: null,
          everyNDays: null,
          monthDay: null,
          numericMode: 'CUMULATIVE',
        },
      ],
    });

    const result = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-06'] },
      env.token,
    );
    expect(result.recorded).toBe(1);
    expect(result.dates).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].title).toBe('刷材料');
    expect(result.skipped[0].reason).toMatch(/累计/);
  });

  it('非服务日没有应做任务，不写入任何记录', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, {
      serviceDays: 20,
      serviceWeekdays: [1, 2, 3, 4, 5],
    });

    const result = await env.services.tasks.completeDates(
      { orderId, dates: ['2026-02-07'] }, // 周六
      env.token,
    );
    expect(result.recorded).toBe(0);
    expect(result.dates).toBe(0);
  });

  it('按次数托管必须逐轮打卡，按日期批量被拒绝', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, {
      serviceCount: 10,
      startDate: '2026-02-01',
      endDate: null,
      periodPriceCents: 30000,
    });

    await expect(
      env.services.tasks.completeDates({ orderId, dates: ['2026-02-03'] }, env.token),
    ).rejects.toThrow(/按次数/);
  });

  it('空日期与非 ISO 日期被拒绝', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);

    await expect(env.services.tasks.completeDates({ orderId, dates: [] }, env.token)).rejects.toThrow(
      /请选择日期/,
    );
    await expect(
      env.services.tasks.completeDates({ orderId, dates: ['2026-2-3'] }, env.token),
    ).rejects.toThrow(/游戏日期/);
  });
});

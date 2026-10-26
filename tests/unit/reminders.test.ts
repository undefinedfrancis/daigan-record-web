import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { BUSINESS_TABLES, type BackupDataSet } from '../../src/contracts/tables';
import { openBusinessDb, writeDataSet } from '../../src/storage/businessDb';
import type { CreateOrderCommand } from '../../src/application/contracts';

const NOW = Date.UTC(2026, 1, 10, 4, 0); // 上海 2026-02-10 12:00

async function freshEnv() {
  await Dexie.delete('daigan-control');
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-')) await Dexie.delete(name);
  }
  resetControlDb();
  let counter = 0;
  const newId = () => `rmd-${++counter}`;
  let clock = NOW;
  const runtime = new DatasetRuntime({ newId, now: () => clock });
  const services = createServices(runtime, () => clock, newId);
  const token = await runtime.init();
  await services.templates.ensureBuiltIns();
  return {
    services,
    token,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

type Env = Awaited<ReturnType<typeof freshEnv>>;

async function seedOrder(env: Env, overrides: Partial<CreateOrderCommand> = {}) {
  const ownerId = await env.services.accounts.saveOwner({ nickname: '提醒老板' }, env.token);
  const accountId = await env.services.accounts.saveAccount(
    {
      ownerId,
      gameName: '原神',
      server: '官服',
      uid: '3003',
      loginAccount: 'acc',
      loginMethod: 'PASSWORD',
      password: 'secret',
    },
    env.token,
  );
  const daily = {
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
    operationId: 'rmd-create-1',
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
    tasks: [daily],
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
  const result = await env.services.orders.create(command, env.token);
  const detail = await env.services.queries.orderDetail(result.orderId);
  return { orderId: result.orderId, taskId: detail?.tasks[0]?.id ?? '', ownerId, accountId };
}

describe('站内提醒 reminders', () => {
  it('到点前不弹出，到点后带订单与老板信息出现在到期列表', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);

    await env.services.reminders.save(
      { orderId, taskId: null, remindAt: NOW + 60 * 60 * 1000, note: '提醒收尾款' },
      env.token,
    );
    expect(await env.services.reminders.due()).toHaveLength(0);

    env.setClock(NOW + 2 * 60 * 60 * 1000);
    const due = await env.services.reminders.due();
    expect(due).toHaveLength(1);
    expect(due[0].orderId).toBe(orderId);
    expect(due[0].orderTitle).toBe('二月托管');
    expect(due[0].ownerNickname).toBe('提醒老板');
    expect(due[0].taskId).toBeNull();
    expect(due[0].note).toBe('提醒收尾款');
  });

  it('任务提醒带出任务标题，非该订单任务被拒绝', async () => {
    const env = await freshEnv();
    const first = await seedOrder(env);

    await env.services.reminders.save(
      { orderId: first.orderId, taskId: first.taskId, remindAt: NOW + 3_600_000, note: null },
      env.token,
    );
    env.setClock(NOW + 7_200_000);
    const due = await env.services.reminders.due();
    expect(due[0].taskTitle).toBe('日常');

    env.setClock(NOW);
    await expect(
      env.services.reminders.save(
        { orderId: 'missing-order', taskId: null, remindAt: NOW + 3_600_000, note: null },
        env.token,
      ),
    ).rejects.toThrow(/订单/);
    await expect(
      env.services.reminders.save(
        { orderId: first.orderId, taskId: 'missing-task', remindAt: NOW + 3_600_000, note: null },
        env.token,
      ),
    ).rejects.toThrow(/任务/);
  });

  it('拒绝过去时间、非法时间与超长备注', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);

    await expect(
      env.services.reminders.save(
        { orderId, taskId: null, remindAt: NOW - 1000, note: null },
        env.token,
      ),
    ).rejects.toThrow(/晚于/);
    await expect(
      env.services.reminders.save(
        { orderId, taskId: null, remindAt: Number.NaN, note: null },
        env.token,
      ),
    ).rejects.toThrow(/时间/);
    await expect(
      env.services.reminders.save(
        { orderId, taskId: null, remindAt: NOW + 3_600_000, note: 'x'.repeat(201) },
        env.token,
      ),
    ).rejects.toThrow(/备注/);
  });

  it('已归档订单不再弹提醒', async () => {
    const env = await freshEnv();
    // 期次已结束，老板才可以归档（归档守卫要求没有未到期托管服务）。
    const archived = await seedOrder(env, { endDate: '2026-02-05' });
    await env.services.reminders.save(
      { orderId: archived.orderId, taskId: null, remindAt: NOW + 60_000, note: null },
      env.token,
    );
    env.setClock(NOW + 120_000);
    expect(await env.services.reminders.due()).toHaveLength(1);
    await env.services.accounts.archive('owner', archived.ownerId, env.token);
    expect(await env.services.reminders.due()).toHaveLength(0);
  });

  it('已作废订单不再弹提醒', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.reminders.save(
      { orderId, taskId: null, remindAt: NOW + 60_000, note: null },
      env.token,
    );
    env.setClock(NOW + 120_000);
    expect(await env.services.reminders.due()).toHaveLength(1);
    await env.services.orders.cancel(orderId, env.token);
    expect(await env.services.reminders.due()).toHaveLength(0);
  });

  it('编辑订单删掉任务时一并清掉该任务的提醒', async () => {
    const env = await freshEnv();
    const { orderId, taskId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    const period = detail!.periods[0];

    await env.services.reminders.save(
      { orderId, taskId, remindAt: NOW + 60_000, note: null },
      env.token,
    );
    await env.services.orders.update(
      {
        orderId,
        title: '二月托管',
        notes: null,
        paymentMode: 'INSTALLMENTS',
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        monthlyRefreshDays: null,
        priceCents: null,
        deadlineDate: null,
        periods: [
          {
            periodId: period.id,
            startDate: period.startDate,
            endDate: period.endDate,
            priceCents: period.priceCents,
          },
        ],
        tasks: [],
      },
      env.token,
    );

    env.setClock(NOW + 120_000);
    expect(await env.services.reminders.due()).toHaveLength(0);
    const db = openBusinessDb(env.token.databaseName);
    try {
      expect(await db.local_reminders.count()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('单笔订单最多 20 条未读提醒', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);

    for (let index = 0; index < 20; index += 1) {
      await env.services.reminders.save(
        { orderId, taskId: null, remindAt: NOW + (index + 1) * 60_000, note: `第 ${index}` },
        env.token,
      );
    }
    await expect(
      env.services.reminders.save(
        { orderId, taskId: null, remindAt: NOW + 3_600_000, note: null },
        env.token,
      ),
    ).rejects.toThrow(/最多/);
  });

  it('知道了之后不再弹出，但订单里仍能看到已提醒记录', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);

    const id = await env.services.reminders.save(
      { orderId, taskId: null, remindAt: NOW + 60_000, note: null },
      env.token,
    );
    env.setClock(NOW + 120_000);
    await env.services.reminders.acknowledge([id], env.token);

    expect(await env.services.reminders.due()).toHaveLength(0);
    const list = await env.services.reminders.list(orderId);
    expect(list).toHaveLength(1);
    expect(list[0].acknowledgedAt).not.toBeNull();
  });

  it('删除订单级联清掉本机提醒', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.reminders.save(
      { orderId, taskId: null, remindAt: NOW + 60_000, note: null },
      env.token,
    );

    await env.services.orders.cancel(orderId, env.token);
    await env.services.orders.deleteCancelled(orderId, env.token);

    const db = openBusinessDb(env.token.databaseName);
    try {
      expect(await db.local_reminders.count()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('恢复备份会清空本机提醒，避免指向已不存在的订单', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.reminders.save(
      { orderId, taskId: null, remindAt: NOW + 60_000, note: null },
      env.token,
    );

    const empty = Object.fromEntries(
      BUSINESS_TABLES.map((table) => [table, []]),
    ) as unknown as BackupDataSet;
    const db = openBusinessDb(env.token.databaseName);
    try {
      expect(await db.local_reminders.count()).toBe(1);
      await writeDataSet(db, empty, new Map());
      expect(await db.local_reminders.count()).toBe(0);
    } finally {
      db.close();
    }
  });
});

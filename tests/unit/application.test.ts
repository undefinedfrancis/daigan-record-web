import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import type {
  CreateOrderCommand,
  TemplateTaskDraft,
  UpdateOrderCommand,
} from '../../src/application/contracts';

const NOW = Date.UTC(2026, 1, 10, 4, 0); // 上海 2026-02-10 12:00

function makeEnv() {
  let counter = 0;
  const newId = () => `id-${++counter}`;
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

async function seedOrder(
  env: Awaited<ReturnType<typeof freshEnv>>,
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
    operationId: 'op-create-1',
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
    tasks: [
      {
        title: '每日签到',
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
    firstReceipt: {
      amountCents: 10000,
      receivedAt: NOW - 60_000,
      channel: 'WECHAT',
      note: null,
    },
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
  const result = await env.services.orders.create(command, env.token);
  return { ownerId, accountId, command, ...result };
}

function taskDraft(title: string): TemplateTaskDraft {
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

describe('本地资料与业务命令', () => {
  beforeEach(async () => {
    resetControlDb();
    await Dexie.delete('daigan-control');
  });

  it('空账本初始化后可以创建老板与账号', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板甲' }, env.token);
    expect(ownerId).toBeTruthy();
    const owners = await env.services.queries.owners(false);
    expect(owners).toHaveLength(1);
    expect(owners[0].number).toBe(1);

    const second = await env.services.accounts.saveOwner({ nickname: '老板乙' }, env.token);
    const list = await env.services.queries.owners(false);
    expect(list.map((item) => item.number)).toEqual([1, 2]);
    expect(second).not.toBe(ownerId);
  });

  it('验证码登录不保存密码', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板' }, env.token);
    const accountId = await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '游戏',
        server: '官服',
        uid: '1',
        loginAccount: 'acc',
        loginMethod: 'VERIFICATION_CODE',
        password: '不该保存',
      },
      env.token,
    );
    const detail = await env.services.queries.ownerDetail(ownerId);
    const account = detail?.accounts.find((item) => item.id === accountId);
    expect(account?.password).toBeNull();
  });

  it('建单写入期次、任务与首笔收款', async () => {
    const env = await freshEnv();
    const { orderId, receiptId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.periods).toHaveLength(1);
    expect(detail?.tasks).toHaveLength(1);
    expect(detail?.receipts).toHaveLength(1);
    expect(receiptId).toBe(detail?.receipts[0].id);
    expect(detail?.order.outstandingCents).toBe(20000);
  });

  it('相同 operationId 重试返回原订单，改载荷拒绝', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const retry = await env.services.orders.create(command, env.token);
    expect(retry.orderId).toBe(orderId);
    await expect(
      env.services.orders.create({ ...command, title: '换了个标题' }, env.token),
    ).rejects.toThrow(/内容不同/);
  });

  it('今日事项只列出当前游戏日的打卡项', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const today = await env.services.queries.today({});
    expect(today.gameDate).toBe('2026-02-10');
    expect(today.hosting).toHaveLength(1);

    const taskId = today.hosting[0].taskId;
    await env.services.tasks.setProgress(
      { taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );
    const after = await env.services.queries.today({});
    expect(after.hosting[0].completed).toBe(true);

    // 同一任务重复打卡不产生第二条发生记录
    await env.services.tasks.setProgress(
      { taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );
    const detail = await env.services.queries.orderDetail(orderId);
    const day = detail?.calendar.find((item) => item.gameDate === '2026-02-10');
    expect(day?.tasks).toHaveLength(1);
  });

  it('不能为未来日期打卡', async () => {
    const env = await freshEnv();
    await seedOrder(env);
    const today = await env.services.queries.today({});
    await expect(
      env.services.tasks.setProgress(
        {
          taskId: today.hosting[0].taskId,
          gameDate: '2026-02-12',
          value: '1',
          completed: true,
          backfilled: false,
        },
        env.token,
      ),
    ).rejects.toThrow(/未来/);
  });

  it('收款超过余额被拒绝，作废后待收恢复', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    await expect(
      env.services.receipts.record(
        {
          operationId: 'op-r1',
          orderId,
          periodId: detail!.periods[0].id,
          amountCents: 50000,
          receivedAt: NOW - 1000,
          channel: 'CASH',
          note: null,
        },
        env.token,
      ),
    ).rejects.toThrow(/超过/);

    const receiptId = await env.services.receipts.record(
      {
        operationId: 'op-r2',
        orderId,
        periodId: detail!.periods[0].id,
        amountCents: 5000,
        receivedAt: NOW - 1000,
        channel: 'CASH',
        note: null,
      },
      env.token,
    );
    const withReceipt = await env.services.queries.orderDetail(orderId);
    expect(withReceipt?.periods[0].outstandingCents).toBe(15000);

    await env.services.receipts.void({ operationId: 'op-v1', receiptId, reason: '记错了' }, env.token);
    const afterVoid = await env.services.queries.orderDetail(orderId);
    expect(afterVoid?.periods[0].outstandingCents).toBe(20000);
    expect(afterVoid?.receipts.find((row) => row.id === receiptId)?.status).toBe('VOIDED');
    expect(afterVoid?.corrections).toHaveLength(1);
  });

  it('更正保留原行并生成新流水', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    const original = detail!.receipts[0];
    const newId = await env.services.receipts.amend(
      {
        operationId: 'op-amend-1',
        receiptId: original.id,
        amountCents: 12000,
        receivedAt: original.receivedAt,
        channel: 'ALIPAY',
        note: null,
        reason: '渠道填错',
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.receipts.find((row) => row.id === original.id)?.status).toBe('REPLACED');
    expect(after?.receipts.find((row) => row.id === newId)?.amountCents).toBe(12000);
    expect(after?.periods[0].paidCents).toBe(12000);
  });

  it('续期创建新期次且不重写旧流水', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env, {
      startDate: '2026-01-01',
      endDate: '2026-02-05',
    });
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = await env.services.orders.renew(
      { operationId: 'op-renew-1', orderId, durationDays: 28, priceCents: 28000 },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.periods).toHaveLength(2);
    expect(after?.periods.find((row) => row.id === periodId)?.startDate).toBe('2026-02-10');
    expect(after?.periods[0].paidCents).toBe(before?.periods[0].paidCents);
    const retry = await env.services.orders.renew(
      { operationId: 'op-renew-1', orderId, durationDays: 28, priceCents: 28000 },
      env.token,
    );
    expect(retry).toBe(periodId);
  });

  it('归档有未到期托管服务的老板被拒绝', async () => {
    const env = await freshEnv();
    const { ownerId } = await seedOrder(env);
    await expect(env.services.accounts.archive('owner', ownerId, env.token)).rejects.toThrow(
      /未到期/,
    );
  });

  it('作废订单后退出待收但保留实收', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.orders.cancel(orderId, env.token);
    const ledger = await env.services.queries.ledger({ month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(ledger.receivedCents).toBe(10000);
    expect(ledger.outstandingCents).toBe(0);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.receipts).toHaveLength(1);
  });

  it('旧代次令牌被拒绝', async () => {
    const env = await freshEnv();
    const stale = { ...env.token, generation: env.token.generation - 1 };
    await expect(
      env.services.accounts.saveOwner({ nickname: '新老板' }, stale),
    ).rejects.toThrow(/资料已切换/);
  });

  it('导出后可恢复为新的本机资料', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const exported = await env.services.exportBackup.exportCurrent();
    expect(exported.blob.size).toBeGreaterThan(0);

    const preview = await env.services.restore.prepareRestore(exported.blob);
    expect(preview.counts.orders).toBe(1);
    expect(preview.outstandingCents).toBe(20000);

    const nextToken = await env.services.restore.commitRestore(preview.sessionId, env.token);
    expect(nextToken.databaseName).not.toBe(env.token.databaseName);

    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.order.title).toBe('二月托管');
    expect(detail?.periods[0].outstandingCents).toBe(20000);

    await expect(
      env.services.accounts.saveOwner({ nickname: '旧页面' }, env.token),
    ).rejects.toThrow(/资料已切换/);
  });

  it('加密备份恢复需要正确密码', async () => {
    const env = await freshEnv();
    await seedOrder(env);
    const exported = await env.services.exportBackup.exportCurrent('代肝🔐');
    await expect(env.services.restore.prepareRestore(exported.blob)).rejects.toThrow(/密码/);
    const preview = await env.services.restore.prepareRestore(exported.blob, '代肝🔐');
    expect(preview.counts.owners).toBe(1);
    await env.services.restore.cancelRestore(preview.sessionId);
  });

  it('订单改名只改名称，不动期次与收款', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.orders.rename(orderId, '二月托管（改名）', env.token);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.order.title).toBe('二月托管（改名）');
    expect(detail?.periods).toHaveLength(1);
    expect(detail?.receipts).toHaveLength(1);
  });

  it('改价不能低于已收，改后待收同步', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    const periodId = detail!.periods[0].id;

    await expect(
      env.services.orders.changePrice({ orderId, periodId, priceCents: 5000 }, env.token),
    ).rejects.toThrow(/不能低于已收/);

    await env.services.orders.changePrice({ orderId, periodId, priceCents: 50000 }, env.token);
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.periods[0].priceCents).toBe(50000);
    expect(after?.periods[0].outstandingCents).toBe(40000);
    expect(after?.receipts[0].amountCents).toBe(10000);
  });

  it('全量修改一次提交改标题、备注、付款方式与任务', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;
    await env.services.orders.update(
      {
        orderId,
        title: '二月托管（全改）',
        notes: '备注内容',
        paymentMode: 'ONE_TIME',
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        priceCents: null,
        deadlineDate: null,
        periods: [
          { periodId, startDate: '2026-02-01', endDate: '2026-02-28', priceCents: 30000, serviceDays: null },
        ],
        tasks: [{ id: taskId, periodId, task: { ...command.tasks[0], title: '每日签到（改）' } }],
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.order.title).toBe('二月托管（全改）');
    expect(after?.notes).toBe('备注内容');
    expect(after?.paymentMode).toBe('ONE_TIME');
    expect(after?.tasks).toHaveLength(1);
    expect(after?.tasks[0].id).toBe(taskId);
    expect(after?.tasks[0].title).toBe('每日签到（改）');
    expect(after?.periods[0].priceCents).toBe(30000);
    expect(after?.receipts).toHaveLength(1);
  });

  it('建单保存每月刷新日并同步到期次副本', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env, { monthlyRefreshDays: ' 20, 5, 5 ' });
    const detail = await env.services.queries.orderDetail(orderId);
    // 归一化为升序去重的日号串。
    expect(detail?.monthlyRefreshDays).toBe('5,20');
    const snapshot = await env.services.exportSnapshot();
    const periods = (
      snapshot.data as unknown as { hosting_periods: { monthlyRefreshDays: string | null }[] }
    ).hosting_periods;
    expect(periods.map((row) => row.monthlyRefreshDays)).toEqual(['5,20']);
  });

  it('每月刷新日非法日号被拒绝', async () => {
    const env = await freshEnv();
    await expect(seedOrder(env, { monthlyRefreshDays: '0,40' })).rejects.toThrow(/每月刷新日/);
  });

  it('全量修改可切换刷新周期并同步期次副本', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;
    const base: UpdateOrderCommand = {
      orderId,
      title: '二月托管',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      monthlyRefreshDays: '1,15',
      priceCents: null,
      deadlineDate: null,
      periods: [
        { periodId, startDate: '2026-02-01', endDate: '2026-02-28', priceCents: 30000, serviceDays: null },
      ],
      tasks: [{ id: taskId, periodId, task: command.tasks[0] }],
    };
    await env.services.orders.update(base, env.token);
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.monthlyRefreshDays).toBe('1,15');
    const snapshot = await env.services.exportSnapshot();
    const periods = (
      snapshot.data as unknown as { hosting_periods: { monthlyRefreshDays: string | null }[] }
    ).hosting_periods;
    expect(periods[0].monthlyRefreshDays).toBe('1,15');

    // 切回按周刷新：订单与期次副本同时清空。
    await env.services.orders.update({ ...base, monthlyRefreshDays: null }, env.token);
    const back = await env.services.queries.orderDetail(orderId);
    expect(back?.monthlyRefreshDays).toBeNull();
    const cleared = (
      (await env.services.exportSnapshot()).data as unknown as {
        hosting_periods: { monthlyRefreshDays: string | null }[];
      }
    ).hosting_periods;
    expect(cleared[0].monthlyRefreshDays).toBeNull();
  });

  it('全量修改改价写审计，且不能低于已收', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;
    const base: Omit<UpdateOrderCommand, 'periods'> = {
      orderId,
      title: '二月托管',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      priceCents: null,
      deadlineDate: null,
      tasks: [{ id: taskId, periodId, task: command.tasks[0] }],
    };
    await env.services.orders.update(
      {
        ...base,
        periods: [
          { periodId, startDate: '2026-02-01', endDate: '2026-02-28', priceCents: 50000, serviceDays: null },
        ],
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.periods[0].priceCents).toBe(50000);
    expect(after?.periods[0].outstandingCents).toBe(40000);
    const snapshot = await env.services.exportSnapshot();
    const changes = (snapshot.data as unknown as { order_price_changes: unknown[] }).order_price_changes;
    expect(changes).toHaveLength(1);
    expect((changes[0] as { previousPriceCents: number }).previousPriceCents).toBe(30000);
    expect((changes[0] as { newPriceCents: number }).newPriceCents).toBe(50000);

    await expect(
      env.services.orders.update(
        {
          ...base,
          periods: [
            { periodId, startDate: '2026-02-01', endDate: '2026-02-28', priceCents: 500, serviceDays: null },
          ],
        },
        env.token,
      ),
    ).rejects.toThrow(/已收/);
  });

  it('全量修改增删任务并重建打卡项，有记录任务不能删', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;
    await env.services.tasks.setProgress(
      { taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );
    const extra: TemplateTaskDraft = {
      title: '素材清空',
      progressType: 'CHECKBOX',
      startValue: '0',
      targetValue: '1',
      unit: null,
      recurrence: 'DAILY',
      weekdays: null,
      everyNDays: null,
      monthDay: null,
    };
    const periods: UpdateOrderCommand['periods'] = [
      { periodId, startDate: '2026-02-01', endDate: '2026-02-28', priceCents: 30000, serviceDays: null },
    ];
    const base = {
      orderId,
      title: '二月托管',
      notes: null,
      paymentMode: 'INSTALLMENTS' as const,
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      priceCents: null,
      deadlineDate: null,
    };

    // 有打卡记录的任务被移出清单 → 拒绝删除
    await expect(
      env.services.orders.update(
        { ...base, periods, tasks: [{ id: null, periodId, task: extra }] },
        env.token,
      ),
    ).rejects.toThrow(/不能删除/);

    // 原任务改排期 + 新增任务：打卡记录保留，今日出现 2 项
    await env.services.orders.update(
      {
        ...base,
        periods,
        tasks: [
          {
            id: taskId,
            periodId,
            task: {
              ...command.tasks[0],
              recurrence: 'SELECTED_WEEKDAYS',
              weekdays: '1,2,3,4,5',
            },
          },
          { id: null, periodId, task: extra },
        ],
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.tasks).toHaveLength(2);
    expect(after?.tasks.find((item) => item.id === taskId)?.title).toBe('每日签到');
    const today = await env.services.queries.today({});
    expect(today.hosting).toHaveLength(2);
    // 2026-02-10 的打卡记录在改排期后保留
    const day = after?.calendar.find((item) => item.gameDate === '2026-02-10');
    expect(day?.tasks.find((item) => item.taskId === taskId)?.completed).toBe(true);

    // 未打卡的新任务可以删除
    await env.services.orders.update(
      {
        ...base,
        periods,
        tasks: [
          {
            id: taskId,
            periodId,
            task: {
              ...command.tasks[0],
              recurrence: 'SELECTED_WEEKDAYS',
              weekdays: '1,2,3,4,5',
            },
          },
        ],
      },
      env.token,
    );
    const cleaned = await env.services.queries.orderDetail(orderId);
    expect(cleaned?.tasks).toHaveLength(1);
    const snapshot = await env.services.exportSnapshot();
    const rows = (snapshot.data as unknown as { task_occurrences: { taskDefinitionId: string }[] })
      .task_occurrences;
    expect(rows.every((row) => row.taskDefinitionId === taskId)).toBe(true);
  });

  it('已有打卡记录时不能移动期次开始日期', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;
    await env.services.tasks.setProgress(
      { taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );
    const base = {
      orderId,
      title: '二月托管',
      notes: null,
      paymentMode: 'INSTALLMENTS' as const,
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 300,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      priceCents: null,
      deadlineDate: null,
      tasks: [{ id: taskId, periodId, task: command.tasks[0] }],
    };
    await expect(
      env.services.orders.update(
        {
          ...base,
          periods: [
            { periodId, startDate: '2026-02-05', endDate: '2026-02-28', priceCents: 30000, serviceDays: null },
          ],
        },
        env.token,
      ),
    ).rejects.toThrow(/不能移动开始日期/);

    // 后移结束日期可以，已有记录保留
    await env.services.orders.update(
      {
        ...base,
        periods: [
          { periodId, startDate: '2026-02-01', endDate: '2026-03-05', priceCents: 30000, serviceDays: null },
        ],
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.periods[0].endDate).toBe('2026-03-05');
    const day = after?.calendar.find((item) => item.gameDate === '2026-02-10');
    expect(day?.tasks[0]?.completed).toBe(true);
  });

  it('订单颜色标记可设置、清除并随查询返回', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    await env.services.orders.setOrderColor(orderId, 'blue', env.token);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.order.colorTag).toBe('blue');
    const list = await env.services.queries.orders({});
    expect(list.find((item) => item.id === orderId)?.colorTag).toBe('blue');
    await env.services.orders.setOrderColor(orderId, null, env.token);
    const cleared = await env.services.queries.orderDetail(orderId);
    expect(cleared?.order.colorTag).toBeNull();
    await expect(env.services.orders.setOrderColor(orderId, 'pink', env.token)).rejects.toThrow(
      /颜色/,
    );
  });

  it('整单颜色标注统一下发到任务，任务自身标记保留原色', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env, {
      tasks: [taskDraft('每日签到'), taskDraft('素材清空')],
    });
    const before = await env.services.queries.orderDetail(orderId);
    const signed = before!.tasks.find((item) => item.title === '每日签到')!.id;
    const farm = before!.tasks.find((item) => item.title === '素材清空')!.id;
    await env.services.tasks.setTaskColor(farm, 'green', env.token);

    await env.services.orders.setOrderColor(orderId, 'blue', env.token);
    const inherited = await env.services.queries.orderDetail(orderId);
    expect(inherited?.tasks.find((item) => item.id === signed)?.colorTag).toBe('blue');
    expect(inherited?.tasks.find((item) => item.id === farm)?.colorTag).toBe('green');
    const today = await env.services.queries.today({});
    expect(today.hosting.find((item) => item.taskId === signed)?.colorTag).toBe('blue');
    expect(today.hosting.find((item) => item.taskId === farm)?.colorTag).toBe('green');

    // 整单改色：跟随标记随之更新，任务自身标记保留原色。
    await env.services.orders.setOrderColor(orderId, 'red', env.token);
    const changed = await env.services.queries.orderDetail(orderId);
    expect(changed?.tasks.find((item) => item.id === signed)?.colorTag).toBe('red');
    expect(changed?.tasks.find((item) => item.id === farm)?.colorTag).toBe('green');
  });

  it('取消整单颜色清除跟随标记，任务自身标记保留', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env, {
      tasks: [taskDraft('每日签到'), taskDraft('素材清空')],
    });
    const before = await env.services.queries.orderDetail(orderId);
    const signed = before!.tasks.find((item) => item.title === '每日签到')!.id;
    const farm = before!.tasks.find((item) => item.title === '素材清空')!.id;
    await env.services.tasks.setTaskColor(farm, 'green', env.token);
    await env.services.orders.setOrderColor(orderId, 'blue', env.token);

    await env.services.orders.setOrderColor(orderId, null, env.token);
    const cleared = await env.services.queries.orderDetail(orderId);
    expect(cleared?.order.colorTag).toBeNull();
    expect(cleared?.tasks.find((item) => item.id === signed)?.colorTag).toBeNull();
    expect(cleared?.tasks.find((item) => item.id === farm)?.colorTag).toBe('green');
  });

  it('续期克隆的任务保留颜色标记', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env, {
      tasks: [taskDraft('每日签到'), taskDraft('素材清空')],
    });
    await env.services.orders.setOrderColor(orderId, 'blue', env.token);
    const before = await env.services.queries.orderDetail(orderId);
    const farm = before!.tasks.find((item) => item.title === '素材清空')!.id;
    await env.services.tasks.setTaskColor(farm, 'green', env.token);

    const periodId = await env.services.orders.renew(
      { operationId: 'op-renew-color', orderId, durationDays: 28, priceCents: 28000 },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    const clones = after!.tasks.filter((item) => item.periodId === periodId);
    expect(clones).toHaveLength(2);
    expect(clones.find((item) => item.title === '每日签到')?.colorTag).toBe('blue');
    expect(clones.find((item) => item.title === '素材清空')?.colorTag).toBe('green');
  });

  it('修改订单新增任务自动继承整单颜色', async () => {
    const env = await freshEnv();
    const { orderId, command } = await seedOrder(env);
    await env.services.orders.setOrderColor(orderId, 'blue', env.token);
    const before = await env.services.queries.orderDetail(orderId);
    const periodId = before!.periods[0].id;
    const taskId = before!.tasks[0].id;

    await env.services.orders.update(
      {
        orderId,
        title: command.title,
        notes: null,
        paymentMode: 'INSTALLMENTS',
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        priceCents: null,
        deadlineDate: null,
        periods: [
          {
            periodId,
            startDate: '2026-02-01',
            endDate: '2026-02-28',
            priceCents: 30000,
            serviceDays: null,
          },
        ],
        tasks: [
          { id: taskId, periodId, task: command.tasks[0] },
          { id: null, periodId, task: taskDraft('素材清空') },
        ],
      },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.tasks.find((item) => item.title === '素材清空')?.colorTag).toBe('blue');
    expect(after?.tasks.find((item) => item.id === taskId)?.colorTag).toBe('blue');
  });

  it('截图可上传、按任务回读并删除', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const detail = await env.services.queries.orderDetail(orderId);
    const taskId = detail!.tasks[0].id;
    const file = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'image/png' });
    const id = await env.services.attachments.put({ taskId }, file, env.token);

    const loaded = await env.services.attachments.load(id);
    expect(loaded).not.toBeNull();
    // 测试环境的结构化克隆不保证 Blob 元数据；真实浏览器返回完整 Blob。
    if (typeof loaded!.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await loaded!.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
    }

    const byTask = await env.services.attachments.listTask(taskId);
    expect(byTask.map((item) => item.id)).toEqual([id]);
    const byOrder = await env.services.attachments.list(orderId);
    expect(byOrder.map((item) => item.id)).toEqual([id]);

    // 多张共存：同一任务可挂多张截图
    const second = await env.services.attachments.put(
      { taskId },
      new Blob([new Uint8Array([9, 9])], { type: 'image/png' }),
      env.token,
    );
    const afterSecond = await env.services.attachments.listTask(taskId);
    expect(afterSecond.map((item) => item.id).sort()).toEqual([id, second].sort());
    expect(await env.services.attachments.load(id)).not.toBeNull();

    await env.services.attachments.remove(second, env.token);
    const afterRemove = await env.services.attachments.listTask(taskId);
    expect(afterRemove.map((item) => item.id)).toEqual([id]);
    await env.services.attachments.remove(id, env.token);
    expect(await env.services.attachments.listTask(taskId)).toHaveLength(0);
  });

  it('作废订单删除会清理打卡、收款与派生记录', async () => {
    const env = await freshEnv();
    const { orderId } = await seedOrder(env);
    const today = await env.services.queries.today({});
    await env.services.tasks.setProgress(
      { taskId: today.hosting[0].taskId, gameDate: '2026-02-10', value: '1', completed: true, backfilled: false },
      env.token,
    );

    await expect(
      env.services.orders.deleteCancelled(orderId, env.token),
    ).rejects.toThrow(/已作废/);

    await env.services.orders.cancel(orderId, env.token);
    const preview = await env.services.orders.previewDeletion(orderId);
    expect(preview.occurrences).toBeGreaterThan(0);
    expect(preview.receipts).toBe(1);

    const counts = await env.services.orders.deleteCancelled(orderId, env.token);
    expect(counts.orders).toBe(1);
    expect(await env.services.queries.orderDetail(orderId)).toBeNull();
    const ledger = await env.services.queries.ledger({ month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(ledger.receivedCents).toBe(0);
    expect(ledger.outstandingCents).toBe(0);
    const orders = await env.services.queries.orders({ includeCancelled: true });
    expect(orders).toHaveLength(0);
  });

  it('删除账号会级联清理其订单、收款与打卡', async () => {
    const env = await freshEnv();
    const { ownerId, accountId, orderId } = await seedOrder(env);
    const preview = await env.services.accounts.previewAccountDeletion(accountId);
    expect(preview.orders).toBe(1);
    expect(preview.receipts).toBe(1);

    const counts = await env.services.accounts.deleteAccount(accountId, env.token);
    expect(counts.orders).toBe(1);

    const detail = await env.services.queries.ownerDetail(ownerId);
    expect(detail?.accounts).toHaveLength(0);
    expect(detail?.orders).toHaveLength(0);
    expect(await env.services.queries.orderDetail(orderId)).toBeNull();
    const ledger = await env.services.queries.ledger({ month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(ledger.receivedCents).toBe(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it('已归档老板可删除并级联清理全部账号与订单', async () => {
    const env = await freshEnv();
    const { ownerId, orderId } = await seedOrder(env);
    // 未归档的老板不能删除。
    await expect(env.services.accounts.deleteOwner(ownerId, env.token)).rejects.toThrow(/归档/);
    // 有未到期托管服务时不能归档；先作废订单再归档。
    await env.services.orders.cancel(orderId, env.token);
    await env.services.accounts.archive('owner', ownerId, env.token);

    const preview = await env.services.accounts.previewOwnerDeletion(ownerId);
    expect(preview.orders).toBe(1);
    expect(preview.receipts).toBe(1);

    const counts = await env.services.accounts.deleteOwner(ownerId, env.token);
    expect(counts.orders).toBe(1);

    const owners = await env.services.queries.owners(true);
    expect(owners.find((item) => item.id === ownerId)).toBeUndefined();
    expect(await env.services.queries.ownerDetail(ownerId)).toBeNull();
    expect(await env.services.queries.orderDetail(orderId)).toBeNull();
    const ledger = await env.services.queries.ledger({ month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(ledger.receivedCents).toBe(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it('模板保存、导出与导入另存', async () => {
    const env = await freshEnv();
    const templates = await env.services.queries.templates();
    expect(templates.some((item) => item.builtInKey === 'generic')).toBe(true);

    const file = await env.services.templates.exportFile(templates[0].id);
    const importedId = await env.services.templates.importFile(file, 'copy', env.token);
    const after = await env.services.queries.templates();
    expect(after).toHaveLength(2);
    expect(after.find((item) => item.id === importedId)?.gameName).toContain('导入');

    const draft = await env.services.queries.templateDetail(templates[0].id);
    expect(draft?.categories.length).toBeGreaterThan(0);
  });
});

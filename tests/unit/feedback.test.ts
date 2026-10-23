import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import type { CreateOrderCommand } from '../../src/application/contracts';
import { parseTemplateFile, serializeTemplate } from '../../src/backup/templateCodec';
import { parseMonthDays, slotFor } from '../../src/domain/occurrences';
import type { HostingPeriodRow, TaskDefinitionRow } from '../../src/contracts/tables';

const NOW = Date.UTC(2026, 1, 10, 4, 0); // 上海 2026-02-10 12:00

function makeEnv() {
  let counter = 0;
  const newId = () => `fid-${++counter}`;
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

async function seedHosting(
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
    operationId: 'fop-create-1',
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
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...overrides,
  };
  const result = await env.services.orders.create(command, env.token);
  return { ownerId, accountId, command, ...result };
}

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
    recurrence: 'MONTHLY',
    weekdays: null,
    everyNDays: null,
    sortOrder: 0,
    completedAt: null,
    completionBatchId: null,
    createdAt: 0,
    updatedAt: 0,
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

describe('UF-025 每月多个固定日号', () => {
  it('解析多日号并去重排序', () => {
    expect(parseMonthDays(null, '15,1,15,32,0')).toEqual([1, 15]);
    expect(parseMonthDays(3, null)).toEqual([3]);
    expect(parseMonthDays(null, null)).toEqual([]);
  });

  it('1 日与 15 日各自生成发生槽，缺失日号跳过', () => {
    const monthly = task({ recurrence: 'MONTHLY', monthDay: 1, monthDays: '1,15' });
    expect(slotFor(monthly, period, '2026-02-01')?.key).toBe('M:2026-02-01');
    expect(slotFor(monthly, period, '2026-02-15')?.key).toBe('M:2026-02-15');
    expect(slotFor(monthly, period, '2026-02-10')).toBeNull();
  });

  it('二月无 31 日时跳过 31 但保留 15', () => {
    const monthly = task({ recurrence: 'MONTHLY', monthDay: 15, monthDays: '15,31' });
    expect(slotFor(monthly, period, '2026-02-28')).toBeNull();
    expect(slotFor(monthly, period, '2026-02-15')?.key).toBe('M:2026-02-15');
  });
});

describe('UF-020 提前续期', () => {
  it('未到期续期从上期结束次日开始，不截断当前期', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);
    const periodId = await env.services.orders.renew(
      { operationId: 'fop-renew-early', orderId, durationDays: 10, priceCents: 20000 },
      env.token,
    );
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.periods).toHaveLength(2);
    const next = detail?.periods.find((item) => item.id === periodId);
    expect(next?.startDate).toBe('2026-03-01');
    expect(next?.endDate).toBe('2026-03-10');
    // 当前期任务不受未来期影响。
    const today = await env.services.queries.today({});
    expect(today.hosting.length).toBeGreaterThan(0);
  });

  it('同一操作重试幂等，不同操作重复续期同一起点会被拒绝', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);
    const first = await env.services.orders.renew(
      { operationId: 'fop-renew-a', orderId, durationDays: 10, priceCents: 20000 },
      env.token,
    );
    const retried = await env.services.orders.renew(
      { operationId: 'fop-renew-a', orderId, durationDays: 10, priceCents: 20000 },
      env.token,
    );
    expect(retried).toBe(first);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail?.periods).toHaveLength(2);
  });
});

describe('UF-021 今日隐藏已到期任务', () => {
  it('无截止日期的短期单不判过期', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板' }, env.token);
    const accountId = await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '游戏',
        server: '官服',
        uid: '1',
        loginAccount: 'a',
        loginMethod: 'PASSWORD',
        password: 'p',
      },
      env.token,
    );
    await env.services.orders.create(
      {
        operationId: 'fop-short-nodl',
        ownerId,
        accountId,
        type: 'SHORT_TASK',
        title: '短期任务',
        notes: null,
        paymentMode: 'ONE_TIME',
        priceCents: 10000,
        deadlineDate: null,
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        startDate: null,
        endDate: null,
        periodPriceCents: null,
        tasks: [
          {
            title: '清体力',
            progressType: 'CHECKBOX',
            startValue: '0',
            targetValue: '1',
            unit: null,
            recurrence: 'ONE_TIME',
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
    );
    const today = await env.services.queries.today({});
    expect(today.shortTasks).toHaveLength(1);
  });

  it('过期短期单默认隐藏，includeExpired 显示', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板' }, env.token);
    const accountId = await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '游戏',
        server: '官服',
        uid: '1',
        loginAccount: 'a',
        loginMethod: 'PASSWORD',
        password: 'p',
      },
      env.token,
    );
    await env.services.orders.create(
      {
        operationId: 'fop-short-overdue',
        ownerId,
        accountId,
        type: 'SHORT_TASK',
        title: '过期短期任务',
        notes: null,
        paymentMode: 'ONE_TIME',
        priceCents: 10000,
        deadlineDate: '2026-02-05', // NOW 游戏日为 2026-02-10，已过期
        gameZoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        startDate: null,
        endDate: null,
        periodPriceCents: null,
        tasks: [
          {
            title: '清体力',
            progressType: 'CHECKBOX',
            startValue: '0',
            targetValue: '1',
            unit: null,
            recurrence: 'ONE_TIME',
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
    );
    const hidden = await env.services.queries.today({});
    expect(hidden.shortTasks).toHaveLength(0);
    expect(hidden.staleOrders.some((item) => item.orderId)).toBe(true);
    const shown = await env.services.queries.today({ includeExpired: true });
    expect(shown.shortTasks).toHaveLength(1);
  });
});

describe('UF-005/006/008/015/017 新字段', () => {
  beforeEach(async () => {
    resetControlDb();
    await Dexie.delete('daigan-control');
  });

  it('扫码登录不保存密码，登录设备与资源记录可保存回读', async () => {
    const env = await freshEnv();
    const ownerId = await env.services.accounts.saveOwner({ nickname: '老板' }, env.token);
    const accountId = await env.services.accounts.saveAccount(
      {
        ownerId,
        gameName: '游戏',
        server: '官服',
        uid: '9',
        loginAccount: 'qr-acc',
        loginMethod: 'QR_CODE',
        password: 'ignored',
        loginDevice: '平板',
        resourceNotes: '原石 ×1600\n五星角色 ×3',
      },
      env.token,
    );
    const detail = await env.services.queries.ownerDetail(ownerId);
    const account = detail?.accounts.find((item) => item.id === accountId);
    expect(account?.loginMethod).toBe('QR_CODE');
    expect(account?.password).toBeNull();
    expect(account?.loginDevice).toBe('平板');
    expect(account?.resourceNotes).toContain('原石 ×1600');
  });

  it('区服选项按游戏保存、查重、删除不影响已有账号', async () => {
    const env = await freshEnv();
    const optionId = await env.services.serverOptions.save(
      { gameName: '原神', name: '官服' },
      env.token,
    );
    await env.services.serverOptions.save({ gameName: '原神', name: 'B服' }, env.token);
    await env.services.serverOptions.save({ gameName: '崩铁', name: '星穹列车' }, env.token);
    const list = await env.services.serverOptions.list('原神');
    expect(list.map((item) => item.name)).toEqual(['官服', 'B服']);
    await expect(
      env.services.serverOptions.save({ gameName: '原神', name: '官服' }, env.token),
    ).rejects.toThrow(/同名/);
    await env.services.serverOptions.remove(optionId, env.token);
    const after = await env.services.serverOptions.list('原神');
    expect(after.map((item) => item.name)).toEqual(['B服']);
    const all = await env.services.serverOptions.listAll();
    expect(all.map((group) => group.gameName).sort()).toEqual(['原神', '崩铁'].sort());
  });

  it('模板价格预设保存后可回读，导出导入保留', async () => {
    const env = await freshEnv();
    const templates = await env.services.queries.templates();
    const builtIn = templates[0];
    const draft = await env.services.queries.templateDetail(builtIn.id);
    expect(draft).not.toBeNull();
    const savedId = await env.services.templates.save(
      {
        ...draft!,
        pricePresets: [
          { amountCents: 6800, label: '月卡' },
          { amountCents: 32800, label: null },
        ],
      },
      env.token,
    );
    const saved = await env.services.queries.templateDetail(savedId);
    expect(saved?.pricePresets).toEqual([
      { amountCents: 6800, label: '月卡' },
      { amountCents: 32800, label: null },
    ]);
    const file = await env.services.templates.exportFile(savedId);
    const importedId = await env.services.templates.importFile(file, 'copy', env.token);
    const imported = await env.services.queries.templateDetail(importedId);
    expect(imported?.pricePresets).toEqual([
      { amountCents: 6800, label: '月卡' },
      { amountCents: 32800, label: null },
    ]);
  });

  it('改价写入审计且不改写收款流水', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);
    const before = await env.services.queries.orderDetail(orderId);
    const receiptBefore = before?.receipts.map((item) => item.id);
    await env.services.orders.changePrice(
      { orderId, periodId: before!.periods[0].id, priceCents: 40000, reason: '拆分日常价' },
      env.token,
    );
    const after = await env.services.queries.orderDetail(orderId);
    expect(after?.periods[0].priceCents).toBe(40000);
    expect(after?.receipts.map((item) => item.id)).toEqual(receiptBefore);
    const snapshot = await env.services.exportSnapshot();
    const changes = (snapshot.data as unknown as { order_price_changes: unknown[] })
      .order_price_changes;
    expect(changes).toHaveLength(1);
    expect((changes[0] as { previousPriceCents: number }).previousPriceCents).toBe(30000);
    expect((changes[0] as { newPriceCents: number }).newPriceCents).toBe(40000);
    // 级联删除订单后审计行一并清理。
    await env.services.orders.cancel(orderId, env.token);
    await env.services.orders.deleteCancelled(orderId, env.token);
    const cleaned = await env.services.exportSnapshot();
    expect(
      (cleaned.data as unknown as { order_price_changes: unknown[] }).order_price_changes,
    ).toHaveLength(0);
  });

  it('UF-010 工作日累计托管：仅周一至周五生成任务，天数按计划口径', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, {
      operationId: 'fop-wd-create',
      startDate: '2026-02-02', // 周一
      endDate: null,
      serviceDays: 5, // 2026-02-02..06（周一至周五）
      tasks: [
        {
          title: '工作日签到',
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
    });
    const detail = await env.services.queries.orderDetail(orderId);
    const period = detail!.periods[0];
    expect(period.startDate).toBe('2026-02-02');
    expect(period.endDate).toBe('2026-02-06');
    expect(period.serviceDays).toBe(5);
    // 游戏日 2026-02-10 已过本期：计划口径 5 天全部消耗，剩余 0。
    expect(period.serviceDaysUsed).toBe(5);
    expect(period.serviceDaysRemaining).toBe(0);
    // 周末无任务：日历不含 02-07/02-08。
    const dates = detail!.calendar.map((day) => day.gameDate);
    expect(dates).not.toContain('2026-02-07');
    expect(dates).not.toContain('2026-02-08');
    expect(dates).toEqual(['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06']);
    // 续期沿用工作日模式：从当前游戏日 2026-02-10（周二）起 5 个工作日到 02-16。
    await env.services.orders.renew(
      { operationId: 'fop-wd-renew', orderId, durationDays: 5, priceCents: 20000 },
      env.token,
    );
    const renewed = await env.services.queries.orderDetail(orderId);
    const next = renewed!.periods[1];
    expect(next.startDate).toBe('2026-02-10');
    expect(next.endDate).toBe('2026-02-16');
    expect(next.serviceDays).toBe(5);
  });

  it('UF-019 单任务颜色标记可设置、清除并随今日任务返回', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env);
    const detail = await env.services.queries.orderDetail(orderId);
    const taskId = detail!.tasks[0].id;
    await env.services.tasks.setTaskColor(taskId, 'red', env.token);
    let today = await env.services.queries.today({});
    expect(today.hosting.find((item) => item.taskId === taskId)?.colorTag).toBe('red');
    let refreshed = await env.services.queries.orderDetail(orderId);
    expect(refreshed!.tasks[0].colorTag).toBe('red');
    await env.services.tasks.setTaskColor(taskId, null, env.token);
    today = await env.services.queries.today({});
    expect(today.hosting.find((item) => item.taskId === taskId)?.colorTag).toBeNull();
    refreshed = await env.services.queries.orderDetail(orderId);
    expect(refreshed!.tasks[0].colorTag).toBeNull();
    await expect(env.services.tasks.setTaskColor(taskId, 'rainbow', env.token)).rejects.toThrow(
      /颜色/,
    );
  });

  it('UF-023 账号搜索覆盖游戏、区服、UID 与老板昵称', async () => {
    const env = await freshEnv();
    await seedHosting(env);
    expect(await env.services.queries.searchAccounts('原神')).toHaveLength(1);
    expect(await env.services.queries.searchAccounts('官服')).toHaveLength(1);
    expect(await env.services.queries.searchAccounts('1001')).toHaveLength(1);
    expect(await env.services.queries.searchAccounts('老板甲')).toHaveLength(1);
    expect(await env.services.queries.searchAccounts('不存在')).toHaveLength(0);
    // 不以密码作为搜索内容。
    expect(await env.services.queries.searchAccounts('secret')).toHaveLength(0);
  });
});

describe('按次数服务与任务生效日期', () => {
  it('建单不需要起止日期；整轮打卡攒满次数后提示可续期', async () => {
    const env = await freshEnv();
    const checkbox = (title: string) => ({
      title,
      progressType: 'CHECKBOX' as const,
      startValue: '0',
      targetValue: '1',
      unit: null,
      recurrence: 'DAILY' as const,
      weekdays: null,
      everyNDays: null,
      monthDay: null,
    });
    const { orderId } = await seedHosting(env, {
      operationId: 'fop-count-1',
      startDate: null,
      endDate: null,
      serviceCount: 1,
      tasks: [checkbox('每日签到'), checkbox('清体力')],
    });
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail!.periods[0].serviceCount).toBe(1);
    expect(detail!.periods[0].serviceRounds).toBe(0);
    expect(detail!.periods[0].serviceDays).toBeNull();

    let today = await env.services.queries.today({});
    const items = today.hosting.filter((item) => item.orderId === orderId);
    expect(items).toHaveLength(2);
    expect(items[0].serviceCount).toBe(1);
    expect(items[0].serviceRounds).toBe(0);

    // 只完成其中一个任务不计轮次。
    await env.services.tasks.setProgress(
      {
        taskId: items[0].taskId,
        gameDate: '2026-02-10',
        value: null,
        completed: true,
        backfilled: false,
      },
      env.token,
    );
    today = await env.services.queries.today({});
    expect(today.staleOrders.find((item) => item.orderId === orderId)).toBeUndefined();

    // 两个都完成 = 1 轮；攒满后提示可续期。
    const second = today.hosting.find(
      (item) => item.orderId === orderId && item.taskId !== items[0].taskId,
    )!;
    await env.services.tasks.setProgress(
      {
        taskId: second.taskId,
        gameDate: '2026-02-10',
        value: null,
        completed: true,
        backfilled: false,
      },
      env.token,
    );
    today = await env.services.queries.today({});
    expect(today.staleOrders.find((item) => item.orderId === orderId)?.reason).toContain('1/1');
    const after = await env.services.queries.orderDetail(orderId);
    expect(after!.periods[0].serviceRounds).toBe(1);
  });

  it('按次数建单拒绝非法次数与模式冲突', async () => {
    const env = await freshEnv();
    await expect(
      seedHosting(env, {
        operationId: 'fop-count-bad',
        startDate: null,
        endDate: null,
        serviceCount: 0,
      }),
    ).rejects.toThrow(/服务次数/);
    await expect(
      seedHosting(env, {
        operationId: 'fop-count-conflict',
        startDate: '2026-02-01',
        endDate: '2026-02-28',
        serviceCount: 5,
        serviceDays: 10,
      }),
    ).rejects.toThrow(/次数|工作日/);
  });

  it('任务只在生效起止日期内出现在今日', async () => {
    const env = await freshEnv();
    const { orderId } = await seedHosting(env, {
      operationId: 'fop-range-1',
      tasks: [
        {
          title: '限时活动',
          progressType: 'CHECKBOX',
          startValue: '0',
          targetValue: '1',
          unit: null,
          recurrence: 'DAILY',
          weekdays: null,
          everyNDays: null,
          monthDay: null,
          activeFrom: '2026-02-20',
          activeUntil: '2026-02-25',
        },
      ],
    });
    const today = await env.services.queries.today({});
    expect(today.hosting.filter((item) => item.orderId === orderId)).toHaveLength(0);
    const detail = await env.services.queries.orderDetail(orderId);
    expect(detail!.tasks[0].activeFrom).toBe('2026-02-20');
    expect(detail!.tasks[0].activeUntil).toBe('2026-02-25');
  });

  it('模板保存服务模式默认值与任务起止日期并回读', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(
      {
        gameName: '星穹铁道',
        templateVersion: '1.0',
        gameVersionNotes: null,
        zoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        serviceMode: 'count',
        serviceCount: 12,
        serverOptions: ['官服', 'B服', '官服'],
        categories: [
          {
            name: '日常',
            tasks: [
              {
                title: '每日实训',
                progressType: 'CHECKBOX',
                startValue: '0',
                targetValue: '1',
                unit: null,
                recurrence: 'DAILY',
                weekdays: null,
                everyNDays: null,
                monthDay: null,
                activeFrom: '2026-03-01',
                activeUntil: '2026-03-31',
              },
            ],
          },
        ],
      },
      env.token,
    );
    const detail = await env.services.queries.templateDetail(templateId);
    expect(detail!.serviceMode).toBe('count');
    expect(detail!.serviceCount).toBe(12);
    // 旧草稿分类未指定服务模式时沿用模板级默认（UF：下沉到分类的兼容回填）。
    expect(detail!.categories[0].serviceMode).toBe('count');
    expect(detail!.categories[0].serviceCount).toBe(12);
    expect(detail!.serverOptions).toEqual(['官服', 'B服']);
    expect(detail!.categories[0].tasks[0].activeFrom).toBe('2026-03-01');
    expect(detail!.categories[0].tasks[0].activeUntil).toBe('2026-03-31');

    // 模板文件往返保留网页扩展字段。
    const roundTrip = parseTemplateFile(serializeTemplate(detail!));
    expect(roundTrip.serviceMode).toBe('count');
    expect(roundTrip.serviceCount).toBe(12);
    expect(roundTrip.categories[0].serviceMode).toBe('count');
    expect(roundTrip.categories[0].serviceCount).toBe(12);
    expect(roundTrip.categories[0].tasks[0].activeUntil).toBe('2026-03-31');
  });

  it('分类可各自指定服务模式，保存回读并随模板文件往返', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(
      {
        gameName: '原神',
        templateVersion: '1.0',
        gameVersionNotes: null,
        zoneId: 'Asia/Shanghai',
        dailyRefreshMinutes: 300,
        weeklyRefreshDay: 1,
        weeklyRefreshMinutes: 300,
        serverOptions: [],
        categories: [
          {
            name: '日常',
            serviceMode: 'weekdays',
            serviceCount: null,
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
          },
          {
            name: '代刷',
            serviceMode: 'count',
            serviceCount: 30,
            tasks: [
              {
                title: '素材清空',
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
      },
      env.token,
    );
    const detail = await env.services.queries.templateDetail(templateId);
    expect(detail!.categories[0].serviceMode).toBe('weekdays');
    expect(detail!.categories[0].serviceCount).toBeNull();
    expect(detail!.categories[1].serviceMode).toBe('count');
    expect(detail!.categories[1].serviceCount).toBe(30);
    // 分类服务模式不一致时，建单默认不预设服务模式。
    expect(detail!.serviceMode).toBeNull();
    expect(detail!.serviceCount).toBeNull();

    // 模板文件往返保留分类服务模式。
    const roundTrip = parseTemplateFile(serializeTemplate(detail!));
    expect(roundTrip.categories[0].serviceMode).toBe('weekdays');
    expect(roundTrip.categories[1].serviceMode).toBe('count');
    expect(roundTrip.categories[1].serviceCount).toBe(30);
  });

  it('分类按次数模式必须填写服务次数', async () => {
    const env = await freshEnv();
    await expect(
      env.services.templates.save(
        {
          gameName: '崩坏：星穹铁道',
          templateVersion: '1.0',
          gameVersionNotes: null,
          zoneId: 'Asia/Shanghai',
          dailyRefreshMinutes: 300,
          weeklyRefreshDay: 1,
          weeklyRefreshMinutes: 300,
          categories: [
            {
              name: '日常',
              serviceMode: 'count',
              serviceCount: null,
              tasks: [
                {
                  title: '每日实训',
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
        },
        env.token,
      ),
    ).rejects.toThrow(/服务次数/);
  });
});

import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type {
  CreateOrderCommand,
  TemplateTaskDraft,
  UpdateOrderCommand,
} from '../../src/application/contracts';
import type { BackupDataSet } from '../../src/contracts/tables';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';

/**
 * 任务手动排序（2026-10-27 用户反馈「同一任务里顺序不一致，希望可以手动排序」）。
 *
 * 数据契约里本来就有 `task_definitions.sortOrder`，但今日事项的读取路径从没按它排序，
 * Dexie 按主键吐出什么顺序就渲染什么顺序 —— 这正是截图里三张卡片
 * （体力/日常/副本 排法各不相同）的根因。这里锁定三件事：
 * 1. 今日事项必须按 sortOrder 渲染；
 * 2. 订单编辑页提交的顺序写入 sortOrder；
 * 3. 手动排序只重排**可见**条目，隐藏条目的槽位不动。
 */

const DAY_MS = 86_400_000;
const ZONE = 'Asia/Shanghai';
const REFRESH = 300;
const START = Date.UTC(2026, 9, 27, 4, 0); // 上海 2026-10-27 12:00
const DAY1 = '2026-10-27';
const DAY2 = '2026-10-28';

let clock = START;
let idCounter = 0;

function newId(): string {
  idCounter += 1;
  return `ord-${idCounter}`;
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

function task(title: string, overrides: Partial<TemplateTaskDraft> = {}): TemplateTaskDraft {
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
    ...overrides,
  };
}

async function dateOrder(env: Env, titles: string[], extra: Partial<CreateOrderCommand> = {}) {
  const ids = await seedAccount(env, `老板-${titles.join('')}`, `${titles.length}0`);
  const command: CreateOrderCommand = {
    operationId: `op-${Math.random().toString(36).slice(2, 9)}`,
    ownerId: ids.ownerId,
    accountId: ids.accountId,
    type: 'HOSTING',
    title: '铁臂全托',
    notes: null,
    paymentMode: 'INSTALLMENTS',
    priceCents: null,
    deadlineDate: null,
    gameZoneId: ZONE,
    dailyRefreshMinutes: REFRESH,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    startDate: DAY1,
    endDate: DAY2,
    periodPriceCents: 10000,
    tasks: titles.map((title) => task(title)),
    firstReceipt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    ...extra,
  };
  const created = await env.services.orders.create(command, env.token);
  const detail = (await env.services.queries.orderDetail(created.orderId))!;
  return { orderId: created.orderId, periodId: detail.periods[0]?.id ?? null, detail };
}

async function readData(env: Env): Promise<BackupDataSet> {
  return env.runtime.read((ctx) => ctx.data);
}

async function sortOrdersOf(env: Env, orderId: string): Promise<Record<string, number>> {
  const data = await readData(env);
  const rows = data.task_definitions.filter((row) => row.orderId === orderId);
  const byId: Record<string, number> = {};
  for (const row of rows) byId[row.id] = row.sortOrder;
  return byId;
}

async function todayTitles(env: Env, orderId: string): Promise<string[]> {
  const view = await env.services.queries.today({});
  return view.hosting.filter((row) => row.orderId === orderId).map((row) => row.title);
}

describe('今日事项按 sortOrder 渲染', () => {
  it('新建订单后按录入顺序展示任务', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常', '副本']);
    expect(await todayTitles(env, orderId)).toEqual(['体力', '日常', '副本']);
  });

  it('编辑订单改变提交顺序后，今日事项同步换序', async () => {
    const env = await freshEnv();
    const { orderId, periodId, detail } = await dateOrder(env, ['体力', '日常', '副本']);
    const byTitle = new Map(detail.tasks.map((row) => [row.title, row]));

    const command: UpdateOrderCommand = {
      orderId,
      title: '铁臂全托',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      gameZoneId: ZONE,
      dailyRefreshMinutes: REFRESH,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      monthlyRefreshDays: null,
      priceCents: null,
      deadlineDate: null,
      periods: [
        {
          periodId,
          startDate: DAY1,
          endDate: DAY2,
          priceCents: 10000,
          serviceDays: null,
          serviceCount: null,
        },
      ],
      // 编辑页把「副本」拖到最前
      tasks: ['副本', '日常', '体力'].map((title) => {
        const row = byTitle.get(title)!;
        return {
          id: row.id,
          periodId,
          task: {
            title: row.title,
            progressType: row.progressType,
            startValue: row.startValue,
            targetValue: row.targetValue,
            unit: row.unit,
            recurrence: row.recurrence,
            weekdays: row.weekdays,
            everyNDays: row.everyNDays,
            monthDay: row.monthDay,
            monthDays: row.monthDays,
            activeFrom: row.activeFrom,
            activeUntil: row.activeUntil,
            numericMode: row.numericMode,
          },
        };
      }),
    };
    await env.services.orders.update(command, env.token);

    expect(await todayTitles(env, orderId)).toEqual(['副本', '日常', '体力']);
    const orders = await sortOrdersOf(env, orderId);
    expect(Object.values(orders).sort((left, right) => left - right)).toEqual([0, 1, 2]);
  });
});

describe('reorderTasks：今日事项手动排序', () => {
  it('把最后一条拖到最前，并重编号写入数据库', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常', '副本']);
    const before = await env.services.queries.orderDetail(orderId);
    const idByTitle = new Map(before!.tasks.map((row) => [row.title, row.id]));

    await env.services.tasks.reorderTasks(
      { orderId, orderedTaskIds: ['副本', '体力', '日常'].map((title) => idByTitle.get(title)!) },
      env.token,
    );

    expect(await todayTitles(env, orderId)).toEqual(['副本', '体力', '日常']);
    const orders = await sortOrdersOf(env, orderId);
    expect(Object.values(orders).sort((left, right) => left - right)).toEqual([0, 1, 2]);
  });

  it('看不见的任务（未到生效日）槽位不动，只重排可见条目', async () => {
    const env = await freshEnv();
    // H 明天才生效 → 今日不显示，但仍然占着一个 sortOrder 槽位
    const { orderId } = await dateOrder(env, ['体力', '日常']);
    const hidden = `hidden-${idCounter}`;
    await env.runtime.write(env.token, async (ctx) => {
      const source = ctx.data.task_definitions.find(
        (row) => row.orderId === orderId && row.title === '体力',
      )!;
      await ctx.table('task_definitions').add({
        ...source,
        id: hidden,
        title: '明日副本',
        sortOrder: 1,
        activeFrom: DAY2,
        currentValue: '0',
        completedAt: null,
        completionBatchId: null,
        createdAt: clock + 10,
        updatedAt: clock + 10,
      });
    });
    // 可见顺序：体力(0) / 日常(2)
    await env.runtime.write(env.token, async (ctx) => {
      const daily = ctx.data.task_definitions.find(
        (row) => row.orderId === orderId && row.title === '日常',
      )!;
      await ctx.table('task_definitions').put({ ...daily, sortOrder: 2 });
    });
    expect(await todayTitles(env, orderId)).toEqual(['体力', '日常']);

    const detail2 = await env.services.queries.orderDetail(orderId);
    const idByTitle = new Map(detail2!.tasks.map((row) => [row.title, row.id]));
    await env.services.tasks.reorderTasks(
      { orderId, orderedTaskIds: [idByTitle.get('日常')!, idByTitle.get('体力')!] },
      env.token,
    );

    expect(await todayTitles(env, orderId)).toEqual(['日常', '体力']);
    const orders = await sortOrdersOf(env, orderId);
    // 日常拿到体力的槽（0），体力拿到日常的槽（2），隐藏的明日副本留在 1。
    expect(orders[idByTitle.get('日常')!]).toBe(0);
    expect(orders[hidden]).toBe(1);
    expect(orders[idByTitle.get('体力')!]).toBe(2);
  });

  it('短期单同样可以手动排序', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常'], {
      type: 'SHORT_TASK',
      startDate: null,
      endDate: null,
      periodPriceCents: null,
      priceCents: 5000,
      deadlineDate: DAY2,
    });
    const view = await env.services.queries.today({});
    expect(view.shortTasks.filter((row) => row.orderId === orderId).map((row) => row.title)).toEqual([
      '体力',
      '日常',
    ]);

    const detail = await env.services.queries.orderDetail(orderId);
    const idByTitle = new Map(detail!.tasks.map((row) => [row.title, row.id]));
    await env.services.tasks.reorderTasks(
      { orderId, orderedTaskIds: [idByTitle.get('日常')!, idByTitle.get('体力')!] },
      env.token,
    );

    const after = await env.services.queries.today({});
    expect(after.shortTasks.filter((row) => row.orderId === orderId).map((row) => row.title)).toEqual([
      '日常',
      '体力',
    ]);
  });

  it('空清单是无操作，不报错', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常']);
    await env.services.tasks.reorderTasks({ orderId, orderedTaskIds: [] }, env.token);
    expect(await todayTitles(env, orderId)).toEqual(['体力', '日常']);
  });

  it('重复 id 或别的订单的任务都拒绝写入', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常']);
    const other = await dateOrder(env, ['外单任务']);
    const detail = await env.services.queries.orderDetail(orderId);
    const mine = detail!.tasks[0].id;
    const foreign = (await env.services.queries.orderDetail(other.orderId))!.tasks[0].id;

    await expect(
      env.services.tasks.reorderTasks({ orderId, orderedTaskIds: [mine, mine] }, env.token),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      env.services.tasks.reorderTasks({ orderId, orderedTaskIds: [foreign] }, env.token),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 拒绝后原顺序不变
    expect(await todayTitles(env, orderId)).toEqual(['体力', '日常']);
  });

  it('作废订单不允许排序', async () => {
    const env = await freshEnv();
    const { orderId } = await dateOrder(env, ['体力', '日常']);
    const detail = await env.services.queries.orderDetail(orderId);
    await env.runtime.write(env.token, async (ctx) => {
      const order = ctx.data.orders.find((row) => row.id === orderId)!;
      await ctx.table('orders').put({ ...order, cancelledAt: clock });
    });
    await expect(
      env.services.tasks.reorderTasks(
        { orderId, orderedTaskIds: detail!.tasks.map((row) => row.id).reverse() },
        env.token,
      ),
    ).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
  });
});

import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { createServices } from '../../src/application';
import type {
  CreateOrderCommand,
  TemplateDraft,
  TemplateTaskDraft,
} from '../../src/application/contracts';
import { DatasetRuntime } from '../../src/storage/datasetRuntime';
import { resetControlDb } from '../../src/storage/controlDb';
import { resolveTemplateServiceDefaults } from '../../src/domain/templateServiceDefaults';
import { applyTemplateTitle, editedTitle, type TitleState } from '../../src/domain/templateTitle';
import { hostingEndDateForWeekdays } from '../../src/domain/gameCalendar';
import { parseTemplateFile } from '../../src/backup/templateCodec';

/**
 * Template format-4 exchange regressions found while closing the Stage-5 template gap.
 *
 * - D-5: the new-order form ignored an **explicit template-level** hosting mode whenever
 *   the template's categories disagreed, so a browser import of an Android template fell
 *   back to "按日期" while Android applied "按次数" for the same file.
 * - D-6: `exportFile` never wrote the template's 区服 options even though the editor
 *   saves them and the companion Android export carries them.
 * - D-8: an explicit `DATE_RANGE` template derived its weekday restriction from the
 *   legacy category mirror instead of `serviceWeekdays`, and the order form never carried
 *   the exact weekday set into the create command, so a restricted template produced a
 *   Monday–Friday (or unrestricted) period while the template file said `1,3,5`.
 */

let idCounter = 0;
let clock = Date.UTC(2026, 2, 10, 4, 0);

async function freshEnv() {
  const names = await Dexie.getDatabaseNames();
  for (const name of names) {
    if (name.startsWith('daigan-data-') || name === 'daigan-control') {
      await Dexie.delete(name);
    }
  }
  resetControlDb();
  idCounter = 0;
  clock = Date.UTC(2026, 2, 10, 4, 0);
  const newId = () => `tpl-${++idCounter}`;
  const runtime = new DatasetRuntime({ newId, now: () => clock });
  const services = createServices(runtime, () => clock, newId);
  await runtime.init();
  const token = await runtime.current();
  return { runtime, services, token };
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(blob);
  });
}

const draft: TemplateDraft = {
  gameName: '互通模板游戏',
  templateVersion: '2026.10',
  gameVersionNotes: null,
  zoneId: 'Asia/Shanghai',
  dailyRefreshMinutes: 240,
  weeklyRefreshDay: 1,
  weeklyRefreshMinutes: 300,
  hostingMode: 'COUNT_BASED',
  targetSessions: 6,
  serviceWeekdays: null,
  defaultOrderTitle: '安卓模板默认标题',
  serverOptions: ['官服', '渠道服'],
  pricePresets: [{ amountCents: 3000, label: '定金' }],
  categories: [
    {
      name: '计次分类',
      hostingMode: 'COUNT_BASED',
      targetSessions: 4,
      serviceWeekdays: null,
      serviceMode: 'count',
      serviceCount: 4,
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
          title: '抽数累计',
          progressType: 'NUMERIC',
          startValue: '0',
          targetValue: '120.5',
          unit: '抽',
          recurrence: 'DAILY',
          weekdays: null,
          everyNDays: null,
          monthDay: null,
          numericMode: 'CUMULATIVE',
        },
      ],
    },
    {
      name: '按日分类',
      hostingMode: 'DATE_RANGE',
      targetSessions: null,
      serviceWeekdays: '1,3,5',
      serviceMode: 'weekdays',
      serviceCount: null,
      tasks: [
        {
          title: '周常',
          progressType: 'CHECKBOX',
          startValue: '0',
          targetValue: '1',
          unit: null,
          recurrence: 'WEEKLY',
          weekdays: null,
          everyNDays: null,
          monthDay: null,
        },
      ],
    },
  ],
};

describe('D-6 模板导出必须带上该游戏的区服选项', () => {
  it('模板保存的区服选项会写进导出文件（保存后不经过界面也能往返）', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(draft, env.token);
    const detail = await env.services.queries.templateDetail(templateId);
    expect(detail?.serverOptions).toEqual(['官服', '渠道服']);

    const text = await readBlob(await env.services.templates.exportFile(templateId));
    const reparsed = parseTemplateFile(text);
    expect(reparsed.serverOptions).toEqual(['官服', '渠道服']);
    // The rest of the format-4 content is unchanged by the fix.
    expect(reparsed.defaultOrderTitle).toBe('安卓模板默认标题');
    expect(reparsed.hostingMode).toBe('COUNT_BASED');
    expect(reparsed.targetSessions).toBe(6);
    expect(reparsed.categories.map((category) => category.name)).toEqual([
      '计次分类',
      '按日分类',
    ]);
  });

  it('导入一个带区服选项的文件后再次导出仍然带着它', async () => {
    const env = await freshEnv();
    const source = await env.services.templates.save(draft, env.token);
    const original = await readBlob(await env.services.templates.exportFile(source));
    const file = new Blob([original], { type: 'application/json' });
    const importedId = await env.services.templates.importFile(file, 'copy', env.token);
    const reexported = parseTemplateFile(
      await readBlob(await env.services.templates.exportFile(importedId)),
    );
    expect(reexported.serverOptions).toEqual(['官服', '渠道服']);
  });
});

describe('D-5 建单表单的模板服务默认值', () => {
  it('显式模板级按次数优先于彼此不一致的分类（安卓同口径）', () => {
    // 分类不一致 → 旧 serviceMode 镜像为 null；这正是曾经的跨端不一致来源。
    expect(
      resolveTemplateServiceDefaults({
        hostingMode: 'COUNT_BASED',
        targetSessions: 6,
        serviceMode: null,
        serviceCount: null,
        categories: [
          { hostingMode: 'COUNT_BASED', targetSessions: 4 },
          { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' },
        ],
      }),
    ).toEqual({
      serviceMode: 'count',
      serviceCount: 6,
      serviceWeekdays: [],
      conflict: false,
      explicit: true,
    });
  });

  it('显式按日期只看 serviceWeekdays：有集合才仅服务日，缺失即不限制', () => {
    expect(
      resolveTemplateServiceDefaults({
        hostingMode: 'DATE_RANGE',
        serviceWeekdays: '5,1,3,3',
      }),
    ).toEqual({
      serviceMode: 'weekdays',
      serviceCount: null,
      serviceWeekdays: [1, 3, 5],
      conflict: false,
      explicit: true,
    });
    expect(
      resolveTemplateServiceDefaults({
        hostingMode: 'DATE_RANGE',
        serviceWeekdays: null,
        serviceMode: 'weekdays',
      }),
    ).toMatchObject({ serviceMode: 'dates', serviceWeekdays: [] });
  });

  it('模板没有意见时才退回旧镜像（保持既有行为）', () => {
    expect(
      resolveTemplateServiceDefaults({ hostingMode: null, serviceMode: 'count', serviceCount: 3 }),
    ).toMatchObject({ serviceMode: 'count', serviceCount: 3 });
    expect(
      resolveTemplateServiceDefaults({ hostingMode: null, serviceMode: null }),
    ).toMatchObject({ serviceMode: 'dates', serviceCount: null, serviceWeekdays: [] });
  });

  it('空模板明细不会让表单崩溃（全部缺省 → 按日期）', () => {
    expect(resolveTemplateServiceDefaults({})).toMatchObject({
      serviceMode: 'dates',
      serviceCount: null,
      serviceWeekdays: [],
    });
  });
});

// ---------------------------------------------------------------------------
// D-8：模板显式服务星期必须穿过表单→命令→期次；以下断言的是**持久化结果**。
// ---------------------------------------------------------------------------

type Env = Awaited<ReturnType<typeof freshEnv>>;
let orderSeq = 0;

function weekdayTask(title: string): TemplateTaskDraft {
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

function categoryDraft(
  name: string,
  defaults: {
    hostingMode: 'DATE_RANGE' | 'COUNT_BASED' | null;
    targetSessions?: number | null;
    serviceWeekdays?: string | null;
  },
  tasks: TemplateTaskDraft[] = [weekdayTask('签到')],
): TemplateDraft['categories'][number] {
  return {
    name,
    hostingMode: defaults.hostingMode,
    targetSessions: defaults.targetSessions ?? null,
    serviceWeekdays: defaults.serviceWeekdays ?? null,
    tasks,
  };
}

function serviceTemplate(
  gameName: string,
  templateDefaults: {
    hostingMode?: 'DATE_RANGE' | 'COUNT_BASED' | null;
    targetSessions?: number | null;
    serviceWeekdays?: string | null;
  },
  categories: TemplateDraft['categories'],
  defaultOrderTitle: string | null,
): TemplateDraft {
  return {
    gameName,
    templateVersion: '2026.10',
    gameVersionNotes: null,
    zoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 240,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    hostingMode: templateDefaults.hostingMode ?? null,
    targetSessions: templateDefaults.targetSessions ?? null,
    serviceWeekdays: templateDefaults.serviceWeekdays ?? null,
    defaultOrderTitle,
    categories,
  };
}

/** 显式 DATE_RANGE + 1,3,5，但分类镜像彼此不一致（旧 serviceMode 镜像为 null）。 */
function restrictedDraft(): TemplateDraft {
  return serviceTemplate(
    '星期受限游戏',
    { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' },
    [
      categoryDraft('受限分类', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
      categoryDraft('无限制分类', { hostingMode: 'DATE_RANGE', serviceWeekdays: null }),
    ],
    '星期三托管',
  );
}

/** 显式 DATE_RANGE 但不限制星期；分类镜像一致为“工作日”（旧镜像 = weekdays）。 */
function unrestrictedDraft(): TemplateDraft {
  return serviceTemplate(
    '星期无限制游戏',
    { hostingMode: 'DATE_RANGE', serviceWeekdays: null },
    [
      categoryDraft('工作日分类甲', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
      categoryDraft('工作日分类乙', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
    ],
    '无限制托管',
  );
}

/** 显式 COUNT_BASED，分类里同时留着日期/星期状态（旧镜像为 null）。 */
function countDraft(): TemplateDraft {
  return serviceTemplate(
    '星期计次游戏',
    { hostingMode: 'COUNT_BASED', targetSessions: 6 },
    [
      categoryDraft('计次分类', { hostingMode: 'COUNT_BASED', targetSessions: 4 }),
      categoryDraft('按日分类', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
    ],
    '计次托管',
  );
}

/** 模板级无意见，分类一致按日期 + 1,3,5：分类共识应生效。 */
function consensusDraft(): TemplateDraft {
  return serviceTemplate(
    '共识游戏',
    { hostingMode: null },
    [
      categoryDraft('共识分类甲', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
      categoryDraft('共识分类乙', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
    ],
    '共识托管',
  );
}

/** 模板级无意见，分类彼此不一致：不得替用户挑一个分类。 */
function disagreeDraft(): TemplateDraft {
  return serviceTemplate(
    '分歧游戏',
    { hostingMode: null },
    [
      categoryDraft('分歧计次分类', { hostingMode: 'COUNT_BASED', targetSessions: 4 }),
      categoryDraft('分歧按日分类', { hostingMode: 'DATE_RANGE', serviceWeekdays: '1,3,5' }),
    ],
    '分歧托管',
  );
}

async function seedAccount(env: Env): Promise<{ ownerId: string; accountId: string }> {
  const ownerId = await env.services.accounts.saveOwner({ nickname: '星期老板' }, env.token);
  const accountId = await env.services.accounts.saveAccount(
    {
      ownerId,
      gameName: '星期测试游戏',
      server: '官服',
      uid: '9001',
      loginAccount: 'weekday-account',
      loginMethod: 'PASSWORD',
      password: 'secret',
    },
    env.token,
  );
  return { ownerId, accountId };
}

/**
 * 与 `OrderEditor.submit` 完全同构：模板明细 → 解析器 → 表单状态 → 建单命令。
 * 返回持久化的订单行与期次行，供断言“真的落库”。
 */
async function createOrderFromTemplate(
  env: Env,
  templateId: string,
  form: { startDate?: string; endDate?: string; serviceDays?: number },
) {
  const detail = (await env.services.queries.templateDetail(templateId))!;
  const defaults = resolveTemplateServiceDefaults(detail);
  const mode = defaults.serviceMode ?? 'dates';
  const { ownerId, accountId } = await seedAccount(env);
  const tasks = detail.categories
    .flatMap((category) => category.tasks)
    .filter((task) => task.recurrence !== 'ONE_TIME');
  const created = await env.services.orders.create(
    {
      operationId: `op-template-${++orderSeq}`,
      ownerId,
      accountId,
      type: 'HOSTING',
      title: detail.defaultOrderTitle?.trim() || `${detail.gameName} 托管`,
      notes: null,
      paymentMode: 'INSTALLMENTS',
      priceCents: null,
      deadlineDate: null,
      gameZoneId: detail.zoneId,
      dailyRefreshMinutes: detail.dailyRefreshMinutes,
      weeklyRefreshDay: detail.weeklyRefreshDay,
      weeklyRefreshMinutes: detail.weeklyRefreshMinutes,
      startDate: mode === 'count' ? null : (form.startDate ?? null),
      endDate: mode === 'dates' ? (form.endDate ?? null) : null,
      periodPriceCents: 30000,
      serviceDays: mode === 'weekdays' ? (form.serviceDays ?? null) : null,
      serviceWeekdays: mode === 'weekdays' ? defaults.serviceWeekdays : null,
      serviceCount: mode === 'count' ? defaults.serviceCount : null,
      tasks,
      firstReceipt: null,
      sourceTemplateId: detail.id ?? null,
      sourceTemplateName: detail.gameName,
      sourceTemplateVersion: detail.templateVersion,
    },
    env.token,
  );
  const persisted = await env.runtime.read((ctx) => ({
    order: ctx.data.orders.find((row) => row.id === created.orderId)!,
    period: ctx.data.hosting_periods.find((row) => row.orderId === created.orderId)!,
  }));
  return { detail, defaults, mode, ...persisted };
}

describe('D-8 模板服务星期：显式值优先并原样落到期次', () => {
  it('显式 DATE_RANGE + 周一/周三/周五：冲突或为 null 的旧镜像都不得覆盖', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(restrictedDraft(), env.token);
    const detail = (await env.services.queries.templateDetail(templateId))!;
    // 前置事实（复现缺陷的输入）：显式星期存在，而旧镜像因为分类不一致为 null。
    expect(detail.hostingMode).toBe('DATE_RANGE');
    expect(detail.serviceWeekdays).toBe('1,3,5');
    expect(detail.serviceMode).toBeNull();
    // 旧实现按旧镜像 → dates；显式值必须赢，并且镜像即使是 'dates' 也一样。
    expect(resolveTemplateServiceDefaults(detail)).toMatchObject({
      serviceMode: 'weekdays',
      serviceWeekdays: [1, 3, 5],
    });
    expect(
      resolveTemplateServiceDefaults({ ...detail, serviceMode: 'dates' }).serviceWeekdays,
    ).toEqual([1, 3, 5]);

    const created = await createOrderFromTemplate(env, templateId, {
      startDate: '2026-03-10',
      serviceDays: 5,
    });
    expect(created.defaults).toMatchObject({
      serviceMode: 'weekdays',
      serviceWeekdays: [1, 3, 5],
      explicit: true,
    });
    expect(created.order.title).toBe('星期三托管');
    expect(created.order.hostingMode).toBe('DATE_RANGE');
    expect(created.period.serviceDays).toBe(5);
    expect(created.period.serviceWeekdays).toBe('1,3,5');
    expect(created.period.serviceCount).toBeNull();
    expect(created.period.startDate).toBe('2026-03-10');
    // 2026-03-10 周二 → 服务日 03-11(三) 03-13(五) 03-16(一) 03-18(三) 03-20(五)
    expect(created.period.endDate).toBe('2026-03-20');
  });

  it('显式 DATE_RANGE 且不限制星期：旧 weekdays 镜像不会让期次只剩工作日', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(unrestrictedDraft(), env.token);
    const detail = (await env.services.queries.templateDetail(templateId))!;
    // 前置事实：旧镜像确实是 weekdays，显式模板级却没有星期限制。
    expect(detail.serviceMode).toBe('weekdays');
    expect(detail.serviceWeekdays).toBeNull();
    expect(resolveTemplateServiceDefaults(detail)).toMatchObject({
      serviceMode: 'dates',
      serviceWeekdays: [],
    });

    const created = await createOrderFromTemplate(env, templateId, {
      startDate: '2026-03-10',
      endDate: '2026-03-31',
    });
    expect(created.period.serviceDays).toBeNull();
    expect(created.period.serviceWeekdays).toBeNull();
    expect(created.period.startDate).toBe('2026-03-10');
    expect(created.period.endDate).toBe('2026-03-31');
  });

  it('显式 COUNT_BASED：目标次数保持正确，日期/星期状态不会漏进计次期次', async () => {
    const env = await freshEnv();
    const templateId = await env.services.templates.save(countDraft(), env.token);
    const created = await createOrderFromTemplate(env, templateId, {});
    expect(created.defaults).toMatchObject({
      serviceMode: 'count',
      serviceCount: 6,
      serviceWeekdays: [],
    });
    expect(created.order.hostingMode).toBe('COUNT_BASED');
    expect(created.order.targetSessions).toBe(6);
    expect(created.period.serviceCount).toBe(6);
    expect(created.period.serviceDays).toBeNull();
    expect(created.period.serviceWeekdays).toBeNull();
    // 计次期次只用创建游戏日作内部锚点，不带日历期限。
    expect(created.period.startDate).toBe('2026-03-10');
    expect(created.period.endDate).toBe('2026-03-10');
  });

  it('模板级无意见：分类共识生效；分歧不挑分类；旧镜像仍作最后兜底', async () => {
    const env = await freshEnv();
    const consensusId = await env.services.templates.save(consensusDraft(), env.token);
    const consensus = await createOrderFromTemplate(env, consensusId, {
      startDate: '2026-03-10',
      serviceDays: 3,
    });
    expect(consensus.defaults).toMatchObject({
      serviceMode: 'weekdays',
      serviceWeekdays: [1, 3, 5],
      explicit: false,
      conflict: false,
    });
    expect(consensus.period.serviceWeekdays).toBe('1,3,5');
    // 2026-03-10 周二 → 03-11、03-13、03-16 三天。
    expect(consensus.period.endDate).toBe('2026-03-16');

    const disagreeId = await env.services.templates.save(disagreeDraft(), env.token);
    const disagreeDetail = (await env.services.queries.templateDetail(disagreeId))!;
    expect(resolveTemplateServiceDefaults(disagreeDetail)).toMatchObject({
      serviceMode: null,
      serviceWeekdays: [],
      conflict: true,
    });

    // 旧镜像兜底（历史语义：weekdays = 周一至周五）。
    expect(
      resolveTemplateServiceDefaults({ hostingMode: null, serviceMode: 'weekdays' }),
    ).toMatchObject({ serviceMode: 'weekdays', serviceWeekdays: [1, 2, 3, 4, 5] });
    expect(
      resolveTemplateServiceDefaults({ hostingMode: null, serviceMode: 'count', serviceCount: 3 }),
    ).toMatchObject({ serviceMode: 'count', serviceCount: 3, serviceWeekdays: [] });
  });

  it('切换模板：自定义星期 → 无限制日期 → 按次数，不残留星期且保留手填标题', async () => {
    const env = await freshEnv();
    const restrictedId = await env.services.templates.save(restrictedDraft(), env.token);
    const unrestrictedId = await env.services.templates.save(unrestrictedDraft(), env.token);
    const countId = await env.services.templates.save(countDraft(), env.token);

    const apply = async (id: string, title: TitleState) => {
      const detail = (await env.services.queries.templateDetail(id))!;
      return {
        defaults: resolveTemplateServiceDefaults(detail),
        title: applyTemplateTitle(title, detail.defaultOrderTitle ?? `${detail.gameName} 托管`),
      };
    };

    let title: TitleState = { value: '', provenance: 'none' };
    const first = await apply(restrictedId, title);
    expect(first.defaults).toMatchObject({ serviceMode: 'weekdays', serviceWeekdays: [1, 3, 5] });
    expect(first.title).toEqual({ value: '星期三托管', provenance: 'auto' });

    // 手填标题后切换：标题来源不变，星期必须整体替换/清空。
    title = editedTitle('手填标题');
    const second = await apply(unrestrictedId, title);
    expect(second.defaults).toMatchObject({ serviceMode: 'dates', serviceWeekdays: [] });
    expect(second.title).toEqual({ value: '手填标题', provenance: 'manual' });

    const third = await apply(countId, title);
    expect(third.defaults).toMatchObject({ serviceMode: 'count', serviceWeekdays: [] });
    expect(third.title).toEqual({ value: '手填标题', provenance: 'manual' });

    // 清空标题后再套受限模板：星期恢复为模板集合，标题重新带入。
    const fourth = await apply(restrictedId, editedTitle(''));
    expect(fourth.defaults).toMatchObject({ serviceMode: 'weekdays', serviceWeekdays: [1, 3, 5] });
    expect(fourth.title).toEqual({ value: '星期三托管', provenance: 'auto' });
  });

  it('服务日结束日按同一集合推算（手算期望值）', () => {
    expect(hostingEndDateForWeekdays('2026-03-10', 5, new Set([1, 3, 5]))).toBe('2026-03-20');
    expect(hostingEndDateForWeekdays('2026-03-10', 5, new Set([1, 2, 3, 4, 5]))).toBe('2026-03-16');
  });

  it('普通建单（不套模板）仍是周一至周五，并拒绝空/非法星期', async () => {
    const env = await freshEnv();
    const { ownerId, accountId } = await seedAccount(env);
    const command = (overrides: Partial<CreateOrderCommand>): CreateOrderCommand => ({
      operationId: `op-ordinary-${++orderSeq}`,
      ownerId,
      accountId,
      type: 'HOSTING',
      title: '普通托管',
      notes: null,
      paymentMode: 'INSTALLMENTS',
      priceCents: null,
      deadlineDate: null,
      gameZoneId: 'Asia/Shanghai',
      dailyRefreshMinutes: 240,
      weeklyRefreshDay: 1,
      weeklyRefreshMinutes: 300,
      startDate: '2026-03-10',
      endDate: null,
      periodPriceCents: 20000,
      serviceDays: 20,
      tasks: [weekdayTask('签到')],
      firstReceipt: null,
      sourceTemplateId: null,
      sourceTemplateName: null,
      sourceTemplateVersion: null,
      ...overrides,
    });

    const created = await env.services.orders.create(command({}), env.token);
    const persisted = await env.runtime.read((ctx) =>
      ctx.data.hosting_periods.find((row) => row.orderId === created.orderId)!,
    );
    expect(persisted.serviceWeekdays).toBe('1,2,3,4,5');
    expect(persisted.serviceDays).toBe(20);
    // 2026-03-10 起 20 个周一至周五 → 2026-04-06。
    expect(persisted.endDate).toBe('2026-04-06');

    await expect(
      env.services.orders.create(command({ serviceWeekdays: [] }), env.token),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      env.services.orders.create(command({ serviceWeekdays: [0, 8] }), env.token),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

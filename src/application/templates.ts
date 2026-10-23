import genericTemplate from '../assets/templates/generic.json';
import { AppError } from '../contracts/errors';
import type {
  GameTemplateRow,
  TemplateCategoryRow,
  TemplatePricePresetRow,
  TemplateTaskRow,
} from '../contracts/tables';
import { isISODate, isValidZone } from '../domain/gameCalendar';
import { bytesOf } from '../backup/archive';
import { parseTemplateFile, readTemplateFile, serializeTemplate } from '../backup/templateCodec';

import type { DatasetRuntime, DatasetToken, WriteContext } from '../storage/datasetRuntime';
import type { TemplateDraft } from './contracts';
import { requireText } from './guards';
import {
  legacyModeFromServiceDefaults,
  serviceDefaultsFromLegacyMode,
} from '../backup/normalize/categoryDefaults';

export interface TemplateDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

const BUILT_IN_KEY = 'generic';

function validateDraft(draft: TemplateDraft): TemplateDraft {
  const gameName = requireText(draft.gameName, '游戏名称', 1, 40);
  const templateVersion = requireText(draft.templateVersion, '模板版本', 1, 30);
  if (!isValidZone(draft.zoneId)) throw new AppError('INVALID_INPUT', '时区不合法');
  if (draft.categories.length < 1 || draft.categories.length > 20) {
    throw new AppError('INVALID_INPUT', '分类数量必须为 1–20');
  }
  const pricePresets = (draft.pricePresets ?? []).slice(0, 20).map((preset) => ({
    amountCents: preset.amountCents,
    label: preset.label?.trim().slice(0, 30) ?? null,
  }));
  pricePresets.forEach((preset) => {
    if (!Number.isSafeInteger(preset.amountCents) || preset.amountCents < 1) {
      throw new AppError('INVALID_INPUT', '价格预设金额必须为正整数分');
    }
  });
  // 服务模式（UF：下沉到分类）：'dates'/其余与缺省同义（存 null）；'count' 需要服务次数。
  // 分类未显式指定时沿用模板级旧值（兼容旧草稿）；模板级字段保存为分类共识值。
  const legacyMode: 'weekdays' | 'count' | null =
    draft.serviceMode === 'weekdays' || draft.serviceMode === 'count' ? draft.serviceMode : null;
  const legacyCount = draft.serviceCount ?? null;
  let total = 0;
  const categories = draft.categories.map((category) => {
    const name = requireText(category.name, '分类名称', 1, 30);
    if (category.tasks.length < 1) throw new AppError('INVALID_INPUT', '每个分类至少需要一个任务');
    total += category.tasks.length;
    if (total > 100) throw new AppError('INVALID_INPUT', '任务总数最多 100 个');
    const inheritLegacy = category.serviceMode === undefined;
    const rawMode = inheritLegacy ? legacyMode : category.serviceMode;
    const serviceMode: 'weekdays' | 'count' | null =
      rawMode === 'weekdays' || rawMode === 'count' ? rawMode : null;
    let serviceCount: number | null = null;
    if (serviceMode === 'count') {
      const count = category.serviceCount ?? (inheritLegacy ? legacyCount : null);
      if (count === null || !Number.isSafeInteger(count) || count < 1 || count > 3650) {
        throw new AppError('INVALID_INPUT', '按次数模式的服务次数必须为 1–3650');
      }
      serviceCount = count;
    }
    return {
      name,
      serviceMode,
      serviceCount,
      // 显式分层默认值必须原样带下去（v4 模板文件/导入会给出它们）。
      hostingMode: category.hostingMode,
      targetSessions: category.targetSessions ?? null,
      serviceWeekdays: category.serviceWeekdays ?? null,
      tasks: category.tasks.map((task) => {
        const title = requireText(task.title, '任务标题', 1, 40);
        if (task.recurrence === 'SELECTED_WEEKDAYS' && !task.weekdays) {
          throw new AppError('INVALID_INPUT', '指定星期任务必须选择星期');
        }
        if (task.recurrence === 'EVERY_N_DAYS' && (!task.everyNDays || task.everyNDays < 1)) {
          throw new AppError('INVALID_INPUT', '每隔 N 天必须为 1–365');
        }
        if (task.recurrence === 'MONTHLY' && (!task.monthDay || task.monthDay < 1 || task.monthDay > 31)) {
          throw new AppError('INVALID_INPUT', '每月任务必须填写 1–31 的日号');
        }
        const activeFrom = optionalTaskDate(task.activeFrom, '任务生效起始日');
        const activeUntil = optionalTaskDate(task.activeUntil, '任务生效截止日');
        if (activeFrom !== null && activeUntil !== null && activeUntil < activeFrom) {
          throw new AppError('INVALID_INPUT', '任务生效截止日不能早于生效起始日');
        }
        return { ...task, title, activeFrom, activeUntil };
      }),
    };
  });
  // 模板级字段 = 显式值，否则分类共识（一致才输出，分歧为 null）。
  const categoryDefaults = categories.map((item) =>
    item.hostingMode !== undefined
      ? {
          hostingMode: item.hostingMode,
          targetSessions: item.hostingMode === 'COUNT_BASED' ? (item.targetSessions ?? null) : null,
          serviceWeekdays:
            item.hostingMode === 'DATE_RANGE' ? (item.serviceWeekdays ?? null) : null,
        }
      : serviceDefaultsFromLegacyMode(item.serviceMode, item.serviceCount, 'category'),
  );
  const firstDefaults = categoryDefaults[0];
  const allSame = categoryDefaults.every(
    (item) =>
      item.hostingMode === firstDefaults.hostingMode &&
      item.targetSessions === firstDefaults.targetSessions &&
      item.serviceWeekdays === firstDefaults.serviceWeekdays,
  );
  const templateDefaults =
    draft.hostingMode !== undefined
      ? {
          hostingMode: draft.hostingMode,
          targetSessions: draft.hostingMode === 'COUNT_BASED' ? (draft.targetSessions ?? null) : null,
          serviceWeekdays:
            draft.hostingMode === 'DATE_RANGE' ? (draft.serviceWeekdays ?? null) : null,
        }
      : allSame
        ? firstDefaults
        : { hostingMode: null, targetSessions: null, serviceWeekdays: null };
  const templateMirror = legacyModeFromServiceDefaults(templateDefaults, 'template');
  return {
    ...draft,
    gameName,
    templateVersion,
    gameVersionNotes: draft.gameVersionNotes?.slice(0, 300) ?? null,
    categories,
    pricePresets,
    hostingMode: templateDefaults.hostingMode,
    targetSessions: templateDefaults.targetSessions,
    serviceWeekdays: templateDefaults.serviceWeekdays,
    serviceMode: templateMirror.serviceMode ?? null,
    serviceCount: templateMirror.serviceCount,
    dailyRefreshMinutes: Math.min(1439, Math.max(0, Math.trunc(draft.dailyRefreshMinutes))),
    weeklyRefreshDay: Math.min(7, Math.max(1, Math.trunc(draft.weeklyRefreshDay))),
    weeklyRefreshMinutes: Math.min(1439, Math.max(0, Math.trunc(draft.weeklyRefreshMinutes))),
  };
}

function optionalTaskDate(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  if (!isISODate(value)) throw new AppError('INVALID_INPUT', `${label}不是有效日期`);
  return value;
}

/**
 * 模板行写入的托管默认值。
 *
 * `draft.serviceMode` 在 `validateDraft` 之后已经是**分类共识**，因此这里写出的
 * `hostingMode` 正是"一致才写、分歧为 null"的镜像；`serviceMode/serviceCount`
 * 只是本机派生镜像（Stage 4 移除），不进入便携目录。
 */
function templateRowDefaults(
  draft: TemplateDraft,
): Pick<
  GameTemplateRow,
  | 'hostingMode'
  | 'targetSessions'
  | 'serviceWeekdays'
  | 'defaultOrderTitle'
  | 'serviceMode'
  | 'serviceCount'
> {
  // v4 文件/导入带来显式分层默认值时优先使用；旧界面草稿走 legacy 映射。
  const defaults =
    draft.hostingMode !== undefined
      ? {
          hostingMode: draft.hostingMode,
          targetSessions: draft.hostingMode === 'COUNT_BASED' ? (draft.targetSessions ?? null) : null,
          serviceWeekdays: draft.hostingMode === 'DATE_RANGE' ? (draft.serviceWeekdays ?? null) : null,
        }
      : serviceDefaultsFromLegacyMode(draft.serviceMode, draft.serviceCount, 'template');
  const mirror = legacyModeFromServiceDefaults(defaults, 'template');
  const rawTitle = draft.defaultOrderTitle ?? null;
  const trimmed = rawTitle === null ? '' : rawTitle.trim().slice(0, 60);
  return {
    hostingMode: defaults.hostingMode,
    targetSessions: defaults.targetSessions,
    serviceWeekdays: defaults.serviceWeekdays,
    defaultOrderTitle: trimmed.length > 0 ? trimmed : null,
    serviceMode: mirror.serviceMode ?? null,
    serviceCount: mirror.serviceCount,
  };
}

export function createTemplateServices({ runtime, newId, now }: TemplateDeps) {
  /** 模板携带的区服选项同步到 game_server_options（UF-005），不覆盖已有同名项。 */
  async function syncServerOptions(ctx: WriteContext, draft: TemplateDraft): Promise<void> {
    const options = draft.serverOptions ?? [];
    if (options.length === 0) return;
    const gameName = draft.gameName.trim();
    const key = gameName.toLowerCase();
    const existing = ctx.data.game_server_options
      .filter((row) => row.gameName.trim().toLowerCase() === key)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const seen = new Set(existing.map((row) => row.name.trim().toLowerCase()));
    let nextOrder = existing.length;
    for (const name of options) {
      const trimmed = name.trim().slice(0, 60);
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      // 同批导入也要去重（写前快照看不到本批已插入的行）。
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (nextOrder >= 50) break;
      await ctx.table('game_server_options').add({
        id: newId(),
        gameName: gameName.slice(0, 40),
        name: trimmed,
        sortOrder: nextOrder,
      });
      nextOrder += 1;
    }
  }

  async function writeTemplateContent(
    ctx: WriteContext,
    templateId: string,
    draft: TemplateDraft,
  ): Promise<void> {
    const existingCategories = ctx.data.template_categories.filter(
      (row) => row.templateId === templateId,
    );
    for (const category of existingCategories) {
      await ctx.table('template_categories').delete(category.id);
    }
    const existingTasks = ctx.data.template_tasks.filter((row) => row.templateId === templateId);
    for (const task of existingTasks) {
      await ctx.table('template_tasks').delete(task.id);
    }
    const existingPresets = ctx.data.template_price_presets.filter(
      (row) => row.templateId === templateId,
    );
    for (const preset of existingPresets) {
      await ctx.table('template_price_presets').delete(preset.id);
    }
    let presetOrder = 0;
    for (const preset of draft.pricePresets ?? []) {
      const presetRow: TemplatePricePresetRow = {
        id: newId(),
        templateId,
        amountCents: preset.amountCents,
        label: preset.label ?? null,
        sortOrder: presetOrder++,
      };
      await ctx.table('template_price_presets').add(presetRow);
    }

    let sortOrder = 0;
    for (const category of draft.categories) {
      const categoryMode =
        category.serviceMode === 'weekdays' || category.serviceMode === 'count'
          ? category.serviceMode
          : null;
      // schema 15：托管默认值下沉到分类。显式 null 表示"继承模板"，不能被改写为 dates。
      const categoryDefaults =
        category.hostingMode !== undefined
          ? {
              hostingMode: category.hostingMode,
              targetSessions: category.targetSessions ?? null,
              serviceWeekdays: category.serviceWeekdays ?? null,
            }
          : serviceDefaultsFromLegacyMode(
              categoryMode,
              categoryMode === 'count' ? (category.serviceCount ?? null) : null,
              'category',
            );
      const categoryMirror = legacyModeFromServiceDefaults(categoryDefaults, 'category');
      const categoryRow: TemplateCategoryRow = {
        id: newId(),
        templateId,
        name: category.name,
        sortOrder: sortOrder++,
        hostingMode: categoryDefaults.hostingMode,
        targetSessions: categoryDefaults.targetSessions,
        serviceWeekdays: categoryDefaults.serviceWeekdays,
        serviceMode: categoryMirror.serviceMode ?? null,
        serviceCount: categoryMirror.serviceCount,
      };
      await ctx.table('template_categories').add(categoryRow);
      for (const task of category.tasks) {
        const taskRow: TemplateTaskRow = {
          id: newId(),
          templateId,
          categoryId: categoryRow.id,
          title: task.title,
          progressType: task.progressType,
          startValue: task.progressType === 'CHECKBOX' ? '0' : task.startValue,
          targetValue: task.progressType === 'CHECKBOX' ? '1' : task.targetValue,
          unit: task.progressType === 'CHECKBOX' ? null : task.unit,
          recurrence: task.recurrence,
          weekdays: task.recurrence === 'SELECTED_WEEKDAYS' ? task.weekdays : null,
          everyNDays: task.recurrence === 'EVERY_N_DAYS' ? task.everyNDays : null,
          sortOrder: sortOrder++,
          monthDay: task.recurrence === 'MONTHLY' ? task.monthDay : null,
          monthDays: task.recurrence === 'MONTHLY' ? (task.monthDays ?? null) : null,
          activeFrom: task.activeFrom ?? null,
          activeUntil: task.activeUntil ?? null,
          numericMode: task.numericMode ?? null,
        };
        await ctx.table('template_tasks').add(taskRow);
      }
    }
  }

  return {
    async ensureBuiltIns(): Promise<void> {
      const token = await runtime.current();
      await runtime.write(token, async (ctx) => {
        const seeded = await ctx.table('template_seed_state').get(BUILT_IN_KEY);
        if (seeded) return;
        const existing = ctx.data.game_templates.find(
          (template) => template.builtInKey === BUILT_IN_KEY,
        );
        if (!existing) {
          const draft = parseTemplateFile(JSON.stringify(genericTemplate));
          const templateId = newId();
          const row: GameTemplateRow = {
            id: templateId,
            gameName: draft.gameName,
            templateVersion: draft.templateVersion,
            gameVersionNotes: draft.gameVersionNotes,
            zoneId: draft.zoneId,
            dailyRefreshMinutes: draft.dailyRefreshMinutes,
            weeklyRefreshDay: draft.weeklyRefreshDay,
            weeklyRefreshMinutes: draft.weeklyRefreshMinutes,
            origin: 'BUILT_IN',
            builtInKey: BUILT_IN_KEY,
            sortOrder: 0,
            createdAt: now(),
            updatedAt: now(),
            ...templateRowDefaults(draft),
          };
          await ctx.table('game_templates').add(row);
          await writeTemplateContent(ctx, templateId, draft);
        }
        await ctx.table('template_seed_state').add({ seedKey: BUILT_IN_KEY, appliedAt: now() });
      });
    },

    async save(input: TemplateDraft, token: DatasetToken): Promise<string> {
      const draft = validateDraft(input);
      return runtime.write(token, async (ctx) => {
        let templateId = draft.id ?? null;
        let existing: GameTemplateRow | undefined;
        if (templateId) {
          existing = ctx.data.game_templates.find((row) => row.id === templateId);
          if (!existing) throw new AppError('NOT_FOUND', '模板不存在');
        }
        const nameConflict = ctx.data.game_templates.find(
          (row) =>
            row.id !== templateId &&
            row.gameName.trim().toLowerCase() === draft.gameName.trim().toLowerCase(),
        );
        if (nameConflict) throw new AppError('CONFLICT', '已存在同名模板，请换一个名称');
        if (!templateId) templateId = newId();
        const row: GameTemplateRow = {
          id: templateId,
          gameName: draft.gameName,
          templateVersion: draft.templateVersion,
          gameVersionNotes: draft.gameVersionNotes,
          zoneId: draft.zoneId,
          dailyRefreshMinutes: draft.dailyRefreshMinutes,
          weeklyRefreshDay: draft.weeklyRefreshDay,
          weeklyRefreshMinutes: draft.weeklyRefreshMinutes,
          origin: existing?.origin ?? 'USER',
          builtInKey: existing?.builtInKey ?? null,
          sortOrder: existing?.sortOrder ?? ctx.data.game_templates.length,
          createdAt: existing?.createdAt ?? now(),
          updatedAt: now(),
          ...templateRowDefaults(draft),
        };
        await ctx.table('game_templates').put(row);
        await writeTemplateContent(ctx, templateId, draft);
        await syncServerOptions(ctx, draft);
        return templateId;
      });
    },

    async remove(id: string, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const template = ctx.data.game_templates.find((row) => row.id === id);
        if (!template) return;
        for (const task of ctx.data.template_tasks.filter((row) => row.templateId === id)) {
          await ctx.table('template_tasks').delete(task.id);
        }
        for (const category of ctx.data.template_categories.filter((row) => row.templateId === id)) {
          await ctx.table('template_categories').delete(category.id);
        }
        for (const preset of ctx.data.template_price_presets.filter(
          (row) => row.templateId === id,
        )) {
          await ctx.table('template_price_presets').delete(preset.id);
        }
        await ctx.table('game_templates').delete(id);
        // 种子标记保留：删除内置模板后不会在下次启动复活。
        for (const account of ctx.data.game_accounts) {
          if (account.defaultTemplateId === id) {
            await ctx.table('game_accounts').put({ ...account, defaultTemplateId: null });
          }
        }
      });
    },

    async importFile(file: Blob, mode: 'copy' | 'replace', token: DatasetToken): Promise<string> {
      const bytes = await bytesOf(file);
      const imported = readTemplateFile(bytes);
      return runtime.write(token, async (ctx) => {
        const normalized = imported.gameName.trim().toLowerCase();
        const existing = ctx.data.game_templates.find(
          (row) => row.gameName.trim().toLowerCase() === normalized,
        );
        if (mode === 'replace' && existing) {
          const row: GameTemplateRow = {
            ...existing,
            gameName: imported.gameName,
            templateVersion: imported.templateVersion,
            gameVersionNotes: imported.gameVersionNotes,
            zoneId: imported.zoneId,
            dailyRefreshMinutes: imported.dailyRefreshMinutes,
            weeklyRefreshDay: imported.weeklyRefreshDay,
            weeklyRefreshMinutes: imported.weeklyRefreshMinutes,
            origin: 'IMPORTED',
            updatedAt: now(),
            ...templateRowDefaults(imported),
          };
          await ctx.table('game_templates').put(row);
          await writeTemplateContent(ctx, existing.id, imported);
          await syncServerOptions(ctx, imported);
          return existing.id;
        }

        let name = imported.gameName;
        if (existing) {
          const base = name.length > 34 ? name.slice(0, 34) : name;
          let candidate = `${base}（导入）`;
          let index = 2;
          while (
            ctx.data.game_templates.some(
              (row) => row.gameName.trim().toLowerCase() === candidate.toLowerCase(),
            )
          ) {
            candidate = `${base}（导入 ${index}）`;
            index += 1;
          }
          name = candidate;
        }
        const templateId = newId();
        const row: GameTemplateRow = {
          id: templateId,
          gameName: name.slice(0, 40),
          templateVersion: imported.templateVersion,
          gameVersionNotes: imported.gameVersionNotes,
          zoneId: imported.zoneId,
          dailyRefreshMinutes: imported.dailyRefreshMinutes,
          weeklyRefreshDay: imported.weeklyRefreshDay,
          weeklyRefreshMinutes: imported.weeklyRefreshMinutes,
          origin: 'IMPORTED',
          builtInKey: null,
          sortOrder: ctx.data.game_templates.length,
          createdAt: now(),
          updatedAt: now(),
          ...templateRowDefaults(imported),
        };
        await ctx.table('game_templates').add(row);
        await writeTemplateContent(ctx, templateId, imported);
        // 区服选项按**游戏名**存放：另存为时模板会被改名（「X（导入）」），所以必须写进
        // 改名后的键，否则模板详情与导出都查不到刚导入的区服列表（安卓 importTemplate
        // 用的是最终名，两端必须一致）。
        await syncServerOptions(ctx, { ...imported, gameName: row.gameName });
        return templateId;
      });
    },

    async exportFile(id: string): Promise<Blob> {
      const detail = await runtime.read((ctx) => {
        const template = ctx.data.game_templates.find((row) => row.id === id);
        if (!template) throw new AppError('NOT_FOUND', '模板不存在');
        const categories = ctx.data.template_categories
          .filter((row) => row.templateId === id)
          .sort((left, right) => left.sortOrder - right.sortOrder);
        const tasks = ctx.data.template_tasks.filter((row) => row.templateId === id);
        const presets = ctx.data.template_price_presets
          .filter((row) => row.templateId === id)
          .sort((left, right) => left.sortOrder - right.sortOrder);
        const draft: TemplateDraft = {
          id: template.id,
          gameName: template.gameName,
          templateVersion: template.templateVersion,
          gameVersionNotes: template.gameVersionNotes,
          zoneId: template.zoneId,
          dailyRefreshMinutes: template.dailyRefreshMinutes,
          weeklyRefreshDay: template.weeklyRefreshDay,
          weeklyRefreshMinutes: template.weeklyRefreshMinutes,
          serviceMode: template.serviceMode ?? null,
          serviceCount: template.serviceCount ?? null,
          // schema 15 的真实分层默认值：导出必须原样写出，而不是从旧镜像反推。
          hostingMode: template.hostingMode,
          targetSessions: template.targetSessions,
          serviceWeekdays: template.serviceWeekdays,
          defaultOrderTitle: template.defaultOrderTitle,
          pricePresets: presets.map((preset) => ({
            amountCents: preset.amountCents,
            label: preset.label,
          })),
          // 模板文件按格式 4 携带该游戏的区服选项（安卓导出同样如此）。这些选项按游戏
          // 存放而不是按模板，所以必须在这里读出来；漏掉会让"网页导出 → 对端导入"
          // 静默丢弃用户配置的区服列表（该字段可选，文件层面无从发现）。
          serverOptions: ctx.data.game_server_options
            .filter(
              (row) => row.gameName.trim().toLowerCase() === template.gameName.trim().toLowerCase(),
            )
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((row) => row.name),
          categories: categories.map((category) => ({
            name: category.name,
            hostingMode: category.hostingMode,
            targetSessions: category.targetSessions,
            serviceWeekdays: category.serviceWeekdays,
            tasks: tasks
              .filter((task) => task.categoryId === category.id)
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((task) => ({
                title: task.title,
                progressType: task.progressType,
                startValue: task.startValue,
                targetValue: task.targetValue,
                unit: task.unit,
                recurrence: task.recurrence,
                weekdays: task.weekdays,
                everyNDays: task.everyNDays,
                monthDay: task.monthDay,
                monthDays: task.monthDays,
                activeFrom: task.activeFrom ?? null,
                activeUntil: task.activeUntil ?? null,
                numericMode: task.numericMode,
              })),
          })),
        };
        return draft;
      });
      return new Blob([serializeTemplate(detail)], { type: 'application/json' });
    },
  };
}

import { AppError } from '../contracts/errors';
import type { HostingMode, NumericMode, ProgressType, Recurrence } from '../contracts/tables';
import {
  HOSTING_MODES,
  NUMERIC_MODES,
  PROGRESS_TYPES,
  RECURRENCES,
} from '../contracts/tables';
import { parseDecimal } from '../domain/decimal';
import { isValidZone, isISODate } from '../domain/gameCalendar';
import type { TemplateDraft, TemplateTaskDraft } from '../application/contracts';
import {
  serviceDefaultsFromLegacyMode,
  legacyModeFromServiceDefaults,
  type ServiceDefaults,
} from './normalize/categoryDefaults';

export const TEMPLATE_FORMAT = 'daigan-template';

/**
 * 模板文件格式（contract v4）。
 *
 * 版本历史：
 * 1 — 模板内容 + 可选区服选项 `serverOptions`；
 * 2 — 增加可选价格预设 `pricePresets`；
 * 3 — 增加可选 `hostingMode` / `targetSessions`（安卓写 3）；
 * 4 — 增加分类级 `hostingMode`/`targetSessions`/`serviceWeekdays`、模板级
 *     `serviceWeekdays`/`defaultOrderTitle`、任务级 `activeFrom`/`activeUntil`/`numericMode`。
 *     双端只写 4，并严格拒绝未知键。
 *
 * 读取 1–3 时按历史键集放行（其中网页扩展的 `serviceMode`/`serviceCount` 被显式
 * 规范化），任何版本都不接受"非历史键"。**账号分类绝不会出现在模板文件里**。
 */
export const TEMPLATE_FORMAT_VERSION = 4;
export const TEMPLATE_MIN_READABLE_VERSION = 1;
export const TEMPLATE_MAX_BYTES = 256 * 1024;

const WEEKDAY_NAMES = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

function fail(message: string): never {
  throw new AppError('BACKUP_FORMAT', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 每个版本允许的键集；未知键一律拒绝（历史版本也按历史键集校验）。 */
function templateKeysFor(version: number): Set<string> {
  const keys = new Set([
    'id',
    'gameName',
    'templateVersion',
    'gameVersionNotes',
    'timeZone',
    'dailyRefresh',
    'weeklyRefreshDay',
    'weeklyRefreshTime',
    'categories',
    'serverOptions',
  ]);
  if (version >= 2) keys.add('pricePresets');
  if (version >= 3) {
    keys.add('hostingMode');
    keys.add('targetSessions');
  }
  if (version >= 4) {
    keys.add('serviceWeekdays');
    keys.add('defaultOrderTitle');
  } else {
    // 网页 1/2 写过的 legacy 扩展键：只在历史版本里被接受。
    keys.add('serviceMode');
    keys.add('serviceCount');
  }
  return keys;
}

function categoryKeysFor(version: number): Set<string> {
  const keys = new Set(['id', 'name', 'tasks']);
  if (version >= 4) {
    keys.add('hostingMode');
    keys.add('targetSessions');
    keys.add('serviceWeekdays');
  } else {
    keys.add('serviceMode');
    keys.add('serviceCount');
  }
  return keys;
}

function taskKeysFor(version: number): Set<string> {
  const keys = new Set([
    'id',
    'categoryId',
    'title',
    'progressType',
    'startValue',
    'targetValue',
    'unit',
    'recurrence',
    'weekdays',
    'everyNDays',
  ]);
  if (version >= 2) {
    keys.add('monthDay');
    keys.add('monthDays');
    keys.add('activeFrom');
    keys.add('activeUntil');
  }
  if (version >= 4) keys.add('numericMode');
  return keys;
}

const PRICE_PRESET_KEYS = new Set(['id', 'amountCents', 'label']);
const ROOT_KEYS = new Set(['format', 'formatVersion', 'template']);

function rejectUnknownKeys(object: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(`${label}包含不支持的字段：${unknown.join('、')}`);
}

function readString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) fail(`${label} 长度必须为 1–${max} 字符`);
  return trimmed;
}

function readOptionalString(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  if ([...value].length > max) fail(`${label} 超过 ${max} 字符`);
  return value;
}

function parseTime(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) fail(`${label} 必须为 HH:mm`);
  const [hour, minute] = value.split(':').map(Number);
  if (hour > 23 || minute > 59) fail(`${label} 时间越界`);
  return hour * 60 + minute;
}

function parseOptionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !isISODate(value)) fail(`${label} 必须为 YYYY-MM-DD 日期`);
  return value;
}

function parseHostingMode(value: unknown, label: string): HostingMode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !(HOSTING_MODES as readonly string[]).includes(value)) {
    fail(`${label} 必须是 DATE_RANGE 或 COUNT_BASED`);
  }
  return value as HostingMode;
}

function parseNumericMode(value: unknown, label: string): NumericMode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !(NUMERIC_MODES as readonly string[]).includes(value)) {
    fail(`${label} 必须是 PER_OCCURRENCE 或 CUMULATIVE`);
  }
  return value as NumericMode;
}

function parseTargetSessions(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3650) {
    fail(`${label} 必须为 1–3650 的整数`);
  }
  return value;
}

/** 服务星期在文件里用 ISO 1–7 的逗号文本；也接受数组写法。 */
function parseServiceWeekdays(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  let numbers: number[];
  if (Array.isArray(value)) {
    numbers = value.map((item) => {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 7) {
        fail(`${label} 必须是 1–7 的星期号`);
      }
      return item;
    });
  } else if (typeof value === 'string') {
    if (value.trim() === '') return null;
    numbers = value.split(',').map((item) => Number(item.trim()));
    if (numbers.some((item) => !Number.isInteger(item) || item < 1 || item > 7)) {
      fail(`${label} 必须是逗号分隔的 ISO 1–7`);
    }
  } else {
    fail(`${label} 必须是字符串或数组`);
    return null;
  }
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  return unique.length > 0 ? unique.join(',') : null;
}

/** 某一层（模板/分类）在文件里声明的托管默认值。 */
function readServiceDefaults(
  object: Record<string, unknown>,
  version: number,
  level: 'template' | 'category',
  diagnosticsLabel: string,
): ServiceDefaults {
  if (version >= 4) {
    const hostingMode = parseHostingMode(object.hostingMode, `${diagnosticsLabel}托管方式`);
    const targetSessions = parseTargetSessions(object.targetSessions, `${diagnosticsLabel}目标次数`);
    const serviceWeekdays = parseServiceWeekdays(object.serviceWeekdays, `${diagnosticsLabel}服务星期`);
    if (hostingMode === 'COUNT_BASED' && targetSessions === null) {
      fail(`${diagnosticsLabel}计次模式必须声明目标次数`);
    }
    if (hostingMode !== 'COUNT_BASED' && targetSessions !== null) {
      fail(`${diagnosticsLabel}非计次模式不得声明目标次数`);
    }
    return { hostingMode, targetSessions, serviceWeekdays };
  }
  // v1–v3：安卓写 hostingMode/targetSessions，网页写 serviceMode/serviceCount。
  const legacyMode = object.serviceMode;
  const legacyCount = object.serviceCount;
  if (legacyMode !== undefined) {
    const mode = legacyMode === null ? null : legacyMode;
    if (mode !== null && mode !== 'dates' && mode !== 'weekdays' && mode !== 'count') {
      fail(`${diagnosticsLabel}不支持的旧服务模式：${String(mode)}`);
    }
    if (mode === 'count') {
      const count = parseTargetSessions(legacyCount, `${diagnosticsLabel}服务次数`);
      if (count === null) fail(`${diagnosticsLabel}按次数模式必须声明服务次数`);
      return serviceDefaultsFromLegacyMode('count', count, level);
    }
    return serviceDefaultsFromLegacyMode(
      mode as 'dates' | 'weekdays' | null,
      null,
      level,
    );
  }
  const hostingMode = parseHostingMode(object.hostingMode, `${diagnosticsLabel}托管方式`);
  const targetSessions = parseTargetSessions(object.targetSessions, `${diagnosticsLabel}目标次数`);
  if (hostingMode === 'COUNT_BASED' && targetSessions === null) {
    fail(`${diagnosticsLabel}计次模式必须声明目标次数`);
  }
  return {
    hostingMode,
    targetSessions,
    serviceWeekdays: null,
  };
}

export function formatTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

export function parseTemplateFile(text: string): TemplateDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('模板文件不是有效 JSON');
  }
  if (!isRecord(parsed)) fail('模板文件顶层必须是对象');
  if (parsed.format !== TEMPLATE_FORMAT) fail('这不是代肝记录模板文件');
  const formatVersion = parsed.formatVersion;
  if (
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    formatVersion < TEMPLATE_MIN_READABLE_VERSION ||
    formatVersion > TEMPLATE_FORMAT_VERSION
  ) {
    fail(`不支持的模板格式版本：${String(parsed.formatVersion)}`);
  }
  rejectUnknownKeys(parsed, ROOT_KEYS, '模板文件');
  const template = parsed.template;
  if (!isRecord(template)) fail('缺少模板内容');
  rejectUnknownKeys(template, templateKeysFor(formatVersion), '模板');

  const id = readString(template.id, '模板编号', 100);
  const gameName = readString(template.gameName, '游戏名称', 40);
  const templateVersion = readString(template.templateVersion, '模板版本', 30);
  const gameVersionNotes = readOptionalString(template.gameVersionNotes, '版本说明', 300);
  const zoneId = readString(template.timeZone, '时区', 64);
  if (!isValidZone(zoneId)) fail('时区不合法');

  const dailyRefreshMinutes = parseTime(template.dailyRefresh, '每日刷新');
  const weeklyRefreshDayName = readString(template.weeklyRefreshDay, '每周刷新日', 16);
  const dayIndex = (WEEKDAY_NAMES as readonly string[]).indexOf(weeklyRefreshDayName);
  if (dayIndex < 0) fail('每周刷新日必须是 MONDAY…SUNDAY');
  const weeklyRefreshMinutes = parseTime(template.weeklyRefreshTime, '每周刷新时间');

  if (!Array.isArray(template.categories)) fail('缺少分类');
  if (template.categories.length < 1 || template.categories.length > 20) {
    fail('分类数量必须为 1–20');
  }

  const ids = new Set<string>([id]);
  let taskTotal = 0;
  const categories = template.categories.map((rawCategory) => {
    if (!isRecord(rawCategory)) fail('分类必须是对象');
    rejectUnknownKeys(rawCategory, categoryKeysFor(formatVersion), '分类');
    const categoryId = readString(rawCategory.id, '分类编号', 100);
    if (ids.has(categoryId)) fail(`编号重复：${categoryId}`);
    ids.add(categoryId);
    const name = readString(rawCategory.name, '分类名称', 30);
    if (!Array.isArray(rawCategory.tasks) || rawCategory.tasks.length < 1) {
      fail('每个分类至少需要一个任务');
    }
    taskTotal += rawCategory.tasks.length;
    if (taskTotal > 100) fail('任务总数超过 100 个');

    const tasks: TemplateTaskDraft[] = rawCategory.tasks.map((rawTask) => {
      if (!isRecord(rawTask)) fail('任务必须是对象');
      rejectUnknownKeys(rawTask, taskKeysFor(formatVersion), '任务');
      const taskId = readString(rawTask.id, '任务编号', 100);
      if (ids.has(taskId)) fail(`编号重复：${taskId}`);
      ids.add(taskId);
      const categoryRef = readString(rawTask.categoryId, '任务分类编号', 100);
      if (categoryRef !== categoryId) fail('任务的分类引用不一致');

      const progressType = rawTask.progressType;
      if (typeof progressType !== 'string' || !PROGRESS_TYPES.includes(progressType as ProgressType)) {
        fail('进度类型不合法');
      }
      const recurrence = rawTask.recurrence;
      if (typeof recurrence !== 'string' || !RECURRENCES.includes(recurrence as Recurrence)) {
        fail('重复周期不合法');
      }

      const startRaw = rawTask.startValue;
      const targetRaw = rawTask.targetValue;
      const startValue = typeof startRaw === 'number' ? String(startRaw) : String(startRaw ?? '');
      const targetValue = typeof targetRaw === 'number' ? String(targetRaw) : String(targetRaw ?? '');
      try {
        parseDecimal(startValue);
        parseDecimal(targetValue);
      } catch {
        fail('起始值或目标值不合法');
      }
      if (Number(startValue) < 0) fail('起始值不能为负');
      if (Number(targetValue) <= Number(startValue)) fail('目标值必须大于起始值');

      let weekdays: string | null = null;
      if (rawTask.weekdays !== undefined && rawTask.weekdays !== null) {
        if (!Array.isArray(rawTask.weekdays)) fail('星期列表必须是数组');
        const numbers = rawTask.weekdays.map((name) => {
          if (typeof name !== 'string') fail('星期必须是字符串');
          const index = (WEEKDAY_NAMES as readonly string[]).indexOf(name);
          if (index < 0) fail(`星期不合法：${name}`);
          return index + 1;
        });
        weekdays = numbers.length > 0 ? numbers.join(',') : null;
      }
      if (recurrence === 'SELECTED_WEEKDAYS' && (!weekdays || weekdays.length === 0)) {
        fail('指定星期任务必须至少选择一个星期');
      }

      let everyNDays: number | null = null;
      if (rawTask.everyNDays !== undefined && rawTask.everyNDays !== null) {
        if (
          typeof rawTask.everyNDays !== 'number' ||
          !Number.isInteger(rawTask.everyNDays) ||
          rawTask.everyNDays < 1 ||
          rawTask.everyNDays > 365
        ) {
          fail('每隔 N 天必须为 1–365 的整数');
        }
        everyNDays = rawTask.everyNDays;
      }

      let monthDay: number | null = null;
      if (rawTask.monthDay !== undefined && rawTask.monthDay !== null) {
        if (
          typeof rawTask.monthDay !== 'number' ||
          !Number.isInteger(rawTask.monthDay) ||
          rawTask.monthDay < 1 ||
          rawTask.monthDay > 31
        ) {
          fail('每月日号必须为 1–31');
        }
        monthDay = rawTask.monthDay;
      }
      // monthDays 数组优先（UF-025），其次单日号 monthDay；空数组视为未设置。
      let monthDays: string | null = null;
      if (rawTask.monthDays !== undefined && rawTask.monthDays !== null) {
        if (!Array.isArray(rawTask.monthDays)) fail('每月日号列表必须是数组');
        const days = rawTask.monthDays.map((value) => {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
            fail('每月日号必须为 1–31');
          }
          return value;
        });
        const unique = [...new Set(days)].sort((a, b) => a - b);
        if (unique.length > 0) {
          monthDays = unique.join(',');
          if (monthDay === null) monthDay = unique[0];
        }
      }
      if (recurrence === 'MONTHLY' && monthDay === null && monthDays === null) {
        fail('每月任务必须填写日号');
      }

      const isCheckbox = progressType === 'CHECKBOX';
      const activeFrom = parseOptionalDate(rawTask.activeFrom, '任务生效起始日');
      const activeUntil = parseOptionalDate(rawTask.activeUntil, '任务生效截止日');
      if (activeFrom !== null && activeUntil !== null && activeUntil < activeFrom) {
        fail('任务生效截止日早于生效日');
      }
      const numericMode = parseNumericMode(rawTask.numericMode, '数值口径');
      if (numericMode === 'CUMULATIVE' && progressType !== 'NUMERIC') {
        fail('只有数值任务才能使用累计口径');
      }
      return {
        title: readString(rawTask.title, '任务标题', 40),
        progressType: progressType as ProgressType,
        startValue: isCheckbox ? '0' : startValue,
        targetValue: isCheckbox ? '1' : targetValue,
        unit: readOptionalString(rawTask.unit, '单位', 10),
        recurrence: recurrence as Recurrence,
        weekdays,
        everyNDays: recurrence === 'EVERY_N_DAYS' ? everyNDays : null,
        monthDay: recurrence === 'MONTHLY' ? monthDay : null,
        monthDays: recurrence === 'MONTHLY' ? monthDays : null,
        activeFrom,
        activeUntil,
        numericMode,
      };
    });

    const defaults = readServiceDefaults(rawCategory, formatVersion, 'category', `分类「${name}」`);
    const mirror = legacyModeFromServiceDefaults(defaults, 'category');
    return {
      name,
      tasks,
      hostingMode: formatVersion >= 4 ? defaults.hostingMode : undefined,
      targetSessions: formatVersion >= 4 ? defaults.targetSessions : undefined,
      serviceWeekdays: formatVersion >= 4 ? defaults.serviceWeekdays : undefined,
      // 旧界面回填：category 无意见 = undefined（继承模板）。
      serviceMode: mirror.serviceMode,
      serviceCount: mirror.serviceCount,
    };
  });

  const pricePresets: { amountCents: number; label: string | null }[] = [];
  if (template.pricePresets !== undefined && template.pricePresets !== null) {
    if (!Array.isArray(template.pricePresets)) fail('价格预设必须是数组');
    if (template.pricePresets.length > 20) fail('价格预设最多 20 个');
    for (const raw of template.pricePresets) {
      if (!isRecord(raw)) fail('价格预设必须是对象');
      rejectUnknownKeys(raw, PRICE_PRESET_KEYS, '价格预设');
      const amountCents = raw.amountCents;
      if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 1) {
        fail('价格预设金额必须为正整数分');
      }
      pricePresets.push({
        amountCents,
        label: readOptionalString(raw.label, '价格预设标签', 30),
      });
    }
  }

  const serverOptions: string[] = [];
  if (template.serverOptions !== undefined && template.serverOptions !== null) {
    if (!Array.isArray(template.serverOptions)) fail('区服选项必须是数组');
    if (template.serverOptions.length > 50) fail('区服选项最多 50 个');
    for (const raw of template.serverOptions) {
      serverOptions.push(readString(raw, '区服选项', 60));
    }
  }

  const templateDefaults = readServiceDefaults(template, formatVersion, 'template', '模板');
  const templateMirror = legacyModeFromServiceDefaults(templateDefaults, 'template');
  const rawTitle = readOptionalString(template.defaultOrderTitle, '建单默认标题', 60);
  const defaultOrderTitle = rawTitle === null ? null : rawTitle.trim() || null;

  return {
    id,
    gameName,
    templateVersion,
    gameVersionNotes,
    zoneId,
    dailyRefreshMinutes,
    weeklyRefreshDay: dayIndex + 1,
    weeklyRefreshMinutes,
    categories,
    pricePresets,
    serverOptions,
    hostingMode: templateDefaults.hostingMode,
    targetSessions: templateDefaults.targetSessions,
    serviceWeekdays: templateDefaults.serviceWeekdays,
    defaultOrderTitle,
    // 旧界面回填。
    serviceMode: templateMirror.serviceMode ?? null,
    serviceCount: templateMirror.serviceCount,
  };
}

export function readTemplateFile(bytes: Uint8Array | ArrayBuffer): TemplateDraft {
  if (bytes.byteLength > TEMPLATE_MAX_BYTES) fail('模板文件超过 256 KB 上限');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes as unknown as BufferSource);
  } catch {
    fail('模板文件不是有效 UTF-8');
  }
  return parseTemplateFile(text);
}

/**
 * 写 format 4。
 *
 * 全部分层默认值都显式写出（`null` 表示"无意见/继承"），因此读取端不需要猜；
 * 只有空集合（serverOptions/pricePresets）按契约省略以保持最小文件。
 */
export function serializeTemplate(draft: TemplateDraft): string {
  const templateDefaults = serviceDefaultsFromLegacyMode(draft.serviceMode, draft.serviceCount, 'template');
  const hostingMode = draft.hostingMode !== undefined ? draft.hostingMode : templateDefaults.hostingMode;
  const targetSessions =
    draft.targetSessions !== undefined ? draft.targetSessions : templateDefaults.targetSessions;
  const serviceWeekdays =
    draft.serviceWeekdays !== undefined ? draft.serviceWeekdays : templateDefaults.serviceWeekdays;
  const effectiveTarget = hostingMode === 'COUNT_BASED' ? targetSessions : null;
  const effectiveWeekdays = hostingMode === 'DATE_RANGE' ? serviceWeekdays : null;
  const title = draft.defaultOrderTitle === undefined || draft.defaultOrderTitle === null
    ? null
    : draft.defaultOrderTitle.trim().slice(0, 60) || null;

  const document = {
    format: TEMPLATE_FORMAT,
    formatVersion: TEMPLATE_FORMAT_VERSION,
    template: {
      id: draft.id ?? 'template',
      gameName: draft.gameName,
      templateVersion: draft.templateVersion,
      gameVersionNotes: draft.gameVersionNotes,
      timeZone: draft.zoneId,
      dailyRefresh: formatTime(draft.dailyRefreshMinutes),
      weeklyRefreshDay: WEEKDAY_NAMES[draft.weeklyRefreshDay - 1] ?? 'MONDAY',
      weeklyRefreshTime: formatTime(draft.weeklyRefreshMinutes),
      hostingMode,
      targetSessions: effectiveTarget,
      serviceWeekdays: effectiveWeekdays,
      defaultOrderTitle: title,
      categories: draft.categories.map((category, categoryIndex) => {
        const categoryDefaults =
          category.hostingMode !== undefined
            ? {
                hostingMode: category.hostingMode,
                targetSessions: category.targetSessions ?? null,
                serviceWeekdays: category.serviceWeekdays ?? null,
              }
            : serviceDefaultsFromLegacyMode(category.serviceMode, category.serviceCount, 'category');
        return {
          id: `cat-${categoryIndex + 1}`,
          name: category.name,
          hostingMode: categoryDefaults.hostingMode,
          targetSessions:
            categoryDefaults.hostingMode === 'COUNT_BASED' ? categoryDefaults.targetSessions : null,
          serviceWeekdays:
            categoryDefaults.hostingMode === 'DATE_RANGE' ? categoryDefaults.serviceWeekdays : null,
          tasks: category.tasks.map((task, taskIndex) => ({
            id: `task-${categoryIndex + 1}-${taskIndex + 1}`,
            categoryId: `cat-${categoryIndex + 1}`,
            title: task.title,
            progressType: task.progressType,
            startValue: task.startValue,
            targetValue: task.targetValue,
            unit: task.unit,
            recurrence: task.recurrence,
            weekdays: (task.weekdays ?? '')
              .split(',')
              .filter(Boolean)
              .map((value) => WEEKDAY_NAMES[Number(value) - 1])
              .filter(Boolean),
            everyNDays: task.everyNDays,
            monthDay: task.monthDay,
            monthDays: (task.monthDays ?? (task.monthDay !== null ? String(task.monthDay) : ''))
              .split(',')
              .filter(Boolean)
              .map(Number)
              .filter((value) => Number.isInteger(value) && value >= 1 && value <= 31),
            activeFrom: task.activeFrom ?? null,
            activeUntil: task.activeUntil ?? null,
            numericMode: task.numericMode ?? null,
          })),
        };
      }),
      ...(draft.serverOptions && draft.serverOptions.length > 0
        ? { serverOptions: draft.serverOptions }
        : {}),
      ...(draft.pricePresets && draft.pricePresets.length > 0
        ? {
            pricePresets: draft.pricePresets.map((preset) => ({
              id: `preset-${preset.amountCents}`,
              amountCents: preset.amountCents,
              label: preset.label,
            })),
          }
        : {}),
    },
  };
  return JSON.stringify(document, null, 2);
}

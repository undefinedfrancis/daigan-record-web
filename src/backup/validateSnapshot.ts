import { AppError } from '../contracts/errors';
import type { Snapshot } from '../contracts/backup';
import type {
  BackupDataSet,
  HostingPeriodRow,
  TaskDefinitionRow,
} from '../contracts/tables';
import {
  BATCH_ITEM_TYPES,
  BATCH_SCOPES,
  CORRECTION_KINDS,
  HOSTING_MODES,
  LIMITS,
  LOGIN_METHODS,
  MONEY_MAX_CENTS,
  NUMERIC_MODES,
  ORDER_TYPES,
  PAYMENT_MODES,
  PROGRESS_EVENT_KINDS,
  PROGRESS_SCOPE_TYPES,
  PROGRESS_TYPES,
  RECEIPT_CHANNELS,
  RECEIPT_STATUSES,
  RECURRENCES,
  TEMPLATE_ORIGINS,
} from '../contracts/tables';
import { countPeriodServiceStart } from '../domain/countSessions';
import { parseDecimal } from '../domain/decimal';
import { isISODate } from '../domain/gameCalendar';
import { validateProgressEvents, type EventChainContext } from '../domain/progressEvents';

export class ValidatedSnapshot {
  readonly snapshot: Snapshot;

  private constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
  }

  static of(snapshot: Snapshot, options: ValidateOptions = {}): ValidatedSnapshot {
    validateSnapshot(snapshot, options);
    return new ValidatedSnapshot(snapshot);
  }
}

function fail(message: string): never {
  throw new AppError('BACKUP_VALIDATION', message);
}

function assertEnum<T extends string>(value: string, allowed: readonly T[], label: string): void {
  if (!(allowed as readonly string[]).includes(value)) {
    fail(`${label} 取值非法：${value}`);
  }
}

function assertUniqueBy<T>(rows: T[], key: (row: T) => unknown, label: string): void {
  const seen = new Set<unknown>();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) fail(`${label} 重复：${String(value)}`);
    seen.add(value);
  }
}

function assertOptionalUniqueBy<T>(rows: T[], key: (row: T) => unknown, label: string): void {
  const seen = new Set<unknown>();
  for (const row of rows) {
    const value = key(row);
    if (value === null || value === undefined || value === '') continue;
    if (seen.has(value)) fail(`${label} 重复：${String(value)}`);
    seen.add(value);
  }
}

function textLength(value: string): number {
  return [...value].length;
}

function assertText(value: string | null, label: string, min: number, max: number): void {
  if (value === null) {
    if (min > 0) fail(`${label} 不能为空`);
    return;
  }
  const length = textLength(value);
  if (length < min || length > max) fail(`${label} 长度必须为 ${min}–${max} 字符`);
}

function assertDate(value: string | null, label: string, nullable = true): void {
  if (value === null) {
    if (!nullable) fail(`${label} 不能为空`);
    return;
  }
  if (!isISODate(value)) fail(`${label} 不是有效 ISO 日期：${value}`);
}

/**
 * 历史十进制按存储文本校验（可能非规范：'10.50'、'007'），绝不因格式不整齐而拒绝；
 * 只有越界或非十进制才失败。共享边界：绝对值 1e12 / 1e15 缩放单位。
 */
function assertDecimalText(value: string, label: string): void {
  try {
    parseDecimal(value);
  } catch {
    fail(`${label} 不是有效十进制文本或超出边界：${value}`);
  }
}

function assertInt(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} 必须是 ${min}–${max} 的整数：${String(value)}`);
  }
}

function assertNullableInt(value: number | null, label: string, min: number, max: number): void {
  if (value === null) return;
  assertInt(value, label, min, max);
}

/** monthDays 优先（逗号分隔 1–31），退回单日号 monthDay。 */
function monthDaysOf(monthDay: number | null, monthDays: string | null): number[] {
  if (monthDays) {
    const parsed = monthDays
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31);
    return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : [];
  }
  return monthDay && monthDay >= 1 && monthDay <= 31 ? [monthDay] : [];
}

function parseRefreshDays(value: string): number[] {
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31);
}

function assertWeekdays(value: string | null, label: string): void {
  if (value === null) return;
  const parts = value.split(',').map((item) => Number(item.trim()));
  if (parts.length === 0 || parts.some((item) => !Number.isInteger(item) || item < 1 || item > 7)) {
    fail(`${label} 必须是逗号分隔的 ISO 1–7：${value}`);
  }
  if (new Set(parts).size !== parts.length) fail(`${label} 存在重复星期：${value}`);
}

function assertMoney(value: number, label: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > MONEY_MAX_CENTS) {
    fail(`${label} 金额越界：${String(value)}`);
  }
}

function assertColour(value: number | null, label: string): void {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || ((value >>> 24) & 0xff) !== 0xff) {
    fail(`${label} 必须是不透明 ARGB（alpha=255）：${String(value)}`);
  }
}

function isCountPeriod(period: HostingPeriodRow): boolean {
  return period.serviceCount !== null;
}

function expectedOccurrencePrefix(task: TaskDefinitionRow, countBased: boolean): string {
  if (countBased) return 'N:';
  switch (task.recurrence) {
    case 'DAILY':
      return 'D:';
    case 'SELECTED_WEEKDAYS':
      return 'S:';
    case 'EVERY_N_DAYS':
      return 'E:';
    case 'WEEKLY':
      return 'W:';
    case 'MONTHLY':
      return 'M:';
    case 'ONE_TIME':
      return 'N:';
    default:
      return 'N:';
  }
}

function sessionIndexFromKey(key: string): number | null {
  if (!key.startsWith('N:')) return null;
  const raw = key.slice(2);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * 校验阶段（S2-R3）。
 *
 * - `authoritative`：只校验**权威**结构与引用（恢复流程的第 2 步）。派生投影
 *   （`task_definitions.currentValue/completedAt`、`hosting_sessions.completedAt` 的
 *   完成上限）此时还可能是文件里的陈旧缓存，不能用来拒绝整份数据。
 * - `candidate`：重建之后对候选数据集做完整校验（第 4 步），派生字段也必须自洽。
 */
export type ValidationPhase = 'authoritative' | 'candidate';

export interface ValidateOptions {
  phase?: ValidationPhase;
}

/**
 * 严格业务/引用校验。
 *
 * 只做"能不能被信任"的判定，不做任何修复：任何一条失败都会让候选数据集在**激活前**
 * 被丢弃，当前数据集保持不变。
 */
export function validateSnapshot(snapshot: Snapshot, options: ValidateOptions = {}): void {
  const phase: ValidationPhase = options.phase ?? 'candidate';
  const authoritativeOnly = phase === 'authoritative';
  const data = snapshot.data;

  // ---- 主键 / 唯一约束 ------------------------------------------------
  assertUniqueBy(data.owners, (row) => row.id, 'owners.id');
  assertUniqueBy(data.owners, (row) => row.number, 'owners.number');
  assertUniqueBy(data.owner_number_sequence, (row) => row.id, 'owner_number_sequence.id');
  assertUniqueBy(data.account_categories, (row) => row.id, 'account_categories.id');
  assertUniqueBy(data.account_categories, (row) => row.name, 'account_categories.name');
  assertUniqueBy(data.game_accounts, (row) => row.id, 'game_accounts.id');
  assertUniqueBy(data.game_server_options, (row) => row.id, 'game_server_options.id');
  assertUniqueBy(data.game_templates, (row) => row.id, 'game_templates.id');
  assertOptionalUniqueBy(data.game_templates, (row) => row.builtInKey, 'game_templates.builtInKey');
  assertUniqueBy(data.template_categories, (row) => row.id, 'template_categories.id');
  assertUniqueBy(data.template_tasks, (row) => row.id, 'template_tasks.id');
  assertUniqueBy(data.template_price_presets, (row) => row.id, 'template_price_presets.id');
  assertUniqueBy(data.template_seed_state, (row) => row.seedKey, 'template_seed_state.seedKey');
  assertUniqueBy(data.completion_batches, (row) => row.id, 'completion_batches.id');
  assertUniqueBy(data.completion_batches, (row) => row.operationId, 'completion_batches.operationId');
  assertUniqueBy(data.orders, (row) => row.id, 'orders.id');
  assertUniqueBy(data.hosting_periods, (row) => row.id, 'hosting_periods.id');
  assertUniqueBy(data.hosting_periods, (row) => `${row.orderId}:${row.periodIndex}`, 'hosting_periods.orderId/periodIndex');
  assertUniqueBy(data.hosting_periods, (row) => `${row.orderId}:${row.startDate}`, 'hosting_periods.orderId/startDate');
  assertOptionalUniqueBy(
    data.hosting_periods,
    (row) => row.renewalOperationId,
    'hosting_periods.renewalOperationId',
  );
  assertUniqueBy(data.hosting_sessions, (row) => row.id, 'hosting_sessions.id');
  assertUniqueBy(data.hosting_sessions, (row) => `${row.orderId}:${row.sessionIndex}`, 'hosting_sessions.orderId/sessionIndex');
  assertUniqueBy(data.order_price_changes, (row) => row.id, 'order_price_changes.id');
  assertUniqueBy(data.order_price_changes, (row) => row.operationId, 'order_price_changes.operationId');
  assertUniqueBy(data.task_definitions, (row) => row.id, 'task_definitions.id');
  assertUniqueBy(data.task_occurrences, (row) => row.id, 'task_occurrences.id');
  assertUniqueBy(
    data.task_occurrences,
    (row) => `${row.taskDefinitionId}:${row.occurrenceKey}`,
    'task_occurrences.taskDefinitionId/occurrenceKey',
  );
  assertUniqueBy(data.task_progress_events, (row) => row.id, 'task_progress_events.id');
  assertUniqueBy(data.task_progress_events, (row) => row.operationId, 'task_progress_events.operationId');
  assertUniqueBy(
    data.task_progress_events,
    (row) => `${row.taskDefinitionId}:${row.sequence}`,
    'task_progress_events.taskDefinitionId/sequence',
  );
  assertUniqueBy(data.completion_batch_items, (row) => row.id, 'completion_batch_items.id');
  assertUniqueBy(data.attachments, (row) => row.id, 'attachments.id');
  assertUniqueBy(data.receipts, (row) => row.id, 'receipts.id');
  assertUniqueBy(data.receipts, (row) => row.operationId, 'receipts.operationId');
  assertUniqueBy(data.receipt_corrections, (row) => row.id, 'receipt_corrections.id');
  assertUniqueBy(data.receipt_corrections, (row) => row.operationId, 'receipt_corrections.operationId');
  assertUniqueBy(data.order_creation_operations, (row) => row.operationId, 'order_creation_operations.operationId');
  if (data.reminder_settings.length > 1) fail('提醒设置只允许一行');
  if (data.reminder_settings.length === 1 && data.reminder_settings[0].id !== 0) {
    fail('提醒设置主键必须为 0');
  }

  // ---- 索引表 ---------------------------------------------------------
  const ownerIds = new Set(data.owners.map((row) => row.id));
  const categoryIds = new Set(data.account_categories.map((row) => row.id));
  const accountIds = new Set(data.game_accounts.map((row) => row.id));
  const orderById = new Map(data.orders.map((row) => [row.id, row]));
  const periodById = new Map(data.hosting_periods.map((row) => [row.id, row]));
  const taskById = new Map(data.task_definitions.map((row) => [row.id, row]));
  const occurrenceIds = new Set(data.task_occurrences.map((row) => row.id));
  const occurrenceById = new Map(data.task_occurrences.map((row) => [row.id, row]));
  const receiptById = new Map(data.receipts.map((row) => [row.id, row]));
  const templateIds = new Set(data.game_templates.map((row) => row.id));
  const templateCategoryById = new Map(data.template_categories.map((row) => [row.id, row]));
  const batchIds = new Set(data.completion_batches.map((row) => row.id));
  const batchById = new Map(data.completion_batches.map((row) => [row.id, row]));
  const sessionsByOrder = new Map<string, typeof data.hosting_sessions>();
  for (const session of data.hosting_sessions) {
    const list = sessionsByOrder.get(session.orderId) ?? [];
    list.push(session);
    sessionsByOrder.set(session.orderId, list);
  }

  // ---- 老板 / 账号分类 / 账号 -----------------------------------------
  for (const owner of data.owners) {
    assertText(owner.nickname.trim(), '老板昵称', 1, LIMITS.maxOwnerNickname);
    assertInt(owner.number, '老板编号', 1, Number.MAX_SAFE_INTEGER);
    assertInt(owner.createdAt, '老板创建时间', 0, Number.MAX_SAFE_INTEGER);
    assertInt(owner.updatedAt, '老板更新时间', 0, Number.MAX_SAFE_INTEGER);
  }
  for (const sequence of data.owner_number_sequence) {
    assertInt(sequence.nextNumber, '老板编号计数器', 1, Number.MAX_SAFE_INTEGER);
  }

  for (const category of data.account_categories) {
    assertText(category.name.trim(), '账号分类名称', 1, LIMITS.maxAccountCategoryName);
    assertInt(category.sortOrder, '账号分类排序', 0, Number.MAX_SAFE_INTEGER);
    assertInt(category.createdAt, '账号分类创建时间', 0, Number.MAX_SAFE_INTEGER);
    assertInt(category.updatedAt, '账号分类更新时间', 0, Number.MAX_SAFE_INTEGER);
  }

  for (const account of data.game_accounts) {
    if (!ownerIds.has(account.ownerId)) fail(`账号 ${account.id} 引用了不存在的老板`);
    assertEnum(account.loginMethod, LOGIN_METHODS, '登录方式');
    if (account.loginMethod !== 'PASSWORD' && account.password !== null) {
      fail(`账号 ${account.id} 非密码登录不得保存密码`);
    }
    assertText(account.gameName.trim(), '游戏名', 1, 60);
    assertText(account.loginDevice, '登录设备', 0, 60);
    assertText(account.resourceNotes, '游戏资源记录', 0, 4000);
    if (account.categoryId !== null && !categoryIds.has(account.categoryId)) {
      fail(`账号 ${account.id} 引用了不存在的分类 ${account.categoryId}`);
    }
  }

  for (const option of data.game_server_options) {
    assertText(option.gameName.trim(), '区服选项游戏名', 1, 60);
    assertText(option.name.trim(), '区服选项名称', 1, 60);
    assertInt(option.sortOrder, '区服选项排序', 0, Number.MAX_SAFE_INTEGER);
  }

  // ---- 订单 -----------------------------------------------------------
  for (const order of data.orders) {
    if (!accountIds.has(order.accountId)) fail(`订单 ${order.id} 引用了不存在的账号`);
    assertEnum(order.type, ORDER_TYPES, '订单类型');
    assertEnum(order.paymentMode, PAYMENT_MODES, '付款方式');
    assertText(order.title, '订单标题', 1, LIMITS.maxOrderTitle);
    assertDate(order.deadlineDate, '订单截止日期');
    if (order.type === 'HOSTING' && order.priceCents !== null) {
      fail(`托管订单 ${order.id} 的总价必须为空`);
    }
    if (order.type === 'SHORT_TASK') {
      if (order.priceCents === null) fail(`短期单 ${order.id} 必须填写总价`);
      assertMoney(order.priceCents, '短期单价格', 1);
    }
    assertInt(order.dailyRefreshMinutes, '每日刷新时间', 0, 1439);
    assertInt(order.weeklyRefreshDay, '每周刷新星期', 1, 7);
    assertInt(order.weeklyRefreshMinutes, '每周刷新时间', 0, 1439);
    if (order.monthlyRefreshDays !== null && parseRefreshDays(order.monthlyRefreshDays).length === 0) {
      fail(`订单 ${order.id} 的每月刷新日非法`);
    }
    assertColour(order.orderColor, `订单 ${order.id} 颜色`);
    if (order.hostingMode !== null) assertEnum(order.hostingMode, HOSTING_MODES, '托管模式');
    if (order.type === 'SHORT_TASK') {
      if (order.hostingMode !== null) fail(`短期单 ${order.id} 不得声明托管模式`);
      if (order.targetSessions !== null) fail(`短期单 ${order.id} 不得声明打卡目标`);
    } else if (order.hostingMode === 'COUNT_BASED') {
      if (order.targetSessions === null) fail(`计次订单 ${order.id} 必须声明打卡目标`);
      assertInt(order.targetSessions, '打卡次数目标', 1, LIMITS.maxTargetSessions);
    } else if (order.targetSessions !== null) {
      fail(`非计次订单 ${order.id} 不得声明打卡目标`);
    }
  }

  // ---- 期次 -----------------------------------------------------------
  for (const period of data.hosting_periods) {
    const order = orderById.get(period.orderId);
    if (!order) fail(`期次 ${period.id} 引用了不存在的订单`);
    if (order.type !== 'HOSTING') fail(`期次 ${period.id} 属于非托管订单`);
    assertDate(period.startDate, '期次开始日', false);
    assertDate(period.endDate, '期次结束日', false);
    if (period.startDate > period.endDate) fail(`期次 ${period.id} 开始日晚于结束日`);
    assertInt(period.periodIndex, '期次序号', 0, Number.MAX_SAFE_INTEGER);
    // 财务 NOT NULL：不臆造，null 直接拒绝。
    assertMoney(period.priceCents, '期次价格', 0);
    assertInt(period.dailyRefreshMinutes, '期次每日刷新时间', 0, 1439);
    assertInt(period.weeklyRefreshDay, '期次每周刷新星期', 1, 7);
    assertInt(period.weeklyRefreshMinutes, '期次每周刷新时间', 0, 1439);
    if (period.monthlyRefreshDays !== null && parseRefreshDays(period.monthlyRefreshDays).length === 0) {
      fail(`期次 ${period.id} 的每月刷新日非法`);
    }
    assertWeekdays(period.serviceWeekdays, `期次 ${period.id} 服务星期`);
    assertNullableInt(period.serviceDays, '累计服务天数', 1, LIMITS.maxServiceDays);
    assertNullableInt(period.serviceCount, '按次数目标', 1, LIMITS.maxTargetSessions);
    if (period.serviceDays !== null && period.serviceCount !== null) {
      fail(`期次 ${period.id} 不能同时按工作日天数和次数服务`);
    }
    if (period.serviceDays !== null && (period.serviceWeekdays ?? '') === '') {
      fail(`期次 ${period.id} 的工作日托管必须选择服务星期`);
    }
  }

  // ---- 打卡轮次 -------------------------------------------------------
  const completedPerPeriod = new Map<string, number>();
  for (const session of data.hosting_sessions) {
    const order = orderById.get(session.orderId);
    if (!order) fail(`轮次 ${session.id} 引用了不存在的订单`);
    if (order.type !== 'HOSTING') fail(`轮次 ${session.id} 属于非托管订单`);
    assertInt(session.sessionIndex, '轮次号', 1, LIMITS.maxSessionIndex);
    assertInt(session.createdAt, '轮次创建时间', 0, Number.MAX_SAFE_INTEGER);
    if (session.completedAt !== null && session.completedAt < session.createdAt) {
      fail(`轮次 ${session.id} 完成时间早于创建时间`);
    }
    const period = periodById.get(session.periodId);
    if (!period) fail(`轮次 ${session.id} 引用了不存在的期次 ${session.periodId}`);
    if (period.orderId !== order.id) fail(`轮次 ${session.id} 的期次不属于该订单`);
    if (period.serviceCount === null) fail(`轮次 ${session.id} 的期次不是计次期次`);
    if (session.completedAt !== null) {
      completedPerPeriod.set(period.id, (completedPerPeriod.get(period.id) ?? 0) + 1);
    }
  }
  for (const [periodId, completed] of completedPerPeriod) {
    const period = periodById.get(periodId);
    // 轮次完成度是**派生**投影：恢复的第 2 步不能因为文件里陈旧的 completedAt
    // 而拒绝整份数据；重建之后（candidate 阶段）必须自洽。
    if (authoritativeOnly) break;
    if (period && period.serviceCount !== null && completed > period.serviceCount) {
      fail(`期次 ${periodId} 已完成轮次 ${completed} 超过目标 ${period.serviceCount}`);
    }
  }

  // ---- 任务 / 打卡记录 ------------------------------------------------
  for (const task of data.task_definitions) {
    const order = orderById.get(task.orderId);
    if (!order) fail(`任务 ${task.id} 引用了不存在的订单`);
    assertText(task.title, '任务标题', 1, LIMITS.maxTaskTitle);
    assertEnum(task.progressType, PROGRESS_TYPES, '进度类型');
    assertEnum(task.recurrence, RECURRENCES, '重复周期');
    assertDecimalText(task.startValue, `任务 ${task.id} 起始值`);
    assertDecimalText(task.targetValue, `任务 ${task.id} 目标值`);
    assertDecimalText(task.currentValue, `任务 ${task.id} 当前值`);
    assertInt(task.sortOrder, '任务排序', 0, Number.MAX_SAFE_INTEGER);
    assertNullableInt(task.everyNDays, '间隔天数', 1, 3650);
    assertNullableInt(task.monthDay, '每月日号', 1, 31);
    assertDate(task.activeFrom, '任务生效日');
    assertDate(task.activeUntil, '任务生效截止日');
    if (task.activeFrom !== null && task.activeUntil !== null && task.activeUntil < task.activeFrom) {
      fail(`任务 ${task.id} 生效截止日早于生效日`);
    }
    if (task.numericMode !== null) {
      assertEnum(task.numericMode, NUMERIC_MODES, '数值口径');
      if (task.numericMode === 'CUMULATIVE' && task.progressType !== 'NUMERIC') {
        fail(`任务 ${task.id} 只有数值任务才能使用累计口径`);
      }
    }
    assertColour(task.colorArgb, `任务 ${task.id} 颜色`);
    if (task.completionBatchId !== null && !batchIds.has(task.completionBatchId)) {
      fail(`任务 ${task.id} 引用了不存在的批次`);
    }
    if (task.recurrence === 'MONTHLY' && monthDaysOf(task.monthDay, task.monthDays).length === 0) {
      fail(`任务 ${task.id} 的每月日号必须为 1–31`);
    }
    if (task.progressType === 'NUMERIC') {
      const start = parseDecimal(task.startValue);
      const target = parseDecimal(task.targetValue);
      if (target.units <= start.units) fail(`任务 ${task.id} 目标值必须大于起始值`);
    }
    if (order.type === 'SHORT_TASK') {
      if (task.periodId !== null) fail(`短期单任务 ${task.id} 不得关联期次`);
    } else {
      if (task.periodId === null) fail(`托管任务 ${task.id} 缺少归属期次`);
      const period = periodById.get(task.periodId);
      if (!period || period.orderId !== order.id) fail(`托管任务 ${task.id} 的期次不属于该订单`);
      if (task.recurrence === 'ONE_TIME') fail(`托管任务 ${task.id} 不得使用一次性周期`);
      // 派生投影：重建（S2-R3）会把它写回 null，因此只在 candidate 阶段强制。
      if (!authoritativeOnly && task.completedAt !== null) {
        fail(`托管任务 ${task.id} 不应保存任务级完成时间`);
      }
    }
  }

  const occurrenceKeyByTask = new Map<string, Set<string>>();
  for (const occurrence of data.task_occurrences) {
    const task = taskById.get(occurrence.taskDefinitionId);
    if (!task) fail(`打卡记录 ${occurrence.id} 引用了不存在的任务`);
    const order = orderById.get(task.orderId);
    if (!order) fail(`打卡记录 ${occurrence.id} 的任务没有订单`);
    assertDate(occurrence.gameDate, '打卡记录游戏日', false);
    assertInt(occurrence.backfilled, '补录标志', 0, 1);
    if (occurrence.value !== null) assertDecimalText(occurrence.value, `打卡记录 ${occurrence.id} 进度`);
    if (occurrence.completionBatchId !== null && !batchIds.has(occurrence.completionBatchId)) {
      fail(`打卡记录 ${occurrence.id} 引用了不存在的批次`);
    }
    if (occurrence.completedAt !== null && occurrence.recordedAt === null) {
      fail(`打卡记录 ${occurrence.id} 已完成但缺少记录时间`);
    }
    if ((occurrence.windowStart === null) !== (occurrence.windowEnd === null)) {
      fail(`打卡记录 ${occurrence.id} 时间窗口不完整`);
    }
    const period = task.periodId === null ? null : periodById.get(task.periodId);
    const countBased = period != null && isCountPeriod(period);
    const prefix = expectedOccurrencePrefix(task, countBased);
    if (!occurrence.occurrenceKey.startsWith(prefix)) {
      fail(`打卡记录 ${occurrence.id} 的键前缀与任务周期不一致（期望 ${prefix}）`);
    }
    if (countBased) {
      const index = sessionIndexFromKey(occurrence.occurrenceKey);
      if (index === null) fail(`打卡记录 ${occurrence.id} 的轮次键无效`);
      const session = (sessionsByOrder.get(order.id) ?? []).find((row) => row.sessionIndex === index);
      if (!session) fail(`打卡记录 ${occurrence.id} 引用了不存在的轮次 ${index}`);
      if (session.periodId !== task.periodId) {
        fail(`打卡记录 ${occurrence.id} 的轮次不属于任务所在期次`);
      }
      if (occurrence.completedAt !== null && occurrence.completedAt < occurrence.createdAt) {
        fail(`打卡记录 ${occurrence.id} 完成时间早于创建时间`);
      }
    } else {
      if (occurrence.occurrenceKey.startsWith('N:')) {
        fail(`打卡记录 ${occurrence.id} 属于按日期期次，不得使用 N: 键`);
      }
      if (occurrence.occurrenceKey.startsWith('C:')) {
        fail(`打卡记录 ${occurrence.id} 仍使用已退役的 C: 键`);
      }
      const datePart = occurrence.occurrenceKey.slice(prefix.length);
      if (!isISODate(datePart)) fail(`打卡记录 ${occurrence.id} 的键日期无效：${datePart}`);
    }
    const keySet = occurrenceKeyByTask.get(occurrence.taskDefinitionId) ?? new Set<string>();
    keySet.add(occurrence.occurrenceKey);
    occurrenceKeyByTask.set(occurrence.taskDefinitionId, keySet);
  }

  // ---- 累计事件链 -----------------------------------------------------
  const chainContext: EventChainContext = {
    taskById,
    orderById: new Map(
      data.orders.map((row) => [row.id, { type: row.type, hostingMode: row.hostingMode }]),
    ),
    periodById: new Map(
      data.hosting_periods.map((row) => [
        row.id,
        {
          orderId: row.orderId,
          serviceCount: row.serviceCount,
          startDate: row.startDate,
          endDate: row.endDate,
          // F1：计次期次的下界是实际服务起点，不是存储锚点。
          serviceStart: countPeriodServiceStart(row),
        },
      ]),
    ),
    sessionById: new Map(
      data.hosting_sessions.map((row) => [row.id, { orderId: row.orderId, periodId: row.periodId }]),
    ),
  };
  const eventViolations = validateProgressEvents(data.task_progress_events, chainContext);
  if (eventViolations.length > 0) {
    const first = eventViolations[0];
    const objects = first.objects
      ? Object.entries(first.objects)
          .filter(([, value]) => value !== '')
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')
      : '';
    fail(
      `累计事件校验失败（${first.code}，事件 ${first.eventId}${
        objects ? `，${objects}` : ''
      }）：${first.reason}`,
    );
  }
  for (const event of data.task_progress_events) {
    assertEnum(event.kind, PROGRESS_EVENT_KINDS, '事件类型');
    assertEnum(event.scopeType, PROGRESS_SCOPE_TYPES, '事件范围');
    assertDate(event.gameDate, '事件游戏日', false);
    assertInt(event.sequence, '事件序号', 1, Number.MAX_SAFE_INTEGER);
    assertInt(event.recordedAt, '事件记录时间', 0, Number.MAX_SAFE_INTEGER);
    assertInt(event.createdAt, '事件创建时间', 0, Number.MAX_SAFE_INTEGER);
    if (event.totalValue !== null) assertDecimalText(event.totalValue, `事件 ${event.id} 总值`);
  }

  // ---- 批量完成 -------------------------------------------------------
  for (const batch of data.completion_batches) {
    assertEnum(batch.scope, BATCH_SCOPES, '批量范围');
    assertText(batch.operationId, '批量操作编号', 1, 200);
    assertInt(batch.createdAt, '批量创建时间', 0, Number.MAX_SAFE_INTEGER);
    if (batch.undoneAt !== null && batch.undoneAt < batch.createdAt) {
      fail(`批次 ${batch.id} 撤销时间早于创建时间`);
    }
    if (batch.scope === 'HOSTING_ALL') {
      // D-21：HOSTING_ALL 的 targetId/gameDate 必须为空。
      if (batch.targetId !== null || batch.gameDate !== null) {
        fail(`HOSTING_ALL 批次 ${batch.id} 的 targetId/gameDate 必须为空`);
      }
    } else {
      if (batch.targetId === null) fail(`批次 ${batch.id} 缺少目标`);
      if (!orderById.has(batch.targetId)) fail(`批次 ${batch.id} 的目标订单不存在`);
      assertDate(batch.gameDate, '批量游戏日');
    }
  }

  for (const item of data.completion_batch_items) {
    const batch = batchById.get(item.batchId);
    if (!batch) fail(`批次明细 ${item.id} 引用了不存在的批次 ${item.batchId}`);
    assertEnum(item.itemType, BATCH_ITEM_TYPES, '批次明细类型');
    if (item.itemType === 'OCCURRENCE') {
      if (item.occurrenceId === null) {
        // CD-01：只有"已撤销批次 + 有效任务引用"才允许无目标历史（目标**从未记录**）。
        // 这与"已知 id 但记录已消失"是两类：后者由归一阶段以
        // UNDONE_BATCH_TARGET_DANGLING 拒绝，绝不被改写成 null。
        const undoneHistory = batch.undoneAt !== null && item.taskDefinitionId !== null;
        if (!undoneHistory) {
          fail(
            `批次明细 ${item.id} 的 OCCURRENCE 缺少 occurrenceId（只有已撤销批次可以保留无目标的历史明细）`,
          );
        }
        if (!taskById.has(item.taskDefinitionId as string)) {
          fail(`批次明细 ${item.id} 引用了不存在的任务 ${item.taskDefinitionId}`);
        }
      } else {
        // 该列在安卓是 RESTRICT 外键：悬空 id 无法插入，所以任何批次（含已撤销）
        // 都不接受悬空引用。归一阶段已在激活前给出对象级诊断。
        const occurrence = occurrenceById.get(item.occurrenceId);
        if (!occurrence) {
          fail(
            `批次明细 ${item.id} 引用了不存在的打卡记录 ${item.occurrenceId}（悬空引用不可持久化；已撤销批次也不得丢弃原 id）`,
          );
        }
        if (
          item.taskDefinitionId !== null &&
          item.taskDefinitionId !== occurrence.taskDefinitionId
        ) {
          // 任务引用可选，但存在时必须与被引用打卡记录的任务一致。
          fail(
            `批次明细 ${item.id} 的任务引用 ${item.taskDefinitionId} 与打卡记录的任务 ${occurrence.taskDefinitionId} 不一致`,
          );
        }
      }
    } else {
      if (item.taskDefinitionId === null) fail(`批次明细 ${item.id} 的 SHORT_TASK 缺少任务引用`);
      if (item.occurrenceId !== null) fail(`批次明细 ${item.id} 的 SHORT_TASK 不得引用打卡记录`);
      if (!taskById.has(item.taskDefinitionId)) fail(`批次明细 ${item.id} 引用了不存在的任务`);
    }
  }

  // ---- 附件 -----------------------------------------------------------
  if (data.attachments.length > LIMITS.maxAttachments) fail('附件数量超过上限');
  for (const attachment of data.attachments) {
    const hasTask = attachment.taskDefinitionId !== null;
    const hasOccurrence = attachment.occurrenceId !== null;
    if (hasTask === hasOccurrence) fail(`截图 ${attachment.id} 必须且只能属于一个任务或打卡记录`);
    if (hasTask && !taskById.has(attachment.taskDefinitionId as string)) {
      fail(`截图 ${attachment.id} 引用了不存在的任务`);
    }
    if (hasOccurrence && !occurrenceIds.has(attachment.occurrenceId as string)) {
      fail(`截图 ${attachment.id} 引用了不存在的打卡记录`);
    }
    assertInt(attachment.sizeBytes, '截图大小', 1, LIMITS.maxAttachmentBytes);
    if (!attachment.mimeType.startsWith('image/')) fail(`截图 ${attachment.id} 类型无效`);
    const blob = snapshot.attachments.get(attachment.id);
    if (!blob) fail(`截图 ${attachment.id} 缺少附件内容`);
    if (blob.size !== attachment.sizeBytes) fail(`截图 ${attachment.id} 字节数与记录不一致`);
  }

  // ---- 收款 / 更正 ----------------------------------------------------
  if (data.receipts.length > LIMITS.maxReceipts) fail('收款记录数量超过上限');
  for (const receipt of data.receipts) {
    const order = orderById.get(receipt.orderId);
    if (!order) fail(`收款 ${receipt.id} 引用了不存在的订单`);
    assertMoney(receipt.amountCents, '收款', 1);
    assertEnum(receipt.channel, RECEIPT_CHANNELS, '收款渠道');
    assertEnum(receipt.status, RECEIPT_STATUSES, '收款状态');
    assertInt(receipt.receivedAt, '收款到账时间', 0, Number.MAX_SAFE_INTEGER);
    if (order.type === 'HOSTING') {
      if (receipt.periodId === null) fail(`托管收款 ${receipt.id} 必须指定期次`);
      const period = periodById.get(receipt.periodId);
      if (!period) fail(`收款 ${receipt.id} 引用了不存在的期次`);
      if (period.orderId !== receipt.orderId) fail(`收款 ${receipt.id} 的期次不属于该订单`);
    } else if (receipt.periodId !== null) {
      fail(`短期单收款 ${receipt.id} 不能指定期次`);
    }
    if (receipt.channel !== 'OTHER' && receipt.note !== null) {
      fail(`收款 ${receipt.id} 的非“其他”渠道备注必须为空`);
    }
    if (receipt.status === 'ACTIVE' && receipt.replacedByReceiptId !== null) {
      fail(`有效收款 ${receipt.id} 不应指向替换行`);
    }
    if (receipt.status === 'REPLACED') {
      const replacement = receipt.replacedByReceiptId
        ? receiptById.get(receipt.replacedByReceiptId)
        : undefined;
      if (!replacement) fail(`被替换收款 ${receipt.id} 必须指向存在的替换行`);
      if (replacement.orderId !== receipt.orderId || replacement.periodId !== receipt.periodId) {
        fail(`收款 ${receipt.id} 的替换归属不一致`);
      }
    }
    if (receipt.status === 'VOIDED' && receipt.replacedByReceiptId !== null) {
      fail(`作废收款 ${receipt.id} 不应指向替换行`);
    }
  }

  for (const correction of data.receipt_corrections) {
    assertEnum(correction.kind, CORRECTION_KINDS, '更正类型');
    const previous = receiptById.get(correction.receiptId);
    if (!previous) fail(`更正 ${correction.id} 引用了不存在的收款`);
    assertMoney(correction.previousAmountCents, '更正前金额', 1);
    assertInt(correction.previousReceivedAt, '更正前到账时间', 0, Number.MAX_SAFE_INTEGER);
    assertEnum(correction.previousChannel, RECEIPT_CHANNELS, '更正前渠道');
    if (correction.kind === 'AMEND') {
      if (correction.newReceiptId === null) fail(`更正 ${correction.id} 缺少新收款记录`);
      const replacement = receiptById.get(correction.newReceiptId);
      if (!replacement) fail(`更正 ${correction.id} 指向了不存在的新收款`);
      if (replacement.orderId !== previous.orderId || replacement.periodId !== previous.periodId) {
        fail(`更正 ${correction.id} 的新收款归属不一致`);
      }
      if (correction.newAmountCents === null) fail(`更正 ${correction.id} 缺少新金额`);
      assertMoney(correction.newAmountCents, '更正后金额', 1);
      if (correction.newReceivedAt === null || correction.newChannel === null) {
        fail(`更正 ${correction.id} 的新收款信息不完整`);
      }
    } else if (
      correction.newReceiptId !== null ||
      correction.newAmountCents !== null ||
      correction.newReceivedAt !== null ||
      correction.newChannel !== null ||
      correction.newNote !== null
    ) {
      fail(`作废记录 ${correction.id} 不得包含新金额信息`);
    }
  }

  for (const operation of data.order_creation_operations) {
    if (!orderById.has(operation.orderId)) fail(`建单操作 ${operation.operationId} 引用了不存在的订单`);
    assertEnum(operation.orderType, ORDER_TYPES, '建单类型');
    assertText(operation.fingerprint, '建单指纹', 1, 4000);
    if (operation.receiptId !== null) {
      const receipt = receiptById.get(operation.receiptId);
      if (!receipt) fail(`建单操作 ${operation.operationId} 引用了不存在的收款`);
      if (receipt.orderId !== operation.orderId) fail(`建单操作 ${operation.operationId} 的首笔收款与订单不一致`);
    }
  }

  // ---- 模板 -----------------------------------------------------------
  for (const template of data.game_templates) {
    assertEnum(template.origin, TEMPLATE_ORIGINS, '模板来源');
    assertText(template.gameName.trim(), '模板游戏名', 1, 60);
    assertText(template.templateVersion.trim(), '模板版本', 1, 30);
    assertInt(template.dailyRefreshMinutes, '模板每日刷新时间', 0, 1439);
    assertInt(template.weeklyRefreshDay, '模板每周刷新星期', 1, 7);
    assertInt(template.weeklyRefreshMinutes, '模板每周刷新时间', 0, 1439);
    if (template.hostingMode !== null) assertEnum(template.hostingMode, HOSTING_MODES, '模板托管模式');
    assertNullableInt(template.targetSessions, '模板打卡目标', 1, LIMITS.maxTargetSessions);
    assertWeekdays(template.serviceWeekdays, '模板服务星期');
    if (template.hostingMode === 'COUNT_BASED' && template.targetSessions === null) {
      fail(`模板 ${template.id} 计次模式必须声明目标次数`);
    }
    if (template.hostingMode !== 'COUNT_BASED' && template.targetSessions !== null) {
      fail(`模板 ${template.id} 非计次模式不得保留目标次数`);
    }
    // UF-036：空白归一为 null，上限 60。
    if (template.defaultOrderTitle !== null) {
      const trimmed = template.defaultOrderTitle.trim();
      if (trimmed.length === 0) fail(`模板 ${template.id} 的默认标题必须是空白归一的 null`);
      assertText(trimmed, '模板默认订单标题', 1, LIMITS.maxOrderTitle);
    }
  }

  for (const category of data.template_categories) {
    if (!templateIds.has(category.templateId)) fail(`模板分类 ${category.id} 引用了不存在的模板`);
    assertText(category.name.trim(), '模板分类名称', 1, LIMITS.maxTemplateCategoryName);
    assertInt(category.sortOrder, '模板分类排序', 0, Number.MAX_SAFE_INTEGER);
    if (category.hostingMode !== null) assertEnum(category.hostingMode, HOSTING_MODES, '分类托管模式');
    assertNullableInt(category.targetSessions, '分类打卡目标', 1, LIMITS.maxTargetSessions);
    assertWeekdays(category.serviceWeekdays, '分类服务星期');
    if (category.hostingMode === 'COUNT_BASED' && category.targetSessions === null) {
      fail(`分类 ${category.id} 计次模式必须声明目标次数`);
    }
    if (category.hostingMode === 'DATE_RANGE' && category.targetSessions !== null) {
      fail(`分类 ${category.id} 显式按日期时不得保留目标次数`);
    }
  }

  for (const task of data.template_tasks) {
    if (!templateIds.has(task.templateId)) fail(`模板任务 ${task.id} 引用了不存在的模板`);
    const category = templateCategoryById.get(task.categoryId);
    if (!category) fail(`模板任务 ${task.id} 引用了不存在的分类`);
    if (category.templateId !== task.templateId) fail(`模板任务 ${task.id} 的分类不属于该模板`);
    assertEnum(task.progressType, PROGRESS_TYPES, '模板进度类型');
    assertEnum(task.recurrence, RECURRENCES, '模板重复周期');
    assertDecimalText(task.startValue, `模板任务 ${task.id} 起始值`);
    assertDecimalText(task.targetValue, `模板任务 ${task.id} 目标值`);
    assertText(task.title, '模板任务标题', 1, LIMITS.maxTaskTitle);
    assertInt(task.sortOrder, '模板任务排序', 0, Number.MAX_SAFE_INTEGER);
    assertNullableInt(task.everyNDays, '模板间隔天数', 1, 3650);
    assertNullableInt(task.monthDay, '模板每月日号', 1, 31);
    assertDate(task.activeFrom, '模板任务生效日');
    assertDate(task.activeUntil, '模板任务生效截止日');
    if (task.activeFrom !== null && task.activeUntil !== null && task.activeUntil < task.activeFrom) {
      fail(`模板任务 ${task.id} 生效截止日早于生效日`);
    }
    if (task.numericMode !== null) {
      assertEnum(task.numericMode, NUMERIC_MODES, '模板数值口径');
      if (task.numericMode === 'CUMULATIVE' && task.progressType !== 'NUMERIC') {
        fail(`模板任务 ${task.id} 只有数值任务才能使用累计口径`);
      }
    }
    if (task.recurrence === 'MONTHLY' && monthDaysOf(task.monthDay, task.monthDays).length === 0) {
      fail(`模板任务 ${task.id} 的每月日号必须为 1–31`);
    }
    if (task.progressType === 'NUMERIC') {
      if (parseDecimal(task.targetValue).units <= parseDecimal(task.startValue).units) {
        fail(`模板任务 ${task.id} 目标值必须大于起始值`);
      }
    }
  }

  for (const preset of data.template_price_presets) {
    if (!templateIds.has(preset.templateId)) fail(`价格预设 ${preset.id} 引用了不存在的模板`);
    assertMoney(preset.amountCents, '价格预设', 1);
    assertText(preset.label, '价格预设标签', 0, 30);
    assertInt(preset.sortOrder, '价格预设排序', 0, Number.MAX_SAFE_INTEGER);
  }

  for (const change of data.order_price_changes) {
    const order = orderById.get(change.orderId);
    if (!order) fail(`改价记录 ${change.id} 引用了不存在的订单`);
    if (!Number.isSafeInteger(change.previousPriceCents) || change.previousPriceCents < 0) {
      fail(`改价记录 ${change.id} 的改价前金额非法`);
    }
    assertMoney(change.newPriceCents, '改价后金额', 1);
    assertText(change.reason, '改价原因', 0, 200);
    assertInt(change.createdAt, '改价时间', 0, Number.MAX_SAFE_INTEGER);
    if (change.periodId !== null) {
      const period = periodById.get(change.periodId);
      if (!period || period.orderId !== change.orderId) fail(`改价记录 ${change.id} 的期次不属于该订单`);
    }
  }

  for (const seed of data.template_seed_state) {
    assertText(seed.seedKey, '内置模板标记', 1, 200);
    assertInt(seed.appliedAt, '内置模板标记时间', 0, Number.MAX_SAFE_INTEGER);
  }

  for (const reminder of data.reminder_settings) {
    for (const minutes of [
      reminder.shortDeadlineMinutes,
      reminder.hostingExpiryMinutes,
      reminder.unfinishedTasksMinutes,
    ]) {
      assertInt(minutes, '提醒时间', 0, 1439);
    }
  }
}

/** 只用于导出/预览的轻量计数，不参与校验。 */
export function tableRowCounts(data: BackupDataSet): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data)) counts[table] = (rows as unknown[]).length;
  return counts;
}

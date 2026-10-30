import type {
  HostingPeriodRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
} from '../contracts/tables';
import {
  addDays,
  dayOfMonth,
  diffDays,
  gameDateAt,
  isoWeekday,
  zonedEpoch,
} from './gameCalendar';

export interface OccurrenceSlot {
  key: string;
  gameDate: string;
  windowStart: string | null;
  windowEnd: string | null;
}

export function parseWeekdays(value: string | null): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 7);
}

/**
 * 每月日号集合（UF-025）：monthDays 逗号分隔 1–31 优先，缺省回退单日号 monthDay。
 * 重复日号去重并排序；无效值不静默截断，直接忽略。
 */
export function parseMonthDays(monthDay: number | null, monthDays: string | null): number[] {
  if (monthDays && monthDays.trim()) {
    const parsed = monthDays
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31);
    return [...new Set(parsed)].sort((left, right) => left - right);
  }
  return monthDay && monthDay >= 1 && monthDay <= 31 ? [monthDay] : [];
}

/** 多日号/单日号统一编码为 monthDays 列值；单日号仍写 monthDay 保持兼容。 */
export function encodeMonthDays(days: number[]): string | null {
  const unique = [...new Set(days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 31))].sort(
    (left, right) => left - right,
  );
  return unique.length > 0 ? unique.join(',') : null;
}

function withinPeriod(period: HostingPeriodRow, date: string): boolean {
  return date >= period.startDate && date <= periodScheduleEnd(period);
}

/**
 * 托管单「一次性」任务的打卡键前缀。
 *
 * 与 `N:`（计次轮次）刻意分开：一次性任务不占轮次号、不参与应做集，
 * 归属日就是**实际打卡那一天**，因此键里带日期而不是轮次号。
 */
export const ONCE_SLOT_PREFIX = 'O:';

/**
 * 普通一次性任务（非累计口径）。
 *
 * 托管单允许它存在：本期只做一次，哪天打卡都算，完成后从今日事项消失，
 * 既不计入每日应做集，也不拖累整轮/整单完成。
 * 累计口径的 `ONE_TIME` 任务仍走事件链（`task_progress_events`），不产生打卡行。
 */
export function isSingleShotTask(
  task: Pick<TaskDefinitionRow, 'recurrence' | 'progressType' | 'numericMode'>,
): boolean {
  if (task.recurrence !== 'ONE_TIME') return false;
  return !(task.progressType === 'NUMERIC' && task.numericMode === 'CUMULATIVE');
}

export function onceSlotKey(gameDate: string): string {
  return `${ONCE_SLOT_PREFIX}${gameDate}`;
}

/**
 * 一次性任务的打卡槽：归属日 = 传入的游戏日（也就是实际打卡日）。
 *
 * 与 `slotFor` 一样遵守期次范围、任务生效起止日期与服务星期限制，
 * 但不绑定任何轮次，也不产生"每天一条"的重复槽。
 */
export function onceSlotFor(
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  gameDate: string,
): OccurrenceSlot | null {
  if (!withinPeriod(period, gameDate)) return null;
  if (!withinTaskActiveRange(task, gameDate)) return null;
  if (period.serviceDays != null) {
    const serviceWeekdays = parseWeekdays(period.serviceWeekdays);
    if (serviceWeekdays.length > 0 && !serviceWeekdays.includes(isoWeekday(gameDate))) {
      return null;
    }
  }
  return { key: onceSlotKey(gameDate), gameDate, windowStart: null, windowEnd: null };
}

/** 调度口径的期次结束日：按次数期次无日历期限，按开区间处理。 */
export function periodScheduleEnd(period: HostingPeriodRow): string {
  return period.serviceCount != null ? '9999-12-31' : period.endDate;
}

/** 按次数模式（整轮打卡累计，无日历期限）。 */
export function isCountPeriod(period: HostingPeriodRow): boolean {
  return period.serviceCount != null;
}

/** 任务生效起止日期过滤：只在 [activeFrom, activeUntil] 内产生打卡。 */
function withinTaskActiveRange(task: TaskDefinitionRow, date: string): boolean {
  if (task.activeFrom !== null && task.activeFrom !== undefined && date < task.activeFrom) {
    return false;
  }
  if (task.activeUntil !== null && task.activeUntil !== undefined && date > task.activeUntil) {
    return false;
  }
  return true;
}

interface WindowBounds {
  /** 未裁剪的窗口起始日（作为发生键与 gameDate）。 */
  windowStartDate: string;
  displayStart: string;
  displayEnd: string;
}

function weeklyWindow(
  _task: TaskDefinitionRow,
  period: HostingPeriodRow,
  gameDate: string,
): WindowBounds | null {
  const reference = zonedEpoch(gameDate, period.dailyRefreshMinutes + 12 * 60, period.gameZoneId);
  let cursor = gameDate;
  for (let step = 0; step < 14; step += 1) {
    const candidate = addDays(cursor, -step);
    if (isoWeekday(candidate) !== period.weeklyRefreshDay) continue;
    const startEpoch = zonedEpoch(candidate, period.weeklyRefreshMinutes, period.gameZoneId);
    if (startEpoch <= reference) {
      const displayStart = candidate < period.startDate ? period.startDate : candidate;
      const rawEnd = addDays(candidate, 6);
      const displayEnd = rawEnd > period.endDate ? period.endDate : rawEnd;
      if (displayStart > displayEnd) return null;
      return { windowStartDate: candidate, displayStart, displayEnd };
    }
  }
  return null;
}

/** 某年某月实际存在的刷新日（1–31 中当月存在者，升序）。 */
function monthRefreshDates(year: number, month: number, days: number[]): string[] {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return days
    .filter((day) => day >= 1 && day <= lastDay)
    .map((day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    .sort();
}

/**
 * 每月刷新窗口（刷新日可多个）：从最近一个已过刷新时刻，到下一个刷新日前一天。
 * 当月不存在该日号时跳过该月（与每月任务一致）；键使用未裁剪的窗口起始日。
 */
function monthlyWindow(
  period: HostingPeriodRow,
  gameDate: string,
  days: number[],
): WindowBounds | null {
  const reference = zonedEpoch(gameDate, period.dailyRefreshMinutes + 12 * 60, period.gameZoneId);
  const [year, month] = gameDate.split('-').map(Number);
  let current: string | null = null;
  for (let back = 0; back <= 13 && current === null; back += 1) {
    const base = new Date(Date.UTC(year, month - 1 - back, 1));
    const dates = monthRefreshDates(base.getUTCFullYear(), base.getUTCMonth() + 1, days);
    for (let index = dates.length - 1; index >= 0; index -= 1) {
      const date = dates[index];
      if (zonedEpoch(date, period.weeklyRefreshMinutes, period.gameZoneId) <= reference) {
        current = date;
        break;
      }
    }
  }
  if (current === null) return null;
  const [currentYear, currentMonth] = current.split('-').map(Number);
  let next: string | null = null;
  for (let forward = 0; forward <= 13 && next === null; forward += 1) {
    const base = new Date(Date.UTC(currentYear, currentMonth - 1 + forward, 1));
    for (const date of monthRefreshDates(base.getUTCFullYear(), base.getUTCMonth() + 1, days)) {
      if (date > current) {
        next = date;
        break;
      }
    }
  }
  if (next === null) return null;
  const displayStart = current < period.startDate ? period.startDate : current;
  const rawEnd = addDays(next, -1);
  const displayEnd = rawEnd > period.endDate ? period.endDate : rawEnd;
  if (displayStart > displayEnd) return null;
  return { windowStartDate: current, displayStart, displayEnd };
}

/**
 * 某个游戏日期上该任务应有的发生槽。
 * 托管任务只在期次范围内存在；短期任务不产生发生记录。
 */
export function slotFor(
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  gameDate: string,
): OccurrenceSlot | null {
  if (!withinPeriod(period, gameDate)) return null;
  if (!withinTaskActiveRange(task, gameDate)) return null;
  // UF-010：仅工作日托管时，非服务日不产生任务。
  if (period.serviceDays != null) {
    const serviceWeekdays = parseWeekdays(period.serviceWeekdays);
    if (serviceWeekdays.length > 0 && !serviceWeekdays.includes(isoWeekday(gameDate))) {
      return null;
    }
  }
  // 按次数模式：不指定时间，每个游戏日都是完整一轮，全部托管任务都需打卡。
  if (period.serviceCount != null) {
    // 一次性任务不属于任何轮次（应做集/轮次完成都不看它），它用自己的 `onceSlotFor`。
    if (task.recurrence === 'ONE_TIME') return null;
    return { key: `C:${gameDate}`, gameDate, windowStart: null, windowEnd: null };
  }
  switch (task.recurrence) {
    case 'DAILY':
      return { key: `D:${gameDate}`, gameDate, windowStart: null, windowEnd: null };
    case 'SELECTED_WEEKDAYS':
      return parseWeekdays(task.weekdays).includes(isoWeekday(gameDate))
        ? { key: `S:${gameDate}`, gameDate, windowStart: null, windowEnd: null }
        : null;
    case 'EVERY_N_DAYS': {
      const interval = task.everyNDays ?? 0;
      if (interval < 1) return null;
      const offset = diffDays(period.startDate, gameDate);
      if (offset < 0 || offset % interval !== 0) return null;
      return { key: `E:${gameDate}`, gameDate, windowStart: null, windowEnd: null };
    }
    case 'MONTHLY': {
      const days = parseMonthDays(task.monthDay, task.monthDays);
      if (days.length === 0) return null;
      // 当月没有该日号时跳过该日，其余日号照常执行，不挪到月末。
      if (!days.includes(dayOfMonth(gameDate))) return null;
      return { key: `M:${gameDate}`, gameDate, windowStart: null, windowEnd: null };
    }
    case 'WEEKLY': {
      // 刷新周期：配置了每月刷新日时按“刷新到刷新”取窗，否则按周窗口。
      const refreshDays = parseMonthDays(null, period.monthlyRefreshDays);
      const window =
        refreshDays.length > 0
          ? monthlyWindow(period, gameDate, refreshDays)
          : weeklyWindow(task, period, gameDate);
      if (!window) return null;
      return {
        key: `W:${window.windowStartDate}`,
        gameDate: window.windowStartDate,
        windowStart: window.displayStart,
        windowEnd: window.displayEnd,
      };
    }
    case 'ONE_TIME':
      // 托管「一次性」任务：本期只做一次，槽落在实际打卡日（`O:` 键，不占轮次）；
      // 累计口径的一次性任务由事件链判定，这里不给槽。
      return isSingleShotTask(task) ? onceSlotFor(task, period, gameDate) : null;
    default:
      return null;
  }
}

/** 某日所在周期的上一 / 下一每月触发日；没有触发日时返回 null。 */
function monthTriggerRange(
  gameDate: string,
  days: number[],
): { trigger: string; next: string } | null {
  const [year, month] = gameDate.split('-').map(Number);
  let trigger: string | null = null;
  for (let back = 0; back <= 13 && trigger === null; back += 1) {
    const base = new Date(Date.UTC(year, month - 1 - back, 1));
    const dates = monthRefreshDates(base.getUTCFullYear(), base.getUTCMonth() + 1, days);
    const past = dates.filter((date) => date <= gameDate);
    if (past.length > 0) trigger = past[past.length - 1];
  }
  if (trigger === null) return null;
  const [triggerYear, triggerMonth] = trigger.split('-').map(Number);
  let next: string | null = null;
  for (let forward = 0; forward <= 13 && next === null; forward += 1) {
    const base = new Date(Date.UTC(triggerYear, triggerMonth - 1 + forward, 1));
    for (const date of monthRefreshDates(base.getUTCFullYear(), base.getUTCMonth() + 1, days)) {
      if (date > trigger) {
        next = date;
        break;
      }
    }
  }
  if (next === null) return null;
  return { trigger, next };
}

/**
 * **展示用**覆盖槽（F-01）：某个游戏日"正在生效的本周期任务"。
 *
 * 与 `slotFor` 的区别只在 MONTHLY / EVERY_N_DAYS：
 * - `slotFor` 是**写入口径**：只有触发日才有槽（一个周期只有一天能打卡）；
 * - `coverageSlotFor` 是**读取口径**：从触发日到下一次触发日前一天，每天都返回同一条槽。
 *
 * 返回值刻意保持与触发日一致（`key` / `gameDate` 都是触发日），因此 occurrence 行
 * 不新增、不迁移、备份契约不变；调用方用 `slot.gameDate !== 当前日` 判断"是否属于本周期
 * 但当天不是触发日"，写入时仍提交 `slot.gameDate`（或让用户明确补录到该日）。
 */
export function coverageSlotFor(
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  gameDate: string,
): OccurrenceSlot | null {
  if (!withinPeriod(period, gameDate)) return null;
  if (!withinTaskActiveRange(task, gameDate)) return null;
  if (period.serviceDays != null) {
    const serviceWeekdays = parseWeekdays(period.serviceWeekdays);
    if (serviceWeekdays.length > 0 && !serviceWeekdays.includes(isoWeekday(gameDate))) {
      return null;
    }
  }
  if (period.serviceCount != null) {
    // 计次托管每天都是完整一轮，无需周期覆盖。
    return slotFor(task, period, gameDate);
  }
  if (task.recurrence !== 'MONTHLY' && task.recurrence !== 'EVERY_N_DAYS') {
    return slotFor(task, period, gameDate);
  }

  let trigger: string;
  let nextTrigger: string | null = null;
  if (task.recurrence === 'MONTHLY') {
    const days = parseMonthDays(task.monthDay, task.monthDays);
    if (days.length === 0) return null;
    const range = monthTriggerRange(gameDate, days);
    if (!range) return null;
    trigger = range.trigger;
    nextTrigger = range.next;
  } else {
    const interval = task.everyNDays ?? 0;
    if (interval < 1) return null;
    const offset = diffDays(period.startDate, gameDate);
    if (offset < 0) return null;
    trigger = addDays(period.startDate, Math.floor(offset / interval) * interval);
    nextTrigger = addDays(trigger, interval);
  }

  // 触发日本身必须可写：早于期次开始日 / 任务生效起始日、晚于截止日的周期不提供展示，
  // 否则会出现"看得到、点不动"的假任务（写入一律归到触发日）。
  if (trigger < period.startDate) return null;
  if (!withinTaskActiveRange(task, trigger)) return null;
  const rawEnd = nextTrigger !== null ? addDays(nextTrigger, -1) : period.endDate;
  const rawWindowEnd = task.activeUntil && task.activeUntil < rawEnd ? task.activeUntil : rawEnd;
  const displayStart = trigger;
  const displayEnd = rawWindowEnd > period.endDate ? period.endDate : rawWindowEnd;
  if (displayStart > displayEnd) return null;
  if (gameDate < displayStart || gameDate > displayEnd) return null;
  return {
    key: task.recurrence === 'MONTHLY' ? `M:${trigger}` : `E:${trigger}`,
    gameDate: trigger,
    windowStart: displayStart,
    windowEnd: displayEnd,
  };
}

/** 生成指定游戏日期范围内的全部发生槽（用于建单、补录、续期与日历）。 */
export function slotsInRange(
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  fromDate: string,
  toDate: string,
): OccurrenceSlot[] {
  const start = fromDate < period.startDate ? period.startDate : fromDate;
  const end = toDate > periodScheduleEnd(period) ? periodScheduleEnd(period) : toDate;
  if (start > end) return [];
  const slots: OccurrenceSlot[] = [];
  const seen = new Set<string>();
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 4000) {
    const slot = slotFor(task, period, cursor);
    if (slot && !seen.has(slot.key)) {
      seen.add(slot.key);
      slots.push(slot);
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return slots;
}

export function currentGameDate(period: HostingPeriodRow, now: number): string {
  return gameDateAt(now, period.gameZoneId, period.dailyRefreshMinutes);
}

export function slotForNow(
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  now: number,
): OccurrenceSlot | null {
  return slotFor(task, period, currentGameDate(period, now));
}

/**
 * 按次数模式的已完成轮次：一个游戏日把该日应做任务全部打卡完成算 1 次。
 * 应做任务按 slotFor 判断（生效起止日期外的任务不计入）；没有任何打卡行的日期不计。
 */
export function completedRounds(
  tasks: TaskDefinitionRow[],
  period: HostingPeriodRow,
  occurrences: TaskOccurrenceRow[],
): number {
  if (tasks.length === 0) return 0;
  const taskIds = new Set(tasks.map((task) => task.id));
  const completedByDate = new Map<string, Set<string>>();
  const touchedDates = new Set<string>();
  for (const row of occurrences) {
    if (!taskIds.has(row.taskDefinitionId)) continue;
    touchedDates.add(row.gameDate);
    if (row.completedAt === null) continue;
    const bucket = completedByDate.get(row.gameDate) ?? new Set<string>();
    bucket.add(row.taskDefinitionId);
    completedByDate.set(row.gameDate, bucket);
  }
  let rounds = 0;
  for (const date of touchedDates) {
    const due = tasks.filter((task) => slotFor(task, period, date) !== null);
    if (due.length === 0) continue;
    const done = completedByDate.get(date);
    if (done && due.every((task) => done.has(task.id))) rounds += 1;
  }
  return rounds;
}

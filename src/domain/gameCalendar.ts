import { AppError } from '../contracts/errors';

const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zoneId: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zoneId);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-CA', {
      timeZone: zoneId,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new AppError('INVALID_INPUT', `时区无效：${zoneId}`);
  }
  formatterCache.set(zoneId, created);
  return created;
}

export function isValidZone(zoneId: string): boolean {
  try {
    formatter(zoneId);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(epochMs: number, zoneId: string): ZonedParts {
  const parts = formatter(zoneId).formatToParts(new Date(epochMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

export function localDateAt(epochMs: number, zoneId: string): string {
  const parts = zonedParts(epochMs, zoneId);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function minutesOfDayAt(epochMs: number, zoneId: string): number {
  const parts = zonedParts(epochMs, zoneId);
  return parts.hour * 60 + parts.minute;
}

export function zoneOffsetMinutes(epochMs: number, zoneId: string): number {
  const parts = zonedParts(epochMs, zoneId);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/** 以“每日刷新”为起点计算游戏日期。 */
export function gameDateAt(epochMs: number, zoneId: string, refreshMinutes: number): string {
  const date = localDateAt(epochMs, zoneId);
  return minutesOfDayAt(epochMs, zoneId) < refreshMinutes ? addDays(date, -1) : date;
}

/** 指定时区本地日期 + 分钟数对应的 epoch 毫秒（处理 DST 的两轮校正）。 */
export function zonedEpoch(dateStr: string, minutes: number, zoneId: string): number {
  const [year, month, day] = parseISODate(dateStr);
  const base = Date.UTC(year, month - 1, day, 0, 0) + minutes * 60_000;
  let guess = base;
  for (let index = 0; index < 3; index += 1) {
    const offset = zoneOffsetMinutes(guess, zoneId);
    const next = base - offset * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function gameDayStartEpoch(dateStr: string, zoneId: string, refreshMinutes: number): number {
  return zonedEpoch(dateStr, refreshMinutes, zoneId);
}

export function parseISODate(dateStr: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new AppError('INVALID_INPUT', `日期格式不正确：${dateStr}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new AppError('INVALID_INPUT', `日期不存在：${dateStr}`);
  }
  return [year, month, day];
}

export function isISODate(value: string): boolean {
  try {
    parseISODate(value);
    return true;
  } catch {
    return false;
  }
}

export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = parseISODate(dateStr);
  const stamp = Date.UTC(year, month - 1, day) + days * DAY_MS;
  const date = new Date(stamp);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function diffDays(from: string, to: string): number {
  const [fy, fm, fd] = parseISODate(from);
  const [ty, tm, td] = parseISODate(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

/**
 * UF-010：仅工作日托管。从 startDate 起数 serviceDays 个工作日（ISO 星期集合），
 * 返回第 N 个工作日的日期（含首尾）。
 */
export function hostingEndDateForWeekdays(
  startDate: string,
  serviceDays: number,
  weekdays: ReadonlySet<number>,
): string {
  if (!Number.isInteger(serviceDays) || serviceDays < 1) {
    throw new Error('托管天数必须大于 0');
  }
  if (weekdays.size === 0) {
    throw new Error('工作日托管至少选择一个星期');
  }
  let date = startDate;
  let count = 0;
  let guard = 0;
  while (guard < 4000) {
    if (weekdays.has(isoWeekday(date))) {
      count += 1;
      if (count === serviceDays) return date;
    }
    date = addDays(date, 1);
    guard += 1;
  }
  throw new Error('托管天数超出可计算范围');
}

/** 计划口径已消耗的服务天数：[startDate, min(today, endDate)] 内落在工作日集合的天数。 */
export function countServiceDaysUsed(
  startDate: string,
  endDate: string,
  today: string,
  weekdays: ReadonlySet<number>,
): number {
  const last = today < endDate ? today : endDate;
  if (last < startDate) return 0;
  let count = 0;
  let date = startDate;
  let guard = 0;
  while (date <= last && guard < 4000) {
    if (weekdays.has(isoWeekday(date))) count += 1;
    date = addDays(date, 1);
    guard += 1;
  }
  return count;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dayOfMonth(dateStr: string): number {
  return parseISODate(dateStr)[2];
}

/** ISO 星期：周一=1 … 周日=7。 */
export function isoWeekday(dateStr: string): number {
  const [year, month, day] = parseISODate(dateStr);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function formatDateTime(epochMs: number, zoneId: string): string {
  const parts = zonedParts(epochMs, zoneId);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatDateWithWeekday(dateStr: string): string {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  return `${dateStr} 周${names[isoWeekday(dateStr) - 1]}`;
}

/** ISO 星期集合 → “周一、周三、周五”（界面与测试共用，顺序固定为升序）。 */
export function weekdayNames(weekdays: readonly number[]): string {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  return [...new Set(weekdays)]
    .sort((left, right) => left - right)
    .map((day) => (day >= 1 && day <= 7 ? `周${names[day - 1]}` : ''))
    .filter(Boolean)
    .join('、');
}

/** 下一次每日刷新时刻（用于前台计时与今日事项刷新）。 */
export function nextRefreshEpoch(now: number, zoneId: string, refreshMinutes: number): number {
  const today = localDateAt(now, zoneId);
  const todayStart = zonedEpoch(today, refreshMinutes, zoneId);
  if (now < todayStart) return todayStart;
  return zonedEpoch(addDays(today, 1), refreshMinutes, zoneId);
}

export function monthRange(month: string, zoneId: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new AppError('INVALID_INPUT', '月份格式应为 yyyy-MM');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const startDate = `${year}-${pad(monthNumber)}-01`;
  const nextMonth = monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${pad(monthNumber + 1)}-01`;
  return { start: zonedEpoch(startDate, 0, zoneId), end: zonedEpoch(nextMonth, 0, zoneId) };
}

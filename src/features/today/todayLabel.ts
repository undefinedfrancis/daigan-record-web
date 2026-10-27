import { isoWeekday, localDateAt, parseISODate } from '../../domain/gameCalendar';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 今日事项页头日期：返图给老板时要一眼看出是哪一天。
 *
 * `2026-10-27` → `2026年10月27日 星期二`（月日不补零，和订单页的 `2026-10-27` 互补）。
 */
export function formatDateLabel(dateStr: string): string {
  const [year, month, day] = parseISODate(dateStr);
  return `${year}年${month}月${day}日 星期${WEEKDAY_LABELS[isoWeekday(dateStr) % 7]}`;
}

/**
 * 订单卡片组头的短日期：`10月27日 周二`。
 *
 * 组头一行要放标题、老板、区服、次数和「整单完成」，去掉年份才能不换行；返图时仍能看出是哪天。
 */
export function formatShortDateLabel(dateStr: string): string {
  const [, month, day] = parseISODate(dateStr);
  return `${month}月${day}日 周${WEEKDAY_LABELS[isoWeekday(dateStr) % 7]}`;
}

/** 按订单时区换算的**公历**今天（不按每日刷新回退，与游戏日区分）。 */
export function localTodayDate(nowMs: number, zoneId: string): string {
  return localDateAt(nowMs, zoneId);
}

/**
 * 游戏日落后于公历日时（尚未到每日刷新时间）的说明；同一天返回 null，不重复展示。
 */
export function gameDateNote(todayDate: string, gameDate: string): string | null {
  if (!todayDate || !gameDate || todayDate === gameDate) return null;
  return `游戏日 ${gameDate}（未到每日刷新时间，仍计前一天）`;
}

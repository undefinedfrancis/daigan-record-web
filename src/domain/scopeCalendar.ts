import type { HostingPeriodRow, OrderRow } from '../contracts/tables';
import { gameDateAt } from './gameCalendar';

/**
 * 归属日期的日历快照（游戏时区 + 每日刷新点）。
 *
 * 累计进度的归属日**必须**用 scope 自己的快照：PERIOD / SESSION 用期次（安卓在建单、
 * 续期与恢复时写入的快照），只有短期单（scope = TASK）才回落到订单口径。
 * 这与命令层 `assertScopeForWrite` 完全同源——两端若各自选日历，UI 会生成一个命令层
 * 不承认的游戏日（R5）。
 */
export interface ScopeCalendar {
  gameZoneId: string;
  dailyRefreshMinutes: number;
}

export function scopeCalendar(period: HostingPeriodRow | null, order: OrderRow): ScopeCalendar {
  return period === null
    ? { gameZoneId: order.gameZoneId, dailyRefreshMinutes: order.dailyRefreshMinutes }
    : { gameZoneId: period.gameZoneId, dailyRefreshMinutes: period.dailyRefreshMinutes };
}

/** 该日历下的"今天"；提交时也用它现算归属日。 */
export function calendarGameDate(calendar: ScopeCalendar, nowMs: number): string {
  return gameDateAt(nowMs, calendar.gameZoneId, calendar.dailyRefreshMinutes);
}

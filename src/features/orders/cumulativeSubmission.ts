import { gameDateAt } from '../../domain/gameCalendar';
import type { ProgressScope } from '../../domain/progressEvents';
import type { ScopeCalendar } from '../../domain/scopeCalendar';

/**
 * 累计提交的**归属日**必须在提交边界现算，不能沿用渲染时那一份读模型日期。
 *
 * 日历（时区 + 每日刷新点）来自读模型给出的**权威 scope 快照**：
 * TASK 用订单、PERIOD 用任务期次、SESSION 用轮次期次、等待中的轮次用活动期次。
 * 这样打开着的表单不会带着上一次刷新的日期提交（R5 / 过期表单防护）。
 */
export function submissionGameDate(calendar: ScopeCalendar, nowMs: number = Date.now()): string {
  return gameDateAt(nowMs, calendar.gameZoneId, calendar.dailyRefreshMinutes);
}

/**
 * 今日列表条目 → 提交 scope。
 *
 * `null` 表示"当前轮次（事务内 ensure）"：读操作与提交前的日期计算都**不**建轮次行，
 * 只有真正的写入事务才会分配。与 `progress.submit` 的 scope 输入同一套映射。
 */
export function cumulativeScopeOf(item: {
  sessionId: string | null;
  periodId: string | null;
  serviceCount: number | null;
}): ProgressScope | null {
  if (item.sessionId !== null) return { kind: 'SESSION', sessionId: item.sessionId };
  // 计次托管但轮次行尚未创建：写入时在事务内 ensure。
  if (item.serviceCount !== null) return null;
  if (item.periodId !== null) return { kind: 'PERIOD', periodId: item.periodId };
  return { kind: 'TASK' };
}

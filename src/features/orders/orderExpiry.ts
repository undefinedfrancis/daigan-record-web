import type { OrderSummary } from '../../application/contracts';
import { diffDays, gameDateAt } from '../../domain/gameCalendar';

export type ExpiryTone = 'normal' | 'warn' | 'danger' | 'info';

export interface OrderExpiryBadge {
  /** 剩余天数：> 0 还剩几天，0 到期当天，< 0 已过期几天；未开始时为距开始天数。 */
  daysLeft: number;
  /** 列表行文案：剩 N 天 / 今天到期 / 已过期 N 天 / 预定 03-01 开始 · 距开始 N 天。 */
  label: string;
  /** 正常、临期（标黄）、已过期（标红）、未开始（预定，标绿）。 */
  tone: ExpiryTone;
  /** true = 期次尚未开始（预订单）：剩余天数口径换成"距开始"。 */
  notStarted: boolean;
}

/** 剩余不足该天数时标黄提醒（含到期当天）。 */
export const EXPIRY_WARN_DAYS = 3;

/**
 * 纯日期口径的剩余天数。订单列表展示的是「当前期次结束日」，
 * 结束日当天仍有服务，所以当天写作「今天到期」而不是「剩 0 天」。
 */
export function expiryOf(today: string, endDate: string): OrderExpiryBadge {
  const daysLeft = diffDays(today, endDate);
  if (daysLeft < 0) {
    return { daysLeft, label: `已过期 ${-daysLeft} 天`, tone: 'danger', notStarted: false };
  }
  if (daysLeft === 0) {
    return { daysLeft, label: '今天到期', tone: 'warn', notStarted: false };
  }
  return {
    daysLeft,
    label: `剩 ${daysLeft} 天`,
    tone: daysLeft <= EXPIRY_WARN_DAYS ? 'warn' : 'normal',
    notStarted: false,
  };
}

/**
 * 期次尚未开始的预定单：剩余天数没有意义，改说「预定 X 开始 · 距开始 N 天」。
 * 开始日当天即进入服务（`today === startDate` → 正常口径）。
 */
export function upcomingOf(today: string, startDate: string): OrderExpiryBadge {
  const daysLeft = diffDays(today, startDate);
  return {
    daysLeft,
    label: `预定 ${startDate} 开始 · 距开始 ${daysLeft} 天`,
    tone: 'info',
    notStarted: true,
  };
}

/**
 * 订单列表行「至 …」后面要追加的提示。
 * 「今天」按订单自己的时区与每日刷新时间取游戏日，与今日事项/打卡口径一致；
 * 按次数服务、已作废、已完成的订单没有日历期限语义，不展示。
 */
export function orderExpiryBadge(order: OrderSummary, nowMs: number = Date.now()): OrderExpiryBadge | null {
  if (order.cancelled || order.completed) return null;
  if (order.currentServiceCount != null) return null;
  const today = gameDateAt(nowMs, order.gameZoneId, order.dailyRefreshMinutes);
  // 预订单：期次还没开始，先说"什么时候开始"，不要用剩余天数误导。
  if (order.currentPeriodStart && today < order.currentPeriodStart) {
    return upcomingOf(today, order.currentPeriodStart);
  }
  if (!order.currentPeriodEnd) return null;
  return expiryOf(today, order.currentPeriodEnd);
}

export function expiryToneClass(tone: ExpiryTone): string {
  if (tone === 'danger') return 'text-danger';
  if (tone === 'warn') return 'text-warn';
  if (tone === 'info') return 'text-sage-deep';
  return '';
}

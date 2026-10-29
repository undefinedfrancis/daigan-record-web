import type { OrderSummary } from '../../application/contracts';
import { diffDays, gameDateAt } from '../../domain/gameCalendar';

export type ExpiryTone = 'normal' | 'warn' | 'danger';

export interface OrderExpiryBadge {
  /** 剩余天数：> 0 还剩几天，0 到期当天，< 0 已过期几天。 */
  daysLeft: number;
  /** 列表行文案：剩 N 天 / 今天到期 / 已过期 N 天。 */
  label: string;
  /** 正常、临期（标黄）、已过期（标红）。 */
  tone: ExpiryTone;
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
    return { daysLeft, label: `已过期 ${-daysLeft} 天`, tone: 'danger' };
  }
  if (daysLeft === 0) {
    return { daysLeft, label: '今天到期', tone: 'warn' };
  }
  return {
    daysLeft,
    label: `剩 ${daysLeft} 天`,
    tone: daysLeft <= EXPIRY_WARN_DAYS ? 'warn' : 'normal',
  };
}

/**
 * 订单列表行「至 …」后面要追加的剩余天数。
 * 「今天」按订单自己的时区与每日刷新时间取游戏日，与今日事项/打卡口径一致；
 * 按次数服务、已作废、已完成的订单没有日历期限语义，不展示。
 */
export function orderExpiryBadge(order: OrderSummary, nowMs: number = Date.now()): OrderExpiryBadge | null {
  if (order.cancelled || order.completed) return null;
  if (order.currentServiceCount != null || !order.currentPeriodEnd) return null;
  const today = gameDateAt(nowMs, order.gameZoneId, order.dailyRefreshMinutes);
  return expiryOf(today, order.currentPeriodEnd);
}

export function expiryToneClass(tone: ExpiryTone): string {
  if (tone === 'danger') return 'text-danger';
  if (tone === 'warn') return 'text-warn';
  return '';
}

import { describe, expect, it } from 'vitest';
import {
  EXPIRY_WARN_DAYS,
  expiryOf,
  expiryToneClass,
  orderExpiryBadge,
} from '../../src/features/orders/orderExpiry';
import type { OrderSummary } from '../../src/application/contracts';

/**
 * 订单列表「至 2026-12-27」后面补充剩余天数（2026-10-29 用户反馈）：
 * 要一眼看出还有几天到期，临期标黄、已过期标红，按次数/作废/完成不展示。
 */

function order(patch: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 'o1',
    type: 'HOSTING',
    title: '日常托管',
    colorTag: null,
    ownerId: 'owner1',
    ownerName: '老板',
    accountId: 'acc1',
    accountName: '账号',
    priceCents: 2600,
    outstandingCents: 0,
    paidCents: 2600,
    cancelled: false,
    completed: false,
    deadlineDate: null,
    currentPeriodEnd: '2026-12-27',
    currentServiceCount: null,
    createdAt: Date.UTC(2026, 9, 1),
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    ...patch,
  };
}

describe('剩余到期天数文案', () => {
  it('按日期差给出「剩 N 天」', () => {
    expect(expiryOf('2026-10-29', '2026-12-27').label).toBe('剩 59 天');
    expect(expiryOf('2026-10-29', '2026-12-27').daysLeft).toBe(59);
    expect(expiryOf('2026-12-26', '2026-12-27').label).toBe('剩 1 天');
  });

  it('结束日当天写「今天到期」，过期后写「已过期 N 天」', () => {
    expect(expiryOf('2026-12-27', '2026-12-27')).toMatchObject({ daysLeft: 0, label: '今天到期' });
    expect(expiryOf('2026-12-30', '2026-12-27').label).toBe('已过期 3 天');
    expect(expiryOf('2026-12-30', '2026-12-27').daysLeft).toBe(-3);
  });

  it('临期（含当天）标黄，已过期标红，其余正常', () => {
    expect(expiryOf('2026-12-20', '2026-12-27').tone).toBe('normal');
    expect(expiryOf('2026-10-29', '2026-12-27').tone).toBe('normal');
    expect(expiryOf(`2026-12-${27 - EXPIRY_WARN_DAYS}`, '2026-12-27').tone).toBe('warn');
    expect(expiryOf('2026-12-27', '2026-12-27').tone).toBe('warn');
    expect(expiryOf('2026-12-28', '2026-12-27').tone).toBe('danger');
  });

  it('文案配色类只给临期/过期上色', () => {
    expect(expiryToneClass('normal')).toBe('');
    expect(expiryToneClass('warn')).toBe('text-warn');
    expect(expiryToneClass('danger')).toBe('text-danger');
  });

  it('跨月跨年与闰日按日历天数计算', () => {
    expect(expiryOf('2026-12-31', '2027-01-01').label).toBe('剩 1 天');
    expect(expiryOf('2024-02-28', '2024-03-01').label).toBe('剩 2 天');
    expect(expiryOf('2026-01-01', '2025-12-31').label).toBe('已过期 1 天');
  });
});

describe('订单行剩余天数（按订单自己的游戏日）', () => {
  it('时区内的“今天”取自游戏日：刷新时间前仍算前一天', () => {
    // 上海 2026-12-26 02:00（刷新 05:00 之前 → 游戏日 12-25）。
    const early = Date.UTC(2026, 11, 25, 18, 0);
    expect(orderExpiryBadge(order(), early)?.label).toBe('剩 2 天');
    // 上海 2026-12-26 06:00（已刷新 → 游戏日 12-26）。
    const afterRefresh = Date.UTC(2026, 11, 25, 22, 0);
    expect(orderExpiryBadge(order(), afterRefresh)?.label).toBe('剩 1 天');
  });

  it('按次数、无结束日、已作废、已完成都不展示', () => {
    expect(orderExpiryBadge(order({ currentServiceCount: 10 }))).toBeNull();
    expect(orderExpiryBadge(order({ currentPeriodEnd: null }))).toBeNull();
    expect(orderExpiryBadge(order({ cancelled: true }))).toBeNull();
    expect(orderExpiryBadge(order({ completed: true }))).toBeNull();
  });

  it('过期订单给出红色提示', () => {
    const badge = orderExpiryBadge(order(), Date.UTC(2027, 0, 5, 4, 0));
    expect(badge).toMatchObject({ tone: 'danger', label: '已过期 9 天' });
  });
});

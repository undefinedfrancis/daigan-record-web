import { describe, expect, it } from 'vitest';
import { parseDecimal, formatDecimal, normalizeDecimal } from '../../src/domain/decimal';
import { formatMoney, parseMoney } from '../../src/domain/money';
import {
  addDays,
  diffDays,
  gameDateAt,
  isoWeekday,
  localDateAt,
  monthRange,
} from '../../src/domain/gameCalendar';
import { completedRounds, slotFor } from '../../src/domain/occurrences';
import { receivablesOf, ledgerFor } from '../../src/domain/ledger';
import type {
  HostingPeriodRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
} from '../../src/contracts/tables';
import { emptyDataSet } from '../../src/backup/catalog';

describe('金额', () => {
  it('0.10 + 0.20 精确得到 30 分', () => {
    expect(parseMoney('0.10') + parseMoney('0.20')).toBe(30);
    expect(formatMoney(30)).toBe('0.30');
  });

  it('拒绝三位小数与越界金额', () => {
    expect(() => parseMoney('1.234')).toThrow();
    expect(() => parseMoney('100000000.00')).toThrow();
    expect(() => parseMoney('0')).toThrow();
  });
});

describe('精确十进制', () => {
  it('保留输入精度', () => {
    expect(normalizeDecimal('0.10')).toBe('0.1');
    expect(formatDecimal(parseDecimal('12.345'))).toBe('12.345');
    expect(() => parseDecimal('1.2345')).toThrow();
  });
});

describe('游戏日历', () => {
  it('刷新前归属前一天', () => {
    const epoch = Date.UTC(2026, 0, 2, 20, 0); // 上海 2026-01-03 04:00
    expect(localDateAt(epoch, 'Asia/Shanghai')).toBe('2026-01-03');
    expect(gameDateAt(epoch, 'Asia/Shanghai', 300)).toBe('2026-01-02');
    expect(gameDateAt(epoch, 'Asia/Shanghai', 240)).toBe('2026-01-03');
    expect(gameDateAt(Date.UTC(2026, 0, 2, 21, 1), 'Asia/Shanghai', 300)).toBe('2026-01-03');
  });

  it('纽约夏令时切换不影响游戏日期计算', () => {
    const beforeDst = Date.UTC(2026, 2, 7, 9, 0); // 纽约 03-07 04:00 EST
    const afterDst = Date.UTC(2026, 2, 9, 8, 0); // 纽约 03-09 04:00 EDT
    expect(localDateAt(beforeDst, 'America/New_York')).toBe('2026-03-07');
    expect(gameDateAt(beforeDst, 'America/New_York', 5 * 60)).toBe('2026-03-06');
    expect(gameDateAt(afterDst, 'America/New_York', 5 * 60)).toBe('2026-03-08');
  });

  it('日期运算与星期', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(30);
    expect(isoWeekday('2026-10-19')).toBe(1);
  });

  it('月份窗口为半开区间', () => {
    const { start, end } = monthRange('2026-02', 'Asia/Shanghai');
    expect(localDateAt(start, 'Asia/Shanghai')).toBe('2026-02-01');
    expect(localDateAt(end - 1, 'Asia/Shanghai')).toBe('2026-02-28');
  });
});

const period: HostingPeriodRow = {
  id: 'p1',
  orderId: 'o1',
  periodIndex: 0,
  startDate: '2026-02-01',
  endDate: '2026-02-28',
  priceCents: 30000,
  gameZoneId: 'Asia/Shanghai',
  dailyRefreshMinutes: 300,
  weeklyRefreshDay: 1,
  weeklyRefreshMinutes: 300,
  createdAt: 0,
  renewalOperationId: null,
  serviceDays: null,
  serviceWeekdays: null,
  monthlyRefreshDays: null,
  serviceCount: null,
};

function occurrence(
  taskDefinitionId: string,
  gameDate: string,
  completedAt: number | null,
): TaskOccurrenceRow {
  return {
    id: `${taskDefinitionId}-${gameDate}`,
    taskDefinitionId,
    occurrenceKey: `C:${gameDate}`,
    gameDate,
    windowStart: null,
    windowEnd: null,
    completedAt,
    recordedAt: completedAt,
    backfilled: 0,
    completionBatchId: null,
    value: null,
    createdAt: 0,
  };
}

function task(overrides: Partial<TaskDefinitionRow>): TaskDefinitionRow {
  return {
    id: 't1',
    orderId: 'o1',
    periodId: 'p1',
    title: '任务',
    progressType: 'CHECKBOX',
    startValue: '0',
    targetValue: '1',
    currentValue: '0',
    unit: null,
    recurrence: 'DAILY',
    weekdays: null,
    everyNDays: null,
    sortOrder: 0,
    completedAt: null,
    completionBatchId: null,
    createdAt: 0,
    updatedAt: 0,
    monthDay: null,
    monthDays: null,
    retiredAt: null,
    activeFrom: null,
    activeUntil: null,
    numericMode: null,
    colorArgb: null,
    ...overrides,
  };
}

describe('发生槽', () => {
  it('每日任务在服务期限外不生成', () => {
    expect(slotFor(task({}), period, '2026-02-28')?.key).toBe('D:2026-02-28');
    expect(slotFor(task({}), period, '2026-03-01')).toBeNull();
    expect(slotFor(task({}), period, '2026-01-31')).toBeNull();
  });

  it('每月 31 日在 2 月跳过而不是挪到月末', () => {
    const monthly = task({ recurrence: 'MONTHLY', monthDay: 31 });
    expect(slotFor(monthly, period, '2026-02-28')).toBeNull();
    expect(slotFor(monthly, { ...period, endDate: '2026-03-31' }, '2026-03-31')?.key).toBe(
      'M:2026-03-31',
    );
  });

  it('每周任务同一窗口只有一条记录', () => {
    const weekly = task({ recurrence: 'WEEKLY' });
    const monday = slotFor(weekly, period, '2026-02-02');
    const thursday = slotFor(weekly, period, '2026-02-05');
    expect(monday?.key).toBe('W:2026-02-02');
    expect(thursday?.key).toBe('W:2026-02-02');
    expect(monday?.windowStart).toBe('2026-02-02');
    expect(monday?.windowEnd).toBe('2026-02-08');
  });

  it('配置每月刷新日后每周任务按刷新日窗口归组', () => {
    const monthlyPeriod = { ...period, monthlyRefreshDays: '5,20' };
    const weekly = task({ recurrence: 'WEEKLY' });
    const first = slotFor(weekly, monthlyPeriod, '2026-02-06');
    expect(first?.key).toBe('W:2026-02-05');
    expect(first?.windowStart).toBe('2026-02-05');
    expect(first?.windowEnd).toBe('2026-02-19');
    const second = slotFor(weekly, monthlyPeriod, '2026-02-20');
    expect(second?.key).toBe('W:2026-02-20');
    expect(second?.windowStart).toBe('2026-02-20');
    // 下一刷新日在 3 月，窗口末端被期次结束日裁剪。
    expect(second?.windowEnd).toBe('2026-02-28');
  });

  it('每月刷新日当月不存在时跳过该月', () => {
    const monthlyPeriod = { ...period, monthlyRefreshDays: '31', endDate: '2026-03-31' };
    const weekly = task({ recurrence: 'WEEKLY' });
    const slot = slotFor(weekly, monthlyPeriod, '2026-02-28');
    // 2 月没有 31 日：窗口从 1/31 起算，展示起点裁剪到期次开始日。
    expect(slot?.key).toBe('W:2026-01-31');
    expect(slot?.windowStart).toBe('2026-02-01');
    expect(slot?.windowEnd).toBe('2026-03-30');
  });

  it('每隔 N 天以期次开始日为锚点', () => {
    const every = task({ recurrence: 'EVERY_N_DAYS', everyNDays: 3 });
    expect(slotFor(every, period, '2026-02-01')?.key).toBe('E:2026-02-01');
    expect(slotFor(every, period, '2026-02-02')).toBeNull();
    expect(slotFor(every, period, '2026-02-04')?.key).toBe('E:2026-02-04');
  });
});

describe('财务口径', () => {
  const data = emptyDataSet();
  data.owners.push({
    id: 'ow1',
    number: 1,
    nickname: '老板',
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    archiveBatchId: null,
  });
  data.game_accounts.push({
    id: 'a1',
    ownerId: 'ow1',
    gameName: '游戏',
    server: '官服',
    uid: '1',
    loginAccount: 'x',
    loginMethod: 'PASSWORD',
    password: 'p',
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    archiveBatchId: null,
    defaultTemplateId: null,
    loginDevice: null,
    resourceNotes: null,
    categoryId: null,
  });
  data.orders.push({
    id: 'o1',
    accountId: 'a1',
    type: 'HOSTING',
    title: '托管',
    priceCents: null,
    paymentMode: 'INSTALLMENTS',
    deadlineDate: null,
    notes: null,
    gameZoneId: 'Asia/Shanghai',
    dailyRefreshMinutes: 300,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: Date.UTC(2026, 1, 1, 4),
    updatedAt: 0,
    completedAt: null,
    sourceTemplateId: null,
    sourceTemplateName: null,
    sourceTemplateVersion: null,
    cancelledAt: null,
    archivedAt: null,
    monthlyRefreshDays: null,
    hostingMode: null,
    targetSessions: null,
    orderColor: null,
  });
  data.hosting_periods.push(period);
  data.receipts.push({
    id: 'r1',
    operationId: 'op1',
    orderId: 'o1',
    periodId: 'p1',
    amountCents: 10000,
    receivedAt: Date.UTC(2026, 1, 5, 4),
    channel: 'WECHAT',
    note: null,
    status: 'ACTIVE',
    replacedByReceiptId: null,
    createdAt: 0,
  });
  data.receipts.push({
    id: 'r2',
    operationId: 'op2',
    orderId: 'o1',
    periodId: 'p1',
    amountCents: 5000,
    receivedAt: Date.UTC(2026, 1, 6, 4),
    channel: 'CASH',
    note: null,
    status: 'VOIDED',
    replacedByReceiptId: null,
    createdAt: 0,
  });

  it('只有 ACTIVE 收款计入实收，作废退出待收', () => {
    const receivables = receivablesOf(data);
    expect(receivables).toHaveLength(1);
    expect(receivables[0].paidCents).toBe(10000);
    expect(receivables[0].outstandingCents).toBe(20000);
  });

  it('作废订单退出待收', () => {
    const cancelled = emptyDataSet();
    Object.assign(cancelled, data);
    cancelled.orders = [{ ...data.orders[0], cancelledAt: 1 }];
    expect(receivablesOf(cancelled)).toHaveLength(0);
  });

  it('报表按月汇总实收并保留全时段欠款', () => {
    const summary = ledgerFor(data, { month: '2026-02', zoneId: 'Asia/Shanghai' });
    expect(summary.receivedCents).toBe(10000);
    expect(summary.outstandingCents).toBe(20000);
    expect(summary.orderCount).toBe(1);
  });
});

describe('任务生效起止日期', () => {
  it('只在 [生效起, 生效止] 内产生打卡槽', () => {
    const ranged = task({ activeFrom: '2026-02-03', activeUntil: '2026-02-05' });
    expect(slotFor(ranged, period, '2026-02-02')).toBeNull();
    expect(slotFor(ranged, period, '2026-02-03')?.key).toBe('D:2026-02-03');
    expect(slotFor(ranged, period, '2026-02-05')?.key).toBe('D:2026-02-05');
    expect(slotFor(ranged, period, '2026-02-06')).toBeNull();
  });

  it('缺省生效日期随期次全程执行', () => {
    const plain = task({});
    expect(slotFor(plain, period, '2026-02-01')).not.toBeNull();
    expect(slotFor(plain, period, '2026-02-28')).not.toBeNull();
    expect(slotFor(plain, period, '2026-03-01')).toBeNull();
  });
});

describe('按次数服务（整轮打卡累计）', () => {
  const countPeriod: HostingPeriodRow = {
    ...period,
    startDate: '2026-02-10',
    endDate: '2026-02-10',
    serviceCount: 3,
  };

  it('不排程周期：每个游戏日全部任务都产生打卡槽', () => {
    const weekly = task({ recurrence: 'SELECTED_WEEKDAYS', weekdays: '1' });
    expect(slotFor(weekly, countPeriod, '2026-02-11')?.key).toBe('C:2026-02-11');
    expect(slotFor(weekly, countPeriod, '2026-03-01')?.key).toBe('C:2026-03-01');
    // 任务生效日期仍然过滤。
    const ranged = task({ recurrence: 'DAILY', activeFrom: '2026-02-12' });
    expect(slotFor(ranged, countPeriod, '2026-02-11')).toBeNull();
    expect(slotFor(ranged, countPeriod, '2026-02-12')?.key).toBe('C:2026-02-12');
  });

  it('一个游戏日把应做任务全部打卡完成算 1 次，缺一不计', () => {
    const t1 = task({ id: 'c1' });
    const t2 = task({ id: 'c2' });
    const rows = [
      occurrence('c1', '2026-02-10', 1),
      occurrence('c2', '2026-02-10', 1),
      occurrence('c1', '2026-02-11', 1),
      occurrence('c2', '2026-02-11', null),
    ];
    expect(completedRounds([t1, t2], countPeriod, rows)).toBe(1);
  });

  it('生效日期外的任务不计入整轮判定', () => {
    const t1 = task({ id: 'c1' });
    const t2 = task({ id: 'c2', activeFrom: '2026-03-01' });
    const rows = [occurrence('c1', '2026-02-10', 1)];
    expect(completedRounds([t1, t2], countPeriod, rows)).toBe(1);
  });
});

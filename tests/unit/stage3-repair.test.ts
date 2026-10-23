import { describe, expect, it } from 'vitest';
import type {
  HostingPeriodRow,
  TaskDefinitionRow,
  TaskProgressEventRow,
} from '../../src/contracts/tables';
import { countPeriodServiceStart } from '../../src/domain/countSessions';
import { dueTasksOn } from '../../src/domain/derivedState';
import { validateProgressEvents, type EventChainContext } from '../../src/domain/progressEvents';

/**
 * 阶段 3 修复（F1/F2）在网页侧的对应规则。
 *
 * 这两条规则是跨端契约的一部分：安卓在同一份数据上写出同日续期的合法进度，网页在
 * 恢复校验/重建时必须给出同样的判定，否则一端能存、另一端报错。
 */

const SHANGHAI = { gameZoneId: 'Asia/Shanghai', dailyRefreshMinutes: 240 };

/** 2026-10-17 10:00 上海 = 游戏日 2026-10-17。 */
const day1TenAm = Date.UTC(2026, 9, 17, 2, 0);

function period(overrides: Partial<HostingPeriodRow> = {}): HostingPeriodRow {
  return {
    id: 'per-1',
    orderId: 'ord-1',
    periodIndex: 1,
    startDate: '2026-10-18',
    endDate: '2026-10-18',
    priceCents: 5000,
    gameZoneId: SHANGHAI.gameZoneId,
    dailyRefreshMinutes: SHANGHAI.dailyRefreshMinutes,
    weeklyRefreshDay: 1,
    weeklyRefreshMinutes: 300,
    createdAt: day1TenAm,
    renewalOperationId: 'op-renew-1',
    serviceDays: null,
    serviceWeekdays: null,
    monthlyRefreshDays: null,
    serviceCount: 2,
    ...overrides,
  };
}

function task(overrides: Partial<TaskDefinitionRow> = {}): TaskDefinitionRow {
  return {
    id: 'task-1',
    orderId: 'ord-1',
    periodId: 'per-1',
    title: '累计抽数',
    progressType: 'NUMERIC',
    startValue: '0',
    targetValue: '100',
    currentValue: '0',
    unit: '抽',
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
    numericMode: 'CUMULATIVE',
    colorArgb: null,
    ...overrides,
  };
}

function event(overrides: Partial<TaskProgressEventRow> = {}): TaskProgressEventRow {
  return {
    id: 'evt-1',
    taskDefinitionId: 'task-1',
    operationId: 'op-1',
    kind: 'SUBMIT',
    scopeType: 'SESSION',
    scopePeriodId: null,
    scopeSessionId: 'ses-1',
    gameDate: '2026-10-17',
    totalValue: '40',
    sequence: 1,
    correctsEventId: null,
    recordedAt: day1TenAm,
    createdAt: day1TenAm,
    ...overrides,
  };
}

function chainContext(periodRow: HostingPeriodRow): EventChainContext {
  return {
    taskById: new Map([['task-1', task({ periodId: periodRow.id })]]),
    orderById: new Map([['ord-1', { type: 'HOSTING', hostingMode: 'COUNT_BASED' }]]),
    periodById: new Map([
      [
        periodRow.id,
        {
          orderId: periodRow.orderId,
          serviceCount: periodRow.serviceCount,
          startDate: periodRow.startDate,
          endDate: periodRow.endDate,
          serviceStart: countPeriodServiceStart(periodRow),
        },
      ],
    ]),
    sessionById: new Map([['ses-1', { orderId: 'ord-1', periodId: periodRow.id }]]),
  };
}

describe('F1 计次期次的实际服务起点', () => {
  it('同日续期把锚点推到下一天，但服务起点仍是创建当天', () => {
    const renewed = period();
    expect(renewed.startDate).toBe('2026-10-18');
    expect(countPeriodServiceStart(renewed)).toBe('2026-10-17');
  });

  it('按日期期次与不可用的 createdAt 都退回 startDate', () => {
    expect(countPeriodServiceStart(period({ serviceCount: null, startDate: '2026-10-01' }))).toBe(
      '2026-10-01',
    );
    expect(countPeriodServiceStart(period({ createdAt: 0 }))).toBe('2026-10-18');
  });

  it('刷新前创建（03:30）仍归属前一个游戏日', () => {
    const beforeRefresh = period({
      startDate: '2026-10-18',
      createdAt: Date.UTC(2026, 9, 17, 19, 30), // 上海 10-18 03:30 = 游戏日 10-17
    });
    expect(countPeriodServiceStart(beforeRefresh)).toBe('2026-10-17');
  });

  it('锚点更晚时，同日写出的 SESSION 事件通过恢复校验', () => {
    const context = chainContext(period());
    expect(validateProgressEvents([event()], context)).toEqual([]);
  });

  it('协议之前的游戏日仍然被拒绝', () => {
    const context = chainContext(period());
    const violations = validateProgressEvents([event({ gameDate: '2026-10-16' })], context);
    expect(violations.map((violation) => violation.code)).toContain(
      'EVENT_DATE_OUT_OF_SERVICE_RANGE',
    );
  });

  it('按日期期次仍以上下界判断', () => {
    const dated = period({ serviceCount: null, startDate: '2026-10-01', endDate: '2026-10-10' });
    const context: EventChainContext = {
      ...chainContext(dated),
      orderById: new Map([['ord-1', { type: 'HOSTING', hostingMode: 'DATE_RANGE' }]]),
    };
    const scoped = event({
      scopeType: 'PERIOD',
      scopePeriodId: dated.id,
      scopeSessionId: null,
      gameDate: '2026-10-11',
    });
    expect(validateProgressEvents([scoped], context).map((v) => v.code)).toContain(
      'EVENT_DATE_OUT_OF_SERVICE_RANGE',
    );
  });
});

describe('F2 历史应做集与退休日边界', () => {
  const p = period({ id: 'per-1', startDate: '2026-10-17', endDate: '2026-10-17' });

  it('退休日之后才不再应做：轮到退休当天仍然算', () => {
    const retiredOnDay2 = task({ retiredAt: Date.UTC(2026, 9, 18, 2, 0) });
    expect(dueTasksOn([retiredOnDay2], p, '2026-10-17').map((t) => t.id)).toEqual(['task-1']);
    expect(dueTasksOn([retiredOnDay2], p, '2026-10-18').map((t) => t.id)).toEqual(['task-1']);
    expect(dueTasksOn([retiredOnDay2], p, '2026-10-19')).toEqual([]);
  });

  it('退休在轮次之前则不计入该轮次', () => {
    const retiredOnDay1 = task({ retiredAt: Date.UTC(2026, 9, 17, 2, 0) });
    expect(dueTasksOn([retiredOnDay1], p, '2026-10-18')).toEqual([]);
  });

  it('普通一次性任务不属于任何轮次，累计一次性任务仍然应做', () => {
    const oneShot = task({ id: 'task-checkbox', progressType: 'CHECKBOX', numericMode: null, recurrence: 'ONE_TIME' });
    const cumulativeOneShot = task({ id: 'task-cumulative', numericMode: 'CUMULATIVE', recurrence: 'ONE_TIME' });
    expect(dueTasksOn([oneShot, cumulativeOneShot], p, '2026-10-17').map((t) => t.id)).toEqual([
      'task-cumulative',
    ]);
  });

  it('activeFrom/activeUntil 决定该日是否应做', () => {
    const later = task({ id: 'task-later', activeFrom: '2026-10-18' });
    const expired = task({ id: 'task-expired', activeUntil: '2026-10-17' });
    expect(dueTasksOn([later, expired], p, '2026-10-17').map((t) => t.id)).toEqual(['task-expired']);
    expect(dueTasksOn([later, expired], p, '2026-10-18').map((t) => t.id)).toEqual(['task-later']);
  });
});

import type {
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  TaskDefinitionRow,
} from '../contracts/tables';
import { lastScopeOf, type ActiveCountState } from './countSessions';
import type { ProgressScope } from './progressEvents';
import { calendarGameDate, scopeCalendar, type ScopeCalendar } from './scopeCalendar';

/**
 * 累计任务的**当前 scope + 权威日历 + 归属日**。
 *
 * 这是唯一一套 scope/日期选择规则，读取投影（订单详情、今日列表）与提交按钮都消费它：
 * - TASK（短期单）→ 订单日历；
 * - PERIOD → 任务自己的期次快照；
 * - SESSION → 该轮次所属期次的快照；
 * - 等待中的轮次 → **活动状态给出的期次**（不是列表里第一个/最后一个期次），
 *   且只读：绝不为了算日期而建轮次行。
 *
 * 命令层 `assertScopeForWrite` 用同一套快照判定"今天"，因此这里算出的日期必然被接受
 * （R5：UI 曾固定用订单日历，与 PERIOD/SESSION 的期次快照产生不同游戏日）。
 */
export type CumulativeActiveState = ActiveCountState | { kind: 'NOT_COUNT_BASED' };

export type CumulativeScopeState =
  | 'TASK'
  | 'PERIOD'
  | 'ACTIVE_SESSION'
  | 'AWAITING_SESSION'
  | 'LAST_SESSION'
  | 'NO_SCOPE';

export interface CumulativeScopeDescriptor {
  state: CumulativeScopeState;
  /** null = 待建轮次（写入时在同一事务内 ensure）或完全没有范围。 */
  scope: ProgressScope | null;
  /** 该 scope 的日历快照；提交时按它在提交边界现算归属日。 */
  calendar: ScopeCalendar;
  /** 读时快照：该日历下的"今天"。 */
  gameDate: string;
  /** 人类可读范围标签（整单目标 / 第 N 期 / 第 N 次打卡）。 */
  label: string;
  /** 该轮次是否已完成（ACTIVE_SESSION / LAST_SESSION 才有值）。 */
  sessionCompletedAt: number | null;
  /** 下一次写入会分配的轮次号（有待建轮次时）。 */
  sessionIndex: number | null;
}

export function cumulativeScopeDescriptor(input: {
  task: TaskDefinitionRow;
  order: OrderRow;
  active: CumulativeActiveState;
  periods: HostingPeriodRow[];
  sessions: HostingSessionRow[];
  nowMs: number;
}): CumulativeScopeDescriptor {
  const { task, order, active, periods, sessions, nowMs } = input;

  const snapshot = (periodId: string | null) => {
    const period = periodId === null ? null : (periods.find((row) => row.id === periodId) ?? null);
    const calendar = scopeCalendar(period, order);
    return { calendar, gameDate: calendarGameDate(calendar, nowMs) };
  };

  if (order.type === 'SHORT_TASK') {
    return {
      state: 'TASK',
      scope: { kind: 'TASK' },
      ...snapshot(null),
      label: '整单目标',
      sessionCompletedAt: null,
      sessionIndex: null,
    };
  }

  const countPeriods = periods.filter((period) => period.serviceCount !== null);
  if (countPeriods.length === 0) {
    return {
      state: 'PERIOD',
      scope: { kind: 'PERIOD', periodId: task.periodId ?? '' },
      ...snapshot(task.periodId),
      label: '本期目标',
      sessionCompletedAt: null,
      sessionIndex: null,
    };
  }

  const activePeriodId = 'periodId' in active ? active.periodId : null;
  const samePeriod = activePeriodId !== null && activePeriodId === task.periodId;

  if (active.kind === 'ACTIVE_SESSION' && samePeriod) {
    const session = sessions.find((row) => row.id === active.sessionId) ?? null;
    return {
      state: 'ACTIVE_SESSION',
      scope: { kind: 'SESSION', sessionId: active.sessionId },
      ...snapshot(active.periodId),
      label: `第 ${active.sessionIndex} 次打卡`,
      sessionCompletedAt: session?.completedAt ?? null,
      sessionIndex: active.sessionIndex,
    };
  }

  if (active.kind === 'AWAITING_SESSION_ROW' && samePeriod) {
    return {
      state: 'AWAITING_SESSION',
      scope: null,
      // 归属日按**活动期次**的快照算；轮次行尚未创建，读操作也不创建。
      ...snapshot(active.periodId),
      label: `第 ${active.sessionIndex} 次打卡（待开始）`,
      sessionCompletedAt: null,
      sessionIndex: active.sessionIndex,
    };
  }

  const last = task.periodId === null ? null : lastScopeOf(periods, sessions, task.periodId);
  if (last) {
    return {
      state: 'LAST_SESSION',
      scope: { kind: 'SESSION', sessionId: last.sessionId },
      ...snapshot(task.periodId),
      label: `第 ${last.sessionIndex} 次打卡`,
      sessionCompletedAt: last.completedAt,
      sessionIndex: last.sessionIndex,
    };
  }

  const awaitingIndex =
    active.kind === 'AWAITING_SESSION_ROW' || active.kind === 'ACTIVE_SESSION'
      ? active.sessionIndex
      : null;
  return {
    state: 'NO_SCOPE',
    scope: null,
    ...snapshot(task.periodId),
    label: awaitingIndex === null ? '尚无轮次' : `第 ${awaitingIndex} 次打卡（待开始）`,
    sessionCompletedAt: null,
    sessionIndex: awaitingIndex,
  };
}

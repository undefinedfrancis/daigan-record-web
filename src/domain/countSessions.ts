import type {
  HostingPeriodRow,
  HostingSessionRow,
  TaskDefinitionRow,
  TaskProgressEventRow,
} from '../contracts/tables';
import { LIMITS } from '../contracts/tables';
import { gameDateAt } from './gameCalendar';
import { reachedTarget, resolveScopeTotal, type ProgressScope } from './progressEvents';

const MAX_SESSION_INDEX = LIMITS.maxSessionIndex;

/**
 * 计次期次的实际服务起点（契约 `conventions.countPeriods.serviceStart`，F1）。
 *
 * `startDate`/`endDate` 只是为了满足 `(orderId, startDate)` 唯一约束的内部锚点：同日续期
 * 会把它推到下一天，因此它**不是**服务下界。协议真正生效的游戏日是期次创建时刻
 * (`createdAt`) 按该期次刷新快照换算的游戏日；它只会早于或等于锚点，所以既不会因为存储
 * 约束推迟服务，也不会放过协议之前的历史。`createdAt` 不可用时退回锚点。
 *
 * Android 的对应实现是 `HostingPeriod.serviceStartDate`；两端必须一致，否则同一天续期的
 * 合法进度会在另一端被判成 `EVENT_DATE_OUT_OF_SERVICE_RANGE`。
 */
export function countPeriodServiceStart(period: {
  serviceCount: number | null;
  startDate: string;
  createdAt: number;
  gameZoneId: string;
  dailyRefreshMinutes: number;
}): string {
  if (period.serviceCount === null) return period.startDate;
  if (!Number.isFinite(period.createdAt) || period.createdAt <= 0) return period.startDate;
  const created = gameDateAt(period.createdAt, period.gameZoneId, period.dailyRefreshMinutes);
  return created < period.startDate ? created : period.startDate;
}

export type ActiveSessionChoice =
  | { kind: 'REUSE_EXISTING'; sessionIndex: number }
  | { kind: 'ALLOCATE_NEW'; sessionIndex: number }
  | { kind: 'PERIOD_FULL' }
  | { kind: 'INDEX_SPACE_EXHAUSTED' };

/** 四种互不重叠的活动状态；"没有活动范围"不再与"待建行"共用一个 null。 */
export type ActiveCountState =
  | { kind: 'ACTIVE_SESSION'; periodId: string; sessionIndex: number; sessionId: string }
  | { kind: 'AWAITING_SESSION_ROW'; periodId: string; sessionIndex: number }
  | { kind: 'ALL_PERIODS_COMPLETE' }
  | { kind: 'INDEX_SPACE_EXHAUSTED'; periodId: string };

export interface LastScope {
  sessionId: string;
  sessionIndex: number;
  completedAt: number | null;
}

export type TaskScopeCache =
  | {
      state: 'ACTIVE_SESSION';
      periodId: string;
      sessionId: string;
      sessionIndex: number;
      currentValue: string;
      completedAt: number | null;
      reachedTarget: boolean;
    }
  | {
      state: 'AWAITING_SESSION_ROW';
      periodId: string;
      sessionIndex: number;
      currentValue: string;
      completedAt: null;
      reachedTarget: boolean;
    }
  | {
      state: 'TASK_PERIOD_TERMINAL' | 'ORDER_TERMINAL';
      periodId: string;
      lastScope: LastScope | null;
      currentValue: string;
      completedAt: number | null;
      reachedTarget: boolean;
    }
  | {
      state: 'INDEX_SPACE_EXHAUSTED';
      periodId: string;
      lastScope: LastScope | null;
      currentValue: string;
      completedAt: number | null;
      reachedTarget: boolean;
      error: 'SESSION_INDEX_EXHAUSTED';
    };

function completedCount(sessions: HostingSessionRow[]): number {
  const indices = new Set<number>();
  for (const session of sessions) {
    if (session.completedAt !== null) indices.add(session.sessionIndex);
  }
  return indices.size;
}

/**
 * 分配新轮次号：**全订单** `max(sessionIndex) + 1`（F1 / D-26）。
 *
 * 只接受整单 session 列表。任何"传入期次内列表再取最大值"的实现都是契约违背：
 * 空期次会重新分配 1，与订单内已用号冲突。
 */
export function nextOrderGlobalSessionIndex(orderSessions: HostingSessionRow[]): number | null {
  const highest = orderSessions.reduce((max, session) => Math.max(max, session.sessionIndex), 0);
  const next = highest + 1;
  if (highest >= MAX_SESSION_INDEX || next > MAX_SESSION_INDEX) return null;
  return next;
}

/**
 * 选择 vs 分配分离（F1）。
 *
 * 语义顺序：①该期有不完整轮次 → 复用最小的订单全局号（先于判满）；
 * ②否则 `completed < serviceCount` → 分配全局新号；③否则 `PERIOD_FULL`；
 * ④全局已达 2147483647 → `INDEX_SPACE_EXHAUSTED`（不重编号）。
 */
export function selectActiveSession(
  orderSessions: HostingSessionRow[],
  periodId: string,
  periodServiceCount: number | null,
): ActiveSessionChoice {
  const periodSessions = orderSessions.filter((session) => session.periodId === periodId);
  const incomplete = periodSessions
    .filter((session) => session.completedAt === null)
    .map((session) => session.sessionIndex)
    .sort((left, right) => left - right);
  if (incomplete.length > 0) {
    return { kind: 'REUSE_EXISTING', sessionIndex: incomplete[0] };
  }
  if (periodServiceCount === null) return { kind: 'PERIOD_FULL' };
  if (completedCount(periodSessions) >= periodServiceCount) return { kind: 'PERIOD_FULL' };
  const next = nextOrderGlobalSessionIndex(orderSessions);
  if (next === null) return { kind: 'INDEX_SPACE_EXHAUSTED' };
  return { kind: 'ALLOCATE_NEW', sessionIndex: next };
}

function countPeriodsOf(periods: HostingPeriodRow[]): HostingPeriodRow[] {
  return periods
    .filter((period) => period.serviceCount !== null)
    .sort((left, right) =>
      left.periodIndex === right.periodIndex
        ? left.id.localeCompare(right.id)
        : left.periodIndex - right.periodIndex,
    );
}

/**
 * 派生活动轮次状态（G1）。返回密封四态，调用方无需再解释 null。
 */
export function resolveActiveCountSession(
  orderId: string,
  periods: HostingPeriodRow[],
  sessions: HostingSessionRow[],
): ActiveCountState {
  const orderSessions = sessions.filter((session) => session.orderId === orderId);
  const orderPeriods = countPeriodsOf(periods.filter((period) => period.orderId === orderId));
  if (orderPeriods.length === 0) return { kind: 'ALL_PERIODS_COMPLETE' };
  for (const period of orderPeriods) {
    const choice = selectActiveSession(orderSessions, period.id, period.serviceCount);
    if (choice.kind === 'INDEX_SPACE_EXHAUSTED') {
      return { kind: 'INDEX_SPACE_EXHAUSTED', periodId: period.id };
    }
    if (choice.kind === 'PERIOD_FULL') continue;
    if (choice.kind === 'REUSE_EXISTING') {
      const session = orderSessions.find(
        (row) => row.periodId === period.id && row.sessionIndex === choice.sessionIndex,
      );
      if (session) {
        return {
          kind: 'ACTIVE_SESSION',
          periodId: period.id,
          sessionIndex: session.sessionIndex,
          sessionId: session.id,
        };
      }
    }
    // ALLOCATE_NEW（以及理论上找不到行的 REUSE）：行尚未创建，绝不为了填缓存而建行。
    return { kind: 'AWAITING_SESSION_ROW', periodId: period.id, sessionIndex: choice.sessionIndex };
  }
  return { kind: 'ALL_PERIODS_COMPLETE' };
}

/** 该期次的冻结范围：最大 `(periodIndex, sessionIndex)`，绝不指向别的期次。 */
export function lastScopeOf(
  periods: HostingPeriodRow[],
  sessions: HostingSessionRow[],
  periodId: string,
): LastScope | null {
  const period = periods.find((row) => row.id === periodId);
  if (!period) return null;
  const rows = sessions
    .filter((session) => session.orderId === period.orderId && session.periodId === periodId)
    .sort((left, right) => right.sessionIndex - left.sessionIndex);
  const last = rows[0];
  if (!last) return null;
  return { sessionId: last.id, sessionIndex: last.sessionIndex, completedAt: last.completedAt };
}

/**
 * 任务缓存（G1 五种状态、F3）。
 *
 * 缓存**只镜像派生状态**，不代表"正在看哪一轮"。`AwaitingSessionRow` 取 `startValue`
 * 且 `completedAt` 为 null：绝不继承上一轮的总值与完成时刻，也不为了填缓存建行或写事件。
 */
export function taskScopeCache(
  task: TaskDefinitionRow,
  state: ActiveCountState,
  periods: HostingPeriodRow[],
  sessions: HostingSessionRow[],
  events: TaskProgressEventRow[],
): TaskScopeCache {
  const startValue = task.startValue;
  const targetValue = task.targetValue;

  if (state.kind === 'ALL_PERIODS_COMPLETE') {
    const periodId = task.periodId ?? '';
    const lastScope = periodId ? lastScopeOf(periods, sessions, periodId) : null;
    const scope: ProgressScope = lastScope
      ? { kind: 'SESSION', sessionId: lastScope.sessionId }
      : { kind: 'TASK' };
    const currentValue = resolveScopeTotal(events, task.id, scope, startValue);
    return {
      state: 'ORDER_TERMINAL',
      periodId,
      lastScope,
      currentValue,
      completedAt: lastScope?.completedAt ?? null,
      reachedTarget: reachedTarget(currentValue, targetValue),
    };
  }

  if (state.kind === 'INDEX_SPACE_EXHAUSTED') {
    const lastScope = lastScopeOf(periods, sessions, state.periodId);
    const scope: ProgressScope = lastScope
      ? { kind: 'SESSION', sessionId: lastScope.sessionId }
      : { kind: 'PERIOD', periodId: state.periodId };
    const currentValue = resolveScopeTotal(events, task.id, scope, startValue);
    return {
      state: 'INDEX_SPACE_EXHAUSTED',
      periodId: state.periodId,
      lastScope,
      currentValue,
      completedAt: lastScope?.completedAt ?? null,
      reachedTarget: reachedTarget(currentValue, targetValue),
      error: 'SESSION_INDEX_EXHAUSTED',
    };
  }

  // 任务所属期次不是活动期次 → 冻结在**该任务自己期次**的最后范围。
  if (task.periodId !== null && task.periodId !== state.periodId) {
    const lastScope = lastScopeOf(periods, sessions, task.periodId);
    const scope: ProgressScope = lastScope
      ? { kind: 'SESSION', sessionId: lastScope.sessionId }
      : { kind: 'PERIOD', periodId: task.periodId };
    const currentValue = resolveScopeTotal(events, task.id, scope, startValue);
    return {
      state: 'TASK_PERIOD_TERMINAL',
      periodId: task.periodId,
      lastScope,
      currentValue,
      completedAt: lastScope?.completedAt ?? null,
      reachedTarget: reachedTarget(currentValue, targetValue),
    };
  }

  if (state.kind === 'AWAITING_SESSION_ROW') {
    return {
      state: 'AWAITING_SESSION_ROW',
      periodId: state.periodId,
      sessionIndex: state.sessionIndex,
      currentValue: startValue,
      completedAt: null,
      reachedTarget: reachedTarget(startValue, targetValue),
    };
  }

  const session = sessions.find((row) => row.id === state.sessionId);
  const currentValue = resolveScopeTotal(
    events,
    task.id,
    { kind: 'SESSION', sessionId: state.sessionId },
    startValue,
  );
  return {
    state: 'ACTIVE_SESSION',
    periodId: state.periodId,
    sessionId: state.sessionId,
    sessionIndex: state.sessionIndex,
    currentValue,
    completedAt: session?.completedAt ?? null,
    reachedTarget: reachedTarget(currentValue, targetValue),
  };
}

/**
 * 轮次完成判定：应做集非空 + 每个应做任务在该轮次内有归属观测且达标。
 *
 * 空轮次**不得**自动完成：`startValue` 已达目标也只是 `reachedTarget`，
 * 用户仍需写一次显式观测。
 */
export function sessionCompletedAt(
  dueTaskIds: string[],
  completedTaskIds: Set<string>,
): null | { completed: boolean } {
  if (dueTaskIds.length === 0) return { completed: false };
  return { completed: dueTaskIds.every((id) => completedTaskIds.has(id)) };
}

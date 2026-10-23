import type {
  HostingPeriodRow,
  HostingSessionRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
  TaskProgressEventRow,
} from '../contracts/tables';
import { countPeriodServiceStart } from './countSessions';
import { dueTasksOn, isCumulativeTask } from './derivedState';
import { gameDateAt } from './gameCalendar';
import {
  hasObservationInScope,
  reachedTarget,
  resolveEffectiveEvent,
  resolveScopeTotal,
} from './progressEvents';

/**
 * 打卡轮次（计次托管）的读取口径。
 *
 * 轮次身份是 `(orderId, sessionIndex)`，occurrence key 为 `N:<sessionIndex>`；同一游戏日
 * 可以有两轮，日期不是身份（契约 F5）。本模块只做**纯读**：不建行、不写事件、不改缓存。
 */

export const ROUND_PREFIX = 'N:';

export function roundKey(sessionIndex: number): string {
  return `${ROUND_PREFIX}${sessionIndex}`;
}

export function roundIndexFromKey(key: string | null | undefined): number | null {
  if (!key || !key.startsWith(ROUND_PREFIX)) return null;
  const raw = key.slice(ROUND_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function sessionsOfOrder(
  sessions: HostingSessionRow[],
  orderId: string,
): HostingSessionRow[] {
  return sessions
    .filter((session) => session.orderId === orderId)
    .sort((left, right) => left.sessionIndex - right.sessionIndex);
}

export function occurrencesOfRound(
  occurrences: TaskOccurrenceRow[],
  sessionIndex: number,
): TaskOccurrenceRow[] {
  const key = roundKey(sessionIndex);
  return occurrences.filter((row) => row.occurrenceKey === key);
}

/**
 * 轮次的归属游戏日：该轮 occurrence 与 SESSION 事件的**最早**游戏日。
 *
 * 一轮可能跨日完成（昨天开工、今天补完），归属日取最早证据，保证"历史应做集"
 * 以本轮开始那天为准，不会因为补完日期而改写历史责任。
 */
export function roundAttributedDate(input: {
  session: HostingSessionRow;
  occurrences: TaskOccurrenceRow[];
  events: TaskProgressEventRow[];
  fallback: string | null;
}): string | null {
  const dates: string[] = [];
  for (const row of occurrencesOfRound(input.occurrences, input.session.sessionIndex)) {
    dates.push(row.gameDate);
  }
  for (const event of input.events) {
    if (event.scopeType === 'SESSION' && event.scopeSessionId === input.session.id) {
      dates.push(event.gameDate);
    }
  }
  if (dates.length === 0) return input.fallback;
  return dates.sort()[0];
}

/**
 * 没有任何归属证据（occurrence / SESSION 事件）时的轮次归属日。
 *
 * 唯一允许的回退是**该轮次创建时刻在期次自己的刷新快照下的游戏日**：它是存储证据，
 * 与设备时钟无关，因此"今天"永远不会把一个历史轮次的责任漂移到当前日期
 * （R3-4：stable createdAt-based attribution）。`createdAt` 不可用时退到期次的服务
 * 起点，仍然不是"今天"。
 */
export function roundFallbackDate(
  session: HostingSessionRow,
  period: HostingPeriodRow,
): string {
  if (Number.isFinite(session.createdAt) && session.createdAt > 0) {
    return gameDateAt(session.createdAt, period.gameZoneId, period.dailyRefreshMinutes);
  }
  return countPeriodServiceStart(period);
}

export interface RoundTaskState {
  taskId: string;
  /** 该轮内是否已满足（普通任务 = 已完成；累计任务 = 有观测且达标）。 */
  satisfied: boolean;
  /** 该轮内是否存在任何归属观测（累计任务区分"零观测"与"观测为起始值"）。 */
  observed: boolean;
  currentValue: string;
  reachedTarget: boolean;
  completedAt: number | null;
}

export function roundTaskState(
  task: TaskDefinitionRow,
  occurrence: TaskOccurrenceRow | null,
  events: TaskProgressEventRow[],
  sessionId: string,
): RoundTaskState {
  if (isCumulativeTask(task)) {
    const scope = { kind: 'SESSION' as const, sessionId };
    const currentValue = resolveScopeTotal(events, task.id, scope, task.startValue);
    const winner = resolveEffectiveEvent(events, task.id, scope);
    const observed = hasObservationInScope(events, task.id, scope);
    const reached = reachedTarget(currentValue, task.targetValue);
    return {
      taskId: task.id,
      satisfied: observed && reached,
      observed,
      currentValue,
      reachedTarget: reached,
      completedAt: winner !== null && winner.recordedAt > 0 ? winner.recordedAt : null,
    };
  }
  const completed = occurrence?.completedAt ?? null;
  const currentValue =
    task.progressType === 'NUMERIC'
      ? (occurrence?.value ?? task.startValue)
      : completed !== null
        ? '1'
        : '0';
  return {
    taskId: task.id,
    satisfied: completed !== null,
    observed: completed !== null,
    currentValue,
    reachedTarget: completed !== null,
    completedAt: completed,
  };
}

/** 该轮次在归属日的应做集（期次完整名册 + 归属日规则，F2）。 */
export function roundDueTasks(
  tasks: TaskDefinitionRow[],
  period: HostingPeriodRow,
  attributedDate: string,
): TaskDefinitionRow[] {
  return dueTasksOn(tasks, period, attributedDate);
}

export interface RoundProgress {
  session: HostingSessionRow;
  period: HostingPeriodRow;
  attributedDate: string | null;
  dueTasks: TaskDefinitionRow[];
  states: RoundTaskState[];
  completedTaskIds: string[];
  /** 应做集非空且全部满足（空轮次永不完成）。 */
  completed: boolean;
  /** 由存储证据导出的完成时刻（最晚的一条）。 */
  completedAt: number | null;
  missingTaskIds: string[];
}

/**
 * 一个轮次的完整读模型（今日、详情、日历共用）。
 *
 * 完成条件与恢复重建（`derivedState.sessionCompletionEvidence`）同一口径：
 * 应做集非空 + 每个应做任务在该轮次内有归属观测且达标。
 */
export function roundProgress(input: {
  session: HostingSessionRow;
  period: HostingPeriodRow;
  tasks: TaskDefinitionRow[];
  occurrences: TaskOccurrenceRow[];
  events: TaskProgressEventRow[];
  fallbackDate: string | null;
}): RoundProgress {
  const attributedDate = roundAttributedDate({
    session: input.session,
    occurrences: input.occurrences,
    events: input.events,
    fallback: input.fallbackDate,
  });
  const dueTasks =
    attributedDate === null ? [] : roundDueTasks(input.tasks, input.period, attributedDate);
  const roundOccurrences = occurrencesOfRound(input.occurrences, input.session.sessionIndex);
  const states = dueTasks.map((task) => {
    const occurrence =
      roundOccurrences.find((row) => row.taskDefinitionId === task.id) ?? null;
    return roundTaskState(task, occurrence, input.events, input.session.id);
  });
  const missingTaskIds = states.filter((state) => !state.satisfied).map((state) => state.taskId);
  const instants = states
    .map((state) => state.completedAt)
    .filter((value): value is number => value !== null);
  const completed = dueTasks.length > 0 && missingTaskIds.length === 0;
  return {
    session: input.session,
    period: input.period,
    attributedDate,
    dueTasks,
    states,
    completedTaskIds: states.filter((state) => state.satisfied).map((state) => state.taskId),
    completed,
    completedAt: completed && instants.length > 0 ? Math.max(...instants) : null,
    missingTaskIds,
  };
}

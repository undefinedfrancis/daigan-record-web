import type {
  BackupDataSet,
  HostingPeriodRow,
  HostingSessionRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
  TaskProgressEventRow,
} from '../contracts/tables';
import { gameDateAt } from './gameCalendar';
import { resolveActiveCountSession, taskScopeCache } from './countSessions';
import {
  hasObservationInScope,
  reachedTarget,
  resolveEffectiveEvent,
  resolveScopeTotal,
  type ProgressScope,
} from './progressEvents';

/**
 * 恢复期派生状态重建（S2-R3）。
 *
 * **权威 vs 派生**（contract `commands.progress.derivedState.authority`）：
 * - 累计进度：`task_progress_events` 是权威；
 * - 普通周期任务：occurrence 历史是权威；
 * - 派生的只有：`hosting_sessions.completedAt`、`task_definitions.currentValue`
 *   （累计任务的活动范围缓存）、`orders.completedAt` 中由轮次/任务推导出来的部分。
 *
 * 因此重建**只写派生值**：绝不新增/删除事件、不删除轮次行、不改 occurrence 的完成历史、
 * 不动附件/收款/更正/批次，也不改写普通任务的状态。
 *
 * 派生时刻一律由**存储证据**给出（该轮次内各应做任务的可观测完成时刻的最大值），
 * 绝不使用恢复设备的当前时间。
 */
export interface ReconstructionReport {
  /** 由证据重新判为完成、且完成时刻被写入的轮次数。 */
  sessionsCompleted: number;
  /** 之前标记完成、但应做集/证据不足而重新打开的轮次数。 */
  sessionsReopened: number;
  /** 完成时刻与证据不一致、被改成派生值的轮次数。 */
  sessionTimestampsCorrected: number;
  /** 累计任务缓存被刷新的任务数。 */
  taskCachesRefreshed: number;
  /** 累计任务的完成投影与派生结果不一致而被改正的任务数。 */
  taskCompletionsChanged: number;
  /** 订单完成标志与派生结果不一致而被改正的订单数。 */
  orderFlagsChanged: number;
  /** 不含时间戳歧义、只记录判定依据的说明。 */
  notes: string[];
}

/**
 * 某期次在某游戏日的"历史应做任务集"（尊重 activeFrom/activeUntil/retiredAt）。
 *
 * 与 Android `CountHosting.isDueInRound` 是**同一个纯规则**（契约 F2）：
 * - 传入的是期次的**完整**任务名单，绝不在历史判定前先按 `retiredAt` 过滤；
 * - 退休日当天仍应做，晚于退休日不再应做；
 * - 累计任务忽略重复触发日（UF-038），普通一次性任务不属于任何轮次。
 */
export function dueTasksOn(
  tasks: TaskDefinitionRow[],
  period: HostingPeriodRow,
  gameDate: string,
): TaskDefinitionRow[] {
  return tasks.filter((task) => {
    if (task.periodId !== period.id) return false;
    if (task.retiredAt !== null) {
      const retireDate = gameDateAt(task.retiredAt, period.gameZoneId, period.dailyRefreshMinutes);
      // 退休日当天仍可能已产生打卡行：算作应做，宁可判"不完整"也不虚判完成。
      if (gameDate > retireDate) return false;
    }
    if (task.activeFrom !== null && gameDate < task.activeFrom) return false;
    if (task.activeUntil !== null && gameDate > task.activeUntil) return false;
    // 累计任务的总值目标与重复触发日无关；只有普通一次性任务没有可重复的轮次。
    if (task.recurrence === 'ONE_TIME' && !isCumulativeTask(task)) return false;
    return true;
  });
}

export function isCumulativeTask(task: TaskDefinitionRow): boolean {
  return task.progressType === 'NUMERIC' && task.numericMode === 'CUMULATIVE';
}

export interface SessionEvidence {
  completedAt: number | null;
  /** 该轮次是否有任何归属观测（轮次完成的前提之一）。 */
  hasEvidence: boolean;
  missingTaskIds: string[];
  dueTaskIds: string[];
}

function eventsByTask(events: TaskProgressEventRow[]): Map<string, TaskProgressEventRow[]> {
  const map = new Map<string, TaskProgressEventRow[]>();
  for (const event of events) {
    const list = map.get(event.taskDefinitionId) ?? [];
    list.push(event);
    map.set(event.taskDefinitionId, list);
  }
  return map;
}

/**
 * 一个轮次的完成证据（S2-R3 / contract `derivedState.sessionCompletion`）。
 *
 * 完成条件：应做集非空 + 每个应做任务在该轮次内有归属观测且达标 + 至少一条归属观测。
 * 完成时刻 = 这些完成证据时刻的最大值（全部来自存储，确定性）。
 */
export function sessionCompletionEvidence(
  session: HostingSessionRow,
  period: HostingPeriodRow,
  tasksOfOrder: TaskDefinitionRow[],
  occurrences: TaskOccurrenceRow[],
  taskEvents: Map<string, TaskProgressEventRow[]>,
): SessionEvidence {
  const key = `N:${session.sessionIndex}`;
  const rows = occurrences.filter((row) => row.occurrenceKey === key);
  const sessionScope: ProgressScope = { kind: 'SESSION', sessionId: session.id };
  const dates = new Set<string>();
  for (const row of rows) dates.add(row.gameDate);
  for (const [taskId, list] of taskEvents) {
    if (!tasksOfOrder.some((task) => task.id === taskId)) continue;
    for (const event of list) {
      if (event.scopeType === 'SESSION' && event.scopeSessionId === session.id) {
        dates.add(event.gameDate);
      }
    }
  }
  if (dates.size === 0) {
    return { completedAt: null, hasEvidence: false, missingTaskIds: [], dueTaskIds: [] };
  }
  // 同一轮次的归属日期理论上唯一；多个时取最早的一个，保证重建是确定性的。
  const attributed = [...dates].sort()[0];
  const due = dueTasksOn(tasksOfOrder, period, attributed);
  if (due.length === 0) {
    return { completedAt: null, hasEvidence: true, missingTaskIds: [], dueTaskIds: [] };
  }

  const missing: string[] = [];
  const instants: number[] = [];
  for (const task of due) {
    if (isCumulativeTask(task)) {
      const events = taskEvents.get(task.id) ?? [];
      const total = resolveScopeTotal(events, task.id, sessionScope, task.startValue);
      const observed = hasObservationInScope(events, task.id, sessionScope);
      if (!observed || !reachedTarget(total, task.targetValue)) {
        missing.push(task.id);
        continue;
      }
      const winner = resolveEffectiveEvent(events, task.id, sessionScope);
      // 非正数时刻不是可用证据：绝不据此编造完成时刻（否则候选校验会按"时间无效"拒绝整份数据）。
      if (winner !== null && winner.recordedAt > 0) instants.push(winner.recordedAt);
      continue;
    }
    const occurrence = rows.find((row) => row.taskDefinitionId === task.id);
    if (!occurrence || occurrence.completedAt === null) {
      missing.push(task.id);
      continue;
    }
    instants.push(occurrence.completedAt);
  }
  if (missing.length > 0) {
    return { completedAt: null, hasEvidence: true, missingTaskIds: missing, dueTaskIds: due.map((task) => task.id) };
  }
  if (instants.length === 0) {
    // 应做任务全部达标但没有可读的完成时刻：保留旧值由调用方决定，绝不编造时间。
    return { completedAt: null, hasEvidence: true, missingTaskIds: [], dueTaskIds: due.map((task) => task.id) };
  }
  return {
    completedAt: Math.max(...instants),
    hasEvidence: true,
    missingTaskIds: [],
    dueTaskIds: due.map((task) => task.id),
  };
}

/**
 * 非轮次 scope（TASK / PERIOD）累计任务的派生值（S2-R3 / contract
 * `derivedState.nonSessionScopes`）。
 *
 * **零事件也要重建**：`resolveScopeTotal` 在没有任何有效观测时回落到 `startValue`，
 * 因此陈旧缓存不可能因为"空事件集合被跳过"而活下来。
 *
 * 完成投影：
 * - `TASK`（短期单）：达标时取**有效观测赢家的 `recordedAt`**；没有有效观测时即使
 *   `startValue` 已达标也保持 `completedAt = null`（禁止臆造完成，D-38 同一口径）；
 *   更正到低于目标即重开。
 * - `PERIOD`（按日期托管）：托管任务的存储规则要求任务级完成时间为 null，完成度由
 *   期次总值 + 目标在读取时派生，因此这里显式清除陈旧值，不新建轮次、不写事件。
 */
export interface TaskProjection {
  scope: ProgressScope;
  currentValue: string;
  /** 由存储证据导出的完成时刻；`PERIOD` 永远为 null。 */
  completedAt: number | null;
  /** 是否存在有效观测（区分"零观测"与"观测为 startValue"）。 */
  observed: boolean;
}

export function nonSessionProjection(
  task: TaskDefinitionRow,
  events: TaskProgressEventRow[],
): TaskProjection {
  const scope: ProgressScope =
    task.periodId === null ? { kind: 'TASK' } : { kind: 'PERIOD', periodId: task.periodId };
  const currentValue = resolveScopeTotal(events, task.id, scope, task.startValue);
  const winner = resolveEffectiveEvent(events, task.id, scope);
  const observed = winner !== null;
  // 时间戳只来自存储证据：有效观测的 recordedAt，绝不使用恢复时刻；
  // 非正数时刻视为不可用证据（不做完成投影，也不伪造时间）。
  const stamp = winner !== null && winner.recordedAt > 0 ? winner.recordedAt : null;
  const reached = observed && reachedTarget(currentValue, task.targetValue);
  return {
    scope,
    currentValue,
    completedAt: task.periodId === null && reached ? stamp : null,
    observed,
  };
}

/**
 * 从权威记录重建派生状态（就地写回数据集，纯内存、无数据库依赖）。
 *
 * 调用点：网页 `prepareRestore`、安卓 `BackupRestoreService.prepareInternal`。
 * 失败时抛出，调用方必须在写候选库/激活之前中止。
 */
export function reconstructDerivedState(data: BackupDataSet): ReconstructionReport {
  const report: ReconstructionReport = {
    sessionsCompleted: 0,
    sessionsReopened: 0,
    sessionTimestampsCorrected: 0,
    taskCachesRefreshed: 0,
    taskCompletionsChanged: 0,
    orderFlagsChanged: 0,
    notes: [],
  };
  const events = data.task_progress_events;
  const taskEvents = eventsByTask(events);
  const orderById = new Map(data.orders.map((order) => [order.id, order]));
  const tasksByOrder = new Map<string, TaskDefinitionRow[]>();
  for (const task of data.task_definitions) {
    const list = tasksByOrder.get(task.orderId) ?? [];
    list.push(task);
    tasksByOrder.set(task.orderId, list);
  }
  const occurrencesByOrder = new Map<string, TaskOccurrenceRow[]>();
  const taskOrder = new Map(data.task_definitions.map((task) => [task.id, task.orderId]));
  for (const occurrence of data.task_occurrences) {
    const orderId = taskOrder.get(occurrence.taskDefinitionId);
    if (!orderId) continue;
    const list = occurrencesByOrder.get(orderId) ?? [];
    list.push(occurrence);
    occurrencesByOrder.set(orderId, list);
  }

  // ---- 1. 轮次完成度（计次订单） --------------------------------------
  const countPeriodById = new Map<string, HostingPeriodRow>();
  for (const period of data.hosting_periods) {
    if (period.serviceCount !== null) countPeriodById.set(period.id, period);
  }
  const sessionsByOrder = new Map<string, HostingSessionRow[]>();
  for (const session of data.hosting_sessions) {
    const list = sessionsByOrder.get(session.orderId) ?? [];
    list.push(session);
    sessionsByOrder.set(session.orderId, list);
  }

  for (const order of data.orders) {
    if (order.type !== 'HOSTING' || order.hostingMode !== 'COUNT_BASED') continue;
    const periods = data.hosting_periods.filter(
      (period) => period.orderId === order.id && period.serviceCount !== null,
    );
    if (periods.length === 0) continue;
    const sessions = sessionsByOrder.get(order.id) ?? [];
    const tasks = tasksByOrder.get(order.id) ?? [];
    const occurrences = occurrencesByOrder.get(order.id) ?? [];

    for (const session of sessions) {
      const period = countPeriodById.get(session.periodId);
      if (!period || period.orderId !== order.id) {
        report.notes.push(
          `轮次 ${session.id} 的期次 ${session.periodId} 不属于订单 ${order.id}，跳过完成度重建（由校验拒绝）`,
        );
        continue;
      }
      const evidence = sessionCompletionEvidence(session, period, tasks, occurrences, taskEvents);
      const previous = session.completedAt;
      if (evidence.completedAt === null) {
        if (previous !== null) {
          session.completedAt = null;
          report.sessionsReopened += 1;
        }
        continue;
      }
      session.completedAt = evidence.completedAt;
      if (previous === null) report.sessionsCompleted += 1;
      else if (previous !== evidence.completedAt) report.sessionTimestampsCorrected += 1;
    }

    // ---- 2. 累计任务缓存（活动范围派生，五种状态） --------------------
    const active = resolveActiveCountSession(order.id, periods, sessions);
    for (const task of tasks) {
      if (!isCumulativeTask(task)) continue;
      const cache = taskScopeCache(task, active, periods, sessions, events);
      if (task.currentValue !== cache.currentValue) {
        task.currentValue = cache.currentValue;
        report.taskCachesRefreshed += 1;
      }
      // 托管任务的 completedAt 由轮次承载；校验要求它保持 null。
      if (task.completedAt !== null) {
        task.completedAt = null;
        report.taskCachesRefreshed += 1;
      }
    }

    // ---- 3. 订单完成标志（每个期次目标都达成） ------------------------
    const completedPerPeriod = new Map<string, number>();
    for (const session of sessions) {
      if (session.completedAt === null) continue;
      completedPerPeriod.set(session.periodId, (completedPerPeriod.get(session.periodId) ?? 0) + 1);
    }
    const everyPeriodMet = periods.every(
      (period) => (completedPerPeriod.get(period.id) ?? 0) >= (period.serviceCount ?? 0),
    );
    // 订单完成是派生投影：达成与未达成都要与证据一致（陈旧的非空值同样要改正）。
    const instants = sessions
      .map((session) => session.completedAt)
      .filter((value): value is number => value !== null);
    const derivedOrderCompletion = everyPeriodMet && instants.length > 0 ? Math.max(...instants) : null;
    if (order.completedAt !== derivedOrderCompletion) {
      order.completedAt = derivedOrderCompletion;
      report.orderFlagsChanged += 1;
    }
  }

  // ---- 4. 非轮次 scope 的累计派生值（TASK / PERIOD） -------------------
  // 每个累计任务都要重建（包括**零事件**的任务）：事件是权威，空集合的结果是
  // startValue，绝不是"保留文件里的缓存"。普通任务的状态是权威历史，不在这里重写。
  for (const task of data.task_definitions) {
    if (!isCumulativeTask(task)) continue;
    const order = orderById.get(task.orderId);
    if (!order) continue;
    if (order.type === 'HOSTING' && order.hostingMode === 'COUNT_BASED') {
      // 计次任务的缓存是活动轮次的镜像，第 1 步已按五种状态刷新。
      continue;
    }
    const projection = nonSessionProjection(task, taskEvents.get(task.id) ?? []);
    if (task.currentValue !== projection.currentValue) {
      task.currentValue = projection.currentValue;
      report.taskCachesRefreshed += 1;
    }
    if (task.completedAt !== projection.completedAt) {
      task.completedAt = projection.completedAt;
      report.taskCompletionsChanged += 1;
    }
  }

  // ---- 5. 短期单整体完成标志 ----------------------------------------
  // 在累计任务完成投影之后：订单完成只看（已经重建过的）任务完成时刻。
  for (const order of data.orders) {
    if (order.type !== 'SHORT_TASK') continue;
    const tasks = (tasksByOrder.get(order.id) ?? []).filter((task) => task.retiredAt === null);
    if (tasks.length === 0) continue;
    const allDone = tasks.every((task) => task.completedAt !== null);
    const derivedOrderCompletion = allDone
      ? Math.max(...tasks.map((task) => task.completedAt as number))
      : null;
    if (order.completedAt !== derivedOrderCompletion) {
      order.completedAt = derivedOrderCompletion;
      report.orderFlagsChanged += 1;
    }
  }

  return report;
}

export interface OrderDerivedChanges {
  sessionsCompleted: number;
  sessionsReopened: number;
  sessionTimestampsCorrected: number;
  taskCachesRefreshed: number;
  taskCompletionsChanged: number;
  orderFlagChanged: boolean;
}

/**
 * 事务内的增量派生刷新（契约 `derivedState.recomputeOrderSteps` 3/5/6/7 步）。
 *
 * 顺序固定：①先按该轮应做集 + 归属观测更新 `hosting_sessions.completedAt`；
 * ②再用**更新后**的轮次派生活动范围并刷新该订单**所有**受影响累计任务的缓存；
 * ③最后重算订单完成标志。缓存刷新绝不早于完成态更新（G2）。
 *
 * 与恢复重建（`reconstructDerivedState`）共用 `sessionCompletionEvidence` /
 * `taskScopeCache` / `nonSessionProjection` 同一组原语，因此"增量结果 == 全量重建"
 * 是可断言的，而不是两套独立实现。
 */
export function refreshOrderDerived(
  data: BackupDataSet,
  orderId: string,
): OrderDerivedChanges {
  const changes: OrderDerivedChanges = {
    sessionsCompleted: 0,
    sessionsReopened: 0,
    sessionTimestampsCorrected: 0,
    taskCachesRefreshed: 0,
    taskCompletionsChanged: 0,
    orderFlagChanged: false,
  };
  const order = data.orders.find((row) => row.id === orderId);
  if (!order) return changes;
  const tasks = data.task_definitions.filter((task) => task.orderId === orderId);
  const taskIds = new Set(tasks.map((task) => task.id));
  const occurrences = data.task_occurrences.filter((row) => taskIds.has(row.taskDefinitionId));
  const events = data.task_progress_events.filter((event) => taskIds.has(event.taskDefinitionId));
  const taskEvents = eventsByTask(events);
  const periods = data.hosting_periods.filter((period) => period.orderId === orderId);
  const countPeriods = periods.filter((period) => period.serviceCount !== null);
  const sessions = data.hosting_sessions.filter((session) => session.orderId === orderId);

  if (order.type === 'HOSTING' && countPeriods.length > 0) {
    for (const session of sessions) {
      const period = countPeriods.find((row) => row.id === session.periodId);
      if (!period) continue;
      const evidence = sessionCompletionEvidence(session, period, tasks, occurrences, taskEvents);
      const previous = session.completedAt;
      const next =
        evidence.completedAt === null
          ? null
          : Math.max(evidence.completedAt, session.createdAt);
      session.completedAt = next;
      if (previous === null && next !== null) changes.sessionsCompleted += 1;
      else if (previous !== null && next === null) changes.sessionsReopened += 1;
      else if (previous !== null && next !== null && previous !== next) {
        changes.sessionTimestampsCorrected += 1;
      }
    }

    const active = resolveActiveCountSession(orderId, periods, sessions);
    for (const task of tasks) {
      if (!isCumulativeTask(task)) continue;
      const cache = taskScopeCache(task, active, periods, sessions, events);
      if (task.currentValue !== cache.currentValue) {
        task.currentValue = cache.currentValue;
        changes.taskCachesRefreshed += 1;
      }
      if (task.completedAt !== null) {
        task.completedAt = null;
        changes.taskCachesRefreshed += 1;
      }
    }

    const completedPerPeriod = new Map<string, number>();
    for (const session of sessions) {
      if (session.completedAt === null) continue;
      completedPerPeriod.set(
        session.periodId,
        (completedPerPeriod.get(session.periodId) ?? 0) + 1,
      );
    }
    const everyPeriodMet = countPeriods.every(
      (period) => (completedPerPeriod.get(period.id) ?? 0) >= (period.serviceCount ?? 0),
    );
    const instants = sessions
      .map((session) => session.completedAt)
      .filter((value): value is number => value !== null);
    const derived = everyPeriodMet && instants.length > 0 ? Math.max(...instants) : null;
    if (order.completedAt !== derived) {
      order.completedAt = derived;
      changes.orderFlagChanged = true;
    }
    return changes;
  }

  // 非轮次 scope（TASK / PERIOD）：事件是权威，零事件也要重建。
  for (const task of tasks) {
    if (!isCumulativeTask(task)) continue;
    const projection = nonSessionProjection(task, taskEvents.get(task.id) ?? []);
    if (task.currentValue !== projection.currentValue) {
      task.currentValue = projection.currentValue;
      changes.taskCachesRefreshed += 1;
    }
    if (task.completedAt !== projection.completedAt) {
      task.completedAt = projection.completedAt;
      changes.taskCompletionsChanged += 1;
    }
  }

  if (order.type === 'SHORT_TASK') {
    const live = tasks.filter((task) => task.retiredAt === null);
    if (live.length > 0) {
      const allDone = live.every((task) => task.completedAt !== null);
      const derived = allDone
        ? Math.max(...live.map((task) => task.completedAt as number))
        : null;
      if (order.completedAt !== derived) {
        order.completedAt = derived;
        changes.orderFlagChanged = true;
      }
    }
  }

  return changes;
}

import type {
  BackupDataSet,
  GameAccountRow,
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  OrderType,
  OwnerRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
  TaskProgressEventRow,
} from '../contracts/tables';
import {
  paidForOrder,
  paidForPeriod,
  pendingReceipts,
  receivablesOf,
  settledReceipts,
} from '../domain/ledger';
import { argbToColourToken } from '../backup/normalize/localColours';
import { legacyModeFromServiceDefaults } from '../backup/normalize/categoryDefaults';
import { countServiceDaysUsed, gameDateAt, localDateAt, monthRange } from '../domain/gameCalendar';
import { countPeriodServiceStart, resolveActiveCountSession } from '../domain/countSessions';
import {
  roundDueTasks,
  roundFallbackDate,
  roundKey,
  roundProgress,
} from '../domain/countRounds';
import {
  cumulativeScopeDescriptor,
  type CumulativeActiveState,
} from '../domain/cumulativeScope';
import { isCumulativeTask } from '../domain/derivedState';
import { sortTasksByOrder } from '../domain/taskOrder';
import { calendarGameDate, scopeCalendar, type ScopeCalendar } from '../domain/scopeCalendar';
import {
  coverageSlotFor,
  isSingleShotTask,
  onceSlotKey,
  parseWeekdays,
  slotFor,
} from '../domain/occurrences';
import {
  hasObservationInScope,
  reachedTarget,
  resolveEffectiveEvent,
  resolveScopeTotal,
  type ProgressScope,
} from '../domain/progressEvents';
import type { ReadContext, DatasetRuntime } from '../storage/datasetRuntime';
import type {
  AccountSummary,
  ActiveCountSummary,
  CumulativeTaskView,
  HistoricalTaskView,
  LedgerView,
  OrderDetailView,
  OrderSummary,
  OwnerDetailView,
  OwnerSummary,
  PeriodView,
  RoundView,
  SettingsView,
  TemplateDraft,
  TemplateSummary,
  TodayTaskItem,
  TodayView,
} from './contracts';
import { progressHistoryOf } from './cumulative';

export interface QueryDeps {
  runtime: DatasetRuntime;
  now: () => number;
}

interface Names {
  owner: OwnerRow | undefined;
  account: GameAccountRow | undefined;
}

function namesOf(data: BackupDataSet, order: OrderRow): Names {
  const account = data.game_accounts.find((row) => row.id === order.accountId);
  const owner = account ? data.owners.find((row) => row.id === account.ownerId) : undefined;
  return { owner, account };
}

function ownerLabel(owner: OwnerRow | undefined): string {
  return owner ? `#${owner.number} ${owner.nickname}` : '未知老板';
}

function accountLabel(account: GameAccountRow | undefined): string {
  return account ? `${account.gameName} · ${account.server}` : '未知账号';
}

/** 计次期次已完成轮次（按 session，不再按 occurrence 日期推断）。 */
function completedSessionsOf(data: BackupDataSet, periodId: string): number {
  return data.hosting_sessions.filter(
    (session) => session.periodId === periodId && session.completedAt !== null,
  ).length;
}

/**
 * 今日归属期次：包含"今天"的期次；提前续期产生的未来期次不得抢走今天的工作。
 * 没有包含今天的期次时回退到最近一期（用于到期/未开始提示）。
 *
 * "今天"必须按期次**自己的**刷新快照换算：期次与订单的快照可以不同（安卓续期/恢复），
 * 用订单口径选期次会让同一份数据在不同日历下选出不同期次（R5）。
 */
function effectivePeriod(data: BackupDataSet, order: OrderRow, nowMs: number) {
  const periods = data.hosting_periods
    .filter((period) => period.orderId === order.id)
    .sort((left, right) => left.periodIndex - right.periodIndex);
  const desc = [...periods].sort((left, right) => right.periodIndex - left.periodIndex);
  const containing = desc.find((period) => {
    const today = calendarGameDate(scopeCalendar(period, order), nowMs);
    return today >= period.startDate && today <= period.endDate;
  });
  return containing ?? desc[0];
}

function isArchivedOrder(data: BackupDataSet, order: OrderRow): boolean {
  if (order.archivedAt !== null) return true;
  const { owner, account } = namesOf(data, order);
  if (!owner || !account) return true;
  return owner.archivedAt !== null || account.archivedAt !== null;
}

function summaryOf(
  data: BackupDataSet,
  order: OrderRow,
  orderColorMarks: Map<string, string | null> = new Map(),
  nowMs: number = Date.now(),
): OrderSummary {
  const { owner, account } = namesOf(data, order);
  const periods = data.hosting_periods.filter((period) => period.orderId === order.id);
  const latest = periods.sort((left, right) => right.periodIndex - left.periodIndex)[0];
  const price = order.type === 'SHORT_TASK' ? (order.priceCents ?? 0) : (latest?.priceCents ?? 0);
  // 只把已经到账的收款算作已收：未来到账的在途款不冲抵待收。
  const paid =
    order.type === 'SHORT_TASK'
      ? paidForOrder(data, order.id, nowMs)
      : latest
        ? paidForPeriod(data, latest.id, nowMs)
        : 0;
  const outstanding = Math.max(0, price - paid);
  return {
    id: order.id,
    type: order.type,
    title: order.title,
    colorTag: orderColorMarks.get(order.id) ?? null,
    ownerId: owner?.id ?? '',
    ownerName: ownerLabel(owner),
    accountId: account?.id ?? '',
    accountName: accountLabel(account),
    priceCents: order.priceCents,
    paidCents: paid,
    outstandingCents: outstanding,
    cancelled: order.cancelledAt !== null,
    completed: order.completedAt !== null,
    deadlineDate: order.deadlineDate,
    // 按次数期次无日历期限：不展示结束日，改展示服务次数。
    currentPeriodEnd: latest && latest.serviceCount == null ? latest.endDate : null,
    currentServiceCount: latest?.serviceCount ?? null,
    createdAt: order.createdAt,
    gameZoneId: order.gameZoneId,
    dailyRefreshMinutes: order.dailyRefreshMinutes,
  };
}

function accountSummary(
  data: BackupDataSet,
  account: GameAccountRow,
  orderColorMarks: Map<string, string | null> = new Map(),
  nowMs: number = Date.now(),
): AccountSummary {
  const category = account.categoryId
    ? data.account_categories.find((row) => row.id === account.categoryId)
    : undefined;
  return {
    id: account.id,
    ownerId: account.ownerId,
    gameName: account.gameName,
    server: account.server,
    uid: account.uid,
    loginAccount: account.loginAccount,
    loginMethod: account.loginMethod,
    password: account.password,
    loginDevice: account.loginDevice ?? null,
    resourceNotes: account.resourceNotes ?? null,
    archived: account.archivedAt !== null,
    defaultTemplateId: account.defaultTemplateId,
    categoryId: account.categoryId,
    categoryName: category?.name ?? null,
    orders: data.orders
      .filter((order) => order.accountId === account.id)
      .map((order) => summaryOf(data, order, orderColorMarks, nowMs)),
  };
}

function eventsOfOrder(data: BackupDataSet, taskIds: Set<string>): TaskProgressEventRow[] {
  return data.task_progress_events.filter((event) => taskIds.has(event.taskDefinitionId));
}

function occurrencesOfOrder(data: BackupDataSet, taskIds: Set<string>): TaskOccurrenceRow[] {
  return data.task_occurrences.filter((row) => taskIds.has(row.taskDefinitionId));
}

function sessionsOfOrder(data: BackupDataSet, orderId: string): HostingSessionRow[] {
  return data.hosting_sessions
    .filter((session) => session.orderId === orderId)
    .sort((left, right) => left.sessionIndex - right.sessionIndex);
}

interface CumulativeView {
  scope: ProgressScope | null;
  label: string;
  currentValue: string;
  reached: boolean;
  completed: boolean;
  observed: boolean;
  gameDate: string;
  calendar: ScopeCalendar;
}

/**
 * 某个累计任务**当前**的 scope、归属日与缓存（F3 五种状态的读取投影）。
 *
 * scope 与日历都来自共享的 `cumulativeScopeDescriptor`——组件与命令层必须选到同一个
 * scope 与同一个日历，否则 UI 会提一个命令层不承认的游戏日（R5）。
 * 与写入侧 `taskScopeCache` 同源；这里只返回展示需要的字段，不写任何行。
 */
function cumulativeViewOf(input: {
  data: BackupDataSet;
  task: TaskDefinitionRow;
  order: OrderRow;
  active: ActiveCountSummary;
  periods: HostingPeriodRow[];
  sessions: HostingSessionRow[];
  events: TaskProgressEventRow[];
  occurrences: TaskOccurrenceRow[];
  nowMs: number;
}): CumulativeView {
  const { task, order, active, periods, sessions, events, nowMs } = input;
  const descriptor = cumulativeScopeDescriptor({
    task,
    order,
    active: active as CumulativeActiveState,
    periods,
    sessions,
    nowMs,
  });
  const scope = descriptor.scope;
  const total = scope
    ? resolveScopeTotal(events, task.id, scope, task.startValue)
    : task.startValue;
  const reached = reachedTarget(total, task.targetValue);
  const observed = scope ? hasObservationInScope(events, task.id, scope) : false;
  // 完成判定按状态给出（与 R1–R4 一致）：短期单看订单/任务完成标志，
  // 按日期期次看达标，轮次看"有观测且达标"，已完成轮次还要看轮次的完成时刻。
  let completed = false;
  if (descriptor.state === 'TASK') completed = task.completedAt !== null;
  else if (descriptor.state === 'PERIOD') completed = reached;
  else if (descriptor.state === 'ACTIVE_SESSION') completed = observed && reached;
  else if (descriptor.state === 'LAST_SESSION') {
    completed = descriptor.sessionCompletedAt !== null && reached;
  }
  return {
    scope,
    label: descriptor.label,
    currentValue: total,
    reached,
    completed,
    observed,
    gameDate: descriptor.gameDate,
    calendar: descriptor.calendar,
  };
}

function activeSummaryOf(state: ReturnType<typeof resolveActiveCountSession>): ActiveCountSummary {
  return state;
}

function roundViewsOf(input: {
  data: BackupDataSet;
  order: OrderRow;
  periods: HostingPeriodRow[];
  sessions: HostingSessionRow[];
  tasks: TaskDefinitionRow[];
  occurrences: TaskOccurrenceRow[];
  events: TaskProgressEventRow[];
}): RoundView[] {
  const { data, periods, sessions, tasks, occurrences, events } = input;
  void data;
  return sessions.flatMap((session) => {
    const period = periods.find((row) => row.id === session.periodId);
    if (!period || period.serviceCount === null) return [];
    const progress = roundProgress({
      session,
      period,
      tasks,
      occurrences,
      events,
      // 没有任何证据时用轮次自己的 createdAt 游戏日，绝不回落到"今天"。
      fallbackDate: roundFallbackDate(session, period),
    });
    return [
      {
        sessionId: session.id,
        sessionIndex: session.sessionIndex,
        periodId: period.id,
        attributedDate: progress.attributedDate,
        completedAt: session.completedAt,
        dueTaskIds: progress.dueTasks.map((task) => task.id),
        completedTaskIds: progress.completedTaskIds,
        missingTaskIds: progress.missingTaskIds,
        hasCumulative: progress.dueTasks.some((task) => isCumulativeTask(task)),
      },
    ];
  });
}

export function createQueryServices({ runtime, now }: QueryDeps) {
  const query = {
    async today(filter: {
      ownerId?: string;
      accountId?: string;
      /** UF-021：默认隐藏已到期订单任务；显式传 true 才展示。 */
      includeExpired?: boolean;
    }): Promise<TodayView> {
      return runtime.read(async (ctx) => {
        const data = ctx.data;
        const hosting: TodayTaskItem[] = [];
        const shortTasks: TodayTaskItem[] = [];
        /** 今天不触发、但仍在周期窗口内的任务（只读展示 + 可补录到触发日）。 */
        const periodic: TodayTaskItem[] = [];
        const staleOrders: TodayView['staleOrders'] = [];
        const includeExpired = filter.includeExpired === true;
        // 任务颜色 = 自身 colorArgb ?? 订单色（继承），不再有独立的"跟随标记"表。
        const orderColorById = new Map<string, string | null>(
          data.orders.map((row) => [row.id, argbToColourToken(row.orderColor)]),
        );
        const colorMarks = new Map<string, string | null>(
          data.task_definitions.map((row) => [
            row.id,
            argbToColourToken(row.colorArgb) ?? orderColorById.get(row.orderId) ?? null,
          ]),
        );
        const attachmentByTask = new Map<string, number>();
        const attachmentByOccurrence = new Map<string, number>();
        for (const attachment of data.attachments) {
          if (attachment.occurrenceId !== null) {
            attachmentByOccurrence.set(
              attachment.occurrenceId,
              (attachmentByOccurrence.get(attachment.occurrenceId) ?? 0) + 1,
            );
          } else if (attachment.taskDefinitionId !== null) {
            attachmentByTask.set(
              attachment.taskDefinitionId,
              (attachmentByTask.get(attachment.taskDefinitionId) ?? 0) + 1,
            );
          }
        }

        for (const order of data.orders) {
          if (order.cancelledAt !== null) continue;
          if (isArchivedOrder(data, order)) continue;
          const { owner, account } = namesOf(data, order);
          if (filter.ownerId && owner?.id !== filter.ownerId) continue;
          if (filter.accountId && account?.id !== filter.accountId) continue;
          const today = gameDateAt(now(), order.gameZoneId, order.dailyRefreshMinutes);
          // TASK scope（短期单）的权威日历就是订单自己的快照。
          const orderCalendar = scopeCalendar(null, order);
          const base = {
            orderId: order.id,
            orderTitle: order.title,
            ownerId: owner?.id ?? '',
            ownerName: ownerLabel(owner),
            accountName: accountLabel(account),
          };

          if (order.type === 'SHORT_TASK') {
            if (order.completedAt === null) {
              const expired = Boolean(order.deadlineDate && today > order.deadlineDate);
              if (expired) {
                staleOrders.push({
                  orderId: order.id,
                  title: order.title,
                  reason: `已超过交付期限 ${order.deadlineDate}`,
                });
              }
              // UF-021：已到期短期单任务不再占用今日列表；无截止日期的不判过期。
              if (expired && !includeExpired) continue;
              // 手动排序：展示顺序 = `sortOrder`（Dexie 的主键顺序不稳定，不能直接渲染）。
              const tasks = sortTasksByOrder(
                data.task_definitions.filter(
                  (task) => task.orderId === order.id && task.periodId === null,
                ),
              );
              const events = eventsOfOrder(
                data,
                new Set(tasks.map((task) => task.id)),
              );
              for (const task of tasks) {
                if (task.retiredAt !== null) continue;
                const cumulative = isCumulativeTask(task);
                const total = cumulative
                  ? resolveScopeTotal(events, task.id, { kind: 'TASK' }, task.startValue)
                  : task.currentValue;
                shortTasks.push({
                  ...base,
                  taskId: task.id,
                  colorTag: colorMarks.get(task.id) ?? null,
                  periodId: null,
                  occurrenceId: null,
                  occurrenceKey: null,
                  title: task.title,
                  progressType: task.progressType,
                  currentValue: total,
                  targetValue: task.targetValue,
                  unit: task.unit,
                  completed: cumulative
                    ? hasObservationInScope(events, task.id, { kind: 'TASK' }) &&
                      reachedTarget(total, task.targetValue)
                    : task.completedAt !== null,
                  backfilled: false,
                  windowStart: null,
                  windowEnd: null,
                  attachmentCount: attachmentByTask.get(task.id) ?? 0,
                  batchId: task.completionBatchId,
                  serviceCount: null,
                  serviceRounds: 0,
                  numericMode: task.numericMode,
                  cumulative,
                  reachedTarget: cumulative
                    ? reachedTarget(total, task.targetValue)
                    : task.completedAt !== null,
                  sessionId: null,
                  sessionIndex: null,
                  awaitingSession: false,
                  roundDate: null,
                  gameDate: today,
                  calendar: orderCalendar,
                });
              }
            }
            continue;
          }

          const periods = data.hosting_periods
            .filter((period) => period.orderId === order.id)
            .sort((left, right) => left.periodIndex - right.periodIndex);
          const countPeriods = periods.filter((period) => period.serviceCount !== null);

          if (countPeriods.length > 0) {
            const sessions = sessionsOfOrder(data, order.id);
            const state = resolveActiveCountSession(order.id, periods, sessions);
            if (state.kind === 'ALL_PERIODS_COMPLETE') {
              const lastPeriod = countPeriods[countPeriods.length - 1];
              const rounds = lastPeriod ? completedSessionsOf(data, lastPeriod.id) : 0;
              staleOrders.push({
                orderId: order.id,
                title: order.title,
                reason: lastPeriod
                  ? `已完成 ${rounds}/${lastPeriod.serviceCount} 次打卡，可续期`
                  : '本单的打卡次数已全部完成，可续期',
              });
              if (!includeExpired) continue;
              continue;
            }
            if (state.kind === 'INDEX_SPACE_EXHAUSTED') {
              staleOrders.push({
                orderId: order.id,
                title: order.title,
                reason: '轮次号已达到上限，无法继续打卡',
              });
              continue;
            }
            const period = periods.find((row) => row.id === state.periodId);
            if (!period) continue;
            // 计次托管的权威日历是**这一期**自己的快照（与命令层同一份）。
            const calendar = scopeCalendar(period, order);
            const periodToday = calendarGameDate(calendar, now());
            if (periodToday < countPeriodServiceStart(period)) continue;
            const periodTasks = sortTasksByOrder(
              data.task_definitions.filter(
                (task) => task.orderId === order.id && task.periodId === period.id,
              ),
            );
            const taskIds = new Set(periodTasks.map((task) => task.id));
            const occurrences = occurrencesOfOrder(data, taskIds);
            const events = eventsOfOrder(data, taskIds);
            const sessionId = state.kind === 'ACTIVE_SESSION' ? state.sessionId : null;
            const session = sessionId
              ? (sessions.find((row) => row.id === sessionId) ?? null)
              : null;
            const attributed = session
              ? (roundProgress({
                  session,
                  period,
                  tasks: periodTasks,
                  occurrences,
                  events,
                  fallbackDate: periodToday,
                }).attributedDate ?? periodToday)
              : periodToday;
            const due = roundDueTasks(periodTasks, period, attributed);
            const serviceRounds = completedSessionsOf(data, period.id);
            if (serviceRounds >= (period.serviceCount ?? 0)) {
              staleOrders.push({
                orderId: order.id,
                title: order.title,
                reason: `已完成 ${serviceRounds}/${period.serviceCount} 次打卡，可续期`,
              });
            }
            for (const task of due) {
              if (task.retiredAt !== null) continue;
              const key = roundKey(state.sessionIndex);
              const occurrence =
                occurrences.find(
                  (row) => row.taskDefinitionId === task.id && row.occurrenceKey === key,
                ) ?? null;
              const cumulative = isCumulativeTask(task);
              const scope: ProgressScope | null = sessionId
                ? { kind: 'SESSION', sessionId }
                : null;
              const total =
                cumulative && scope
                  ? resolveScopeTotal(events, task.id, scope, task.startValue)
                  : cumulative
                    ? task.startValue
                    : (occurrence?.value ?? task.currentValue);
              const reached = cumulative
                ? reachedTarget(total, task.targetValue)
                : Boolean(occurrence?.completedAt);
              const completed = cumulative
                ? Boolean(scope) && hasObservationInScope(events, task.id, scope as ProgressScope) && reached
                : Boolean(occurrence?.completedAt);
              hosting.push({
                ...base,
                taskId: task.id,
                colorTag: colorMarks.get(task.id) ?? null,
                periodId: period.id,
                occurrenceId: occurrence?.id ?? null,
                occurrenceKey: key,
                title: task.title,
                progressType: task.progressType,
                currentValue: total,
                targetValue: task.targetValue,
                unit: task.unit,
                completed,
                backfilled: occurrence?.backfilled === 1,
                windowStart: occurrence?.windowStart ?? null,
                windowEnd: occurrence?.windowEnd ?? null,
                attachmentCount: occurrence
                  ? (attachmentByOccurrence.get(occurrence.id) ?? 0)
                  : (attachmentByTask.get(task.id) ?? 0),
                batchId: occurrence?.completionBatchId ?? null,
                serviceCount: period.serviceCount,
                serviceRounds,
                numericMode: task.numericMode,
                cumulative,
                reachedTarget: reached,
                sessionId,
                sessionIndex: state.sessionIndex,
                awaitingSession: sessionId === null,
                roundDate: attributed,
                // 累计提交的归属日：该期次快照下的今天；待建轮次也一样，
                // 且读操作绝不为了算日期而创建轮次行。
                gameDate: periodToday,
                calendar,
              });
            }
            // 托管「一次性」任务：本期做一次即可，完成前每天都出现在今日事项里，
            // 归属日就是实际打卡那一天（`O:` 键，不占轮次、也不算应做集）。
            for (const task of periodTasks) {
              if (task.retiredAt !== null) continue;
              if (!isSingleShotTask(task)) continue;
              if (occurrences.some((row) => row.taskDefinitionId === task.id && row.completedAt !== null)) {
                continue;
              }
              const key = onceSlotKey(periodToday);
              const occurrence =
                occurrences.find(
                  (row) => row.taskDefinitionId === task.id && row.occurrenceKey === key,
                ) ?? null;
              hosting.push({
                ...base,
                taskId: task.id,
                colorTag: colorMarks.get(task.id) ?? null,
                periodId: period.id,
                occurrenceId: occurrence?.id ?? null,
                occurrenceKey: key,
                title: task.title,
                progressType: task.progressType,
                currentValue: occurrence?.value ?? task.currentValue,
                targetValue: task.targetValue,
                unit: task.unit,
                completed: Boolean(occurrence?.completedAt),
                backfilled: occurrence?.backfilled === 1,
                windowStart: null,
                windowEnd: null,
                attachmentCount: occurrence
                  ? (attachmentByOccurrence.get(occurrence.id) ?? 0)
                  : (attachmentByTask.get(task.id) ?? 0),
                batchId: occurrence?.completionBatchId ?? null,
                serviceCount: period.serviceCount,
                serviceRounds,
                numericMode: task.numericMode,
                cumulative: false,
                reachedTarget: Boolean(occurrence?.completedAt),
                sessionId: null,
                sessionIndex: null,
                awaitingSession: false,
                roundDate: null,
                gameDate: periodToday,
                calendar,
                singleShot: true,
              });
            }
            continue;
          }

          // ---- 按日期托管 ------------------------------------------------
          const period = effectivePeriod(data, order, now());
          if (!period) continue;
          // 普通任务的行槽仍按页面/订单口径；累计目标的归属日与资格必须用期次快照。
          const calendar = scopeCalendar(period, order);
          const periodToday = calendarGameDate(calendar, now());
          if (today > period.endDate) {
            staleOrders.push({
              orderId: order.id,
              title: order.title,
              reason: `托管服务已于 ${period.endDate} 到期，可续期`,
            });
            // UF-021：到期后（结束日次日起）隐藏其任务；到期当天正常显示。
            if (!includeExpired) continue;
          }
          if (today < period.startDate) continue;

          const periodTasks = sortTasksByOrder(
            data.task_definitions.filter(
              (task) => task.orderId === order.id && task.periodId === period.id,
            ),
          );
          const taskIds = new Set(periodTasks.map((task) => task.id));
          const occurrences = occurrencesOfOrder(data, taskIds);
          const events = eventsOfOrder(data, taskIds);
          for (const task of periodTasks) {
            if (task.retiredAt !== null) continue;
            const singleShot = isSingleShotTask(task);
            // 一次性任务本期只做一次：完成即从今日事项消失（历史在打卡日历里可撤销）。
            if (
              singleShot &&
              occurrences.some(
                (row) => row.taskDefinitionId === task.id && row.completedAt !== null,
              )
            ) {
              continue;
            }
            const cumulative = isCumulativeTask(task);
            // 累计目标不受原重复触发日限制（UF-038）：达标前每天都可以更新。
            const slot = cumulative ? null : slotFor(task, period, today);
            if (!cumulative && !slot) {
              // F-01：今天不是触发日，但本周期已开始（每月 / 每 N 天）→ 进"本周期任务"，
              // 让用户第二天仍能看到这个周期到底做完没有；写入仍归到触发日。
              const windowSlot = coverageSlotFor(task, period, today);
              if (windowSlot && windowSlot.gameDate !== today) {
                const occurrence =
                  occurrences.find(
                    (row) =>
                      row.taskDefinitionId === task.id &&
                      row.occurrenceKey === windowSlot.key,
                  ) ?? null;
                periodic.push({
                  ...base,
                  taskId: task.id,
                  colorTag: colorMarks.get(task.id) ?? null,
                  periodId: period.id,
                  occurrenceId: occurrence?.id ?? null,
                  occurrenceKey: windowSlot.key,
                  title: task.title,
                  progressType: task.progressType,
                  currentValue: occurrence?.value ?? task.currentValue,
                  targetValue: task.targetValue,
                  unit: task.unit,
                  completed: Boolean(occurrence?.completedAt),
                  backfilled: occurrence?.backfilled === 1,
                  windowStart: windowSlot.windowStart,
                  windowEnd: windowSlot.windowEnd,
                  attachmentCount: occurrence
                    ? (attachmentByOccurrence.get(occurrence.id) ?? 0)
                    : (attachmentByTask.get(task.id) ?? 0),
                  batchId: occurrence?.completionBatchId ?? null,
                  serviceCount: null,
                  serviceRounds: 0,
                  numericMode: task.numericMode,
                  cumulative: false,
                  reachedTarget: Boolean(occurrence?.completedAt),
                  sessionId: null,
                  sessionIndex: null,
                  awaitingSession: false,
                  roundDate: windowSlot.gameDate,
                  gameDate: windowSlot.gameDate,
                  calendar,
                });
              }
              continue;
            }
            // 期次快照下的归属日不在服务窗口内时不列出：命令层也会拒绝，不要显示一个
            // 永远写不进去的"今天"。
            if (cumulative && (periodToday < period.startDate || periodToday > period.endDate)) {
              continue;
            }
            const occurrence = slot
              ? (occurrences.find(
                  (row) => row.taskDefinitionId === task.id && row.occurrenceKey === slot.key,
                ) ?? null)
              : null;
            const scope: ProgressScope = { kind: 'PERIOD', periodId: period.id };
            const total = cumulative
              ? resolveScopeTotal(events, task.id, scope, task.startValue)
              : (occurrence?.value ?? task.currentValue);
            const reached = cumulative
              ? reachedTarget(total, task.targetValue)
              : Boolean(occurrence?.completedAt);
            hosting.push({
              ...base,
              taskId: task.id,
              colorTag: colorMarks.get(task.id) ?? null,
              periodId: period.id,
              occurrenceId: occurrence?.id ?? null,
              occurrenceKey: slot?.key ?? null,
              title: task.title,
              progressType: task.progressType,
              currentValue: total,
              targetValue: task.targetValue,
              unit: task.unit,
              completed: cumulative
                ? hasObservationInScope(events, task.id, scope) && reached
                : Boolean(occurrence?.completedAt),
              backfilled: occurrence?.backfilled === 1,
              windowStart: slot?.windowStart ?? occurrence?.windowStart ?? null,
              windowEnd: slot?.windowEnd ?? occurrence?.windowEnd ?? null,
              attachmentCount: occurrence
                ? (attachmentByOccurrence.get(occurrence.id) ?? 0)
                : (attachmentByTask.get(task.id) ?? 0),
              batchId: occurrence?.completionBatchId ?? null,
              serviceCount: null,
              serviceRounds: 0,
              numericMode: task.numericMode,
              cumulative,
              reachedTarget: reached,
              sessionId: null,
              sessionIndex: null,
              awaitingSession: false,
              roundDate: cumulative ? periodToday : today,
              gameDate: cumulative ? periodToday : today,
              calendar,
              singleShot,
            });
          }
        }

        const firstOrder = data.orders.find((order) => order.cancelledAt === null);
        const zoneId = firstOrder?.gameZoneId ?? 'Asia/Shanghai';
        const refresh = firstOrder?.dailyRefreshMinutes ?? 300;
        return {
          gameDate: gameDateAt(now(), zoneId, refresh),
          // 公历今天与游戏日分开算：刷新时间之前两者不同，页头要把这层差别说清楚。
          todayDate: localDateAt(now(), zoneId),
          timeZoneId: zoneId,
          hosting,
          shortTasks,
          periodic,
          staleOrders,
        };
      });
    },

    async searchAccounts(keyword: string) {
      return runtime.read((ctx) => {
        const data = ctx.data;
        const text = keyword.trim().toLowerCase();
        if (!text) return [];
        return data.game_accounts
          .filter((account) => {
            const owner = data.owners.find((row) => row.id === account.ownerId);
            const haystack = [
              account.gameName,
              account.server,
              account.uid,
              account.loginAccount,
              owner?.nickname ?? '',
              owner ? String(owner.number) : '',
            ]
              .join(' ')
              .toLowerCase();
            return haystack.includes(text);
          })
          .slice(0, 50)
          .map((account) => {
            const owner = data.owners.find((row) => row.id === account.ownerId);
            return {
              id: account.id,
              ownerId: account.ownerId,
              ownerLabel: ownerLabel(owner),
              gameName: account.gameName,
              server: account.server,
              uid: account.uid,
              archived: account.archivedAt !== null,
            };
          });
      });
    },

    async owners(includeArchived: boolean): Promise<OwnerSummary[]> {
      return runtime.read((ctx) => {
        const data = ctx.data;
        const receivables = receivablesOf(data);
        return data.owners
          .filter((owner) => includeArchived || owner.archivedAt === null)
          .sort((left, right) => left.number - right.number)
          .map((owner) => {
            const accounts = data.game_accounts.filter((account) => account.ownerId === owner.id);
            const accountIds = new Set(accounts.map((account) => account.id));
            const orders = data.orders.filter((order) => accountIds.has(order.accountId));
            const active = orders.filter(
              (order) =>
                order.cancelledAt === null &&
                order.completedAt === null &&
                order.archivedAt === null,
            );
            return {
              id: owner.id,
              number: owner.number,
              nickname: owner.nickname,
              archived: owner.archivedAt !== null,
              accountCount: accounts.filter((account) => account.archivedAt === null).length,
              activeOrderCount: active.length,
              outstandingCents: receivables
                .filter((item) => active.some((order) => order.id === item.orderId))
                .reduce((sum, item) => sum + item.outstandingCents, 0),
            };
          });
      });
    },

    async ownerDetail(ownerId: string): Promise<OwnerDetailView | null> {
      return runtime.read(async (ctx) => {
        const data = ctx.data;
        const orderColorMarks = new Map<string, string | null>(
          data.orders.map((row) => [row.id, argbToColourToken(row.orderColor)]),
        );
        const owner = data.owners.find((row) => row.id === ownerId);
        if (!owner) return null;
        const accounts = data.game_accounts.filter((account) => account.ownerId === ownerId);
        const activeAccounts = accounts.filter((account) => account.archivedAt === null);
        const archivedAccounts = accounts.filter((account) => account.archivedAt !== null);
        const orders = data.orders
          .filter((order) => accounts.some((account) => account.id === order.accountId))
          .sort((left, right) => right.createdAt - left.createdAt)
          .map((order) => summaryOf(data, order, orderColorMarks, now()));
        return {
          owner: {
            id: owner.id,
            number: owner.number,
            nickname: owner.nickname,
            archived: owner.archivedAt !== null,
            accountCount: activeAccounts.length,
            activeOrderCount: orders.filter((order) => !order.cancelled && !order.completed).length,
            outstandingCents: orders.reduce((sum, order) => sum + order.outstandingCents, 0),
          },
          accounts: activeAccounts.map((account) =>
            accountSummary(data, account, orderColorMarks, now()),
          ),
          archivedAccounts: archivedAccounts.map((account) =>
            accountSummary(data, account, orderColorMarks, now()),
          ),
          orders,
          templates: data.game_templates
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((template) => ({
              id: template.id,
              gameName: template.gameName,
              templateVersion: template.templateVersion,
              origin: template.origin,
              zoneId: template.zoneId,
              builtInKey: template.builtInKey,
              taskCount: data.template_tasks.filter((task) => task.templateId === template.id).length,
            })),
        };
      });
    },

    async orders(filter: {
      ownerId?: string;
      type?: OrderType;
      includeCancelled?: boolean;
    }): Promise<OrderSummary[]> {
      return runtime.read(async (ctx) => {
        const data = ctx.data;
        const orderColorMarks = new Map<string, string | null>(
          data.orders.map((row) => [row.id, argbToColourToken(row.orderColor)]),
        );
        return data.orders
          .filter((order) => {
            if (!filter.includeCancelled && order.cancelledAt !== null) return false;
            if (order.archivedAt !== null) return false;
            if (filter.type && order.type !== filter.type) return false;
            if (filter.ownerId) {
              const { owner } = namesOf(data, order);
              if (owner?.id !== filter.ownerId) return false;
            }
            return true;
          })
          .sort((left, right) => right.createdAt - left.createdAt)
          .map((order) => summaryOf(data, order, orderColorMarks, now()));
      });
    },

    async orderDetail(orderId: string): Promise<OrderDetailView | null> {
      return runtime.read(async (ctx) => orderDetailOf(ctx, orderId, now()));
    },

    async ledger(report: { month: string; zoneId: string }): Promise<LedgerView> {
      return runtime.read((ctx) => {
        const data = ctx.data;
        const { start, end } = monthRange(report.month, report.zoneId);
        const nowMs = now();
        // 只有已经到账的收款算实收；未来到账的进"待到账"，不冲抵待收。
        const active = settledReceipts(data, nowMs);
        const pending = pendingReceipts(data, nowMs);
        const inMonth = active
          .filter((receipt) => receipt.receivedAt >= start && receipt.receivedAt < end)
          .sort((left, right) => right.receivedAt - left.receivedAt);

        function entryOf(receipt: (typeof data.receipts)[number]) {
          const order = data.orders.find((row) => row.id === receipt.orderId);
          const { owner } = order ? namesOf(data, order) : { owner: undefined };
          return {
            receiptId: receipt.id,
            orderId: receipt.orderId,
            orderTitle: order?.title ?? '未知订单',
            ownerName: ownerLabel(owner),
            periodId: receipt.periodId,
            amountCents: receipt.amountCents,
            receivedAt: receipt.receivedAt,
            channel: receipt.channel,
            note: receipt.note,
            status: receipt.status,
            createdAt: receipt.createdAt,
          };
        }

        const entries = inMonth.map(entryOf);
        const pendingEntries = [...pending]
          .sort((left, right) => left.receivedAt - right.receivedAt)
          .map(entryOf);

        const receivables = receivablesOf(data, nowMs).filter((item) => item.outstandingCents > 0);
        const monthlyTotals: LedgerView['monthlyTotals'] = [];
        const base = new Date(`${report.month}-01T00:00:00Z`);
        for (let offset = 5; offset >= 0; offset -= 1) {
          const stamp = new Date(
            Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - offset, 1),
          );
          const key = `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}`;
          const range = monthRange(key, report.zoneId);
          monthlyTotals.push({
            month: key,
            receivedCents: active
              .filter(
                (receipt) => receipt.receivedAt >= range.start && receipt.receivedAt < range.end,
              )
              .reduce((sum, receipt) => sum + receipt.amountCents, 0),
          });
        }

        return {
          month: report.month,
          zoneId: report.zoneId,
          receivedCents: inMonth.reduce((sum, receipt) => sum + receipt.amountCents, 0),
          pendingCents: pending.reduce((sum, receipt) => sum + receipt.amountCents, 0),
          outstandingCents: receivables.reduce((sum, item) => sum + item.outstandingCents, 0),
          orderCount: data.orders.filter(
            (order) => order.createdAt >= start && order.createdAt < end,
          ).length,
          entries,
          pending: pendingEntries,
          outstanding: receivables.map((item) => ({
            key: item.key,
            orderId: item.orderId,
            periodId: item.periodId,
            orderTitle: item.orderTitle,
            ownerName: item.ownerName,
            priceCents: item.priceCents,
            paidCents: item.paidCents,
            pendingCents: item.pendingCents,
            outstandingCents: item.outstandingCents,
          })),
          monthlyTotals,
        };
      });
    },

    async templates(): Promise<TemplateSummary[]> {
      return runtime.read((ctx) => {
        const data = ctx.data;
        return data.game_templates
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((template) => ({
            id: template.id,
            gameName: template.gameName,
            templateVersion: template.templateVersion,
            origin: template.origin,
            zoneId: template.zoneId,
            builtInKey: template.builtInKey,
            taskCount: data.template_tasks.filter((task) => task.templateId === template.id).length,
          }));
      });
    },

    async templateDetail(id: string): Promise<TemplateDraft | null> {
      return runtime.read((ctx) => {
        const data = ctx.data;
        const template = data.game_templates.find((row) => row.id === id);
        if (!template) return null;
        const categories = data.template_categories
          .filter((row) => row.templateId === id)
          .sort((left, right) => left.sortOrder - right.sortOrder);
        const tasks = data.template_tasks.filter((row) => row.templateId === id);
        const presets = data.template_price_presets
          .filter((row) => row.templateId === id)
          .sort((left, right) => left.sortOrder - right.sortOrder);
        const templateMirror = legacyModeFromServiceDefaults(
          {
            hostingMode: template.hostingMode,
            targetSessions: template.targetSessions,
            serviceWeekdays: template.serviceWeekdays,
          },
          'template',
        );
        const categoryDrafts = categories.map((category) => {
          // 旧界面字段由 schema-15 分层默认值派生（分类 null = 继承模板），
          // 既保留 Stage 4 之前的读取路径，也不改变 v15 的真实语义。
          const mirror = legacyModeFromServiceDefaults(
            {
              hostingMode: category.hostingMode,
              targetSessions: category.targetSessions,
              serviceWeekdays: category.serviceWeekdays,
            },
            'category',
          );
          const rawMode = mirror.serviceMode ?? templateMirror.serviceMode ?? null;
          const serviceMode: 'dates' | 'weekdays' | 'count' =
            rawMode === 'weekdays' || rawMode === 'count' ? rawMode : 'dates';
          return {
            name: category.name,
            serviceMode,
            serviceCount:
              serviceMode === 'count'
                ? (mirror.serviceCount ?? templateMirror.serviceCount ?? null)
                : null,
            // schema 15 的真实分层默认值：null = 继承模板（分类级）。
            hostingMode: category.hostingMode,
            targetSessions: category.targetSessions,
            serviceWeekdays: category.serviceWeekdays,
            tasks: tasks
              .filter((task) => task.categoryId === category.id)
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((task) => ({
                title: task.title,
                progressType: task.progressType,
                startValue: task.startValue,
                targetValue: task.targetValue,
                unit: task.unit,
                recurrence: task.recurrence,
                weekdays: task.weekdays,
                everyNDays: task.everyNDays,
                monthDay: task.monthDay,
                monthDays: task.monthDays,
                activeFrom: task.activeFrom ?? null,
                activeUntil: task.activeUntil ?? null,
                numericMode: task.numericMode,
              })),
          };
        });
        const firstCategory = categoryDrafts[0];
        const uniformLegacy =
          categoryDrafts.length > 0 &&
          categoryDrafts.every(
            (item) =>
              item.serviceMode === firstCategory.serviceMode &&
              item.serviceCount === firstCategory.serviceCount,
          );
        const categoryLegacyMode = firstCategory?.serviceMode ?? 'dates';
        const categoryLegacyCount = firstCategory?.serviceCount ?? null;
        return {
          id: template.id,
          gameName: template.gameName,
          templateVersion: template.templateVersion,
          gameVersionNotes: template.gameVersionNotes,
          zoneId: template.zoneId,
          dailyRefreshMinutes: template.dailyRefreshMinutes,
          weeklyRefreshDay: template.weeklyRefreshDay,
          weeklyRefreshMinutes: template.weeklyRefreshMinutes,
          hostingMode: template.hostingMode,
          targetSessions: template.targetSessions,
          serviceWeekdays: template.serviceWeekdays,
          defaultOrderTitle: template.defaultOrderTitle,
          // 旧字段语义：分类不一致时不预设（null），一致才给出共识值。
          serviceMode: uniformLegacy ? categoryLegacyMode : null,
          serviceCount: uniformLegacy && categoryLegacyMode === 'count' ? categoryLegacyCount : null,
          pricePresets: presets.map((preset) => ({
            amountCents: preset.amountCents,
            label: preset.label,
          })),
          serverOptions: data.game_server_options
            .filter(
              (row) =>
                row.gameName.trim().toLowerCase() === template.gameName.trim().toLowerCase(),
            )
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((row) => row.name),
          categories: categoryDrafts,
        };
      });
    },

    async settings(): Promise<SettingsView> {
      const token = await runtime.current();
      const revision = await runtime.revision();
      return runtime.read((ctx) => {
        const data = ctx.data;
        const reminder = data.reminder_settings[0];
        return {
          ownerCount: data.owners.length,
          accountCount: data.game_accounts.length,
          orderCount: data.orders.length,
          attachmentCount: data.attachments.length,
          attachmentBytes: data.attachments.reduce((sum, row) => sum + row.sizeBytes, 0),
          datasetDatabase: token.databaseName,
          generation: token.generation,
          revision,
          reminderSettings: {
            shortDeadlineEnabled: reminder?.shortDeadlineEnabled === 1,
            shortDeadlineMinutes: reminder?.shortDeadlineMinutes ?? 0,
            hostingExpiryEnabled: reminder?.hostingExpiryEnabled === 1,
            hostingExpiryMinutes: reminder?.hostingExpiryMinutes ?? 0,
            unfinishedTasksEnabled: reminder?.unfinishedTasksEnabled === 1,
            unfinishedTasksMinutes: reminder?.unfinishedTasksMinutes ?? 0,
          },
        };
      });
    },
  };

  return query;
}

async function orderDetailOf(
  ctx: ReadContext,
  orderId: string,
  nowMs: number,
): Promise<OrderDetailView | null> {
  const data = ctx.data;
  const orderColorById = new Map<string, string | null>(
    data.orders.map((row) => [row.id, argbToColourToken(row.orderColor)]),
  );
  const colorMarks = new Map<string, string | null>(
    data.task_definitions.map((row) => [
      row.id,
      argbToColourToken(row.colorArgb) ?? orderColorById.get(row.orderId) ?? null,
    ]),
  );
  const orderColorMarks = new Map<string, string | null>(orderColorById);
  const order = data.orders.find((row) => row.id === orderId);
  if (!order) return null;
  const account = data.game_accounts.find((row) => row.id === order.accountId) ?? null;
  const periods = data.hosting_periods
    .filter((period) => period.orderId === order.id)
    .sort((left, right) => left.periodIndex - right.periodIndex);
  const tasks = data.task_definitions.filter((task) => task.orderId === order.id);
  const taskIds = new Set(tasks.map((task) => task.id));
  const occurrences = occurrencesOfOrder(data, taskIds);
  const events = eventsOfOrder(data, taskIds);
  const sessions = sessionsOfOrder(data, order.id);
  const today = gameDateAt(nowMs, order.gameZoneId, order.dailyRefreshMinutes);
  const countPeriods = periods.filter((period) => period.serviceCount !== null);
  const active: ActiveCountSummary =
    countPeriods.length > 0
      ? activeSummaryOf(resolveActiveCountSession(order.id, periods, sessions))
      : { kind: 'NOT_COUNT_BASED' };

  const periodViews: PeriodView[] = periods.map((period) => {
    const paid = paidForPeriod(data, period.id, nowMs);
    // UF-010：计划口径已用/剩余服务天数（非服务日不计）。
    const serviceDays = period.serviceDays ?? null;
    const used =
      serviceDays !== null
        ? countServiceDaysUsed(
            period.startDate,
            period.endDate,
            today,
            new Set(parseWeekdays(period.serviceWeekdays)),
          )
        : 0;
    const serviceCount = period.serviceCount ?? null;
    return {
      id: period.id,
      periodIndex: period.periodIndex,
      startDate: period.startDate,
      endDate: period.endDate,
      priceCents: period.priceCents,
      paidCents: paid,
      pendingCents: pendingReceipts(data, nowMs)
        .filter((receipt) => receipt.periodId === period.id)
        .reduce((sum, receipt) => sum + receipt.amountCents, 0),
      outstandingCents: Math.max(0, period.priceCents - paid),
      serviceDays,
      serviceWeekdays: period.serviceWeekdays,
      serviceDaysUsed: used,
      serviceDaysRemaining: serviceDays !== null ? Math.max(0, serviceDays - used) : 0,
      serviceCount,
      serviceRounds: serviceCount !== null ? completedSessionsOf(data, period.id) : 0,
    };
  });

  const cumulativeViews: CumulativeTaskView[] = [];
  const taskViews: OrderDetailView['tasks'] = tasks
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((task) => {
      const activeSessionKey =
        active.kind === 'ACTIVE_SESSION' && task.periodId === active.periodId
          ? roundKey(active.sessionIndex)
          : null;
      const occurrence =
        occurrences.find(
          (row) =>
            row.taskDefinitionId === task.id &&
            (task.periodId === null
              ? true
              : activeSessionKey !== null
                ? row.occurrenceKey === activeSessionKey
                : row.gameDate === today),
        ) ?? null;
      const cumulative = isCumulativeTask(task);
      const view = cumulative
        ? cumulativeViewOf({
            data,
            task,
            order,
            active,
            periods,
            sessions,
            events,
            occurrences,
            nowMs,
          })
        : null;
      if (cumulative && view) {
        const chain = progressHistoryOf(data, task.id);
        cumulativeViews.push({
          taskId: task.id,
          title: task.title,
          unit: task.unit,
          startValue: task.startValue,
          targetValue: task.targetValue,
          currentValue: view.currentValue,
          reachedTarget: view.reached,
          completed: view.completed,
          scope: view.scope,
          scopeLabel: view.label,
          gameDate: view.gameDate,
          calendar: view.calendar,
          retired: task.retiredAt !== null,
          history: chain,
        });
      }
      return {
        id: task.id,
        title: task.title,
        colorTag: colorMarks.get(task.id) ?? null,
        progressType: task.progressType,
        startValue: task.startValue,
        targetValue: task.targetValue,
        currentValue: view ? view.currentValue : (occurrence?.value ?? task.currentValue),
        unit: task.unit,
        numericMode: task.numericMode,
        cumulative,
        reachedTarget: view
          ? view.reached
          : task.periodId
            ? Boolean(occurrence?.completedAt)
            : task.completedAt !== null,
        recurrence: task.recurrence,
        weekdays: task.weekdays,
        everyNDays: task.everyNDays,
        monthDay: task.monthDay,
        monthDays: task.monthDays,
        activeFrom: task.activeFrom ?? null,
        activeUntil: task.activeUntil ?? null,
        completed: view
          ? view.completed
          : task.periodId
            ? Boolean(occurrence?.completedAt)
            : task.completedAt !== null,
        periodId: task.periodId,
        occurrenceId: occurrence?.id ?? null,
        completedAt: occurrence?.completedAt ?? task.completedAt,
        backfilled: occurrence?.backfilled === 1,
        attachmentCount: data.attachments.filter(
          (attachment) =>
            attachment.taskDefinitionId === task.id ||
            (occurrence ? attachment.occurrenceId === occurrence.id : false),
        ).length,
      };
    });

  const rounds = roundViewsOf({
    data,
    order,
    periods,
    sessions,
    tasks,
    occurrences,
    events,
  });

  const historicalTasks: HistoricalTaskView[] = tasks
    .filter((task) => task.retiredAt !== null)
    .flatMap((task) => {
      if (task.periodId === null) return [];
      const period = periods.find((row) => row.id === task.periodId);
      if (!period || period.serviceCount === null) return [];
      const roundRows = sessions.flatMap((session) => {
        if (session.periodId !== period.id) return [];
        const progress = roundProgress({
          session,
          period,
          tasks,
          occurrences,
          events,
          // 与写入命令同源的稳定归属日（R2-9 / R3-4）。
          fallbackDate: roundFallbackDate(session, period),
        });
        const state = progress.states.find((item) => item.taskId === task.id);
        if (!state) return [];
        // 有效观测 = 该轮 scope 里仍有一个有效事件赢家（撤回不复活旧值）。
        const hasEffectiveObservation = isCumulativeTask(task)
          ? resolveEffectiveEvent(events, task.id, {
              kind: 'SESSION',
              sessionId: session.id,
            }) !== null
          : state.observed;
        return [
          {
            sessionId: session.id,
            sessionIndex: session.sessionIndex,
            attributedDate: progress.attributedDate,
            completed: state.satisfied,
            hasObservation: state.observed,
            hasEffectiveObservation,
            currentValue: state.currentValue,
          },
        ];
      });
      if (roundRows.length === 0) return [];
      return [
        {
          taskId: task.id,
          title: task.title,
          unit: task.unit,
          startValue: task.startValue,
          targetValue: task.targetValue,
          cumulative: isCumulativeTask(task),
          retiredAt: task.retiredAt,
          retiredDate:
            task.retiredAt === null
              ? null
              : gameDateAt(
                  task.retiredAt,
                  period.gameZoneId,
                  period.dailyRefreshMinutes,
                ),
          rounds: roundRows,
        },
      ];
    });

  return {
    order: summaryOf(data, order, orderColorMarks, nowMs),
    notes: order.notes,
    paymentMode: order.paymentMode,
    weeklyRefreshDay: order.weeklyRefreshDay,
    weeklyRefreshMinutes: order.weeklyRefreshMinutes,
    monthlyRefreshDays: order.monthlyRefreshDays,
    account: account ? accountSummary(data, account, orderColorMarks, nowMs) : null,
    periods: periodViews,
    tasks: taskViews,
    receipts: data.receipts
      .filter((receipt) => receipt.orderId === order.id)
      .sort((left, right) => right.receivedAt - left.receivedAt)
      .map((receipt) => ({
        id: receipt.id,
        amountCents: receipt.amountCents,
        receivedAt: receipt.receivedAt,
        channel: receipt.channel,
        note: receipt.note,
        status: receipt.status,
        periodId: receipt.periodId,
        createdAt: receipt.createdAt,
        operationId: receipt.operationId,
        pending: receipt.status === 'ACTIVE' && receipt.receivedAt > nowMs,
      })),
    corrections: data.receipt_corrections
      .filter((correction) =>
        data.receipts.some(
          (receipt) => receipt.id === correction.receiptId && receipt.orderId === order.id,
        ),
      )
      .map((correction) => ({
        id: correction.id,
        receiptId: correction.receiptId,
        kind: correction.kind,
        reason: correction.reason,
        createdAt: correction.createdAt,
        previousAmountCents: correction.previousAmountCents,
        newAmountCents: correction.newAmountCents,
      })),
    calendar: buildCalendar({
      data,
      order,
      periods,
      tasks,
      occurrences,
      events,
      sessions,
      today,
      countPeriods,
    }),
    rounds,
    activeCount: active,
    cumulative: cumulativeViews,
    historicalTasks,
  };
}

function buildCalendar(input: {
  data: BackupDataSet;
  order: OrderRow;
  periods: HostingPeriodRow[];
  tasks: TaskDefinitionRow[];
  occurrences: TaskOccurrenceRow[];
  events: TaskProgressEventRow[];
  sessions: HostingSessionRow[];
  today: string;
  countPeriods: HostingPeriodRow[];
}): OrderDetailView['calendar'] {
  const { data, order, periods, tasks, occurrences, events, sessions, today, countPeriods } = input;
  if (countPeriods.length > 0) {
    return sessions.flatMap((session) => {
      const period = periods.find((row) => row.id === session.periodId);
      if (!period || period.serviceCount === null) return [];
      const progress = roundProgress({
        session,
        period,
        tasks,
        occurrences,
        events,
        fallbackDate: today,
      });
      const eventCountByTask = new Map<string, number>();
      for (const event of events) {
        if (event.scopeType !== 'SESSION' || event.scopeSessionId !== session.id) continue;
        eventCountByTask.set(
          event.taskDefinitionId,
          (eventCountByTask.get(event.taskDefinitionId) ?? 0) + 1,
        );
      }
      return [
        {
          gameDate: progress.attributedDate ?? today,
          sessionIndex: session.sessionIndex,
          tasks: progress.states.map((state) => {
            const task = progress.dueTasks.find((row) => row.id === state.taskId);
            const occurrence =
              occurrences.find(
                (row) =>
                  row.taskDefinitionId === state.taskId &&
                  row.occurrenceKey === roundKey(session.sessionIndex),
              ) ?? null;
            return {
              taskId: state.taskId,
              title: task?.title ?? '任务',
              occurrenceId: occurrence?.id ?? null,
              completed: state.satisfied,
              backfilled: occurrence?.backfilled === 1,
              value: state.currentValue,
              attachmentCount: occurrence
                ? data.attachments.filter((row) => row.occurrenceId === occurrence.id).length
                : 0,
              cumulative: Boolean(task && isCumulativeTask(task)),
              reachedTarget: state.reachedTarget,
              eventCount: eventCountByTask.get(state.taskId) ?? 0,
              attributedDate: progress.attributedDate ?? today,
              inWindow: false,
            };
          }),
        },
      ];
    });
  }

  const period = [...periods].sort((left, right) => right.periodIndex - left.periodIndex)[0];
  if (!period) return [];
  const start = period.startDate;
  const end = period.endDate;
  const days: OrderDetailView['calendar'] = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 400) {
    const dayTasks = tasks
      .filter((task) => task.periodId === period.id)
      .flatMap((task) => {
        const cumulative = isCumulativeTask(task);
        const scope: ProgressScope = { kind: 'PERIOD', periodId: period.id };
        if (cumulative) {
          if (cursor < (task.activeFrom ?? start)) return [];
          if (task.activeUntil !== null && cursor > task.activeUntil) return [];
          const total = resolveScopeTotal(events, task.id, scope, task.startValue, cursor);
          return [
            {
              taskId: task.id,
              title: task.title,
              occurrenceId: null,
              completed: reachedTarget(total, task.targetValue),
              backfilled: false,
              value: total,
              attachmentCount: 0,
              cumulative: true,
              reachedTarget: reachedTarget(total, task.targetValue),
              eventCount: events.filter(
                (event) => event.taskDefinitionId === task.id && event.gameDate === cursor,
              ).length,
              attributedDate: cursor,
              inWindow: false,
            },
          ];
        }
        if (isSingleShotTask(task)) {
          // 一次性任务没有排期：只把真正记过的那一天画出来（点它可撤销/更正）。
          const occurrence =
            occurrences.find(
              (row) =>
                row.taskDefinitionId === task.id && row.occurrenceKey === onceSlotKey(cursor),
            ) ?? null;
          if (!occurrence) return [];
          return [
            {
              taskId: task.id,
              title: task.title,
              occurrenceId: occurrence.id,
              completed: occurrence.completedAt !== null,
              backfilled: occurrence.backfilled === 1,
              value: occurrence.value,
              attachmentCount: data.attachments.filter(
                (row) => row.occurrenceId === occurrence.id,
              ).length,
              cumulative: false,
              reachedTarget: occurrence.completedAt !== null,
              eventCount: 0,
              attributedDate: occurrence.gameDate,
              inWindow: false,
            },
          ];
        }
        // 读取用覆盖槽：每月 / 每 N 天任务在其周期窗口内每天都能看到状态，
        // 但 occurrence 仍只有触发日那一条（key / gameDate 都是触发日）。
        const slot = coverageSlotFor(task, period, cursor);
        if (!slot) return [];
        const occurrence = occurrences.find(
          (row) => row.taskDefinitionId === task.id && row.occurrenceKey === slot.key,
        );
        return [
          {
            taskId: task.id,
            title: task.title,
            occurrenceId: occurrence?.id ?? null,
            completed: Boolean(occurrence?.completedAt),
            backfilled: occurrence?.backfilled === 1,
            value: occurrence?.value ?? null,
            attachmentCount: occurrence
              ? data.attachments.filter((row) => row.occurrenceId === occurrence.id).length
              : 0,
            cumulative: false,
            reachedTarget: Boolean(occurrence?.completedAt),
            eventCount: 0,
            attributedDate: slot.gameDate,
            // 每周任务本来就整窗展示（历史行为），不标记为"窗口覆盖"，避免改变既有格子口径。
            inWindow: task.recurrence !== 'WEEKLY' && slot.gameDate !== cursor,
          },
        ];
      });
    if (dayTasks.length > 0) days.push({ gameDate: cursor, sessionIndex: null, tasks: dayTasks });
    cursor = addOneDay(cursor);
    guard += 1;
  }
  void order;
  return days;
}

function addOneDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, day + 1));
  return `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}-${String(
    stamp.getUTCDate(),
  ).padStart(2, '0')}`;
}

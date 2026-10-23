import { AppError } from '../contracts/errors';
import type {
  BackupDataSet,
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  TaskDefinitionRow,
  TaskProgressEventRow,
} from '../contracts/tables';
import { parseDecimal } from '../domain/decimal';
import { countPeriodServiceStart, resolveActiveCountSession, selectActiveSession } from '../domain/countSessions';
import { gameDateAt, isISODate, isoWeekday } from '../domain/gameCalendar';
import { parseWeekdays } from '../domain/occurrences';
import {
  allowedScopeKind,
  reachedTarget,
  resolveEffectiveEvent,
  resolveScopeTotal,
  sameScope,
  scopeKey,
  scopeOfEvent,
  type ProgressScope,
} from '../domain/progressEvents';
import {
  calendarGameDate,
  scopeCalendar,
  type ScopeCalendar,
} from '../domain/scopeCalendar';
import type { DatasetRuntime, DatasetToken, WriteContext } from '../storage/datasetRuntime';
import { persistOrderDerived } from './derived';
import {
  assertOrderWritable,
  mustFindOrder,
} from './guards';
import type {
  CorrectProgressCommand,
  ProgressEventResult,
  ProgressHistoryEntry,
  ProgressScopeInput,
  SubmitProgressCommand,
} from './contracts';

export interface CumulativeDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

export function isCumulativeTask(task: TaskDefinitionRow): boolean {
  return task.progressType === 'NUMERIC' && task.numericMode === 'CUMULATIVE';
}

export function todayGameDate(order: OrderRow, nowMs: number): string {
  return gameDateAt(nowMs, order.gameZoneId, order.dailyRefreshMinutes);
}

function taskOf(data: BackupDataSet, taskId: string): TaskDefinitionRow {
  const task = data.task_definitions.find((row) => row.id === taskId);
  if (!task) throw new AppError('NOT_FOUND', '任务不存在');
  return task;
}

function assertCumulativeTask(task: TaskDefinitionRow): void {
  if (!isCumulativeTask(task)) {
    throw new AppError(
      'INVALID_INPUT',
      `任务「${task.title}」不是累计目标；普通周期任务请用打卡完成`,
    );
  }
}

/** SESSION 输入省略 sessionId 时返回 null（表示"事务内 ensure 当前轮次"）。 */
function scopeOfInput(input: ProgressScopeInput): ProgressScope | null {
  if (input.kind === 'TASK') return { kind: 'TASK' };
  if (input.kind === 'PERIOD') return { kind: 'PERIOD', periodId: input.periodId };
  const sessionId = input.sessionId ?? null;
  return sessionId ? { kind: 'SESSION', sessionId } : null;
}

function scopeMatchesEvent(event: TaskProgressEventRow, input: ProgressScopeInput): boolean {
  if (event.scopeType !== input.kind) return false;
  if (input.kind === 'PERIOD') return event.scopePeriodId === input.periodId;
  if (input.kind === 'SESSION') {
    return input.sessionId == null || event.scopeSessionId === input.sessionId;
  }
  return true;
}

function normalizeValue(value: string): string {
  return parseDecimal(value).units.toString();
}

/**
 * 任务的退休**游戏日**（含当天仍可归属，之后为新的归属）。
 *
 * 日历必须来自 scope 的刷新快照：用订单口径去判定期次日期，会让"今天"、退休边界与
 * 服务日起点彼此不一致（R1-3）。
 */
export function retirementGameDate(
  task: TaskDefinitionRow,
  calendar: ScopeCalendar,
): string | null {
  if (task.retiredAt === null) return null;
  return calendarGameDate(calendar, task.retiredAt);
}

/**
 * 累计总值的唯一数值边界（契约 `submitProgress.bounds`）。
 *
 * 输入是**当前累计总值**，因此不接受负数；上限与小数位交给共享的 `parseDecimal`
 * （绝对值 1000000000000 / 最多 3 位小数）。返回缩放单位文本，仅用于幂等比较。
 */
export function parseCumulativeTotal(value: string | null): string {
  if (value === null) throw new AppError('INVALID_INPUT', '必须填写当前累计总值');
  const parsed = parseDecimal(value);
  if (parsed.units < 0n) {
    throw new AppError(
      'INVALID_INPUT',
      '当前累计总值不能是负数：这里填的是累计总值，不是本次扣减量',
    );
  }
  return parsed.units.toString();
}

/**
 * 写入前的 scope 校验（与 `validateProgressEvents` 同一套规则）。
 *
 * 顺序固定（R1）：①scope 归属与模式矩阵 → ②scope 自己的日历快照（期次优先）→
 * ③scope 的服务窗口 → ④任务生效区间 → ⑤退休游戏日（含当天）→ ⑥服务星期。
 *
 * - 计次期次的服务下界是 `countPeriodServiceStart`，`startDate/endDate` 只是内部锚点，
 *   同日续期不推迟服务，也不存在"计次到期日"（CD-02 / F1）；
 * - 服务星期只看期次的 `serviceWeekdays`，与任务的重复触发日无关（UF-038）；
 * - 退休不是"永久只读"：退休日当天仍可归属，之后的日期是新的工作记录，一律拒绝。
 */
export function assertScopeForWrite(
  data: BackupDataSet,
  task: TaskDefinitionRow,
  order: OrderRow,
  scope: ProgressScope,
  gameDate: string,
  nowMs: number,
): { period: HostingPeriodRow | null; session: HostingSessionRow | null } {
  if (!isISODate(gameDate)) throw new AppError('INVALID_INPUT', '游戏日期不合法');
  const allowed = allowedScopeKind(order.type, order.hostingMode);
  if (scope.kind !== allowed) {
    throw new AppError(
      'SCOPE_NOT_ALLOWED',
      `该订单只允许 ${allowed} 范围的累计进度（当前 ${scope.kind}）`,
    );
  }

  // ① scope 归属（先于任何日期判断，日历必须由归属对象给出）。
  let period: HostingPeriodRow | null = null;
  let session: HostingSessionRow | null = null;
  if (scope.kind === 'TASK') {
    if (order.type !== 'SHORT_TASK' || task.periodId !== null) {
      throw new AppError('SCOPE_NOT_ALLOWED', 'TASK 范围只属于短期单任务');
    }
  } else if (scope.kind === 'PERIOD') {
    period = data.hosting_periods.find((row) => row.id === scope.periodId) ?? null;
    if (!period || period.orderId !== order.id) {
      throw new AppError('INVALID_INPUT', '期次不属于该订单');
    }
    if (period.serviceCount !== null) {
      throw new AppError('SCOPE_NOT_ALLOWED', '计次期次不接受期次范围的累计进度');
    }
    if (task.periodId !== period.id) {
      throw new AppError('INVALID_INPUT', '期次范围必须与任务所属期次一致');
    }
  } else {
    session = data.hosting_sessions.find((row) => row.id === scope.sessionId) ?? null;
    if (!session || session.orderId !== order.id) {
      throw new AppError('INVALID_INPUT', '轮次不属于该订单');
    }
    period = data.hosting_periods.find((row) => row.id === session!.periodId) ?? null;
    if (!period || period.serviceCount === null || period.orderId !== order.id) {
      throw new AppError('INVALID_INPUT', '轮次所属期次不是该订单的计次期次');
    }
    if (task.periodId !== session.periodId) {
      throw new AppError('INVALID_INPUT', '任务与轮次不属于同一期次');
    }
  }

  // ② 日历：期次快照优先，短期单才用订单口径。
  const calendar = scopeCalendar(period, order);
  const today = calendarGameDate(calendar, nowMs);
  if (gameDate > today) throw new AppError('INVALID_INPUT', '不能为未来日期记录累计进度');

  // ③ scope 的服务窗口。
  if (period !== null) {
    if (period.serviceCount === null) {
      if (gameDate < period.startDate || gameDate > period.endDate) {
        throw new AppError(
          'OUT_OF_SERVICE_RANGE',
          `该日期不在期次服务期限 ${period.startDate} ~ ${period.endDate} 内`,
        );
      }
    } else {
      const serviceStart = countPeriodServiceStart(period);
      if (gameDate < serviceStart) {
        throw new AppError('OUT_OF_SERVICE_RANGE', `该日期早于期次服务起点 ${serviceStart}`);
      }
    }
  }

  // ④ 任务生效区间（两端含）。
  if (task.activeFrom !== null && gameDate < task.activeFrom) {
    throw new AppError('OUT_OF_SERVICE_RANGE', `该日期早于任务生效起始日 ${task.activeFrom}`);
  }
  if (task.activeUntil !== null && gameDate > task.activeUntil) {
    throw new AppError('OUT_OF_SERVICE_RANGE', `该日期晚于任务生效截止日 ${task.activeUntil}`);
  }

  // ⑤ 退休边界：退休游戏日当天仍可归属（与 `dueTasksOn` 同一规则）。
  const retired = retirementGameDate(task, calendar);
  if (retired !== null && gameDate > retired) {
    throw new AppError(
      'OUT_OF_SERVICE_RANGE',
      `该任务已于 ${retired} 移除，只能在移除日及以前记录或更正`,
    );
  }

  // ⑥ 服务星期：只按期次的 serviceWeekdays；任务重复触发日不参与资格判定。
  const weekdays = parseWeekdays(period?.serviceWeekdays ?? null);
  if (weekdays.length > 0 && !weekdays.includes(isoWeekday(gameDate))) {
    throw new AppError(
      'OUT_OF_SERVICE_RANGE',
      `该日期不是本期的服务日（服务星期：${period?.serviceWeekdays ?? ''}）`,
    );
  }

  return { period, session };
}

/**
 * 只校验 scope 的**归属与矩阵**（查询用；查询不改数据，也不应因当前日期而失败）。
 */
export function assertScopeOwnership(
  data: BackupDataSet,
  task: TaskDefinitionRow,
  order: OrderRow,
  scope: ProgressScope,
): void {
  const allowed = allowedScopeKind(order.type, order.hostingMode);
  if (scope.kind !== allowed) {
    throw new AppError('SCOPE_NOT_ALLOWED', `该订单只允许 ${allowed} 范围的累计进度`);
  }
  if (scope.kind === 'TASK') {
    if (order.type !== 'SHORT_TASK' || task.periodId !== null) {
      throw new AppError('SCOPE_NOT_ALLOWED', 'TASK 范围只属于短期单任务');
    }
    return;
  }
  if (scope.kind === 'PERIOD') {
    const period = data.hosting_periods.find((row) => row.id === scope.periodId);
    if (!period || period.orderId !== order.id) {
      throw new AppError('INVALID_INPUT', '期次不属于该订单');
    }
    if (period.serviceCount !== null) {
      throw new AppError('SCOPE_NOT_ALLOWED', '计次期次不接受期次范围的累计进度');
    }
    if (task.periodId !== period.id) {
      throw new AppError('INVALID_INPUT', '期次范围必须与任务所属期次一致');
    }
    return;
  }
  const session = data.hosting_sessions.find((row) => row.id === scope.sessionId);
  if (!session || session.orderId !== order.id) {
    throw new AppError('INVALID_INPUT', '轮次不属于该订单');
  }
  const period = data.hosting_periods.find((row) => row.id === session.periodId);
  if (!period || period.serviceCount === null || period.orderId !== order.id) {
    throw new AppError('INVALID_INPUT', '轮次所属期次不是该订单的计次期次');
  }
  if (task.periodId !== session.periodId) {
    throw new AppError('INVALID_INPUT', '任务与轮次不属于同一期次');
  }
}

function nextSequence(events: TaskProgressEventRow[], taskId: string): number {
  let max = 0;
  for (const event of events) {
    if (event.taskDefinitionId === taskId && event.sequence > max) max = event.sequence;
  }
  return max + 1;
}

function chainOf(data: BackupDataSet, taskId: string): TaskProgressEventRow[] {
  return data.task_progress_events.filter((event) => event.taskDefinitionId === taskId);
}

/** scope 的人类可读标签（"第 N 次打卡" / "第 N 期" / "整单目标"）。 */
export function scopeLabelOf(data: BackupDataSet, scope: ProgressScope): string {
  if (scope.kind === 'TASK') return '整单目标';
  if (scope.kind === 'PERIOD') {
    const period = data.hosting_periods.find((row) => row.id === scope.periodId);
    return period ? `第 ${period.periodIndex + 1} 期` : '本期目标';
  }
  const session = data.hosting_sessions.find((row) => row.id === scope.sessionId);
  return session ? `第 ${session.sessionIndex} 次打卡` : '未知轮次';
}

/**
 * 一个任务的追加式事件历史（含被取代关系与"当前有效观测"标记）。
 *
 * `effective` 只表示"是否决定当前显示总值"，**不是**可更正性：较早日期未被取代的
 * 观测可能因为更晚的绝对值而失去 `effective`，但它仍可被更正/撤销（单后继规则）。
 * 因此可编辑性单独由 `correctable` 表达：
 * - 已被任何事件（含 RETRACT）指向 → 不能再追加后继（契约 `supersedeGuard`）；
 * - 自身是 RETRACT → 不提供"更正撤销"，否则会把撤回变成一个可复活的取值（不复活旧值）。
 *
 * 只读：不修改任何行，也不为缺失的 scope 造事件。
 */
export function progressHistoryOf(
  data: BackupDataSet,
  taskId: string,
): ProgressHistoryEntry[] {
  const events = chainOf(data, taskId).sort((left, right) => left.sequence - right.sequence);
  const supersededBy = new Map<string, string>();
  for (const event of events) {
    if (event.correctsEventId) supersededBy.set(event.correctsEventId, event.id);
  }
  const scopes = new Map<string, ProgressScope>();
  for (const event of events) {
    const scope = scopeOfEvent(event);
    scopes.set(scopeKey(scope), scope);
  }
  const winners = new Set<string>();
  for (const [, scope] of scopes) {
    const winner = resolveEffectiveEvent(events, taskId, scope);
    if (winner) winners.add(winner.id);
  }
  return events.map((event) => {
    const scope = scopeOfEvent(event);
    const superseded = supersededBy.get(event.id) ?? null;
    return {
      id: event.id,
      kind: event.kind,
      scope,
      scopeLabel: scopeLabelOf(data, scope),
      gameDate: event.gameDate,
      totalValue: event.totalValue,
      sequence: event.sequence,
      correctsEventId: event.correctsEventId,
      recordedAt: event.recordedAt,
      supersededBy: superseded,
      effective: winners.has(event.id),
      correctable: superseded === null && event.kind !== 'RETRACT',
    };
  });
}

function resultOf(
  event: TaskProgressEventRow,
  events: TaskProgressEventRow[],
  task: TaskDefinitionRow,
  alreadyApplied: boolean,
): ProgressEventResult {
  const scope = scopeOfEvent(event);
  const currentTotal = resolveScopeTotal(events, task.id, scope, task.startValue);
  return {
    eventId: event.id,
    taskId: task.id,
    kind: event.kind,
    scope,
    totalValue: event.totalValue,
    currentTotal,
    reachedTarget: reachedTarget(currentTotal, task.targetValue),
    alreadyApplied,
  };
}

/** 五种缓存状态中的活动状态（写入路径只关心轮次是否存在/是否可分配）。 */
export function activeStateOf(data: BackupDataSet, orderId: string) {
  return resolveActiveCountSession(
    orderId,
    data.hosting_periods.filter((period) => period.orderId === orderId),
    data.hosting_sessions.filter((session) => session.orderId === orderId),
  );
}

export interface EnsureDeps {
  newId: () => string;
  now: () => number;
}

/**
 * 事务内 ensure 一个轮次（F1 / D-26 / F4）。
 *
 * 检查顺序：数据集代号（runtime 已比较）→ 订单/期次归属与归档/作废守卫 →
 * **已存在轮次原样返回** → 只有新轮次才判"订单已完成/期次已满"。
 */
export async function ensureSessionForWrite(
  ctx: WriteContext,
  deps: EnsureDeps,
  order: OrderRow,
  periodId: string,
  requested: number | null,
): Promise<{ session: HostingSessionRow; created: boolean }> {
  const period = ctx.data.hosting_periods.find(
    (row) => row.id === periodId && row.orderId === order.id,
  );
  if (!period) throw new AppError('NOT_FOUND', '期次不属于该订单');
  if (period.serviceCount === null) {
    throw new AppError('INVALID_INPUT', '该期次不是按次数服务，没有轮次');
  }
  const orderSessions = ctx.data.hosting_sessions
    .filter((session) => session.orderId === order.id)
    .sort((left, right) => left.sessionIndex - right.sessionIndex);

  if (requested !== null) {
    const existing = orderSessions.find((session) => session.sessionIndex === requested);
    if (existing) {
      if (existing.periodId !== period.id) {
        throw new AppError('CONFLICT', `轮次 ${requested} 属于别的期次，不能跨期次复用`);
      }
      return { session: existing, created: false };
    }
    const choice = selectActiveSession(orderSessions, period.id, period.serviceCount);
    if (choice.kind !== 'ALLOCATE_NEW' || choice.sessionIndex !== requested) {
      throw new AppError('CONFLICT', `轮次 ${requested} 不是当前可分配的轮次号`);
    }
  }

  if (requested === null) {
    const choice = selectActiveSession(orderSessions, period.id, period.serviceCount);
    if (choice.kind === 'REUSE_EXISTING') {
      const existing = orderSessions.find(
        (session) =>
          session.periodId === period.id && session.sessionIndex === choice.sessionIndex,
      );
      if (existing) return { session: existing, created: false };
    }
    if (choice.kind === 'PERIOD_FULL') {
      throw new AppError('CONFLICT', '本期的打卡次数已全部完成，请先续期或调整目标');
    }
    if (choice.kind === 'INDEX_SPACE_EXHAUSTED') {
      throw new AppError('SESSION_INDEX_EXHAUSTED', '轮次号已达到上限，不能新建轮次');
    }
    requested = choice.sessionIndex;
  }

  if (order.completedAt !== null) {
    throw new AppError('CONFLICT', '订单已完成，不能开始新的轮次');
  }

  const session: HostingSessionRow = {
    id: deps.newId(),
    orderId: order.id,
    sessionIndex: requested,
    createdAt: deps.now(),
    completedAt: null,
    completionBatchId: null,
    periodId: period.id,
  };
  await ctx.table('hosting_sessions').add(session);
  // 事务内后续读取（校验/派生）必须立刻看到新行。
  ctx.data.hosting_sessions.push(session);
  return { session, created: true };
}

/** 事务内取活动轮次；待建行时按已分配号建行。 */
export async function ensureActiveSessionForWrite(
  ctx: WriteContext,
  deps: EnsureDeps,
  order: OrderRow,
): Promise<HostingSessionRow> {
  const state = activeStateOf(ctx.data, order.id);
  if (state.kind === 'ALL_PERIODS_COMPLETE') {
    throw new AppError('CONFLICT', '该订单没有进行中的按次数期次');
  }
  if (state.kind === 'INDEX_SPACE_EXHAUSTED') {
    throw new AppError('SESSION_INDEX_EXHAUSTED', '轮次号已达到上限，不能新建轮次');
  }
  if (state.kind === 'ACTIVE_SESSION') {
    const session = ctx.data.hosting_sessions.find((row) => row.id === state.sessionId);
    if (session) return session;
  }
  const awaiting = state as { periodId: string; sessionIndex: number };
  const ensured = await ensureSessionForWrite(
    ctx,
    deps,
    order,
    awaiting.periodId,
    awaiting.sessionIndex,
  );
  return ensured.session;
}

export function createCumulativeServices({ runtime, newId, now }: CumulativeDeps) {
  const deps: EnsureDeps = { newId, now };
  const ensureSessionInWrite = (
    ctx: WriteContext,
    order: OrderRow,
    periodId: string,
    requested: number | null,
  ) => ensureSessionForWrite(ctx, deps, order, periodId, requested);
  const ensureActiveSession = (ctx: WriteContext, order: OrderRow) =>
    ensureActiveSessionForWrite(ctx, deps, order);

  function requireScope(
    data: BackupDataSet,
    task: TaskDefinitionRow,
    order: OrderRow,
    input: ProgressScopeInput,
    gameDate: string,
    nowMs: number,
  ): ProgressScope {
    const scope = scopeOfInput(input);
    if (scope === null) {
      throw new AppError('INVALID_INPUT', '请指定要记录的轮次');
    }
    assertScopeForWrite(data, task, order, scope, gameDate, nowMs);
    return scope;
  }

  /** 查询路径：只校验归属（不因"今天不在服务期"而让历史读数失败）。 */
  function scopeForQuery(
    data: BackupDataSet,
    task: TaskDefinitionRow,
    input: ProgressScopeInput,
  ): ProgressScope {
    const scope = scopeOfInput(input);
    if (scope === null) {
      throw new AppError('INVALID_INPUT', '请指定要读取的轮次');
    }
    assertScopeOwnership(data, task, mustFindOrder(data, task.orderId), scope);
    return scope;
  }

  return {
    async submit(input: SubmitProgressCommand, token: DatasetToken): Promise<ProgressEventResult> {
      // 数值边界（0..1e12 / 最多 3 位小数）在事务之前完成：非法输入不触碰任何行。
      parseCumulativeTotal(input.totalValue);
      return runtime.write(token, async (ctx) => {
        const task = taskOf(ctx.data, input.taskId);
        const order = assertOrderWritable(ctx.data, task.orderId);
        assertCumulativeTask(task);
        if (!isISODate(input.gameDate)) throw new AppError('INVALID_INPUT', '游戏日期不合法');

        // ② operationId 先于任何"当前范围"解析：同载荷重试返回首次结果。
        const existing = ctx.data.task_progress_events.find(
          (event) => event.operationId === input.operationId,
        );
        if (existing) {
          const samePayload =
            existing.taskDefinitionId === task.id &&
            existing.kind === 'SUBMIT' &&
            existing.gameDate === input.gameDate &&
            (existing.totalValue === null
              ? false
              : normalizeValue(existing.totalValue) === normalizeValue(input.totalValue)) &&
            scopeMatchesEvent(existing, input.scope) &&
            existing.correctsEventId === null;
          if (!samePayload) {
            throw new AppError('CONFLICT', '同一操作编号的累计进度内容不同，已拒绝');
          }
          return resultOf(existing, ctx.data.task_progress_events, task, true);
        }

        let scope: ProgressScope;
        if (input.scope.kind === 'SESSION' && (input.scope.sessionId ?? null) === null) {
          // scope 矩阵先于"取当前轮次"：按日期/短期单不能借 SESSION 绕过每轮目标。
          if (allowedScopeKind(order.type, order.hostingMode) !== 'SESSION') {
            throw new AppError('SCOPE_NOT_ALLOWED', '该订单不允许按轮次记录累计进度');
          }
          const session = await ensureActiveSession(ctx, order);
          scope = { kind: 'SESSION', sessionId: session.id };
          assertScopeForWrite(ctx.data, task, order, scope, input.gameDate, now());
        } else {
          scope = requireScope(ctx.data, task, order, input.scope, input.gameDate, now());
        }

        // 已完成轮次不再接受**新**观测：不重定向到别的轮次，也不静默改历史；
        // 要改旧值请用 CORRECT/RETRACT（它们会按证据重开轮次）。
        if (scope.kind === 'SESSION') {
          const session = ctx.data.hosting_sessions.find((row) => row.id === scope.sessionId);
          if (session && session.completedAt !== null) {
            throw new AppError(
              'CONFLICT',
              '该轮次已完成：请更正历史事件，或继续记录下一轮',
            );
          }
        }

        const event: TaskProgressEventRow = {
          id: newId(),
          taskDefinitionId: task.id,
          operationId: input.operationId,
          kind: 'SUBMIT',
          scopeType: scope.kind,
          scopePeriodId: scope.kind === 'PERIOD' ? scope.periodId : null,
          scopeSessionId: scope.kind === 'SESSION' ? scope.sessionId : null,
          gameDate: input.gameDate,
          totalValue: input.totalValue,
          sequence: nextSequence(ctx.data.task_progress_events, task.id),
          correctsEventId: null,
          recordedAt: now(),
          createdAt: now(),
        };
        await ctx.table('task_progress_events').add(event);
        ctx.data.task_progress_events.push(event);

        // ③–⑦ 同一事务内：轮次完成态 → 活动范围 → 缓存 → 订单标志。
        await persistOrderDerived(ctx, order.id);

        return resultOf(event, ctx.data.task_progress_events, task, false);
      });
    },

    async correct(input: CorrectProgressCommand, token: DatasetToken): Promise<ProgressEventResult> {
      if (input.kind === 'CORRECT') {
        // 与 SUBMIT 同一套边界：非负、共享上限、最多 3 位小数。
        parseCumulativeTotal(input.totalValue);
      } else if (input.totalValue !== null) {
        throw new AppError('INVALID_INPUT', '撤销不需要填写数值');
      }

      return runtime.write(token, async (ctx) => {
        const existing = ctx.data.task_progress_events.find(
          (event) => event.operationId === input.operationId,
        );
        if (existing) {
          const samePayload =
            existing.correctsEventId === input.correctsEventId &&
            existing.kind === input.kind &&
            (existing.totalValue === null
              ? input.totalValue === null
              : input.totalValue !== null &&
                normalizeValue(existing.totalValue) === normalizeValue(input.totalValue)) &&
            (input.scope === undefined || scopeMatchesEvent(existing, input.scope)) &&
            existing.gameDate === input.gameDate;
          if (!samePayload) {
            throw new AppError('CONFLICT', '同一操作编号的更正内容不同，已拒绝');
          }
          // R4：重放**先过安全守卫**再返回原结果。数据集代号已在 runtime 边界比较；
          // 这里补齐被重放事件所属的订单/归属守卫，避免归档/作废/归档账号的历史命令
          // 借"重试"继续被当作成功。只做读取与拒绝，绝不追加事件或刷新派生值。
          const replayed = taskOf(ctx.data, existing.taskDefinitionId);
          assertCumulativeTask(replayed);
          assertOrderWritable(ctx.data, replayed.orderId);
          return resultOf(existing, ctx.data.task_progress_events, replayed, true);
        }

        const target = ctx.data.task_progress_events.find(
          (event) => event.id === input.correctsEventId,
        );
        if (!target) throw new AppError('NOT_FOUND', '被更正的事件不存在');
        const task = taskOf(ctx.data, target.taskDefinitionId);
        const order = assertOrderWritable(ctx.data, task.orderId);
        assertCumulativeTask(task);

        // 更正链：被任何事件指向者即被取代，只允许撤回**有效叶子**（F4）。
        const superseded = ctx.data.task_progress_events.some(
          (event) => event.correctsEventId === target.id,
        );
        if (superseded) {
          throw new AppError('SUPERSEDED_EVENT', '该事件已被更正，不能再追加新的更正；请更正最新一条');
        }
        if (target.gameDate !== input.gameDate) {
          throw new AppError(
            'INVALID_INPUT',
            `更正必须沿用原事件的归属日期 ${target.gameDate}；要改日期请先撤回再重新记录`,
          );
        }
        const targetScope = scopeOfEvent(target);
        if (input.scope !== undefined) {
          // SESSION 省略 sessionId = "沿用被更正事件的轮次"（更正不指定新范围）。
          const inheritSession =
            input.scope.kind === 'SESSION' && (input.scope.sessionId ?? null) === null;
          if (inheritSession) {
            if (target.scopeType !== 'SESSION') {
              throw new AppError('INVALID_INPUT', '原事件不是轮次范围，不能按轮次更正');
            }
          } else {
            const inputScope = scopeOfInput(input.scope);
            if (inputScope === null || !sameScope(inputScope, targetScope)) {
              throw new AppError('INVALID_INPUT', '更正不得跨范围；请对准原事件的轮次/期次');
            }
          }
        }
        // 归属日不可变：沿用原事件的 scope 与日期再校验一次服务区间与生命周期。
        assertScopeForWrite(ctx.data, task, order, targetScope, target.gameDate, now());

        const event: TaskProgressEventRow = {
          id: newId(),
          taskDefinitionId: task.id,
          operationId: input.operationId,
          kind: input.kind,
          scopeType: target.scopeType,
          scopePeriodId: target.scopePeriodId,
          scopeSessionId: target.scopeSessionId,
          gameDate: target.gameDate,
          totalValue: input.kind === 'RETRACT' ? null : input.totalValue,
          sequence: nextSequence(ctx.data.task_progress_events, task.id),
          correctsEventId: target.id,
          recordedAt: now(),
          createdAt: now(),
        };
        await ctx.table('task_progress_events').add(event);
        ctx.data.task_progress_events.push(event);

        await persistOrderDerived(ctx, order.id);
        return resultOf(event, ctx.data.task_progress_events, task, false);
      });
    },

    async currentTotal(input: {
      taskId: string;
      scope: ProgressScopeInput;
    }): Promise<{ total: string; reachedTarget: boolean }> {
      return runtime.read((ctx) => {
        const task = taskOf(ctx.data, input.taskId);
        const scope = scopeForQuery(ctx.data, task, input.scope);
        const total = resolveScopeTotal(
          ctx.data.task_progress_events,
          task.id,
          scope,
          task.startValue,
        );
        return { total, reachedTarget: reachedTarget(total, task.targetValue) };
      });
    },

    async totalAsOf(input: {
      taskId: string;
      scope: ProgressScopeInput;
      asOfGameDate: string;
    }): Promise<{ total: string; reachedTarget: boolean }> {
      if (!isISODate(input.asOfGameDate)) {
        throw new AppError('INVALID_INPUT', '查询日期不合法');
      }
      return runtime.read((ctx) => {
        const task = taskOf(ctx.data, input.taskId);
        const scope = scopeForQuery(ctx.data, task, input.scope);
        const total = resolveScopeTotal(
          ctx.data.task_progress_events,
          task.id,
          scope,
          task.startValue,
          input.asOfGameDate,
        );
        return { total, reachedTarget: reachedTarget(total, task.targetValue) };
      });
    },

    async history(taskId: string): Promise<ProgressHistoryEntry[]> {
      return runtime.read((ctx) => {
        taskOf(ctx.data, taskId);
        return progressHistoryOf(ctx.data, taskId);
      });
    },

    async updateNumericMode(
      input: { taskId: string; mode: 'PER_OCCURRENCE' | 'CUMULATIVE' },
      token: DatasetToken,
    ): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const task = taskOf(ctx.data, input.taskId);
        assertOrderWritable(ctx.data, task.orderId);
        if (input.mode === 'CUMULATIVE' && task.progressType !== 'NUMERIC') {
          throw new AppError('INVALID_INPUT', '只有数值任务可以使用累计目标');
        }
        if (task.numericMode === input.mode) return;
        const hasOccurrences = ctx.data.task_occurrences.some(
          (row) => row.taskDefinitionId === task.id,
        );
        const hasEvents = ctx.data.task_progress_events.some(
          (row) => row.taskDefinitionId === task.id,
        );
        if (hasOccurrences || hasEvents) {
          throw new AppError(
            'CONFLICT',
            '该任务已有进度记录，不能就地切换数值口径；请新建任务并保留旧任务',
          );
        }
        const next: TaskDefinitionRow = {
          ...task,
          numericMode: input.mode,
          currentValue: task.progressType === 'NUMERIC' ? task.startValue : task.currentValue,
          updatedAt: now(),
        };
        await ctx.table('task_definitions').put(next);
        await persistOrderDerived(ctx, task.orderId);
      });
    },

    async ensureSession(
      input: { orderId: string; periodId: string; requestedSessionIndex?: number | null },
      token: DatasetToken,
    ): Promise<{ sessionId: string; sessionIndex: number; created: boolean }> {
      return runtime.write(token, async (ctx) => {
        // 守卫先于既有行返回；完成/满员判定在其后（F4）。
        const order = assertOrderWritable(ctx.data, input.orderId);
        if (order.type !== 'HOSTING') throw new AppError('INVALID_INPUT', '短期单没有打卡轮次');
        const ensured = await ensureSessionInWrite(
          ctx,
          order,
          input.periodId,
          input.requestedSessionIndex ?? null,
        );
        if (ensured.created) await persistOrderDerived(ctx, order.id);
        return {
          sessionId: ensured.session.id,
          sessionIndex: ensured.session.sessionIndex,
          created: ensured.created,
        };
      });
    },

    async reopenSession(
      input: { orderId: string; sessionIndex: number },
      token: DatasetToken,
    ): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const order = assertOrderWritable(ctx.data, input.orderId);
        const session = ctx.data.hosting_sessions.find(
          (row) => row.orderId === order.id && row.sessionIndex === input.sessionIndex,
        );
        if (!session) throw new AppError('NOT_FOUND', '轮次不存在');
        if (session.completedAt === null) return;
        const period = ctx.data.hosting_periods.find((row) => row.id === session.periodId);
        const tasks = ctx.data.task_definitions.filter(
          (task) => task.orderId === order.id && task.periodId === session.periodId,
        );
        if (tasks.some((task) => isCumulativeTask(task)) && period) {
          throw new AppError(
            'CONFLICT',
            '该轮含累计任务：请用「累计进度」的更正/撤销重开，不能直接撤销本轮',
          );
        }
        session.completedAt = null;
        session.completionBatchId = null;
        await ctx.table('hosting_sessions').put(session);
        await persistOrderDerived(ctx, order.id);
      });
    },

    /** 供写路径复用（今日/批量完成/历史补记）。 */
    ensureSessionInWrite,
    ensureActiveSession,
  };
}

import { AppError } from '../contracts/errors';
import type {
  CompletionBatchItemRow,
  CompletionBatchRow,
  HostingPeriodRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
} from '../contracts/tables';
import { countPeriodServiceStart } from '../domain/countSessions';
import {
  roundAttributedDate,
  roundDueTasks,
  roundFallbackDate,
  roundIndexFromKey,
  roundKey,
} from '../domain/countRounds';
import { compareDecimal, parseDecimal } from '../domain/decimal';
import { gameDateAt, isISODate } from '../domain/gameCalendar';
import { periodScheduleEnd, slotFor } from '../domain/occurrences';
import { reachedTarget, resolveScopeTotal } from '../domain/progressEvents';
import type { DatasetRuntime, DatasetToken, WriteContext } from '../storage/datasetRuntime';
import { colourTokenToArgb } from '../backup/normalize/localColours';
import type {
  BatchCompletionDetailedResult,
  CompleteBatchCommand,
  CompleteDatesCommand,
  CompleteDatesResult,
  SetProgressCommand,
  SkippedTask,
} from './contracts';
import {
  activeStateOf,
  ensureSessionForWrite,
  isCumulativeTask,
} from './cumulative';
import { persistOrderDerived } from './derived';
import { assertOrderWritable, accountGameDate } from './guards';

export interface TaskDeps {
  runtime: DatasetRuntime;
  newId: () => string;
  now: () => number;
}

function findPeriodOfTask(ctx: WriteContext, task: TaskDefinitionRow): HostingPeriodRow | null {
  return ctx.data.hosting_periods.find((period) => period.id === task.periodId) ?? null;
}

function retirementDate(task: TaskDefinitionRow, order: { gameZoneId: string; dailyRefreshMinutes: number }): string | null {
  if (task.retiredAt === null) return null;
  return gameDateAt(task.retiredAt, order.gameZoneId, order.dailyRefreshMinutes);
}

function numericCompletionValue(task: TaskDefinitionRow, current: string | null): string {
  if (task.progressType !== 'NUMERIC') return current ?? '1';
  const base = current ?? task.startValue;
  return compareDecimal(parseDecimal(base), parseDecimal(task.targetValue)) >= 0
    ? base
    : task.targetValue;
}

/**
 * 日期式托管的写入校验（含退休边界）。
 *
 * 已移除任务只允许写入**已存在**的历史打卡行：绝不因为一次"补记"创造新的历史日期
 * （契约：历史更正不得创建缺失轮次，也不得在退休后继续归属）。
 */
function assertDateTaskWritable(
  ctx: WriteContext,
  task: TaskDefinitionRow,
  gameDate: string,
  nowMs: number,
): HostingPeriodRow {
  const order = assertOrderWritable(ctx.data, task.orderId);
  const period = findPeriodOfTask(ctx, task);
  if (!period) throw new AppError('NOT_FOUND', '任务缺少所属期次');
  if (!isISODate(gameDate)) throw new AppError('INVALID_INPUT', '游戏日期不合法');
  if (gameDate > accountGameDate(order, nowMs)) {
    throw new AppError('INVALID_INPUT', '不能为未来日期打卡');
  }
  if (gameDate < period.startDate || gameDate > periodScheduleEnd(period)) {
    throw new AppError('INVALID_INPUT', '该日期不在服务期限内');
  }
  if (!slotFor(task, period, gameDate)) {
    throw new AppError('INVALID_INPUT', '该任务在这一天不需要执行');
  }
  const retired = retirementDate(task, order);
  if (retired !== null && gameDate > retired) {
    throw new AppError('INVALID_INPUT', '该任务已移除，不能再在移除之后的日期记录');
  }
  return period;
}

/** 计次轮次的写入校验：轮次下界是实际服务起点，不使用期次锚点 endDate（CD-02）。 */
function assertRoundTaskWritable(
  ctx: WriteContext,
  task: TaskDefinitionRow,
  period: HostingPeriodRow,
  gameDate: string,
  nowMs: number,
): void {
  const order = assertOrderWritable(ctx.data, task.orderId);
  if (!isISODate(gameDate)) throw new AppError('INVALID_INPUT', '游戏日期不合法');
  if (gameDate > accountGameDate(order, nowMs)) {
    throw new AppError('INVALID_INPUT', '不能为未来日期打卡');
  }
  if (gameDate < countPeriodServiceStart(period)) {
    throw new AppError('INVALID_INPUT', `该日期早于期次服务起点 ${countPeriodServiceStart(period)}`);
  }
  if (task.activeFrom !== null && gameDate < task.activeFrom) {
    throw new AppError('INVALID_INPUT', '该日期早于任务生效起始日');
  }
  if (task.activeUntil !== null && gameDate > task.activeUntil) {
    throw new AppError('INVALID_INPUT', '该日期晚于任务生效截止日');
  }
  if (task.recurrence === 'ONE_TIME' && !isCumulativeTask(task)) {
    throw new AppError('INVALID_INPUT', '一次性任务不属于打卡轮次');
  }
}

async function writeOccurrence(
  ctx: WriteContext,
  task: TaskDefinitionRow,
  slot: { key: string; gameDate: string; windowStart: string | null; windowEnd: string | null },
  apply: (row: TaskOccurrenceRow | null) => TaskOccurrenceRow | null,
  newId: () => string,
  now: () => number,
): Promise<TaskOccurrenceRow | null> {
  const existing = ctx.data.task_occurrences.find(
    (row) => row.taskDefinitionId === task.id && row.occurrenceKey === slot.key,
  );
  const next = apply(existing ?? null);
  if (!next) return null;
  if (existing) {
    await ctx.table('task_occurrences').put(next);
    Object.assign(existing, next);
    return existing;
  }
  const row: TaskOccurrenceRow = {
    ...next,
    id: newId(),
    taskDefinitionId: task.id,
    occurrenceKey: slot.key,
    gameDate: slot.gameDate,
    windowStart: slot.windowStart,
    windowEnd: slot.windowEnd,
    createdAt: now(),
  };
  await ctx.table('task_occurrences').add(row);
  ctx.data.task_occurrences.push(row);
  return row;
}

function occurrenceOfRound(
  ctx: WriteContext,
  task: TaskDefinitionRow,
  sessionIndex: number,
): TaskOccurrenceRow | null {
  const key = roundKey(sessionIndex);
  return (
    ctx.data.task_occurrences.find(
      (row) => row.taskDefinitionId === task.id && row.occurrenceKey === key,
    ) ?? null
  );
}

/**
 * 找出该任务在当前游戏日**仍在进行**的轮次（同日多轮时不要串到已完成的轮次）。
 *
 * 只复用 `completedAt === null` 的轮次：上一轮已完成后，同一天再打卡属于新的第 N+1 轮。
 */
function existingRoundOfToday(
  ctx: WriteContext,
  task: TaskDefinitionRow,
  gameDate: string,
): number | null {
  const candidates = ctx.data.task_occurrences.filter(
    (item) => item.taskDefinitionId === task.id && item.gameDate === gameDate,
  );
  for (const item of candidates) {
    const index = roundIndexFromKey(item.occurrenceKey);
    if (index === null) continue;
    const session = ctx.data.hosting_sessions.find(
      (row) => row.orderId === task.orderId && row.sessionIndex === index,
    );
    if (session && session.completedAt === null) return index;
  }
  return null;
}

export function createTaskServices({ runtime, newId, now }: TaskDeps) {
  const deps = { newId, now };

  async function completeBatchInternal(
    input: CompleteBatchCommand,
    token: DatasetToken,
  ): Promise<BatchCompletionDetailedResult> {
    return runtime.write(token, async (ctx) => {
      const existing = ctx.data.completion_batches.find(
        (batch) => batch.operationId === input.operationId,
      );
      if (existing) return { batchId: existing.id, skipped: [] };

      const nowStamp = now();
      // HOSTING_ALL 横跨不同时区/刷新时间，按契约（D-21）没有单一游戏日，
      // 目标与日期都写 null——新写入永远规范，导出即可被自己的读取路径接受。
      const scope = input.scope;
      if (scope !== 'HOSTING_ALL' && input.targetId === null) {
        throw new AppError('INVALID_INPUT', '批量完成缺少目标订单');
      }
      const targetOrderId = scope === 'HOSTING_ALL' ? null : (input.targetId as string);
      const batchGameDate = scope === 'HOSTING_ALL' ? null : (input.gameDate ?? null);
      if (scope !== 'HOSTING_ALL' && (batchGameDate === null || !isISODate(batchGameDate))) {
        throw new AppError('INVALID_INPUT', '批量完成缺少合法游戏日');
      }

      const items: CompletionBatchItemRow[] = [];
      const skipped: SkippedTask[] = [];
      const pendingOccurrences: {
        id: string;
        task: TaskDefinitionRow;
        key: string;
        gameDate: string;
        windowStart: string | null;
        windowEnd: string | null;
        value: string | null;
      }[] = [];
      const batchId = newId();
      const touchedOrders = new Set<string>();

      const skipCumulative = (task: TaskDefinitionRow, total: string) => {
        const unfinished = !reachedTarget(total, task.targetValue);
        skipped.push({
          taskId: task.id,
          title: task.title,
          reason: unfinished
            ? `累计目标未达标（${total}/${task.targetValue}${task.unit ?? ''}），请先在累计进度中记录`
            : '累计任务由当前总值判定完成，请在累计进度中核对，不做批量勾选',
        });
      };

      if (scope === 'SHORT_ORDER') {
        const order = assertOrderWritable(ctx.data, targetOrderId as string);
        if (order.type !== 'SHORT_TASK') throw new AppError('INVALID_INPUT', '该订单不是短期单');
        const tasks = ctx.data.task_definitions.filter(
          (task) =>
            task.orderId === order.id && task.periodId === null && task.completedAt === null,
        );
        for (const task of tasks) {
          if (task.retiredAt !== null) continue;
          if (isCumulativeTask(task)) {
            const total = resolveScopeTotal(
              ctx.data.task_progress_events,
              task.id,
              { kind: 'TASK' },
              task.startValue,
            );
            skipCumulative(task, total);
            continue;
          }
          const appliedValue =
            task.progressType === 'CHECKBOX'
              ? '1'
              : numericCompletionValue(task, task.currentValue);
          items.push({
            id: newId(),
            batchId,
            itemType: 'SHORT_TASK',
            occurrenceId: null,
            taskDefinitionId: task.id,
            previousCompletedAt: task.completedAt,
            previousRecordedAt: null,
            previousBackfilled: null,
            previousValue: task.currentValue,
            previousCompletionBatchId: task.completionBatchId,
            appliedCompletedAt: nowStamp,
            appliedRecordedAt: nowStamp,
            appliedBackfilled: 0,
            appliedValue,
            appliedCompletionBatchId: batchId,
          });
        }
        touchedOrders.add(order.id);
      } else {
        const orders =
          scope === 'HOSTING_ORDER'
            ? [assertOrderWritable(ctx.data, targetOrderId as string)]
            : ctx.data.orders.filter(
                (order) =>
                  order.type === 'HOSTING' &&
                  order.cancelledAt === null &&
                  order.archivedAt === null,
              );
        for (const order of orders) {
          if (order.type !== 'HOSTING') continue;
          const today = gameDateAt(nowStamp, order.gameZoneId, order.dailyRefreshMinutes);
          if (scope === 'HOSTING_ORDER' && batchGameDate !== today) {
            throw new AppError('INVALID_INPUT', '批量完成只处理当前游戏日');
          }
          const allPeriods = ctx.data.hosting_periods.filter((row) => row.orderId === order.id);
          const state = activeStateOf(ctx.data, order.id);
          const countMode = allPeriods.some((period) => period.serviceCount !== null);

          if (countMode) {
            if (state.kind === 'ALL_PERIODS_COMPLETE') {
              skipped.push({
                taskId: order.id,
                title: order.title,
                reason: '本单的打卡次数已全部完成',
              });
              continue;
            }
            if (state.kind === 'INDEX_SPACE_EXHAUSTED') {
              skipped.push({
                taskId: order.id,
                title: order.title,
                reason: '轮次号已耗尽，无法继续打卡',
              });
              continue;
            }
            const period = allPeriods.find((row) => row.id === state.periodId);
            if (!period) continue;
            const tasks = ctx.data.task_definitions.filter(
              (task) => task.orderId === order.id && task.periodId === period.id,
            );
            const sessionIndex =
              state.kind === 'ACTIVE_SESSION'
                ? state.sessionIndex
                : (state as { sessionIndex: number }).sessionIndex;
            const sessionId =
              state.kind === 'ACTIVE_SESSION' ? state.sessionId : null;
            const attributed =
              roundAttributedDate({
                session: {
                  id: sessionId ?? `awaiting-${sessionIndex}`,
                  orderId: order.id,
                  sessionIndex,
                  periodId: period.id,
                  createdAt: nowStamp,
                  completedAt: null,
                  completionBatchId: null,
                },
                occurrences: ctx.data.task_occurrences,
                events: ctx.data.task_progress_events,
                fallback: today,
              }) ?? today;
            const due = roundDueTasks(tasks, period, attributed);
            // 先判断有没有可完成的普通任务；没有就不建轮次行（读/空批量都不建行）。
            const candidates: TaskDefinitionRow[] = [];
            for (const task of due) {
              if (task.retiredAt !== null) continue;
              const occurrence = occurrenceOfRound(ctx, task, sessionIndex);
              if (isCumulativeTask(task)) {
                const scopeRef = sessionId
                  ? ({ kind: 'SESSION', sessionId } as const)
                  : null;
                const total = scopeRef
                  ? resolveScopeTotal(
                      ctx.data.task_progress_events,
                      task.id,
                      scopeRef,
                      task.startValue,
                    )
                  : task.startValue;
                skipCumulative(task, total);
                continue;
              }
              if (occurrence?.completedAt) continue;
              candidates.push(task);
            }
            if (candidates.length === 0) {
              if (attributed !== today || due.length === 0) {
                skipped.push({
                  taskId: order.id,
                  title: order.title,
                  reason: '本次打卡轮次没有可自动完成的事项',
                });
              }
              continue;
            }
            let ensuredId = sessionId;
            if (ensuredId === null) {
              const ensured = await ensureSessionForWrite(
                ctx,
                deps,
                order,
                period.id,
                sessionIndex,
              );
              ensuredId = ensured.session.id;
            }
            touchedOrders.add(order.id);
            for (const task of candidates) {
              const occurrence = occurrenceOfRound(ctx, task, sessionIndex);
              const appliedValue =
                task.progressType === 'CHECKBOX'
                  ? '1'
                  : numericCompletionValue(task, occurrence?.value ?? null);
              let occurrenceId = occurrence?.id ?? null;
              if (occurrenceId === null) {
                occurrenceId = newId();
                pendingOccurrences.push({
                  id: occurrenceId,
                  task,
                  key: roundKey(sessionIndex),
                  gameDate: today,
                  windowStart: null,
                  windowEnd: null,
                  value: appliedValue,
                });
              }
              items.push({
                id: newId(),
                batchId,
                itemType: 'OCCURRENCE',
                occurrenceId,
                taskDefinitionId: task.id,
                previousCompletedAt: occurrence?.completedAt ?? null,
                previousRecordedAt: occurrence?.recordedAt ?? null,
                previousBackfilled: occurrence?.backfilled ?? null,
                previousValue: occurrence?.value ?? null,
                previousCompletionBatchId: occurrence?.completionBatchId ?? null,
                appliedCompletedAt: nowStamp,
                appliedRecordedAt: nowStamp,
                appliedBackfilled: 0,
                appliedValue,
                appliedCompletionBatchId: batchId,
              });
            }
            continue;
          }

          const period = [...allPeriods].sort(
            (left, right) => right.periodIndex - left.periodIndex,
          )[0];
          if (!period) continue;
          if (today > period.endDate) {
            skipped.push({
              taskId: order.id,
              title: order.title,
              reason: `托管服务已于 ${period.endDate} 到期`,
            });
            continue;
          }
          const tasks = ctx.data.task_definitions.filter(
            (task) => task.orderId === order.id && task.periodId === period.id,
          );
          for (const task of tasks) {
            if (task.retiredAt !== null) continue;
            const slot = slotFor(task, period, today);
            if (!slot) continue;
            const occurrence = ctx.data.task_occurrences.find(
              (row) => row.taskDefinitionId === task.id && row.occurrenceKey === slot.key,
            );
            if (occurrence?.completedAt) continue;
            if (isCumulativeTask(task)) {
              const total = resolveScopeTotal(
                ctx.data.task_progress_events,
                task.id,
                { kind: 'PERIOD', periodId: period.id },
                task.startValue,
              );
              skipCumulative(task, total);
              continue;
            }
            const appliedValue =
              task.progressType === 'CHECKBOX'
                ? '1'
                : numericCompletionValue(task, occurrence?.value ?? null);
            let occurrenceId = occurrence?.id ?? null;
            if (occurrenceId === null) {
              occurrenceId = newId();
              pendingOccurrences.push({
                id: occurrenceId,
                task,
                key: slot.key,
                gameDate: slot.gameDate,
                windowStart: slot.windowStart,
                windowEnd: slot.windowEnd,
                value: appliedValue,
              });
            }
            items.push({
              id: newId(),
              batchId,
              itemType: 'OCCURRENCE',
              occurrenceId,
              taskDefinitionId: task.id,
              previousCompletedAt: occurrence?.completedAt ?? null,
              previousRecordedAt: occurrence?.recordedAt ?? null,
              previousBackfilled: occurrence?.backfilled ?? null,
              previousValue: occurrence?.value ?? null,
              previousCompletionBatchId: occurrence?.completionBatchId ?? null,
              appliedCompletedAt: nowStamp,
              appliedRecordedAt: nowStamp,
              appliedBackfilled: 0,
              appliedValue,
              appliedCompletionBatchId: batchId,
            });
          }
          touchedOrders.add(order.id);
        }
      }

      if (items.length === 0) {
        if (skipped.length > 0) return { batchId: null, skipped };
        throw new AppError('CONFLICT', '没有可完成的事项');
      }

      const batch: CompletionBatchRow = {
        id: batchId,
        operationId: input.operationId,
        scope,
        targetId: targetOrderId,
        gameDate: batchGameDate,
        createdAt: nowStamp,
        undoneAt: null,
      };
      await ctx.table('completion_batches').add(batch);
      for (const item of items) await ctx.table('completion_batch_items').add(item);
      // 补建记录与明细在同一事务：失败即整批回滚，绝不留下"半链接"的批次。
      for (const pending of pendingOccurrences) {
        const row: TaskOccurrenceRow = {
          id: pending.id,
          taskDefinitionId: pending.task.id,
          occurrenceKey: pending.key,
          gameDate: pending.gameDate,
          windowStart: pending.windowStart,
          windowEnd: pending.windowEnd,
          completedAt: nowStamp,
          recordedAt: nowStamp,
          backfilled: 0,
          completionBatchId: batch.id,
          value: pending.value,
          createdAt: nowStamp,
        };
        await ctx.table('task_occurrences').add(row);
        ctx.data.task_occurrences.push(row);
      }
      for (const item of items) {
        if (item.taskDefinitionId) {
          const task = ctx.data.task_definitions.find((row) => row.id === item.taskDefinitionId);
          if (task && !task.periodId) {
            const next: TaskDefinitionRow = {
              ...task,
              completedAt: item.appliedCompletedAt,
              completionBatchId: batch.id,
              currentValue: task.progressType === 'CHECKBOX' ? '1' : (item.appliedValue ?? task.currentValue),
              updatedAt: nowStamp,
            };
            await ctx.table('task_definitions').put(next);
            Object.assign(task, next);
            continue;
          }
        }
        if (item.occurrenceId === null) continue;
        const occurrence = ctx.data.task_occurrences.find((row) => row.id === item.occurrenceId);
        // 补建的记录已经写好；既有的记录在这里更新完成态。
        if (!occurrence) continue;
        const next: TaskOccurrenceRow = {
          ...occurrence,
          completedAt: nowStamp,
          recordedAt: nowStamp,
          backfilled: 0,
          completionBatchId: batch.id,
          value: item.appliedValue,
        };
        await ctx.table('task_occurrences').put(next);
        Object.assign(occurrence, next);
      }

      for (const orderId of touchedOrders) await persistOrderDerived(ctx, orderId);
      return { batchId, skipped };
    });
  }

  return {
    async setProgress(input: SetProgressCommand, token: DatasetToken): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const task = ctx.data.task_definitions.find((row) => row.id === input.taskId);
        if (!task) throw new AppError('NOT_FOUND', '任务不存在');
        if (isCumulativeTask(task)) {
          throw new AppError(
            'INVALID_INPUT',
            '累计目标请记录“当前累计总值”，不能用普通打卡勾选',
          );
        }

        if (!task.periodId) {
          const order = assertOrderWritable(ctx.data, task.orderId);
          if (task.retiredAt !== null) {
            throw new AppError('INVALID_INPUT', '该任务已移除，不能再打卡');
          }
          if (task.progressType === 'CHECKBOX') {
            const next: TaskDefinitionRow = {
              ...task,
              completedAt: input.completed ? now() : null,
              currentValue: input.completed ? '1' : '0',
              updatedAt: now(),
            };
            await ctx.table('task_definitions').put(next);
            Object.assign(task, next);
          } else {
            const value = input.value === null ? '0' : input.value;
            parseDecimal(value);
            const next: TaskDefinitionRow = {
              ...task,
              currentValue: value,
              completedAt: input.completed ? now() : null,
              updatedAt: now(),
            };
            await ctx.table('task_definitions').put(next);
            Object.assign(task, next);
          }
          await persistOrderDerived(ctx, order.id);
          return;
        }

        const period = findPeriodOfTask(ctx, task);
        if (!period) throw new AppError('NOT_FOUND', '任务缺少所属期次');
        const order = assertOrderWritable(ctx.data, task.orderId);
        if (period.serviceCount !== null) {
          assertRoundTaskWritable(ctx, task, period, input.gameDate, now());
          const existingIndex = existingRoundOfToday(ctx, task, input.gameDate);
          let sessionIndex = existingIndex;
          if (sessionIndex === null) {
            const state = activeStateOf(ctx.data, order.id);
            if (state.kind === 'ALL_PERIODS_COMPLETE') {
              throw new AppError('CONFLICT', '本单的打卡次数已全部完成');
            }
            if (state.kind === 'INDEX_SPACE_EXHAUSTED') {
              throw new AppError('SESSION_INDEX_EXHAUSTED', '轮次号已达到上限');
            }
            if (state.kind === 'ACTIVE_SESSION') {
              const session = ctx.data.hosting_sessions.find((row) => row.id === state.sessionId);
              if (!session) throw new AppError('CONFLICT', '活动轮次不存在');
              sessionIndex = session.sessionIndex;
              if (session.periodId !== period.id) {
                // 活动轮次属于别的期次：本轮属于该期次自己的待建行。
                const ensured = await ensureSessionForWrite(ctx, deps, order, period.id, null);
                sessionIndex = ensured.session.sessionIndex;
              }
            } else {
              const ensured = await ensureSessionForWrite(
                ctx,
                deps,
                order,
                period.id,
                (state as { sessionIndex: number }).sessionIndex,
              );
              sessionIndex = ensured.session.sessionIndex;
            }
          }
          const value = task.progressType === 'CHECKBOX' ? (input.completed ? '1' : null) : input.value;
          if (task.progressType === 'NUMERIC' && value !== null) parseDecimal(value);
          await writeOccurrence(
            ctx,
            task,
            {
              key: roundKey(sessionIndex),
              gameDate: input.gameDate,
              windowStart: null,
              windowEnd: null,
            },
            (row) => ({
              id: row?.id ?? '',
              taskDefinitionId: task.id,
              occurrenceKey: row?.occurrenceKey ?? '',
              gameDate: row?.gameDate ?? input.gameDate,
              windowStart: row?.windowStart ?? null,
              windowEnd: row?.windowEnd ?? null,
              completedAt: input.completed ? now() : null,
              recordedAt: input.completed ? now() : null,
              backfilled: input.backfilled || row?.backfilled === 1 ? 1 : 0,
              completionBatchId: row?.completionBatchId ?? null,
              value,
              createdAt: row?.createdAt ?? now(),
            }),
            newId,
            now,
          );
          await persistOrderDerived(ctx, order.id);
          return;
        }

        assertDateTaskWritable(ctx, task, input.gameDate, now());
        const retired = retirementDate(task, order);
        if (retired !== null && input.gameDate <= retired) {
          // 历史补记只能落在已存在的打卡行上（不创建新的历史日期）。
          const exists = ctx.data.task_occurrences.some(
            (row) => row.taskDefinitionId === task.id && row.gameDate === input.gameDate,
          );
          if (!exists) {
            throw new AppError(
              'CONFLICT',
              '该任务已移除：只能更正已有的历史打卡，不能新增历史日期',
            );
          }
        }
        const slot = slotFor(task, period, input.gameDate);
        if (!slot) throw new AppError('INVALID_INPUT', '该任务在这一天不需要执行');
        const value = task.progressType === 'CHECKBOX' ? (input.completed ? '1' : null) : input.value;
        if (task.progressType === 'NUMERIC' && value !== null) parseDecimal(value);
        await writeOccurrence(
          ctx,
          task,
          slot,
          (row) => ({
            id: row?.id ?? '',
            taskDefinitionId: task.id,
            occurrenceKey: row?.occurrenceKey ?? '',
            gameDate: row?.gameDate ?? input.gameDate,
            windowStart: row?.windowStart ?? null,
            windowEnd: row?.windowEnd ?? null,
            completedAt: input.completed ? now() : null,
            recordedAt: input.completed ? now() : null,
            backfilled: input.backfilled || row?.backfilled === 1 ? 1 : 0,
            completionBatchId: row?.completionBatchId ?? null,
            value,
            createdAt: row?.createdAt ?? now(),
          }),
          newId,
          now,
        );
        await persistOrderDerived(ctx, order.id);
      });
    },

    /**
     * 日历多选补录：按游戏日批量完成普通打卡。
     *
     * 与 `completeBatch` 的差别是日期可以不只今天（迁移历史），因此不写
     * `completion_batches`（批次表只有一个 gameDate，跨日批次会让撤销语义失真），
     * 也不覆盖任何已有完成时刻；误操作按项点回即可。整批在一个事务内写入。
     */
    async completeDates(
      input: CompleteDatesCommand,
      token: DatasetToken,
    ): Promise<CompleteDatesResult> {
      return runtime.write(token, async (ctx) => {
        const order = assertOrderWritable(ctx.data, input.orderId);
        const nowStamp = now();
        const today = accountGameDate(order, nowStamp);
        if (input.dates.length === 0) throw new AppError('INVALID_INPUT', '请选择日期');
        const dates = [...new Set(input.dates)].sort();
        if (dates.length > 366) throw new AppError('INVALID_INPUT', '一次最多补录 366 天');
        for (const date of dates) {
          if (!isISODate(date)) throw new AppError('INVALID_INPUT', `游戏日期不合法：${date}`);
          if (date > today) throw new AppError('INVALID_INPUT', `不能为未来日期打卡：${date}`);
        }

        const periods = ctx.data.hosting_periods.filter((row) => row.orderId === order.id);
        if (periods.some((period) => period.serviceCount !== null)) {
          throw new AppError('INVALID_INPUT', '按次数托管请按轮次逐个打卡，暂不支持按日期批量补录');
        }

        const skipped: SkippedTask[] = [];
        const skippedKeys = new Set<string>();
        const addSkip = (taskId: string, title: string, reason: string) => {
          const key = `${taskId}|${reason}`;
          if (skippedKeys.has(key)) return;
          skippedKeys.add(key);
          skipped.push({ taskId, title, reason });
        };

        let recorded = 0;
        const writtenDates = new Set<string>();
        for (const date of dates) {
          // 历史补录要落在该日期实际所属的期次（续期后同一月可能横跨两期）。
          const period = periods
            .filter((row) => date >= row.startDate && date <= periodScheduleEnd(row))
            .sort((left, right) => right.periodIndex - left.periodIndex)[0];
          if (!period) {
            addSkip(order.id, order.title, `${date} 不在服务期限内`);
            continue;
          }
          const tasks = ctx.data.task_definitions.filter(
            (row) => row.orderId === order.id && row.periodId === period.id,
          );
          for (const task of tasks) {
            if (task.retiredAt !== null) {
              addSkip(task.id, task.title, '该任务已移除，不能新增历史打卡');
              continue;
            }
            if (isCumulativeTask(task)) {
              addSkip(task.id, task.title, '累计任务请到「累计进度」记录，不能按日期批量勾选');
              continue;
            }
            const slot = slotFor(task, period, date);
            if (!slot) continue;
            const existing = ctx.data.task_occurrences.find(
              (row) => row.taskDefinitionId === task.id && row.occurrenceKey === slot.key,
            );
            // 已有完成记录直接跳过：保留原始完成时刻，重复点选同一批日期也安全。
            if (existing?.completedAt) continue;
            const value =
              task.progressType === 'CHECKBOX'
                ? '1'
                : numericCompletionValue(task, existing?.value ?? null);
            await writeOccurrence(
              ctx,
              task,
              slot,
              (row) => ({
                id: row?.id ?? '',
                taskDefinitionId: task.id,
                occurrenceKey: row?.occurrenceKey ?? '',
                gameDate: row?.gameDate ?? slot.gameDate,
                windowStart: row?.windowStart ?? slot.windowStart,
                windowEnd: row?.windowEnd ?? slot.windowEnd,
                completedAt: nowStamp,
                recordedAt: nowStamp,
                // 补录标记按写入归属日判定（周任务的槽可能落在本周触发日）。
                backfilled: slot.gameDate < today || row?.backfilled === 1 ? 1 : 0,
                completionBatchId: row?.completionBatchId ?? null,
                value,
                createdAt: row?.createdAt ?? nowStamp,
              }),
              newId,
              now,
            );
            recorded += 1;
            writtenDates.add(date);
          }
        }

        if (recorded > 0) await persistOrderDerived(ctx, order.id);
        return { recorded, dates: writtenDates.size, skipped };
      });
    },

    async completeBatch(input: CompleteBatchCommand, token: DatasetToken): Promise<string> {
      const result = await completeBatchInternal(input, token);
      if (result.batchId === null) {
        const detail = result.skipped
          .map((item) => `${item.title}：${item.reason}`)
          .slice(0, 3)
          .join('；');
        throw new AppError(
          'CONFLICT',
          detail ? `没有可完成的事项（${detail}）` : '没有可完成的事项',
        );
      }
      return result.batchId;
    },

    async completeBatchDetailed(
      input: CompleteBatchCommand,
      token: DatasetToken,
    ): Promise<BatchCompletionDetailedResult> {
      return completeBatchInternal(input, token);
    },

    async undoBatch(
      batchId: string,
      token: DatasetToken,
    ): Promise<{ restored: number; conflicts: number }> {
      return runtime.write(token, async (ctx) => {
        const batch = ctx.data.completion_batches.find((row) => row.id === batchId);
        if (!batch) throw new AppError('NOT_FOUND', '批次不存在');
        if (batch.undoneAt !== null) return { restored: 0, conflicts: 0 };
        const nowStamp = now();
        let restored = 0;
        let conflicts = 0;
        const touchedOrders = new Set<string>();

        const items = ctx.data.completion_batch_items.filter((row) => row.batchId === batchId);
        for (const item of items) {
          if (item.taskDefinitionId) {
            const task = ctx.data.task_definitions.find((row) => row.id === item.taskDefinitionId);
            if (task) touchedOrders.add(task.orderId);
          }
          if (item.occurrenceId) {
            const occurrence = ctx.data.task_occurrences.find((row) => row.id === item.occurrenceId);
            if (!occurrence) {
              conflicts += 1;
              continue;
            }
            const unchanged =
              occurrence.completedAt === item.appliedCompletedAt &&
              occurrence.recordedAt === item.appliedRecordedAt &&
              occurrence.completionBatchId === item.appliedCompletionBatchId;
            if (!unchanged) {
              conflicts += 1;
              continue;
            }
            // 撤销只回退完成态，不删除打卡记录行：批次明细以 RESTRICT 引用它
            // （契约 `completion_batch_items.referenceRule`），删行会让历史批次悬空、
            // 并让下一次导出无法被自己的读取路径接受。批次补建行保留为"未完成槽"。
            const next: TaskOccurrenceRow = {
              ...occurrence,
              completedAt: item.previousCompletedAt,
              recordedAt: item.previousRecordedAt,
              backfilled: item.previousBackfilled ?? 0,
              completionBatchId: item.previousCompletionBatchId,
              value: item.previousValue,
            };
            await ctx.table('task_occurrences').put(next);
            Object.assign(occurrence, next);
            restored += 1;
            continue;
          }
          const task = item.taskDefinitionId
            ? ctx.data.task_definitions.find((row) => row.id === item.taskDefinitionId)
            : undefined;
          if (!task) {
            conflicts += 1;
            continue;
          }
          const unchanged =
            task.completedAt === item.appliedCompletedAt &&
            task.completionBatchId === item.appliedCompletionBatchId;
          if (!unchanged) {
            conflicts += 1;
            continue;
          }
          const next: TaskDefinitionRow = {
            ...task,
            completedAt: item.previousCompletedAt,
            completionBatchId: item.previousCompletionBatchId,
            currentValue: item.previousValue ?? task.currentValue,
            updatedAt: nowStamp,
          };
          await ctx.table('task_definitions').put(next);
          Object.assign(task, next);
          restored += 1;
        }
        await ctx.table('completion_batches').put({ ...batch, undoneAt: nowStamp });
        // 轮次完成度是派生值：撤销后必须与证据一致地重开。
        for (const orderId of touchedOrders) await persistOrderDerived(ctx, orderId);
        return { restored, conflicts };
      });
    },

    /**
     * UF-019：任务自身颜色（schema 15 起写入 `task_definitions.colorArgb`）。
     *
     * null = 不设自身颜色 → 显示时继承 `orders.orderColor`。写自身颜色即为显式覆盖，
     * 此后整单改色不再影响该任务（与旧"任务自身标记"语义一致）。
     */
    async setTaskColor(taskId: string, color: string | null, token: DatasetToken): Promise<void> {
      const argb = colourTokenToArgb(color);
      if (color !== null && argb === null) {
        throw new AppError('INVALID_INPUT', '颜色标记不合法');
      }
      await runtime.write(token, async (ctx) => {
        const task = ctx.data.task_definitions.find((row) => row.id === taskId);
        if (!task) throw new AppError('NOT_FOUND', '任务不存在');
        await ctx.table('task_definitions').put({ ...task, colorArgb: argb });
      });
    },

    /**
     * 已移除任务的历史补记/撤销（仅计次托管、仅已存在的轮次）。
     *
     * 资格口径与轮次完成/重建**同源**（R3）：
     * - 归属日 = 该轮最早的存储证据；没有任何证据时用 `roundFallbackDate`
     *   （轮次 createdAt 在期次快照下的游戏日），绝不使用"今天"；
     * - 应做集 = `roundDueTasks`（该期次完整名册 + 归属日；activeFrom/activeUntil 含端点、
     *   退休日含当天、普通一次性任务不属于任何轮次）；
     * - 累计任务仍走事件链；未写轮次不会被创建。
     */
    async setHistoricalRoundCompletion(
      input: { orderId: string; sessionIndex: number; taskId: string; completed: boolean },
      token: DatasetToken,
    ): Promise<void> {
      await runtime.write(token, async (ctx) => {
        const order = assertOrderWritable(ctx.data, input.orderId);
        if (order.type !== 'HOSTING') throw new AppError('INVALID_INPUT', '只有托管订单有轮次');
        const session = ctx.data.hosting_sessions.find(
          (row) => row.orderId === order.id && row.sessionIndex === input.sessionIndex,
        );
        if (!session) throw new AppError('NOT_FOUND', '轮次不存在（历史更正不会创建轮次）');
        const period = ctx.data.hosting_periods.find((row) => row.id === session.periodId);
        if (!period || period.serviceCount === null || period.orderId !== order.id) {
          throw new AppError('INVALID_INPUT', '轮次所属期次不是该订单的计次期次');
        }
        const task = ctx.data.task_definitions.find((row) => row.id === input.taskId);
        if (!task || task.orderId !== order.id) throw new AppError('NOT_FOUND', '任务不存在');
        if (task.periodId !== session.periodId) {
          throw new AppError('INVALID_INPUT', '任务不属于该轮次的期次');
        }
        if (task.retiredAt === null) {
          throw new AppError('INVALID_INPUT', '在册任务请直接打卡，不走历史补记');
        }
        if (isCumulativeTask(task)) {
          throw new AppError('INVALID_INPUT', '累计任务请用累计进度的更正/撤销');
        }
        const attributed =
          roundAttributedDate({
            session,
            occurrences: ctx.data.task_occurrences,
            events: ctx.data.task_progress_events,
            fallback: null,
          }) ?? roundFallbackDate(session, period);
        // 退休边界用**期次自己的**刷新快照换算游戏日（与 dueTasksOn 同一规则）。
        const retired =
          task.retiredAt === null
            ? null
            : gameDateAt(task.retiredAt, period.gameZoneId, period.dailyRefreshMinutes);
        if (retired !== null && attributed > retired) {
          throw new AppError('INVALID_INPUT', '该轮次归属日晚于任务移除日，不能再补记');
        }
        const roster = ctx.data.task_definitions.filter(
          (row) => row.orderId === order.id && row.periodId === period.id,
        );
        const due = roundDueTasks(roster, period, attributed);
        if (!due.some((row) => row.id === task.id)) {
          throw new AppError(
            'INVALID_INPUT',
            `该任务在第 ${session.sessionIndex} 次打卡（归属 ${attributed}）不应做，不能补记`,
          );
        }
        const key = roundKey(session.sessionIndex);
        const existing = ctx.data.task_occurrences.find(
          (row) => row.taskDefinitionId === task.id && row.occurrenceKey === key,
        );
        if (!input.completed) {
          if (!existing) throw new AppError('NOT_FOUND', '该轮次没有可撤销的记录');
          const next: TaskOccurrenceRow = {
            ...existing,
            completedAt: null,
            recordedAt: null,
            value: null,
          };
          await ctx.table('task_occurrences').put(next);
          Object.assign(existing, next);
          await persistOrderDerived(ctx, order.id);
          return;
        }
        // 与正常完成同一表达式：至少达到目标、保留更高值、缺失值以起始值代入。
        const value =
          task.progressType === 'NUMERIC'
            ? numericCompletionValue(task, existing?.value ?? null)
            : (existing?.value ?? '1');
        const stamp = now();
        if (existing) {
          const next: TaskOccurrenceRow = {
            ...existing,
            completedAt: stamp,
            recordedAt: stamp,
            backfilled: 1,
            value,
          };
          await ctx.table('task_occurrences').put(next);
          Object.assign(existing, next);
        } else {
          const row: TaskOccurrenceRow = {
            id: newId(),
            taskDefinitionId: task.id,
            occurrenceKey: key,
            gameDate: attributed,
            windowStart: null,
            windowEnd: null,
            completedAt: stamp,
            recordedAt: stamp,
            backfilled: 1,
            completionBatchId: null,
            value,
            createdAt: stamp,
          };
          await ctx.table('task_occurrences').add(row);
          ctx.data.task_occurrences.push(row);
        }
        await persistOrderDerived(ctx, order.id);
      });
    },
  };
}

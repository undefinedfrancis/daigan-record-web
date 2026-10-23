import type {
  HostingMode,
  OrderType,
  ProgressEventKind,
  TaskProgressEventRow,
  TaskDefinitionRow,
  ProgressScopeType,
} from '../contracts/tables';
import { parseDecimal, compareDecimal } from './decimal';

/** 累计进度的不可变范围（只在写入时确定一次）。 */
export type ProgressScope =
  | { kind: 'TASK' }
  | { kind: 'PERIOD'; periodId: string }
  | { kind: 'SESSION'; sessionId: string };

export interface ProgressEventViolation {
  code: ProgressEventViolationCode;
  eventId: string;
  reason: string;
  /** 受影响对象（event/task/order/period/session 的持久 id），用于对象级诊断。 */
  objects?: Record<string, string>;
}

export type ProgressEventViolationCode =
  | 'SCOPE_NOT_ALLOWED'
  | 'SCOPE_OWNERSHIP_INVALID'
  | 'SCOPE_FIELDS_INCONSISTENT'
  | 'TASK_NOT_CUMULATIVE'
  | 'TASK_SCOPE_REQUIRES_PERIODLESS_TASK'
  | 'SCOPE_PERIOD_NOT_TASK_PERIOD'
  | 'SCOPE_PERIOD_NOT_DATE_BASED'
  | 'SCOPE_SESSION_NOT_COUNT_BASED'
  | 'SCOPE_SESSION_PERIOD_MISMATCH'
  | 'EVENT_DATE_OUT_OF_SERVICE_RANGE'
  | 'CORRECTION_TARGET_MISSING'
  | 'CORRECTION_TARGET_OTHER_TASK'
  | 'CORRECTION_TARGET_OTHER_SCOPE'
  | 'CORRECTION_DATE_CHANGED'
  | 'SUPERSEDED_EVENT'
  | 'CORRECTION_CYCLE'
  | 'IMPOSSIBLE_SEQUENCE'
  | 'DUPLICATE_OPERATION_ID'
  | 'DUPLICATE_SEQUENCE'
  | 'KIND_PAYLOAD_INVALID';

export function scopeOfEvent(event: {
  scopeType: ProgressScopeType;
  scopePeriodId: string | null;
  scopeSessionId: string | null;
}): ProgressScope {
  if (event.scopeType === 'PERIOD') {
    return { kind: 'PERIOD', periodId: event.scopePeriodId ?? '' };
  }
  if (event.scopeType === 'SESSION') {
    return { kind: 'SESSION', sessionId: event.scopeSessionId ?? '' };
  }
  return { kind: 'TASK' };
}

export function scopeTypeOf(scope: ProgressScope): ProgressScopeType {
  return scope.kind;
}

export function scopePeriodIdOf(scope: ProgressScope): string | null {
  return scope.kind === 'PERIOD' ? scope.periodId : null;
}

export function scopeSessionIdOf(scope: ProgressScope): string | null {
  return scope.kind === 'SESSION' ? scope.sessionId : null;
}

export function sameScope(left: ProgressScope, right: ProgressScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'PERIOD' && right.kind === 'PERIOD') return left.periodId === right.periodId;
  if (left.kind === 'SESSION' && right.kind === 'SESSION') return left.sessionId === right.sessionId;
  return true;
}

export function scopeKey(scope: ProgressScope): string {
  if (scope.kind === 'PERIOD') return `PERIOD:${scope.periodId}`;
  if (scope.kind === 'SESSION') return `SESSION:${scope.sessionId}`;
  return 'TASK';
}

/**
 * 每种订单模式**只允许一种**累计 scope（F2 / D-35）。
 *
 * 短单 → TASK；按日期托管（`hostingMode` null 读作按日期）→ PERIOD；
 * 按次数托管 → SESSION。违例一律 `SCOPE_NOT_ALLOWED`：
 * 例：计次任务用 PERIOD 会让期次级总值绕过每轮独立目标。
 */
export function allowedScopeKind(orderType: OrderType, hostingMode: HostingMode | null): ProgressScopeType {
  if (orderType === 'SHORT_TASK') return 'TASK';
  return hostingMode === 'COUNT_BASED' ? 'SESSION' : 'PERIOD';
}

export function isScopeAllowed(
  scope: ProgressScope,
  orderType: OrderType,
  hostingMode: HostingMode | null,
): boolean {
  return scope.kind === allowedScopeKind(orderType, hostingMode);
}

function isEffective(event: TaskProgressEventRow, superseded: Set<string>): boolean {
  if (event.kind === 'RETRACT') return false;
  return !superseded.has(event.id);
}

/**
 * 解析**某个任务的某个 scope** 的总值。
 *
 * 语义（R4/R5、F4、D-29）：事件是权威。
 * - **先按任务过滤**：任务标识是解析边界的一部分，别的任务的序号/更正/撤回绝不参与；
 * - 被**任何**事件（含 RETRACT）指向者即被取代；
 * - 有效 = 未被取代且非 RETRACT；
 * - 有 `asOfGameDate` 时再丢弃晚于该日的观测（"更正后的历史真值"，不引入第二套时间模型）；
 * - 取剩余中最大 `gameDate`，同日取最大 `sequence`；
 * - 无有效事件回落 `startValue`。
 *
 * `taskId` 是**显式参数**（S2-R1）：`SCOPE` 不足以标识一份进度——同一 `SESSION` 下可以有
 * 多个任务各自的观测，`TASK` scope 也不是数据集全局。调用方永远无法只传 scope 就取到
 * 别的任务的值。
 *
 * 返回**规范化**的十进制文本（`'10' == '10.0' == '10.000'`）。
 */
export function resolveScopeTotal(
  events: TaskProgressEventRow[],
  taskId: string,
  scope: ProgressScope,
  startValue: string,
  asOfGameDate?: string | null,
): string {
  const winner = resolveEffectiveEvent(events, taskId, scope, asOfGameDate);
  if (winner === null || winner.totalValue === null) return normalize(startValue);
  return normalize(winner.totalValue);
}

/**
 * 该任务在该 scope 内胜出的有效观测（`resolveScopeTotal` 的唯一取值来源）。
 *
 * 恢复期重建需要它的 `recordedAt` 作为"确定性派生的完成时刻"，因此单独暴露；
 * 它与总值解析共用同一套过滤顺序（先任务、再取代集、再 scope、再 asOf 与序），
 * 不可能给出与 `resolveScopeTotal` 不一致的赢家。
 */
export function resolveEffectiveEvent(
  events: TaskProgressEventRow[],
  taskId: string,
  scope: ProgressScope,
  asOfGameDate?: string | null,
): TaskProgressEventRow | null {
  const taskEvents = events.filter((event) => event.taskDefinitionId === taskId);
  const superseded = new Set<string>();
  for (const event of taskEvents) {
    if (event.correctsEventId) superseded.add(event.correctsEventId);
  }
  const key = scopeKey(scope);
  let winner: TaskProgressEventRow | null = null;
  for (const event of taskEvents) {
    if (scopeKey(scopeOfEvent(event)) !== key) continue;
    if (!isEffective(event, superseded)) continue;
    if (asOfGameDate != null && event.gameDate > asOfGameDate) continue;
    if (winner === null) {
      winner = event;
      continue;
    }
    if (event.gameDate > winner.gameDate) {
      winner = event;
    } else if (event.gameDate === winner.gameDate && event.sequence > winner.sequence) {
      winner = event;
    }
  }
  return winner;
}

/** 该任务在该 scope 内是否有**任何**归属观测（含被取代者与 RETRACT 之外的提交）。 */
export function hasObservationInScope(
  events: TaskProgressEventRow[],
  taskId: string,
  scope: ProgressScope,
): boolean {
  const key = scopeKey(scope);
  return events.some(
    (event) => event.taskDefinitionId === taskId && scopeKey(scopeOfEvent(event)) === key,
  );
}

function normalize(value: string): string {
  const parsed = parseDecimal(value);
  const negative = parsed.units < 0n;
  const abs = negative ? -parsed.units : parsed.units;
  const whole = abs / 1000n;
  const fraction = abs % 1000n;
  const fractionText =
    fraction === 0n ? '' : `.${fraction.toString().padStart(3, '0').replace(/0+$/, '')}`;
  return `${negative ? '-' : ''}${whole.toString()}${fractionText}`;
}

/** 事件 payload 的规范形态，用于幂等比较（不参与 `recordedAt`/`createdAt`）。 */
export function canonicalEventPayload(event: {
  taskDefinitionId: string;
  kind: ProgressEventKind;
  scopeType: ProgressScopeType;
  scopePeriodId: string | null;
  scopeSessionId: string | null;
  gameDate: string;
  totalValue: string | null;
  correctsEventId: string | null;
}): string {
  const total = event.totalValue === null ? '' : normalize(event.totalValue);
  return [
    event.taskDefinitionId,
    event.kind,
    event.scopeType,
    event.scopePeriodId ?? '',
    event.scopeSessionId ?? '',
    event.gameDate,
    total,
    event.correctsEventId ?? '',
  ].join('|');
}

export interface EventChainContext {
  taskById: Map<string, TaskDefinitionRow>;
  /** orderId → 订单类型与托管模式（null 读作按日期）。 */
  orderById: Map<string, { type: OrderType; hostingMode: HostingMode | null }>;
  /**
   * periodId → 期次归属、目标与名义服务区间。
   *
   * `serviceStart` 是计次期次的**实际服务下界**（`countPeriodServiceStart`）；`startDate`
   * 只是满足唯一约束的内部锚点，同日续期会把它推后（F1）。
   */
  periodById: Map<
    string,
    {
      orderId: string;
      serviceCount: number | null;
      startDate: string;
      endDate: string;
      serviceStart: string;
    }
  >;
  /** sessionId → { orderId, periodId } */
  sessionById: Map<string, { orderId: string; periodId: string }>;
}

/**
 * 事件归属日期的服务区间（S2-R2 / F1）。
 *
 * - 任务自身的 `activeFrom/activeUntil` 永远生效；
 * - 下界分两种：按日期期次是 `startDate`；计次期次是**实际服务起点** `serviceStart`
 *   （`countPeriodServiceStart`）。把计次期次的存储锚点当下界，会把同日续期当天的合法
 *   进度判成非法；
 * - 上界只对**按日期期次**生效：计次期次的名义 `startDate/endDate` 在安卓建单时相同，
 *   轮次可以晚于名义结束日完成，用上界会把合法的历史轮次判成非法。
 */
function withinServiceRange(
  task: TaskDefinitionRow,
  period: {
    serviceCount: number | null;
    startDate: string;
    endDate: string;
    serviceStart: string;
  } | null,
  gameDate: string,
): boolean {
  if (task.activeFrom !== null && gameDate < task.activeFrom) return false;
  if (task.activeUntil !== null && gameDate > task.activeUntil) return false;
  if (period !== null) {
    const start = period.serviceCount === null ? period.startDate : period.serviceStart;
    if (gameDate < start) return false;
    if (period.serviceCount === null && gameDate > period.endDate) return false;
  }
  return true;
}

/**
 * 严格校验追加式事件链（恢复时与写入前共用）。
 *
 * 覆盖：kind/payload 形状、scope 矩阵、scope 归属、更正目标同任务/同 scope/同日、
 * 被取代事件不得再被更正（单后继）、更正环、序号关系、operationId 与 sequence 唯一。
 */
export function validateProgressEvents(
  events: TaskProgressEventRow[],
  context: EventChainContext,
): ProgressEventViolation[] {
  const violations: ProgressEventViolation[] = [];
  const byId = new Map<string, TaskProgressEventRow>();
  const operationIds = new Set<string>();
  const sequences = new Set<string>();
  const correctedTargets = new Set<string>();

  for (const event of events) {
    if (byId.has(event.id)) {
      violations.push({ code: 'DUPLICATE_OPERATION_ID', eventId: event.id, reason: '事件 id 重复' });
    }
    byId.set(event.id, event);
    if (operationIds.has(event.operationId)) {
      violations.push({
        code: 'DUPLICATE_OPERATION_ID',
        eventId: event.id,
        reason: `operationId ${event.operationId} 重复`,
      });
    }
    operationIds.add(event.operationId);
    const sequenceKey = `${event.taskDefinitionId}#${event.sequence}`;
    if (sequences.has(sequenceKey)) {
      violations.push({
        code: 'DUPLICATE_SEQUENCE',
        eventId: event.id,
        reason: `任务内序号 ${event.sequence} 重复`,
      });
    }
    sequences.add(sequenceKey);
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      violations.push({
        code: 'IMPOSSIBLE_SEQUENCE',
        eventId: event.id,
        reason: '序号必须是从 1 起的整数',
      });
    }
    if (event.correctsEventId !== null) {
      if (correctedTargets.has(event.correctsEventId)) {
        violations.push({
          code: 'SUPERSEDED_EVENT',
          eventId: event.id,
          reason: `目标事件 ${event.correctsEventId} 已被更正过（单后继）`,
        });
      }
      correctedTargets.add(event.correctsEventId);
    }
  }

  for (const event of events) {
    const task = context.taskById.get(event.taskDefinitionId);
    if (!task) {
      violations.push({
        code: 'SCOPE_OWNERSHIP_INVALID',
        eventId: event.id,
        reason: '事件引用了不存在的任务',
        objects: { eventId: event.id, taskDefinitionId: event.taskDefinitionId },
      });
      continue;
    }
    const order = context.orderById.get(task.orderId);
    const objects: Record<string, string> = {
      eventId: event.id,
      taskDefinitionId: task.id,
      orderId: task.orderId,
      periodId: task.periodId ?? '',
      sessionId: event.scopeSessionId ?? '',
    };
    // kind / payload 形状
    if (event.kind === 'SUBMIT') {
      if (event.correctsEventId !== null || event.totalValue === null) {
        violations.push({
          code: 'KIND_PAYLOAD_INVALID',
          eventId: event.id,
          reason: 'SUBMIT 必须携带总值且不指向被更正事件',
          objects,
        });
      }
    } else if (event.kind === 'CORRECT') {
      if (event.correctsEventId === null || event.totalValue === null) {
        violations.push({
          code: 'KIND_PAYLOAD_INVALID',
          eventId: event.id,
          reason: 'CORRECT 必须指向被更正事件并携带总值',
          objects,
        });
      }
    } else if (event.correctsEventId === null || event.totalValue !== null) {
      violations.push({
        code: 'KIND_PAYLOAD_INVALID',
        eventId: event.id,
        reason: 'RETRACT 必须指向被更正事件且不携带总值',
        objects,
      });
    }
    // 只有"数值 + 累计"任务才有事件（S2-R2）。
    if (task.progressType !== 'NUMERIC' || task.numericMode !== 'CUMULATIVE') {
      violations.push({
        code: 'TASK_NOT_CUMULATIVE',
        eventId: event.id,
        reason: `任务 ${task.id} 的 progressType=${task.progressType}、numericMode=${
          task.numericMode ?? 'null(PER_OCCURRENCE)'
        }，只有 NUMERIC + CUMULATIVE 任务允许累计事件`,
        objects,
      });
    }
    if (!order) {
      violations.push({
        code: 'SCOPE_OWNERSHIP_INVALID',
        eventId: event.id,
        reason: `任务 ${task.id} 引用了不存在的订单 ${task.orderId}`,
        objects,
      });
      continue;
    }
    // scope 字段自洽
    const periodFieldOk = event.scopeType === 'PERIOD' ? event.scopePeriodId !== null : event.scopePeriodId === null;
    const sessionFieldOk =
      event.scopeType === 'SESSION' ? event.scopeSessionId !== null : event.scopeSessionId === null;
    if (!periodFieldOk || !sessionFieldOk) {
      violations.push({
        code: 'SCOPE_FIELDS_INCONSISTENT',
        eventId: event.id,
        reason: 'scope 类型与 scopePeriodId/scopeSessionId 不一致',
        objects,
      });
    }
    // scope 矩阵
    const allowed = allowedScopeKind(order.type, order.hostingMode);
    if (event.scopeType !== allowed) {
      violations.push({
        code: 'SCOPE_NOT_ALLOWED',
        eventId: event.id,
        reason: `订单 ${task.orderId}（${order.type}/${order.hostingMode ?? 'null→DATE_RANGE'}）只允许 ${allowed} scope，实际 ${event.scopeType}`,
        objects,
      });
    }
    // scope 归属：每种 scope 都有精确的归属与形状要求。
    if (event.scopeType === 'TASK') {
      if (order.type !== 'SHORT_TASK' || task.periodId !== null) {
        violations.push({
          code: 'TASK_SCOPE_REQUIRES_PERIODLESS_TASK',
          eventId: event.id,
          reason: `TASK scope 只属于短期单任务；任务 ${task.id} 属于订单 ${task.orderId}（${order.type}），期次 ${task.periodId ?? 'null'}`,
          objects,
        });
      }
      if (!withinServiceRange(task, null, event.gameDate)) {
        violations.push({
          code: 'EVENT_DATE_OUT_OF_SERVICE_RANGE',
          eventId: event.id,
          reason: `事件 ${event.id} 的游戏日 ${event.gameDate} 不在任务 ${task.id} 的生效区间内`,
          objects,
        });
      }
    }
    if (event.scopeType === 'PERIOD' && event.scopePeriodId !== null) {
      const period = context.periodById.get(event.scopePeriodId);
      if (!period || period.orderId !== task.orderId) {
        violations.push({
          code: 'SCOPE_OWNERSHIP_INVALID',
          eventId: event.id,
          reason: `scope 期次 ${event.scopePeriodId} 不属于订单 ${task.orderId}`,
          objects,
        });
      } else {
        if (task.periodId !== event.scopePeriodId) {
          violations.push({
            code: 'SCOPE_PERIOD_NOT_TASK_PERIOD',
            eventId: event.id,
            reason: `事件 ${event.id} 的期次 ${event.scopePeriodId} 不是任务 ${task.id} 自己的期次 ${task.periodId ?? 'null'}`,
            objects: { ...objects, scopePeriodId: event.scopePeriodId },
          });
        }
        if (period.serviceCount !== null) {
          violations.push({
            code: 'SCOPE_PERIOD_NOT_DATE_BASED',
            eventId: event.id,
            reason: `期次 ${event.scopePeriodId} 是计次期次（serviceCount=${period.serviceCount}），不接受 PERIOD scope`,
            objects: { ...objects, scopePeriodId: event.scopePeriodId },
          });
        }
        if (!withinServiceRange(task, period, event.gameDate)) {
          violations.push({
            code: 'EVENT_DATE_OUT_OF_SERVICE_RANGE',
            eventId: event.id,
            reason: `事件 ${event.id} 的游戏日 ${event.gameDate} 不在期次 ${period.startDate}..${period.endDate} 与任务的生效区间内`,
            objects: { ...objects, scopePeriodId: event.scopePeriodId },
          });
        }
      }
    }
    if (event.scopeType === 'SESSION' && event.scopeSessionId !== null) {
      const session = context.sessionById.get(event.scopeSessionId);
      if (!session || session.orderId !== task.orderId) {
        violations.push({
          code: 'SCOPE_OWNERSHIP_INVALID',
          eventId: event.id,
          reason: `scope 轮次 ${event.scopeSessionId} 不属于订单 ${task.orderId}`,
          objects,
        });
      } else {
        if (task.periodId !== session.periodId) {
          violations.push({
            code: 'SCOPE_SESSION_PERIOD_MISMATCH',
            eventId: event.id,
            reason: `轮次 ${event.scopeSessionId} 属于期次 ${session.periodId}，任务 ${task.id} 属于期次 ${task.periodId ?? 'null'}`,
            objects: { ...objects, scopeSessionId: event.scopeSessionId, sessionPeriodId: session.periodId },
          });
        }
        const sessionPeriod = context.periodById.get(session.periodId);
        if (!sessionPeriod || sessionPeriod.serviceCount === null) {
          violations.push({
            code: 'SCOPE_SESSION_NOT_COUNT_BASED',
            eventId: event.id,
            reason: `轮次 ${event.scopeSessionId} 的期次 ${session.periodId} 不是计次期次，不接受 SESSION scope`,
            objects: { ...objects, scopeSessionId: event.scopeSessionId, sessionPeriodId: session.periodId },
          });
        } else if (!withinServiceRange(task, sessionPeriod, event.gameDate)) {
          violations.push({
            code: 'EVENT_DATE_OUT_OF_SERVICE_RANGE',
            eventId: event.id,
            reason: `事件 ${event.id} 的游戏日 ${event.gameDate} 早于期次 ${sessionPeriod.startDate} 或超出任务 ${task.id} 的生效区间`,
            objects: { ...objects, scopeSessionId: event.scopeSessionId, sessionPeriodId: session.periodId },
          });
        }
      }
    }
    // 更正关系
    if (event.correctsEventId !== null) {
      const target = byId.get(event.correctsEventId);
      if (!target) {
        violations.push({
          code: 'CORRECTION_TARGET_MISSING',
          eventId: event.id,
          reason: '被更正事件不存在',
        });
        continue;
      }
      if (target.taskDefinitionId !== event.taskDefinitionId) {
        violations.push({
          code: 'CORRECTION_TARGET_OTHER_TASK',
          eventId: event.id,
          reason: `被更正事件 ${target.id} 属于任务 ${target.taskDefinitionId}，不是 ${event.taskDefinitionId}`,
          objects: { ...objects, targetEventId: target.id, targetTaskId: target.taskDefinitionId },
        });
      }
      if (!sameScope(scopeOfEvent(target), scopeOfEvent(event))) {
        violations.push({
          code: 'CORRECTION_TARGET_OTHER_SCOPE',
          eventId: event.id,
          reason: `更正不得跨 scope（${scopeKey(scopeOfEvent(target))} → ${scopeKey(scopeOfEvent(event))}）`,
          objects: { ...objects, targetEventId: target.id },
        });
      }
      // 归属日期不可变：要改日期只能 RETRACT + 新 SUBMIT。
      if (target.gameDate !== event.gameDate) {
        violations.push({
          code: 'CORRECTION_DATE_CHANGED',
          eventId: event.id,
          reason: `更正必须与被更正事件同一游戏日（${target.gameDate} → ${event.gameDate}）`,
          objects: { ...objects, targetEventId: target.id },
        });
      }
      if (event.sequence <= target.sequence) {
        violations.push({
          code: 'IMPOSSIBLE_SEQUENCE',
          eventId: event.id,
          reason: `更正事件的序号必须大于被更正事件（${event.sequence} <= ${target.sequence}）`,
          objects: { ...objects, targetEventId: target.id },
        });
      }
    }
  }

  // 更正环：沿 correctsEventId 走，遇到重复即环。
  for (const event of events) {
    const seen = new Set<string>();
    let cursor: TaskProgressEventRow | undefined = event;
    while (cursor && cursor.correctsEventId) {
      if (seen.has(cursor.id)) {
        violations.push({ code: 'CORRECTION_CYCLE', eventId: event.id, reason: '更正链存在环' });
        break;
      }
      seen.add(cursor.id);
      cursor = byId.get(cursor.correctsEventId);
    }
  }

  return violations;
}

/** 达到目标判定（`current >= target`）。 */
export function reachedTarget(current: string, target: string): boolean {
  return compareDecimal(parseDecimal(current), parseDecimal(target)) >= 0;
}

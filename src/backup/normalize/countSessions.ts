import type {
  BackupDataSet,
  HostingPeriodRow,
  HostingSessionRow,
  OrderRow,
  TaskDefinitionRow,
  TaskOccurrenceRow,
} from '../../contracts/tables';
import { LIMITS } from '../../contracts/tables';
import { gameDateAt } from '../../domain/gameCalendar';
import { bailAll, type MigrationDiagnostic } from './diagnostics';

const LEGACY_COUNT_PREFIX = 'C:';

/** 某期次在其游戏日上的"历史应做任务集"（按次数期次：除一次性任务外每天都要做）。 */
export function countDueTasksOn(
  tasks: TaskDefinitionRow[],
  period: HostingPeriodRow,
  gameDate: string,
): TaskDefinitionRow[] {
  if (period.serviceCount == null) return [];
  if (gameDate < period.startDate) return [];
  return tasks.filter((task) => {
    if (task.periodId !== period.id) return false;
    if (task.recurrence === 'ONE_TIME') return false;
    if (task.activeFrom !== null && gameDate < task.activeFrom) return false;
    if (task.activeUntil !== null && gameDate > task.activeUntil) return false;
    if (task.retiredAt !== null) {
      const retireDate = gameDateAt(task.retiredAt, period.gameZoneId, period.dailyRefreshMinutes);
      // 退休日当天仍可能已产生打卡行：把该日算作应做，宁可判"不完整"也不虚判完成。
      if (gameDate > retireDate) return false;
    }
    return true;
  });
}

function isCountPeriod(period: HostingPeriodRow): boolean {
  return period.serviceCount != null;
}

function sessionIndexOrNull(key: string): number | null {
  if (!key.startsWith('N:')) return null;
  const raw = key.slice(2);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * 由期次反推订单级托管模式（`web-12-to-15-business` 的 orders 部分）。
 *
 * - 全部期次都是计次期次 → COUNT_BASED + `targetSessions` = 最高 periodIndex 计次期次的目标；
 * - 没有计次期次 → 保持 null（按日期）；
 * - 混合 → 对象级诊断并中止（不挑选、不合并）。
 *
 * Android 13/14 的订单已带真实 `hostingMode`/`targetSessions`，只做一致性校验，
 * 不用期次信息覆盖它。
 */
export function alignOrderHostingMode(
  data: BackupDataSet,
): { changed: number; notes: string[] } {
  const diagnostics: MigrationDiagnostic[] = [];
  const notes: string[] = [];
  const periodsByOrder = new Map<string, HostingPeriodRow[]>();
  for (const period of data.hosting_periods) {
    const list = periodsByOrder.get(period.orderId) ?? [];
    list.push(period);
    periodsByOrder.set(period.orderId, list);
  }

  let changed = 0;
  for (const order of data.orders) {
    const periods = periodsByOrder.get(order.id) ?? [];
    const countPeriods = periods.filter(isCountPeriod);
    const countSessions = data.hosting_sessions.filter((row) => row.orderId === order.id);
    if (order.type !== 'HOSTING') {
      if (order.hostingMode != null || order.targetSessions != null) {
        diagnostics.push({
          code: 'OWNERSHIP_INCONSISTENT',
          objects: { orderId: order.id },
          reason: '非托管订单不得声明托管模式或打卡目标',
        });
      }
      if (countSessions.length > 0) {
        diagnostics.push({
          code: 'OWNERSHIP_INCONSISTENT',
          objects: { orderId: order.id },
          reason: '非托管订单不得包含打卡轮次',
        });
      }
      continue;
    }
    if (order.hostingMode === 'DATE_RANGE') {
      if (countPeriods.length > 0) {
        diagnostics.push({
          code: 'OWNERSHIP_INCONSISTENT',
          objects: { orderId: order.id, countPeriods: countPeriods.length },
          reason: '按日期订单不得包含计次期次',
        });
      }
      if (countSessions.length > 0) {
        diagnostics.push({
          code: 'OWNERSHIP_INCONSISTENT',
          objects: { orderId: order.id, sessions: countSessions.length },
          reason: '按日期订单不得包含打卡轮次',
        });
      }
      continue;
    }
    if (order.hostingMode === 'COUNT_BASED') {
      // 已声明计次的订单：网页允许多期次（每期自带 serviceCount）。只有"期次没有
      // 自己的目标"时才需要 Android 的单期次回填，其歧义由
      // `android-count-period-backfill` 单独诊断，这里不重复判。
      continue;
    }
    // hostingMode === null：网页 12 从未写该列，由期次形状推导。
    if (countPeriods.length === 0) continue;
    if (countPeriods.length !== periods.length) {
      diagnostics.push({
        code: 'OWNERSHIP_INCONSISTENT',
        objects: {
          orderId: order.id,
          countPeriods: countPeriods.map((row) => row.id).join(','),
          datePeriods: periods
            .filter((row) => !isCountPeriod(row))
            .map((row) => row.id)
            .join(','),
        },
        reason: '同一订单混合计次期次与按日期期次，没有安全的托管模式',
      });
      continue;
    }
    const highest = countPeriods.reduce((left, right) =>
      right.periodIndex > left.periodIndex ||
      (right.periodIndex === left.periodIndex && right.id > left.id)
        ? right
        : left,
    );
    order.hostingMode = 'COUNT_BASED';
    order.targetSessions = highest.serviceCount;
    changed += 1;
    notes.push(`order ${order.id} 依据计次期次推导为 COUNT_BASED/${String(highest.serviceCount)}`);
  }

  // 其余订单不得残留目标镜像。
  for (const order of data.orders) {
    if (order.hostingMode !== 'COUNT_BASED') order.targetSessions = null;
  }
  if (diagnostics.length > 0) bailAll(diagnostics, '订单托管模式无法安全推导');
  return { changed, notes };
}

/**
 * Android 13/14 计次归属回填（`android-count-period-backfill`）。
 *
 * 有效计次订单恰好一个期次 → 归属可证；期次目标来自 `orders.targetSessions`。
 * 歧义即中止，绝不合并或挑选。
 */
export function backfillAndroidCountPeriods(data: BackupDataSet): {
  periodsFilled: number;
  sessionsOwned: number;
} {
  const diagnostics: MigrationDiagnostic[] = [];
  const periodsByOrder = new Map<string, HostingPeriodRow[]>();
  for (const period of data.hosting_periods) {
    const list = periodsByOrder.get(period.orderId) ?? [];
    list.push(period);
    periodsByOrder.set(period.orderId, list);
  }
  let periodsFilled = 0;
  for (const order of data.orders) {
    if (order.hostingMode !== 'COUNT_BASED') continue;
    const periods = periodsByOrder.get(order.id) ?? [];
    const sessions = data.hosting_sessions.filter((row) => row.orderId === order.id);
    const unowned = sessions.some((row) => row.periodId === null || row.periodId === undefined);
    if (!unowned && periods.every((row) => isCountPeriod(row))) continue;
    if (periods.length !== 1) {
      diagnostics.push({
        code: 'COUNT_PERIOD_AMBIGUOUS',
        objects: {
          orderId: order.id,
          sessionIds: sessions.map((row) => row.id).join(','),
          candidatePeriodIds: periods.map((row) => row.id).join(','),
          reason: `计次订单期望恰好 1 个期次，实际 ${periods.length} 个`,
        },
        reason: '无法证明打卡轮次归属的期次',
      });
      continue;
    }
    const period = periods[0];
    if (period.serviceCount == null) {
      const target = order.targetSessions;
      if (target == null || !Number.isInteger(target) || target < 1 || target > LIMITS.maxTargetSessions) {
        diagnostics.push({
          code: 'COUNT_TARGET_MISSING',
          objects: { orderId: order.id, periodId: period.id },
          reason: '计次订单缺少有效的目标次数，期次目标无法回填',
        });
        continue;
      }
      period.serviceCount = target;
      periodsFilled += 1;
    }
    for (const session of sessions) {
      session.periodId = period.id;
    }
  }
  if (diagnostics.length > 0) bailAll(diagnostics, '打卡轮次归属无法安全回填');
  const sessionsOwned = data.hosting_sessions.filter(
    (row) => typeof row.periodId === 'string' && row.periodId.length > 0,
  ).length;
  return { periodsFilled, sessionsOwned };
}

interface Group {
  orderId: string;
  period: HostingPeriodRow;
  gameDate: string;
  occurrences: TaskOccurrenceRow[];
}

/**
 * 网页 `C:<gameDate>` → `N:<订单全局序号>`（`web-count-sessions-from-dates`）。
 *
 * 分组键 `(orderId, periodId, gameDate)`；每组只建一行、只登记一次 id；组内所有
 * occurrence 共用同一个 `N:` 号；每个订单独立计数；同一日期跨期次/跨订单合法。
 */
export function migrateCountSessionsFromDates(data: BackupDataSet): {
  sessionsCreated: number;
  occurrencesRewritten: number;
  alreadyMigratedOrders: number;
  ordersMigrated: number;
} {
  const diagnostics: MigrationDiagnostic[] = [];
  const taskById = new Map(data.task_definitions.map((row) => [row.id, row]));
  const periodById = new Map(data.hosting_periods.map((row) => [row.id, row]));
  const orderById = new Map(data.orders.map((row) => [row.id, row]));
  const existingSessionIds = new Set(data.hosting_sessions.map((row) => row.id));

  // 1. 归属解析：每条 occurrence 找到任务 → 期次 → 订单。
  interface Located {
    occurrence: TaskOccurrenceRow;
    task: TaskDefinitionRow;
    period: HostingPeriodRow;
    order: OrderRow;
    legacy: boolean;
  }
  const located: Located[] = [];
  const seenOccurrenceIds = new Set<string>();
  for (const occurrence of data.task_occurrences) {
    const task = taskById.get(occurrence.taskDefinitionId);
    if (!task) {
      diagnostics.push({
        code: 'OWNERSHIP_INCONSISTENT',
        objects: { occurrenceId: occurrence.id },
        reason: '打卡记录引用了不存在的任务',
      });
      continue;
    }
    const order = orderById.get(task.orderId);
    const period = task.periodId === null ? undefined : periodById.get(task.periodId);
    if (!order || !period || period.orderId !== order.id) {
      diagnostics.push({
        code: 'OWNERSHIP_INCONSISTENT',
        objects: {
          occurrenceId: occurrence.id,
          taskId: task.id,
          periodId: task.periodId,
          orderId: task.orderId,
        },
        reason: '打卡记录的任务/期次/订单归属不一致',
      });
      continue;
    }
    if (seenOccurrenceIds.has(occurrence.id)) {
      diagnostics.push({
        code: 'SOURCE_RECORD_IN_MULTIPLE_GROUPS',
        objects: { occurrenceId: occurrence.id },
        reason: '同一条源记录出现多次，不能归入多个分组',
      });
      continue;
    }
    seenOccurrenceIds.add(occurrence.id);
    located.push({
      occurrence,
      task,
      period,
      order,
      legacy: occurrence.occurrenceKey.startsWith(LEGACY_COUNT_PREFIX),
    });
  }

  const affectedOrders = new Set<string>();
  for (const item of located) {
    if (isCountPeriod(item.period)) affectedOrders.add(item.order.id);
  }
  // 期次是计次但一条打卡行都没有的订单同样属于"已迁移/无数据"。
  for (const period of data.hosting_periods) {
    if (isCountPeriod(period)) affectedOrders.add(period.orderId);
  }

  // 2. 混合 C:/N: 同一订单 → 写入前拒绝，绝不部分重编号。
  for (const orderId of affectedOrders) {
    const items = located.filter((item) => item.order.id === orderId);
    const hasLegacy = items.some((item) => item.legacy);
    const hasModern = items.some((item) => !item.legacy);
    if (hasLegacy && hasModern) {
      diagnostics.push({
        code: 'UNSUPPORTED_MIXED_C_N_INPUT',
        objects: {
          orderId,
          legacyKeys: items.filter((item) => item.legacy).map((item) => item.occurrence.occurrenceKey).join(','),
          modernKeys: items.filter((item) => !item.legacy).map((item) => item.occurrence.occurrenceKey).join(','),
        },
        reason: '同一订单混合 C: 与 N: 打卡键，没有安全映射',
      });
    }
    // 计次期次之外的 C: 行同样无法映射。
    for (const item of items) {
      if (item.legacy && !isCountPeriod(item.period)) {
        diagnostics.push({
          code: 'OWNERSHIP_INCONSISTENT',
          objects: { occurrenceId: item.occurrence.id, periodId: item.period.id },
          reason: 'C: 打卡键出现在非计次期次，无法映射为轮次',
        });
      }
    }
  }
  if (diagnostics.length > 0) bailAll(diagnostics, '打卡轮次无法安全迁移');

  // 3. 逐订单建组：期次 (periodIndex, periodId) 升序，期次内 gameDate 升序。
  let sessionsCreated = 0;
  let occurrencesRewritten = 0;
  let ordersMigrated = 0;
  let alreadyMigratedOrders = 0;
  const generatedIdentities = new Set<string>();

  for (const orderId of [...affectedOrders].sort()) {
    const items = located.filter((item) => item.order.id === orderId);
    const periods = data.hosting_periods
      .filter((period) => period.orderId === orderId && isCountPeriod(period))
      .sort((left, right) =>
        left.periodIndex === right.periodIndex
          ? left.id.localeCompare(right.id)
          : left.periodIndex - right.periodIndex,
      );
    const orderTasks = data.task_definitions.filter((task) => task.orderId === orderId);

    const groups: Group[] = [];
    for (const period of periods) {
      const periodItems = items.filter((item) => item.period.id === period.id && item.legacy);
      const byDate = new Map<string, TaskOccurrenceRow[]>();
      for (const item of periodItems) {
        const list = byDate.get(item.occurrence.gameDate) ?? [];
        list.push(item.occurrence);
        byDate.set(item.occurrence.gameDate, list);
      }
      for (const gameDate of [...byDate.keys()].sort()) {
        groups.push({ orderId, period, gameDate, occurrences: byDate.get(gameDate) ?? [] });
      }
    }

    if (groups.length === 0) {
      if (items.length === 0 || items.every((item) => !item.legacy)) alreadyMigratedOrders += 1;
      continue;
    }
    ordersMigrated += 1;

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const sessionIndex = index + 1;
      const sessionId = `mig-session-${orderId}-${sessionIndex}`;
      const identity = `${orderId}#${sessionIndex}`;
      if (existingSessionIds.has(sessionId) || generatedIdentities.has(identity)) {
        diagnostics.push({
          code: 'GENERATED_ID_OR_INDEX_COLLISION',
          objects: { orderId, sessionId, sessionIndex },
          reason: '生成的轮次 id 或身份与既有记录/其他分组冲突',
        });
        continue;
      }
      generatedIdentities.add(identity);
      existingSessionIds.add(sessionId);

      const due = countDueTasksOn(orderTasks, group.period, group.gameDate);
      const byTask = new Map<string, TaskOccurrenceRow>();
      for (const occurrence of group.occurrences) byTask.set(occurrence.taskDefinitionId, occurrence);
      let completedAt: number | null = null;
      let completionBatchId: string | null = null;
      if (due.length > 0 && due.every((task) => byTask.get(task.id)?.completedAt != null)) {
        const completed = due.map((task) => byTask.get(task.id) as TaskOccurrenceRow);
        completedAt = Math.max(...completed.map((row) => row.completedAt as number));
        const batches = new Set(completed.map((row) => row.completionBatchId ?? ''));
        if (batches.size === 1) {
          const only = [...batches][0];
          completionBatchId = only === '' ? null : only;
        }
      }

      const createdAts = group.occurrences.map((row) => row.createdAt);
      const session: HostingSessionRow = {
        id: sessionId,
        orderId,
        sessionIndex,
        createdAt: createdAts.length > 0 ? Math.min(...createdAts) : group.period.createdAt,
        completedAt,
        completionBatchId,
        periodId: group.period.id,
      };
      data.hosting_sessions.push(session);
      sessionsCreated += 1;

      for (const occurrence of group.occurrences) {
        occurrence.occurrenceKey = `N:${sessionIndex}`;
        occurrencesRewritten += 1;
      }
    }
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '打卡轮次无法安全迁移');
  return { sessionsCreated, occurrencesRewritten, alreadyMigratedOrders, ordersMigrated };
}

/**
 * 迁移后断言：schema 15 的数据里不得残留 `C:` 键，也不得有 periodId 为空的轮次。
 * 违反即格式错误（`attach-legacy-occurrence-keys`）。
 */
export function assertNoLegacyCountKeys(data: BackupDataSet): void {
  const diagnostics: MigrationDiagnostic[] = [];
  for (const occurrence of data.task_occurrences) {
    if (occurrence.occurrenceKey.startsWith(LEGACY_COUNT_PREFIX)) {
      diagnostics.push({
        code: 'UNSUPPORTED_MIXED_C_N_INPUT',
        objects: { occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey },
        reason: 'schema 15 不允许 C: 打卡键',
      });
    }
    if (occurrence.occurrenceKey.startsWith('N:') && sessionIndexOrNull(occurrence.occurrenceKey) === null) {
      diagnostics.push({
        code: 'OWNERSHIP_INCONSISTENT',
        objects: { occurrenceId: occurrence.id, occurrenceKey: occurrence.occurrenceKey },
        reason: 'N: 打卡键必须携带 1 起的整数轮次号',
      });
    }
  }
  for (const session of data.hosting_sessions) {
    if (typeof session.periodId !== 'string' || session.periodId.length === 0) {
      diagnostics.push({
        code: 'OWNERSHIP_INCONSISTENT',
        objects: { sessionId: session.id, orderId: session.orderId },
        reason: '打卡轮次缺少归属期次',
      });
    }
  }
  if (diagnostics.length > 0) bailAll(diagnostics, '迁移后仍存在无法解释的旧计次数据');
}

import type { BackupDataSet, SchemaVersion, TaskOccurrenceRow } from '../../contracts/tables';
import { CURRENT_SCHEMA } from '../../contracts/tables';
import { isISODate } from '../../domain/gameCalendar';
import { bailAll, type MigrationDiagnostic } from './diagnostics';

/**
 * 历史批次的两处确定性归一（S2-R4 / S2-R5）。
 *
 * 1. **HOSTING_ALL 形状**（D-21）：网页历史写入把 `targetId` 写成字面量 `'all'`、把
 *    当天游戏日写进 `gameDate`；契约要求两者都是 null（不同订单的时区/刷新时间不同，
 *    一个批次不可能有单一游戏日）。
 * 2. **批次明细 → 打卡记录的引用**：网页历史补建的 occurrence 没有回写
 *    `item.occurrenceId`（B-04）。这里只在**证据唯一**时补链，绝不凭日期或名称猜测。
 *
 * 两者都只在**便携 schema < 15** 的历史输入上执行；schema-15 输入按原样进入严格校验
 * （非规范形状会被拒绝，而不是被悄悄改写）。
 */
export interface BatchNormalizationContext {
  /**
   * batchId → 该批次**历史**记录的游戏日。
   *
   * HOSTING_ALL 的 `gameDate` 归一成 null 之后，这个日期仍是唯一能区分"同一天完成"的
   * 证据，因此必须保留到链接修复结束（R5：不要过早丢弃证据）。
   */
  legacyGameDateByBatch: Map<string, string>;
  /** 已经归一过的 HOSTING_ALL 批次数。 */
  hostingAllNormalized: number;
}

export function normalizeLegacyBatches(
  data: BackupDataSet,
  schemaVersion: SchemaVersion,
): BatchNormalizationContext {
  const context: BatchNormalizationContext = {
    legacyGameDateByBatch: new Map(),
    hostingAllNormalized: 0,
  };
  if (schemaVersion >= CURRENT_SCHEMA) return context;
  const diagnostics: MigrationDiagnostic[] = [];

  for (const batch of data.completion_batches) {
    if (batch.gameDate !== null) context.legacyGameDateByBatch.set(batch.id, batch.gameDate);
    if (batch.scope !== 'HOSTING_ALL') continue;
    const objects = { batchId: batch.id, scope: batch.scope };
    if (batch.targetId !== null && batch.targetId !== 'all') {
      // 未知目标形状绝不解释成合法值。
      diagnostics.push({
        code: 'UNSUPPORTED_LEGACY_BATCH_SHAPE',
        objects: { ...objects, targetId: batch.targetId },
        reason: 'HOSTING_ALL 批次的目标只允许 null 或历史哨兵值 "all"',
      });
      continue;
    }
    if (batch.gameDate !== null && !isISODate(batch.gameDate)) {
      diagnostics.push({
        code: 'UNSUPPORTED_LEGACY_BATCH_SHAPE',
        objects: { ...objects, gameDate: batch.gameDate },
        reason: 'HOSTING_ALL 批次的游戏日必须是合法 ISO 日期或 null',
      });
      continue;
    }
    const changed = batch.targetId !== null || batch.gameDate !== null;
    batch.targetId = null;
    batch.gameDate = null;
    if (changed) context.hostingAllNormalized += 1;
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '历史批量完成记录无法安全归一');
  return context;
}

export interface BatchLinkRepairResult {
  linked: number;
  /** 已撤销批次里"目标记录已随撤销消失"的明细数（保留历史，不臆造）。 */
  undoneWithoutTarget: number;
  notes: string[];
}

function matchesBatchDate(
  occurrence: TaskOccurrenceRow,
  batchDate: string | null,
): boolean {
  if (batchDate === null) return true;
  if (occurrence.gameDate === batchDate) return true;
  // 周窗口：一次性任务/周任务的历史 occurrence 键以窗口起点命名，归属日可能不同。
  return (
    occurrence.windowStart !== null &&
    occurrence.windowEnd !== null &&
    occurrence.windowStart <= batchDate &&
    batchDate <= occurrence.windowEnd
  );
}

export interface UndoneTargetAudit {
  /** 受支持的"无目标历史"明细数（`occurrenceId` 原本就是 null，且带任务引用）。 */
  nullTargetHistory: number;
}

/**
 * CD-01：已撤销批次的"无目标历史"是唯一可表达的历史形态（S2-R6）。
 *
 * 契约增量（`contractDeltas[CD-01]`）：`completion_batch_items.occurrenceId` 允许为
 * null，**只**在所属批次已撤销（`undoneAt` 非空）且明细带有效任务引用时成立。
 *
 * 支持 / 拒绝边界（两端必须逐条一致）：
 * - 已撤销 + `occurrenceId` 原本为 null + 任务引用 → **接受**，只计数，不改写、不臆造；
 * - 已撤销 + 非空 id 且记录存在 → 原样通过（目标身份与前后快照全部保留）；
 * - 已撤销 + 非空 id 但记录不存在 → **拒绝**（`UNDONE_BATCH_TARGET_DANGLING`，激活前、
 *   对象级诊断，原 id 同时保留在诊断与输入里）。绝不写 null、绝不猜替代目标、绝不臆造
 *   occurrence、绝不删明细：已知 id 是历史事实，把它丢进临时迁移报告并不等于无损；
 * - 未撤销 + 悬空 id → 继续按严格规则拒绝（`BATCH_TARGET_DANGLING`）。
 *
 * 该步骤对**所有**便携 schema 生效：它不是版本迁移，而是同一 schema 的可表达性断言，
 * 幂等（原本为 null 的仍是 null）。
 */
export function auditUndoneBatchTargets(data: BackupDataSet): UndoneTargetAudit {
  const result: UndoneTargetAudit = { nullTargetHistory: 0 };
  const diagnostics: MigrationDiagnostic[] = [];
  const batchById = new Map(data.completion_batches.map((batch) => [batch.id, batch]));
  const occurrenceIds = new Set(data.task_occurrences.map((occurrence) => occurrence.id));

  for (const item of data.completion_batch_items) {
    if (item.itemType !== 'OCCURRENCE') continue;
    const batch = batchById.get(item.batchId);
    if (!batch) continue; // 由严格校验拒绝（缺少批次）。
    if (item.occurrenceId === null) {
      // 只有"已撤销 + 任务引用"才是受支持的无目标历史；任务是否存在由严格校验判定。
      if (batch.undoneAt !== null && item.taskDefinitionId !== null) {
        result.nullTargetHistory += 1;
      }
      continue;
    }
    if (occurrenceIds.has(item.occurrenceId)) continue;
    if (batch.undoneAt === null) {
      diagnostics.push({
        code: 'BATCH_TARGET_DANGLING',
        objects: {
          itemId: item.id,
          batchId: batch.id,
          occurrenceId: item.occurrenceId,
          taskDefinitionId: item.taskDefinitionId ?? '',
        },
        reason: '未撤销批次的明细引用了不存在的打卡记录；悬空引用无法在两端持久化',
      });
      continue;
    }
    // 已知 id 但记录已消失：这一类历史没有无损的持久化表示（安卓是 RESTRICT 外键），
    // 因此明确拒绝，而不是把原 id 换成 null。
    diagnostics.push({
      code: 'UNDONE_BATCH_TARGET_DANGLING',
      objects: {
        itemId: item.id,
        batchId: batch.id,
        originalOccurrenceId: item.occurrenceId,
        taskDefinitionId: item.taskDefinitionId ?? '',
      },
      reason:
        `已撤销批次 ${batch.id} 的明细 ${item.id} 引用了已不存在的打卡记录 ` +
        `${item.occurrenceId}；原目标 id 无法在两端持久化，整份归档被拒绝（不改写为无目标历史）`,
    });
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '批量完成的历史目标无法安全表示');
  return result;
}

/**
 * 修复"批次明细缺少 occurrenceId"的历史数据（S2-R4 / D-17）。
 *
 * 证据分层，每一层都必须给出**唯一**目标：
 * 1. 应用态证据：`occurrence.completionBatchId === batch.id`，且任务一致；
 * 2. 时刻 + 值证据：`occurrence.completedAt === item.appliedCompletedAt` 且
 *    `occurrence.value` 与 `item.appliedValue` 一致，且任务一致。
 *
 * 日期只作**额外的收窄条件**，从不作为唯一证据；`HOSTING_ALL` 横跨不同时区，其历史
 * 游戏日不能用于收窄（否则会把另一个订单当天的记录排除掉）。多个或零个可辩护目标时
 * 输出对象级诊断并保留原数据集。
 */
export function repairLegacyBatchLinks(
  data: BackupDataSet,
  context: BatchNormalizationContext,
): BatchLinkRepairResult {
  const result: BatchLinkRepairResult = { linked: 0, undoneWithoutTarget: 0, notes: [] };
  const diagnostics: MigrationDiagnostic[] = [];
  const batchById = new Map(data.completion_batches.map((batch) => [batch.id, batch]));
  const taskById = new Map(data.task_definitions.map((task) => [task.id, task]));

  for (const item of data.completion_batch_items) {
    if (item.itemType !== 'OCCURRENCE') continue;
    if (item.occurrenceId !== null) continue;
    if (item.taskDefinitionId === null) {
      diagnostics.push({
        code: 'LEGACY_BATCH_LINK_UNRESOLVED',
        objects: { itemId: item.id, batchId: item.batchId },
        reason: '批次明细既没有打卡记录引用也没有任务引用，无法定位目标',
      });
      continue;
    }
    const batch = batchById.get(item.batchId);
    if (!batch) {
      diagnostics.push({
        code: 'LEGACY_BATCH_LINK_UNRESOLVED',
        objects: { itemId: item.id, batchId: item.batchId },
        reason: '批次明细引用了不存在的批次',
      });
      continue;
    }
    const task = taskById.get(item.taskDefinitionId);
    const batchDate =
      batch.scope === 'HOSTING_ALL' ? null : context.legacyGameDateByBatch.get(batch.id) ?? null;
    const sameTask = data.task_occurrences.filter(
      (occurrence) => occurrence.taskDefinitionId === item.taskDefinitionId,
    );
    const byAppliedBatch = sameTask.filter(
      (occurrence) =>
        occurrence.completionBatchId === batch.id && matchesBatchDate(occurrence, batchDate),
    );
    let candidates: TaskOccurrenceRow[] = byAppliedBatch;
    if (candidates.length === 0) {
      candidates = sameTask.filter(
        (occurrence) =>
          item.appliedCompletedAt !== null &&
          occurrence.completedAt === item.appliedCompletedAt &&
          (item.appliedValue === null || occurrence.value === item.appliedValue) &&
          matchesBatchDate(occurrence, batchDate),
      );
    }
    if (candidates.length === 1) {
      const target = candidates[0];
      item.occurrenceId = target.id;
      if (task && target.taskDefinitionId !== task.id) {
        diagnostics.push({
          code: 'LEGACY_BATCH_LINK_AMBIGUOUS',
          objects: { itemId: item.id, batchId: batch.id, occurrenceId: target.id },
          reason: '唯一候选的任务与明细的任务不一致',
        });
        continue;
      }
      result.linked += 1;
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push({
        code: 'LEGACY_BATCH_LINK_AMBIGUOUS',
        objects: {
          itemId: item.id,
          batchId: batch.id,
          taskDefinitionId: item.taskDefinitionId,
          candidateIds: candidates.map((row) => row.id).join(','),
        },
        reason: `存在 ${candidates.length} 条可辩护的打卡记录，无法唯一确定批次明细的目标`,
      });
      continue;
    }
    // 零候选：已撤销的历史批次可能把自己的 occurrence 删掉了，这是历史格式无法表达的
    // 情形（见交接文档的 contract delta）。保留历史行，绝不臆造一条打卡记录来满足引用。
    if (batch.undoneAt !== null) {
      result.undoneWithoutTarget += 1;
      result.notes.push(
        `已撤销批次 ${batch.id} 的明细 ${item.id} 目标记录已不存在，保留历史（不补造）`,
      );
      continue;
    }
    diagnostics.push({
      code: 'LEGACY_BATCH_LINK_UNRESOLVED',
      objects: {
        itemId: item.id,
        batchId: batch.id,
        taskDefinitionId: item.taskDefinitionId,
        gameDate: context.legacyGameDateByBatch.get(batch.id) ?? '',
      },
      reason: '没有任何打卡记录能证明该明细的目标',
    });
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '历史批量完成的打卡引用无法安全修复');
  return result;
}

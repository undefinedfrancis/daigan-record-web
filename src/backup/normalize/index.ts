import type { BackupDataSet, SchemaVersion } from '../../contracts/tables';
import { CURRENT_SCHEMA } from '../../contracts/tables';
import type { ColumnPresence } from '../dataCodec';
import {
  auditUndoneBatchTargets,
  normalizeLegacyBatches,
  repairLegacyBatchLinks,
} from './batches';
import { applyCategoryServiceDefaults } from './categoryDefaults';
import {
  alignOrderHostingMode,
  assertNoLegacyCountKeys,
  backfillAndroidCountPeriods,
  migrateCountSessionsFromDates,
} from './countSessions';
import { type MigrationReport, emptyReport } from './diagnostics';

/**
 * 旧文件里"缺列"与"存 null"必须分开处理的地方，全部集中在这里。
 *
 * 这些默认值是**读取语义**，不是迁移臆造：
 * - `completion_batch_items.itemType` 缺失时按出现的引用推断（schema 13 之前的文件）；
 * - 其余缺列由 codec 补 null，null 本身就是契约声明的读取默认值。
 */
function fillLegacyStructuralDefaults(data: BackupDataSet, columnsByTable: ColumnPresence): boolean {
  const itemColumns = columnsByTable.completion_batch_items ?? null;
  if (itemColumns !== null && itemColumns.includes('itemType')) return false;
  const hostingTaskIds = new Set(
    data.task_definitions.filter((task) => task.periodId !== null).map((task) => task.id),
  );
  let changed = false;
  for (const item of data.completion_batch_items) {
    // 有 occurrenceId → OCCURRENCE；否则看被引用的任务：托管任务（有期次）必然对应打卡
    // 记录，短期单任务才用 SHORT_TASK。**不能**因为引用缺失就一律判成 SHORT_TASK ——
    // 那会把"缺失打卡引用"的唯一证据抹掉，让后面的补链永远无法完成。
    item.itemType =
      item.occurrenceId !== null || (item.taskDefinitionId !== null && hostingTaskIds.has(item.taskDefinitionId))
        ? 'OCCURRENCE'
        : 'SHORT_TASK';
    changed = true;
  }
  return changed;
}

export interface NormalizeInput {
  data: BackupDataSet;
  columnsByTable: ColumnPresence;
  /** 输入声明的便携 schema。 */
  schemaVersion: SchemaVersion;
}

export interface NormalizeResult {
  report: MigrationReport;
  /** 输入是否真的低于当前便携 schema（决定是否需要写迁移说明）。 */
  legacy: boolean;
}

/**
 * 把任意受支持的 legacy 输入规范化成 schema-15 语义。
 *
 * 顺序固定：
 * 1. 结构性默认值（itemType）；
 * 2. `category-service-defaults`（必须早于共识镜像使用）；
 * 3. `web-12-to-15-business` 的订单部分（由期次推导托管模式）；
 * 4. `android-count-period-backfill`（计次订单恰一个期次）；
 * 5. `web-count-sessions-from-dates`（C: → N:）；
 * 6. 终态断言（无 C:、每个轮次有期次）。
 *
 * 任何一步的诊断都会让整次导入在**激活前**失败，当前数据集保持不变。
 */
export function normalizeDecodedDataset(input: NormalizeInput): NormalizeResult {
  const report = emptyReport();
  const legacy = input.schemaVersion < CURRENT_SCHEMA;
  const { data, columnsByTable } = input;

  if (legacy) {
    if (fillLegacyStructuralDefaults(data, columnsByTable)) {
      report.applied.push('attach-legacy-occurrence-keys:itemType');
      report.counts.itemTypeInferred = data.completion_batch_items.length;
    }

    // HOSTING_ALL 形状必须在任何"按批次定位目标"之前归一；历史游戏日随上下文保留，
    // 供后面的批次明细链接修复使用（否则证据会被过早丢弃）。
    const batches = normalizeLegacyBatches(data, input.schemaVersion);
    report.counts.hostingAllBatchesNormalized = batches.hostingAllNormalized;

    const categoryReport = applyCategoryServiceDefaults(data, columnsByTable);
    report.applied.push('category-service-defaults');
    report.counts.categoriesMigrated = categoryReport.categoriesMigrated;
    report.counts.templatesMigrated = categoryReport.templatesMigrated;
    report.notes.push(...categoryReport.notes);

    const hosting = alignOrderHostingMode(data);
    report.applied.push('web-12-to-15-business');
    report.counts.ordersHostingModeDerived = hosting.changed;
    report.notes.push(...hosting.notes);

    const backfill = backfillAndroidCountPeriods(data);
    report.applied.push('android-count-period-backfill');
    report.counts.periodsServiceCountFilled = backfill.periodsFilled;

    const sessions = migrateCountSessionsFromDates(data);
    report.applied.push('web-count-sessions-from-dates');
    report.counts.sessionsCreated = sessions.sessionsCreated;
    report.counts.occurrencesRewritten = sessions.occurrencesRewritten;
    report.counts.ordersMigrated = sessions.ordersMigrated;
    report.counts.ordersAlreadyMigrated = sessions.alreadyMigratedOrders;

    // C:→N: 重写之后再补链：键会变，id 不会变，因此证据在这之后依然成立。
    const links = repairLegacyBatchLinks(data, batches);
    report.counts.batchLinksRecovered = links.linked;
    report.counts.batchLinksWithoutTarget = links.undoneWithoutTarget;
    report.notes.push(...links.notes);
  }

  // CD-01：只**审计**已撤销批次的目标，不改写任何 id。这一步**对所有便携 schema 生效**：
  // 它不是版本迁移，而是同一 schema 的可表达性断言（安卓是 RESTRICT 外键，悬空 id 无法
  // 插入）。原本为 null 的无目标历史被接受并计数；已知但悬空的 id 在这里就中止，
  // 绝不改写成 null、也绝不留给校验器或 SQLite 才发现。
  const undoneTargets = auditUndoneBatchTargets(data);
  report.counts.undoneTargetsWithoutReference = undoneTargets.nullTargetHistory;

  assertNoLegacyCountKeys(data);
  return { report, legacy };
}

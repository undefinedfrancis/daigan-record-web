import { AppError } from '../../contracts/errors';

/**
 * 一条迁移诊断。**对象级**：写明受影响的业务对象与原因，而不是只给一句总失败。
 * 诊断是中止原因，绝不"降级继续"。
 */
export interface MigrationDiagnostic {
  /** 稳定机器码，便于测试与支持定位。 */
  code: MigrationDiagnosticCode;
  /** 受影响对象的标识（orderId / periodId / sessionId / categoryId ...）。 */
  objects: Record<string, string | number | null>;
  reason: string;
}

export type MigrationDiagnosticCode =
  | 'UNSUPPORTED_MIXED_C_N_INPUT'
  | 'OWNERSHIP_INCONSISTENT'
  | 'SOURCE_RECORD_IN_MULTIPLE_GROUPS'
  | 'GENERATED_ID_OR_INDEX_COLLISION'
  | 'COUNT_TARGET_MISSING'
  | 'COUNT_PERIOD_AMBIGUOUS'
  | 'UNKNOWN_COLOUR_TOKEN'
  | 'UNSUPPORTED_LEGACY_COLUMN_VALUE'
  | 'UNSUPPORTED_LEGACY_BATCH_SHAPE'
  | 'LEGACY_BATCH_LINK_UNRESOLVED'
  | 'LEGACY_BATCH_LINK_AMBIGUOUS'
  /** CD-01：未撤销批次的明细引用了不存在的打卡记录（悬空，无法在两端持久化）。 */
  | 'BATCH_TARGET_DANGLING'
  /**
   * CD-01：已撤销批次的明细带**非空但已不存在**的打卡记录 id。这一类历史没有无损的
   * 持久化表示（改写成 null 会丢掉原 id），因此整份归档在激活前被明确拒绝。
   */
  | 'UNDONE_BATCH_TARGET_DANGLING';

/** 携带全部对象级诊断的失败；调用方据此展示，不吞掉任何一条。 */
export class NormalizationError extends AppError {
  readonly diagnostics: MigrationDiagnostic[];

  constructor(code: AppErrorCode, summary: string, diagnostics: MigrationDiagnostic[]) {
    const detail = diagnostics
      .map((item) => `${item.code}(${JSON.stringify(item.objects)}): ${item.reason}`)
      .join(' | ');
    super(code, detail ? `${summary}：${detail}` : summary);
    this.name = 'NormalizationError';
    this.diagnostics = diagnostics;
  }
}

type AppErrorCode = ConstructorParameters<typeof AppError>[0];

export function bail(code: MigrationDiagnosticCode, objects: MigrationDiagnostic['objects'], reason: string): never {
  throw new NormalizationError('BACKUP_VALIDATION', '备份数据无法安全迁移', [{ code, objects, reason }]);
}

export function bailAll(
  diagnostics: MigrationDiagnostic[],
  summary = '备份数据无法安全迁移',
): never {
  throw new NormalizationError('BACKUP_VALIDATION', summary, diagnostics);
}

/** 记录一次迁移做了哪些确定性变换（写入预览/报告，便于复核）。 */
export interface MigrationReport {
  /** 已执行的迁移 id（契约 `migrations[].id`）。 */
  applied: string[];
  /** 关键计数，例如生成/改写的行数。 */
  counts: Record<string, number>;
  /** 非阻断说明（例如"该分类按模板值固化"）。 */
  notes: string[];
}

export function emptyReport(): MigrationReport {
  return { applied: [], counts: {}, notes: [] };
}

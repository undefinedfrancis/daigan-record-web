import { AppError } from '../contracts/errors';
import type { BackupDataSet, TableName } from '../contracts/tables';
import { BUSINESS_TABLES, CURRENT_SCHEMA } from '../contracts/tables';

/**
 * 备份列目录（便携 schema 15）。
 *
 * 这是网页端**唯一**的便携表/列声明来源：导出编码、导入解码、严格校验、以及
 * `emitMetadata()` 生成的契约元数据都读这里，因此元数据不可能与运行时不一致。
 *
 * 三条独立概念不要混用：
 * - `CURRENT_SCHEMA`（便携号 15）描述跨端文件；
 * - Dexie 本地版本号（3）描述本机对象仓库升级；
 * - `LEGACY_OPTIONAL_COLUMNS` 是**读取**兼容白名单，不代表当前写出列集。
 */
export type ColumnType = 'TEXT' | 'INT';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** 引入该列的便携 schema 号。 */
  since: number;
  /** 该列声明的枚举名（键在 `ENUM_DECLARATIONS`）。 */
  enumName?: string;
  /** 非空列的显式默认值；可空列的默认一律是 null。 */
  defaultValue?: string | number;
  /**
   * 只出现在 legacy 输入里的旧扩展列（schema < 15）。
   * 解码时接受，规范化迁移消费后从 vnext 数据集中移除。
   */
  legacyOnly?: boolean;
}

export interface ForeignKeySpec {
  from: string[];
  to: { table: string; columns: string[] };
  onDelete: 'RESTRICT' | 'CASCADE';
  onUpdate: 'RESTRICT' | 'CASCADE';
}

export interface TableSpec {
  name: TableName;
  columns: ColumnSpec[];
  primaryKey: string[];
  /** 单例设置表：恢复时只允许一行且主键为 0。 */
  singleton?: boolean;
  unique?: string[][];
  indexes?: string[][];
  foreignKeys?: ForeignKeySpec[];
  /** 最老可恢复代之后才出现的表：缺失时按空表补齐。 */
  legacyOptionalTableUntil?: number;
}

const t = (name: string, since: number, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  type: 'TEXT',
  nullable: true,
  since,
  ...extra,
});
const tN = (name: string, since: number, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  type: 'TEXT',
  nullable: false,
  since,
  ...extra,
});
const i = (name: string, since: number, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  type: 'INT',
  nullable: true,
  since,
  ...extra,
});
const iN = (name: string, since: number, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({
  name,
  type: 'INT',
  nullable: false,
  since,
  ...extra,
});

/** 契约声明的全部枚举；emitMetadata() 直接输出它。 */
export const ENUM_DECLARATIONS = {
  ORDER_TYPES: ['SHORT_TASK', 'HOSTING'],
  PAYMENT_MODES: ['ONE_TIME', 'INSTALLMENTS'],
  LOGIN_METHODS: ['PASSWORD', 'VERIFICATION_CODE', 'QR_CODE'],
  PROGRESS_TYPES: ['CHECKBOX', 'NUMERIC'],
  BATCH_ITEM_TYPES: ['OCCURRENCE', 'SHORT_TASK'],
  RECURRENCES: ['ONE_TIME', 'DAILY', 'WEEKLY', 'SELECTED_WEEKDAYS', 'EVERY_N_DAYS', 'MONTHLY'],
  RECEIPT_CHANNELS: ['WECHAT', 'ALIPAY', 'BANK', 'CASH', 'OTHER'],
  RECEIPT_STATUSES: ['ACTIVE', 'REPLACED', 'VOIDED'],
  CORRECTION_KINDS: ['AMEND', 'VOID'],
  BATCH_SCOPES: ['HOSTING_ORDER', 'HOSTING_ALL', 'SHORT_ORDER'],
  TEMPLATE_ORIGINS: ['BUILT_IN', 'USER', 'IMPORTED'],
  HOSTING_MODES: ['DATE_RANGE', 'COUNT_BASED'],
  NUMERIC_MODES: ['PER_OCCURRENCE', 'CUMULATIVE'],
  PROGRESS_EVENT_KINDS: ['SUBMIT', 'CORRECT', 'RETRACT'],
  PROGRESS_SCOPE_TYPES: ['TASK', 'PERIOD', 'SESSION'],
  OCCURRENCE_KEY_PREFIXES: ['D', 'S', 'E', 'M', 'W', 'C', 'N'],
  WEEKDAY_TOKENS: [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY',
  ],
} as const;

export const TABLE_SPECS: Record<TableName, TableSpec> = {

  owners: {
    name: 'owners',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      iN('number', 7),
      tN('nickname', 7),
      iN('createdAt', 7),
      iN('updatedAt', 7),
      i('archivedAt', 7),
      t('archiveBatchId', 7),
    ],
    unique: [['number']],
    indexes: [['number'], ['archivedAt']],
  },
  owner_number_sequence: {
    name: 'owner_number_sequence',
    primaryKey: ['id'],
    columns: [
      iN('id', 7),
      iN('nextNumber', 7),
    ],
    singleton: true,
  },
  account_categories: {
    name: 'account_categories',
    primaryKey: ['id'],
    columns: [
      tN('id', 15),
      tN('name', 15),
      iN('sortOrder', 15),
      iN('createdAt', 15),
      iN('updatedAt', 15),
    ],
    unique: [['name']],
    indexes: [['sortOrder']],
    legacyOptionalTableUntil: 14,
  },
  game_accounts: {
    name: 'game_accounts',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('ownerId', 7),
      tN('gameName', 7),
      tN('server', 7),
      tN('uid', 7),
      tN('loginAccount', 7),
      tN('loginMethod', 7, { enumName: 'LOGIN_METHODS' }),
      t('password', 7),
      iN('createdAt', 7),
      iN('updatedAt', 7),
      i('archivedAt', 7),
      t('archiveBatchId', 7),
      t('defaultTemplateId', 7),
      t('loginDevice', 9),
      t('resourceNotes', 11),
      t('categoryId', 15),
    ],
    indexes: [['ownerId'], ['ownerId', 'archivedAt'], ['categoryId']],
    foreignKeys: [
      { from: ['ownerId'], to: { table: 'owners', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  game_server_options: {
    name: 'game_server_options',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('gameName', 7),
      tN('name', 7),
      iN('sortOrder', 7),
    ],
    indexes: [['gameName', 'sortOrder']],
    legacyOptionalTableUntil: 8,
  },
  game_templates: {
    name: 'game_templates',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('gameName', 7),
      tN('templateVersion', 7),
      t('gameVersionNotes', 7),
      tN('zoneId', 7),
      iN('dailyRefreshMinutes', 7),
      iN('weeklyRefreshDay', 7),
      iN('weeklyRefreshMinutes', 7),
      tN('origin', 7, { enumName: 'TEMPLATE_ORIGINS' }),
      t('builtInKey', 7),
      iN('sortOrder', 7),
      iN('createdAt', 7),
      iN('updatedAt', 7),
      t('hostingMode', 13, { enumName: 'HOSTING_MODES' }),
      i('targetSessions', 13),
      t('serviceWeekdays', 15),
      t('defaultOrderTitle', 15),
      t('serviceMode', 12, { legacyOnly: true }),
      i('serviceCount', 12, { legacyOnly: true }),
    ],
    unique: [['builtInKey']],
    indexes: [['gameName']],
  },
  template_categories: {
    name: 'template_categories',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('templateId', 7),
      tN('name', 7),
      iN('sortOrder', 7),
      t('hostingMode', 15, { enumName: 'HOSTING_MODES' }),
      i('targetSessions', 15),
      t('serviceWeekdays', 15),
      t('serviceMode', 12, { legacyOnly: true }),
      i('serviceCount', 12, { legacyOnly: true }),
    ],
    indexes: [['templateId']],
    foreignKeys: [
      { from: ['templateId'], to: { table: 'game_templates', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  template_tasks: {
    name: 'template_tasks',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('templateId', 7),
      tN('categoryId', 7),
      tN('title', 7),
      tN('progressType', 7, { enumName: 'PROGRESS_TYPES' }),
      tN('startValue', 7),
      tN('targetValue', 7),
      t('unit', 7),
      tN('recurrence', 7, { enumName: 'RECURRENCES' }),
      t('weekdays', 7),
      i('everyNDays', 7),
      iN('sortOrder', 7),
      i('monthDay', 7),
      t('monthDays', 7),
      t('activeFrom', 15),
      t('activeUntil', 15),
      t('numericMode', 15, { enumName: 'NUMERIC_MODES' }),
    ],
    indexes: [['templateId'], ['categoryId']],
    foreignKeys: [
      { from: ['templateId'], to: { table: 'game_templates', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['categoryId'], to: { table: 'template_categories', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  template_price_presets: {
    name: 'template_price_presets',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('templateId', 7),
      iN('amountCents', 7),
      t('label', 7),
      iN('sortOrder', 7),
    ],
    indexes: [['templateId']],
    foreignKeys: [
      { from: ['templateId'], to: { table: 'game_templates', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
    legacyOptionalTableUntil: 8,
  },
  template_seed_state: {
    name: 'template_seed_state',
    primaryKey: ['seedKey'],
    columns: [
      tN('seedKey', 7),
      iN('appliedAt', 7),
    ],
  },
  completion_batches: {
    name: 'completion_batches',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('operationId', 13),
      tN('scope', 13, { enumName: 'BATCH_SCOPES' }),
      t('targetId', 13),
      t('gameDate', 13),
      iN('createdAt', 13),
      i('undoneAt', 13),
    ],
    unique: [['operationId']],
    indexes: [['operationId']],
  },
  orders: {
    name: 'orders',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('accountId', 7),
      tN('type', 7, { enumName: 'ORDER_TYPES' }),
      tN('title', 7),
      i('priceCents', 7),
      tN('paymentMode', 7, { enumName: 'PAYMENT_MODES' }),
      t('deadlineDate', 7),
      t('notes', 7),
      tN('gameZoneId', 7),
      iN('dailyRefreshMinutes', 7),
      iN('weeklyRefreshDay', 7),
      iN('weeklyRefreshMinutes', 7),
      iN('createdAt', 7),
      iN('updatedAt', 7),
      i('completedAt', 7),
      t('sourceTemplateId', 7),
      t('sourceTemplateName', 7),
      t('sourceTemplateVersion', 7),
      i('cancelledAt', 7),
      i('archivedAt', 13),
      t('hostingMode', 13, { enumName: 'HOSTING_MODES' }),
      i('targetSessions', 13),
      i('orderColor', 14),
      t('monthlyRefreshDays', 15),
    ],
    indexes: [['accountId'], ['accountId', 'type'], ['type', 'completedAt'], ['archivedAt']],
    foreignKeys: [
      { from: ['accountId'], to: { table: 'game_accounts', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  hosting_periods: {
    name: 'hosting_periods',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('orderId', 7),
      iN('periodIndex', 7),
      tN('startDate', 7),
      tN('endDate', 7),
      iN('priceCents', 7),
      tN('gameZoneId', 7),
      iN('dailyRefreshMinutes', 7),
      iN('weeklyRefreshDay', 7),
      iN('weeklyRefreshMinutes', 7),
      iN('createdAt', 7),
      t('renewalOperationId', 7),
      i('serviceDays', 13),
      t('serviceWeekdays', 13),
      t('monthlyRefreshDays', 15),
      i('serviceCount', 15),
    ],
    unique: [['orderId', 'periodIndex'], ['orderId', 'startDate'], ['renewalOperationId']],
    indexes: [['orderId'], ['renewalOperationId']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  hosting_sessions: {
    name: 'hosting_sessions',
    primaryKey: ['id'],
    columns: [
      tN('id', 13),
      tN('orderId', 13),
      iN('sessionIndex', 13),
      iN('createdAt', 13),
      i('completedAt', 13),
      t('completionBatchId', 13),
      tN('periodId', 15),
    ],
    unique: [['orderId', 'sessionIndex']],
    indexes: [['orderId'], ['periodId']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
    legacyOptionalTableUntil: 12,
  },
  order_price_changes: {
    name: 'order_price_changes',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('operationId', 7),
      tN('orderId', 7),
      t('periodId', 7),
      iN('previousPriceCents', 7),
      iN('newPriceCents', 7),
      t('reason', 7),
      iN('createdAt', 7),
    ],
    unique: [['operationId']],
    indexes: [['orderId'], ['periodId']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['periodId'], to: { table: 'hosting_periods', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
    legacyOptionalTableUntil: 8,
  },
  task_definitions: {
    name: 'task_definitions',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('orderId', 7),
      t('periodId', 7),
      tN('title', 7),
      tN('progressType', 7, { enumName: 'PROGRESS_TYPES' }),
      tN('startValue', 7),
      tN('targetValue', 7),
      tN('currentValue', 7),
      t('unit', 7),
      tN('recurrence', 7, { enumName: 'RECURRENCES' }),
      t('weekdays', 7),
      i('everyNDays', 7),
      iN('sortOrder', 7),
      i('completedAt', 7),
      t('completionBatchId', 7),
      iN('createdAt', 7),
      iN('updatedAt', 7),
      i('monthDay', 7),
      t('monthDays', 7),
      i('retiredAt', 7),
      t('activeFrom', 13),
      t('activeUntil', 15),
      t('numericMode', 15, { enumName: 'NUMERIC_MODES' }),
      i('colorArgb', 15),
    ],
    indexes: [['orderId'], ['periodId'], ['completionBatchId']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['periodId'], to: { table: 'hosting_periods', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['completionBatchId'], to: { table: 'completion_batches', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  task_occurrences: {
    name: 'task_occurrences',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('taskDefinitionId', 7),
      tN('occurrenceKey', 7),
      tN('gameDate', 7),
      t('windowStart', 7),
      t('windowEnd', 7),
      i('completedAt', 7),
      i('recordedAt', 7),
      iN('backfilled', 7, { defaultValue: 0 }),
      t('completionBatchId', 7),
      t('value', 7),
      iN('createdAt', 7),
    ],
    unique: [['taskDefinitionId', 'occurrenceKey']],
    indexes: [['taskDefinitionId'], ['gameDate'], ['completionBatchId']],
    foreignKeys: [
      { from: ['taskDefinitionId'], to: { table: 'task_definitions', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['completionBatchId'], to: { table: 'completion_batches', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  task_progress_events: {
    name: 'task_progress_events',
    primaryKey: ['id'],
    columns: [
      tN('id', 15),
      tN('taskDefinitionId', 15),
      tN('operationId', 15),
      tN('kind', 15, { enumName: 'PROGRESS_EVENT_KINDS' }),
      tN('scopeType', 15, { enumName: 'PROGRESS_SCOPE_TYPES' }),
      t('scopePeriodId', 15),
      t('scopeSessionId', 15),
      tN('gameDate', 15),
      t('totalValue', 15),
      iN('sequence', 15),
      t('correctsEventId', 15),
      iN('recordedAt', 15),
      iN('createdAt', 15),
    ],
    unique: [['operationId'], ['taskDefinitionId', 'sequence']],
    indexes: [['taskDefinitionId'], ['scopePeriodId'], ['scopeSessionId'], ['gameDate'], ['correctsEventId']],
    foreignKeys: [
      { from: ['taskDefinitionId'], to: { table: 'task_definitions', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['correctsEventId'], to: { table: 'task_progress_events', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
    legacyOptionalTableUntil: 14,
  },
  completion_batch_items: {
    name: 'completion_batch_items',
    primaryKey: ['id'],
    columns: [
      tN('id', 13),
      tN('batchId', 13),
      tN('itemType', 13, { enumName: 'BATCH_ITEM_TYPES' }),
      t('occurrenceId', 13),
      t('taskDefinitionId', 13),
      i('previousCompletedAt', 13),
      i('previousRecordedAt', 13),
      i('previousBackfilled', 13),
      t('previousValue', 13),
      t('previousCompletionBatchId', 13),
      i('appliedCompletedAt', 13),
      i('appliedRecordedAt', 13),
      i('appliedBackfilled', 13),
      t('appliedValue', 13),
      t('appliedCompletionBatchId', 13),
    ],
    indexes: [['batchId'], ['occurrenceId'], ['taskDefinitionId']],
    foreignKeys: [
      { from: ['batchId'], to: { table: 'completion_batches', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['occurrenceId'], to: { table: 'task_occurrences', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['taskDefinitionId'], to: { table: 'task_definitions', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  attachments: {
    name: 'attachments',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      t('taskDefinitionId', 7),
      t('occurrenceId', 7),
      tN('relativePath', 7),
      tN('mimeType', 7),
      iN('sizeBytes', 7),
      iN('createdAt', 7),
    ],
    indexes: [['taskDefinitionId'], ['occurrenceId']],
    foreignKeys: [
      { from: ['taskDefinitionId'], to: { table: 'task_definitions', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['occurrenceId'], to: { table: 'task_occurrences', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  receipts: {
    name: 'receipts',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('operationId', 7),
      tN('orderId', 7),
      t('periodId', 7),
      iN('amountCents', 7),
      iN('receivedAt', 7),
      tN('channel', 7, { enumName: 'RECEIPT_CHANNELS' }),
      t('note', 7),
      tN('status', 7, { enumName: 'RECEIPT_STATUSES' }),
      t('replacedByReceiptId', 7),
      iN('createdAt', 7),
    ],
    unique: [['operationId']],
    indexes: [['orderId'], ['periodId'], ['receivedAt']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['periodId'], to: { table: 'hosting_periods', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  receipt_corrections: {
    name: 'receipt_corrections',
    primaryKey: ['id'],
    columns: [
      tN('id', 7),
      tN('operationId', 7),
      tN('receiptId', 7),
      tN('kind', 7, { enumName: 'CORRECTION_KINDS' }),
      t('reason', 7),
      iN('previousAmountCents', 7),
      iN('previousReceivedAt', 7),
      tN('previousChannel', 7, { enumName: 'RECEIPT_CHANNELS' }),
      t('previousNote', 7),
      t('newReceiptId', 7),
      i('newAmountCents', 7),
      i('newReceivedAt', 7),
      t('newChannel', 7, { enumName: 'RECEIPT_CHANNELS' }),
      t('newNote', 7),
      iN('createdAt', 7),
    ],
    unique: [['operationId']],
    indexes: [['receiptId'], ['newReceiptId']],
    foreignKeys: [
      { from: ['receiptId'], to: { table: 'receipts', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      { from: ['newReceiptId'], to: { table: 'receipts', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  order_creation_operations: {
    name: 'order_creation_operations',
    primaryKey: ['operationId'],
    columns: [
      tN('operationId', 7),
      tN('orderType', 7, { enumName: 'ORDER_TYPES' }),
      tN('fingerprint', 7),
      tN('orderId', 7),
      t('receiptId', 7),
      iN('createdAt', 7),
    ],
    unique: [['operationId']],
    indexes: [['orderId']],
    foreignKeys: [
      { from: ['orderId'], to: { table: 'orders', columns: ['id'] }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ],
  },
  reminder_settings: {
    name: 'reminder_settings',
    primaryKey: ['id'],
    columns: [
      iN('id', 7),
      iN('shortDeadlineEnabled', 7),
      iN('shortDeadlineMinutes', 7),
      iN('hostingExpiryEnabled', 7),
      iN('hostingExpiryMinutes', 7),
      iN('unfinishedTasksEnabled', 7),
      iN('unfinishedTasksMinutes', 7),
      iN('updatedAt', 7),
    ],
    singleton: true,
  },
};

/**
 * 最老可恢复代之后新增的表：旧文件缺表按空表补齐（与安卓 `legacyOptionalTables` 一致）。
 */
export const LEGACY_OPTIONAL_TABLES: ReadonlySet<string> = new Set(
  BUSINESS_TABLES.filter((table) => TABLE_SPECS[table].legacyOptionalTableUntil !== undefined),
);

/**
 * 最老可恢复代之后新增的列：旧文件缺列补 NULL（读取兼容白名单，非写出列集）。
 *
 * 含两类：
 * - 便携契约里 `since >= 13` 的列（schema 7–12 的文件不可能有）；
 * - 只存在于历史网页扩展、schema 15 已退役的 `serviceMode`/`serviceCount`。
 */
export const LEGACY_OPTIONAL_COLUMNS: Record<string, ReadonlySet<string>> = {
  game_accounts: new Set([
    'loginDevice',
    'resourceNotes',
    'categoryId',
  ]),
  game_templates: new Set([
    'hostingMode',
    'targetSessions',
    'serviceWeekdays',
    'defaultOrderTitle',
    // legacy-only: 由 category-service-defaults 迁移消费，绝不写回 schema 15。
    'serviceMode',
    'serviceCount',
  ]),
  template_categories: new Set([
    'hostingMode',
    'targetSessions',
    'serviceWeekdays',
    'serviceMode',
    'serviceCount',
  ]),
  template_tasks: new Set(['monthDay', 'monthDays', 'activeFrom', 'activeUntil', 'numericMode']),
  orders: new Set([
    'cancelledAt',
    'archivedAt',
    'hostingMode',
    'targetSessions',
    'orderColor',
    'monthlyRefreshDays',
  ]),
  hosting_periods: new Set([
    'serviceDays',
    'serviceWeekdays',
    'monthlyRefreshDays',
    'serviceCount',
  ]),
  hosting_sessions: new Set(['periodId']),
  task_definitions: new Set([
    'monthDay',
    'monthDays',
    'retiredAt',
    'activeFrom',
    'activeUntil',
    'numericMode',
    'colorArgb',
  ]),
  task_occurrences: new Set([]),
  completion_batch_items: new Set(['itemType']),
  receipts: new Set([]),
  receipt_corrections: new Set([]),
};

/** 网页端早期开发导出（schema ≤ 8）使用过的提醒设置旧列名 → 现列名。 */
export const LEGACY_REMINDER_COLUMN_ALIASES: Record<string, string> = {
  shortTaskEnabled: 'shortDeadlineEnabled',
  shortTaskMinutes: 'shortDeadlineMinutes',
  hostingEnabled: 'hostingExpiryEnabled',
  hostingMinutes: 'hostingExpiryMinutes',
  paymentEnabled: 'unfinishedTasksEnabled',
  paymentMinutes: 'unfinishedTasksMinutes',
};

/** schema 15 写出列（按契约顺序，含 legacy 列之外的完整列集）。 */
export function columnsFor(table: TableName): string[] {
  return TABLE_SPECS[table].columns.filter((column) => !column.legacyOnly).map((column) => column.name);
}

/** 解码时可接受的列集：vnext 列 + legacy-only 列。 */
export function readableColumnsFor(table: TableName): string[] {
  return TABLE_SPECS[table].columns.map((column) => column.name);
}

export function columnSpecOf(table: TableName, column: string): ColumnSpec | null {
  return TABLE_SPECS[table].columns.find((item) => item.name === column) ?? null;
}

export function emptyDataSet(): BackupDataSet {
  const data = {} as BackupDataSet;
  for (const table of BUSINESS_TABLES) {
    (data as Record<string, unknown[]>)[table] = [];
  }
  return data;
}

export function tableSpec(table: string): TableSpec {
  const spec = (TABLE_SPECS as Record<string, TableSpec>)[table];
  if (!spec) throw new AppError('BACKUP_FORMAT', `未知业务表：${table}`);
  return spec;
}

export interface EmittedColumn {
  name: string;
  type: ColumnType;
  nullable: boolean;
}

export interface EmittedForeignKey {
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete: 'RESTRICT' | 'CASCADE';
  onUpdate: 'RESTRICT' | 'CASCADE';
}

export interface EmittedTable {
  name: string;
  included: true;
  singleton: boolean;
  primaryKey: string[];
  unique: string[][];
  indexes: string[][];
  /** 与检查器要求的形状一致：`{columns, references:{table, columns}}`。 */
  foreignKeys: EmittedForeignKey[];
  columns: EmittedColumn[];
}

export interface EmittedMetadata {
  platform: 'web';
  product: { name: string; version: string };
  portableSchemaVersion: number;
  templateFormatVersion: number;
  tableOrder: string[];
  tables: EmittedTable[];
  enums: Record<string, readonly string[]>;
  defaults: Record<string, { declared: boolean; value?: string | number | null }>;
  limitations: string[];
}

/**
 * 从**本文件的运行时声明**生成契约元数据（供 `tools/interop` parity 模式使用）。
 *
 * 这不是复制 contract.json：列、类型、可空性、主键、外键、唯一约束、索引、枚举与
 * 默认值都来自上面被导出/解码真实使用的 `TABLE_SPECS`。若两者不一致，检查器会报差异。
 */
export function emitMetadata(): EmittedMetadata {
  const tables: EmittedTable[] = BUSINESS_TABLES.map((name) => {
    const spec = TABLE_SPECS[name];
    return {
      name,
      included: true as const,
      singleton: spec.singleton === true,
      primaryKey: [...spec.primaryKey],
      unique: (spec.unique ?? []).map((group) => [...group]),
      indexes: (spec.indexes ?? []).map((group) => [...group]),
      foreignKeys: (spec.foreignKeys ?? []).map((fk) => ({
        columns: [...fk.from],
        references: { table: fk.to.table, columns: [...fk.to.columns] },
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      })),
      columns: spec.columns
        .filter((column) => !column.legacyOnly)
        .map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })),
    };
  });
  const defaults: EmittedMetadata['defaults'] = {};
  for (const name of BUSINESS_TABLES) {
    for (const column of TABLE_SPECS[name].columns) {
      if (column.legacyOnly) continue;
      const key = `${name}.${column.name}`;
      if (column.defaultValue !== undefined) {
        defaults[key] = { declared: true, value: column.defaultValue };
      } else if (column.nullable) {
        defaults[key] = { declared: true, value: null };
      } else {
        defaults[key] = { declared: false };
      }
    }
  }
  return {
    platform: 'web',
    product: { name: 'daigan-record-web', version: '0.2.0' },
    portableSchemaVersion: CURRENT_SCHEMA,
    templateFormatVersion: 4,
    tableOrder: [...BUSINESS_TABLES],
    tables,
    enums: ENUM_DECLARATIONS,
    defaults,
    limitations: [
      'Index declarations are emitted but physical index shape is not comparable across engines.',
      'attachmentBlobs / dataset_meta are device-local stores and are not part of the portable catalog.',
    ],
  };
}

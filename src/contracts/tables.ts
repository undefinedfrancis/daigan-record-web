/**
 * 业务表契约。
 *
 * 字段名沿用安卓实体命名（camelCase），备份导出时通过 `catalog.ts` 的显式列目录
 * 映射为 JSON 列数组；两者之间不允许隐式转换。
 *
 * 便携 schema 15（contract v4）与 Dexie 本地版本号是两件事：
 * 便携号描述跨端文件，Dexie 版本描述本机对象仓库升级。
 */

export type OrderType = 'SHORT_TASK' | 'HOSTING';
export type PaymentMode = 'ONE_TIME' | 'INSTALLMENTS';
export type LoginMethod = 'PASSWORD' | 'VERIFICATION_CODE' | 'QR_CODE';
export type ProgressType = 'CHECKBOX' | 'NUMERIC';
export type BatchItemType = 'OCCURRENCE' | 'SHORT_TASK';
export type Recurrence =
  | 'ONE_TIME'
  | 'DAILY'
  | 'WEEKLY'
  | 'SELECTED_WEEKDAYS'
  | 'EVERY_N_DAYS'
  | 'MONTHLY';
export type ReceiptChannel = 'WECHAT' | 'ALIPAY' | 'BANK' | 'CASH' | 'OTHER';
export type ReceiptStatus = 'ACTIVE' | 'REPLACED' | 'VOIDED';
export type CorrectionKind = 'AMEND' | 'VOID';
export type BatchScope = 'HOSTING_ORDER' | 'HOSTING_ALL' | 'SHORT_ORDER';
export type TemplateOrigin = 'BUILT_IN' | 'USER' | 'IMPORTED';

/** 托管模式（schema 13 起）。null 读作 DATE_RANGE。 */
export type HostingMode = 'DATE_RANGE' | 'COUNT_BASED';
/** 数值任务的累计口径（schema 15）。null 读作 PER_OCCURRENCE。 */
export type NumericMode = 'PER_OCCURRENCE' | 'CUMULATIVE';
/** 累计事件类型（UF-038，追加式）。 */
export type ProgressEventKind = 'SUBMIT' | 'CORRECT' | 'RETRACT';
/** 累计事件的不可变 scope 类型。 */
export type ProgressScopeType = 'TASK' | 'PERIOD' | 'SESSION';

/**
 * 旧版网页扩展的建单默认服务模式。
 *
 * 只出现在**解码 legacy 输入**和 Dexie 2 库中；便携 schema 15 不再写这些列，
 * 迁移后由 `hostingMode`/`targetSessions`/`serviceWeekdays` 承载（见
 * `backup/normalize/categoryDefaults.ts`）。
 */
export type ServiceMode = 'dates' | 'weekdays' | 'count';

export const ORDER_TYPES: OrderType[] = ['SHORT_TASK', 'HOSTING'];
export const PAYMENT_MODES: PaymentMode[] = ['ONE_TIME', 'INSTALLMENTS'];
export const LOGIN_METHODS: LoginMethod[] = ['PASSWORD', 'VERIFICATION_CODE', 'QR_CODE'];
export const PROGRESS_TYPES: ProgressType[] = ['CHECKBOX', 'NUMERIC'];
export const BATCH_ITEM_TYPES: BatchItemType[] = ['OCCURRENCE', 'SHORT_TASK'];
export const RECURRENCES: Recurrence[] = [
  'ONE_TIME',
  'DAILY',
  'WEEKLY',
  'SELECTED_WEEKDAYS',
  'EVERY_N_DAYS',
  'MONTHLY',
];
export const RECEIPT_CHANNELS: ReceiptChannel[] = ['WECHAT', 'ALIPAY', 'BANK', 'CASH', 'OTHER'];
export const RECEIPT_STATUSES: ReceiptStatus[] = ['ACTIVE', 'REPLACED', 'VOIDED'];
export const CORRECTION_KINDS: CorrectionKind[] = ['AMEND', 'VOID'];
export const BATCH_SCOPES: BatchScope[] = ['HOSTING_ORDER', 'HOSTING_ALL', 'SHORT_ORDER'];
export const TEMPLATE_ORIGINS: TemplateOrigin[] = ['BUILT_IN', 'USER', 'IMPORTED'];
export const HOSTING_MODES: HostingMode[] = ['DATE_RANGE', 'COUNT_BASED'];
export const NUMERIC_MODES: NumericMode[] = ['PER_OCCURRENCE', 'CUMULATIVE'];
export const PROGRESS_EVENT_KINDS: ProgressEventKind[] = ['SUBMIT', 'CORRECT', 'RETRACT'];
export const PROGRESS_SCOPE_TYPES: ProgressScopeType[] = ['TASK', 'PERIOD', 'SESSION'];
/** 便携 occurrence key 前缀白名单；`C:` 只允许出现在 schema < 15 的输入里。 */
export const OCCURRENCE_KEY_PREFIXES = ['D', 'S', 'E', 'M', 'W', 'C', 'N'] as const;
/** 旧版网页模板/分类的建单默认服务模式取值。 */
export const SERVICE_MODES: ServiceMode[] = ['dates', 'weekdays', 'count'];

/** 默认工作日集合（分类/模板 serviceWeekdays 迁移与新建默认都使用它）。 */
export const DEFAULT_SERVICE_WEEKDAYS = '1,2,3,4,5';

export interface AccountCategoryRow {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface OwnerRow {
  id: string;
  number: number;
  nickname: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archiveBatchId: string | null;
}

export interface GameAccountRow {
  id: string;
  ownerId: string;
  gameName: string;
  server: string;
  uid: string;
  loginAccount: string;
  loginMethod: LoginMethod;
  password: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archiveBatchId: string | null;
  defaultTemplateId: string | null;
  /** 登录设备（手机/平板/电脑/自定义），可空。 */
  loginDevice: string | null;
  /** 自由文本游戏资源记录，每行一项，可空。 */
  resourceNotes: string | null;
  /** 账号分类（UF-037）；null = 未分类。逻辑外键，无 SQL FK。 */
  categoryId: string | null;
}

/** 按游戏名维护的区服选项（UF-005）。 */
export interface GameServerOptionRow {
  id: string;
  gameName: string;
  name: string;
  sortOrder: number;
}

export interface OwnerNumberSequenceRow {
  id: number;
  nextNumber: number;
}

export interface OrderRow {
  id: string;
  accountId: string;
  type: OrderType;
  title: string;
  priceCents: number | null;
  paymentMode: PaymentMode;
  deadlineDate: string | null;
  notes: string | null;
  gameZoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  /** 每月刷新日（逗号分隔 1–31）；null 表示按周刷新。 */
  monthlyRefreshDays: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  sourceTemplateId: string | null;
  sourceTemplateName: string | null;
  sourceTemplateVersion: string | null;
  cancelledAt: number | null;
  /** 订单归档时间（安卓端可写入；网页端不提供归档操作，但参与过滤与守卫）。 */
  archivedAt: number | null;
  /** 托管模式；null 读作 DATE_RANGE。 */
  hostingMode: HostingMode | null;
  /** 打卡式托管的订单级目标镜像；null 表示非计次订单。 */
  targetSessions: number | null;
  /** 整单颜色，不透明 ARGB；null = 未设置。 */
  orderColor: number | null;
}

export interface HostingPeriodRow {
  id: string;
  orderId: string;
  periodIndex: number;
  startDate: string;
  endDate: string;
  priceCents: number;
  gameZoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  createdAt: number;
  renewalOperationId: string | null;
  /** 累计托管天数模式（UF-010）；null 表示按日期期限。 */
  serviceDays: number | null;
  /** 服务星期集合，逗号分隔 ISO 1–7；配合 serviceDays 使用。 */
  serviceWeekdays: string | null;
  /** 每月刷新日（逗号分隔 1–31）；null 表示按周刷新。 */
  monthlyRefreshDays: string | null;
  /**
   * 按次数模式：本**期次**的总次数目标；null 表示按日期/工作日模式。
   * 按次数期次不按日历期限服务：startDate/endDate 仅作内部锚点。
   */
  serviceCount: number | null;
}

/**
 * 一个打卡轮次。身份是 `(orderId, sessionIndex)`，`sessionIndex` **订单全局**，
 * 不按期次重启；occurrence key 为 `N:<index>`。
 */
export interface HostingSessionRow {
  id: string;
  orderId: string;
  sessionIndex: number;
  createdAt: number;
  completedAt: number | null;
  completionBatchId: string | null;
  /** 归属期次；必须属于同一订单且该期次 serviceCount 非空。 */
  periodId: string;
}

export interface TaskDefinitionRow {
  id: string;
  orderId: string;
  periodId: string | null;
  title: string;
  progressType: ProgressType;
  startValue: string;
  targetValue: string;
  currentValue: string;
  unit: string | null;
  recurrence: Recurrence;
  weekdays: string | null;
  everyNDays: number | null;
  sortOrder: number;
  completedAt: number | null;
  completionBatchId: string | null;
  createdAt: number;
  updatedAt: number;
  monthDay: number | null;
  /** 每月多个固定日号（UF-025），逗号分隔 1–31；兼容单日号 monthDay。 */
  monthDays: string | null;
  retiredAt: number | null;
  /** 任务生效起始日（ISO）；null 表示随期次开始。 */
  activeFrom: string | null;
  /** 任务生效截止日（ISO）；null 表示随期次结束。 */
  activeUntil: string | null;
  /** 数值口径；null 读作 PER_OCCURRENCE（普通任务保持不变）。 */
  numericMode: NumericMode | null;
  /** 任务自身颜色，不透明 ARGB；null = 继承订单色。 */
  colorArgb: number | null;
}

export interface TaskOccurrenceRow {
  id: string;
  taskDefinitionId: string;
  occurrenceKey: string;
  gameDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  completedAt: number | null;
  recordedAt: number | null;
  backfilled: number;
  completionBatchId: string | null;
  value: string | null;
  createdAt: number;
}

/**
 * 一次累计进度观测（UF-038）。追加式、不可改写；`scope` 在写入时冻结。
 * `totalValue` 是**缩放单位下的当前累计总值**快照，仅在 RETRACT 时为 null。
 */
export interface TaskProgressEventRow {
  id: string;
  taskDefinitionId: string;
  operationId: string;
  kind: ProgressEventKind;
  scopeType: ProgressScopeType;
  scopePeriodId: string | null;
  scopeSessionId: string | null;
  gameDate: string;
  totalValue: string | null;
  /** 任务内全局递增序号，1 起。 */
  sequence: number;
  correctsEventId: string | null;
  recordedAt: number;
  createdAt: number;
}

export interface CompletionBatchRow {
  id: string;
  operationId: string;
  scope: BatchScope;
  targetId: string | null;
  gameDate: string | null;
  createdAt: number;
  undoneAt: number | null;
}

export interface CompletionBatchItemRow {
  id: string;
  batchId: string;
  itemType: BatchItemType;
  occurrenceId: string | null;
  taskDefinitionId: string | null;
  previousCompletedAt: number | null;
  previousRecordedAt: number | null;
  previousBackfilled: number | null;
  previousValue: string | null;
  previousCompletionBatchId: string | null;
  appliedCompletedAt: number | null;
  appliedRecordedAt: number | null;
  appliedBackfilled: number | null;
  appliedValue: string | null;
  appliedCompletionBatchId: string | null;
}

export interface AttachmentRow {
  id: string;
  taskDefinitionId: string | null;
  occurrenceId: string | null;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
}

export interface ReceiptRow {
  id: string;
  operationId: string;
  orderId: string;
  periodId: string | null;
  amountCents: number;
  receivedAt: number;
  channel: ReceiptChannel;
  note: string | null;
  status: ReceiptStatus;
  replacedByReceiptId: string | null;
  createdAt: number;
}

export interface ReceiptCorrectionRow {
  id: string;
  operationId: string;
  receiptId: string;
  kind: CorrectionKind;
  reason: string | null;
  /** 财务 NOT NULL：null 输入按对象级诊断拒绝，绝不臆造。 */
  previousAmountCents: number;
  previousReceivedAt: number;
  previousChannel: ReceiptChannel;
  previousNote: string | null;
  newReceiptId: string | null;
  newAmountCents: number | null;
  newReceivedAt: number | null;
  newChannel: ReceiptChannel | null;
  newNote: string | null;
  createdAt: number;
}

export interface OrderCreationOperationRow {
  operationId: string;
  orderType: OrderType;
  fingerprint: string;
  orderId: string;
  receiptId: string | null;
  createdAt: number;
}

export interface GameTemplateRow {
  id: string;
  gameName: string;
  templateVersion: string;
  gameVersionNotes: string | null;
  zoneId: string;
  dailyRefreshMinutes: number;
  weeklyRefreshDay: number;
  weeklyRefreshMinutes: number;
  origin: TemplateOrigin;
  builtInKey: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** 模板级托管方式镜像（分类共识）；null = 分类分歧或未设置 → DATE_RANGE。 */
  hostingMode: HostingMode | null;
  targetSessions: number | null;
  serviceWeekdays: string | null;
  /** 建单默认标题（UF-036）；null = 不预填。 */
  defaultOrderTitle: string | null;
  /**
   * @deprecated 本机派生镜像，**不进入便携目录**。
   *
   * schema 15 用 `hostingMode`/`targetSessions`/`serviceWeekdays` 表达同一语义；
   * 这里只为 Stage 4 之前的现有界面保留读取路径，由 Dexie 3 升级从新列推导写入。
   */
  serviceMode?: ServiceMode | null;
  /** @deprecated 见 `serviceMode`。 */
  serviceCount?: number | null;
}

export interface TemplateCategoryRow {
  id: string;
  templateId: string;
  name: string;
  sortOrder: number;
  /** 分类级托管方式；null = 继承模板（只有 vnext 写入才会产生）。 */
  hostingMode: HostingMode | null;
  targetSessions: number | null;
  serviceWeekdays: string | null;
  /** @deprecated 本机派生镜像，不进入便携目录；Stage 4 移除。 */
  serviceMode?: ServiceMode | null;
  /** @deprecated 见 `serviceMode`。 */
  serviceCount?: number | null;
}

export interface TemplateTaskRow {
  id: string;
  templateId: string;
  categoryId: string;
  title: string;
  progressType: ProgressType;
  startValue: string;
  targetValue: string;
  unit: string | null;
  recurrence: Recurrence;
  weekdays: string | null;
  everyNDays: number | null;
  sortOrder: number;
  monthDay: number | null;
  /** 每月多个固定日号（UF-025），逗号分隔 1–31。 */
  monthDays: string | null;
  /** 任务生效起始日（ISO），建单时作为默认值。 */
  activeFrom: string | null;
  /** 任务生效截止日（ISO），建单时作为默认值。 */
  activeUntil: string | null;
  /** 数值口径默认值；null 读作 PER_OCCURRENCE。 */
  numericMode: NumericMode | null;
}

export interface TemplateSeedStateRow {
  seedKey: string;
  appliedAt: number;
}

/** 模板价格预设（UF-015），建单时下拉选用，不回写已有订单。 */
export interface TemplatePricePresetRow {
  id: string;
  templateId: string;
  amountCents: number;
  label: string | null;
  sortOrder: number;
}

/** 改价审计（UF-012），只追加不改写收款流水。 */
export interface OrderPriceChangeRow {
  id: string;
  operationId: string;
  orderId: string;
  periodId: string | null;
  previousPriceCents: number;
  newPriceCents: number;
  reason: string | null;
  createdAt: number;
}

export interface ReminderSettingsRow {
  id: number;
  shortDeadlineEnabled: number;
  shortDeadlineMinutes: number;
  hostingExpiryEnabled: number;
  hostingExpiryMinutes: number;
  unfinishedTasksEnabled: number;
  unfinishedTasksMinutes: number;
  updatedAt: number;
}

/**
 * 可进入 `.dgbk` 的业务表，顺序即导出顺序（contract v4 `tables[].order`）。
 * 与安卓 `BackupTableCatalog.includedTables` 逐项一致。
 */
export const BUSINESS_TABLES = [
  'owners',
  'owner_number_sequence',
  'account_categories',
  'game_accounts',
  'game_server_options',
  'game_templates',
  'template_categories',
  'template_tasks',
  'template_price_presets',
  'template_seed_state',
  'completion_batches',
  'orders',
  'hosting_periods',
  'hosting_sessions',
  'order_price_changes',
  'task_definitions',
  'task_occurrences',
  'task_progress_events',
  'completion_batch_items',
  'attachments',
  'receipts',
  'receipt_corrections',
  'order_creation_operations',
  'reminder_settings',
] as const;

export type TableName = (typeof BUSINESS_TABLES)[number];

export interface TableRows {
  owners: OwnerRow;
  owner_number_sequence: OwnerNumberSequenceRow;
  account_categories: AccountCategoryRow;
  game_accounts: GameAccountRow;
  game_server_options: GameServerOptionRow;
  game_templates: GameTemplateRow;
  template_categories: TemplateCategoryRow;
  template_tasks: TemplateTaskRow;
  template_price_presets: TemplatePricePresetRow;
  template_seed_state: TemplateSeedStateRow;
  completion_batches: CompletionBatchRow;
  orders: OrderRow;
  hosting_periods: HostingPeriodRow;
  hosting_sessions: HostingSessionRow;
  order_price_changes: OrderPriceChangeRow;
  task_definitions: TaskDefinitionRow;
  task_occurrences: TaskOccurrenceRow;
  task_progress_events: TaskProgressEventRow;
  completion_batch_items: CompletionBatchItemRow;
  attachments: AttachmentRow;
  receipts: ReceiptRow;
  receipt_corrections: ReceiptCorrectionRow;
  order_creation_operations: OrderCreationOperationRow;
  reminder_settings: ReminderSettingsRow;
}

export type BackupDataSet = { [K in TableName]: TableRows[K][] };

/** 便携 schema：7–15 可读，15 为当前写出值。 */
export type SchemaVersion = 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/** 与安卓一致的业务上限。 */
export const LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxDataJsonBytes: 64 * 1024 * 1024,
  maxEntries: 5000,
  maxAttachments: 2000,
  maxAttachmentBytes: 32 * 1024 * 1024,
  maxAttachmentTotalBytes: 384 * 1024 * 1024,
  maxCollectionRatioAfterBytes: 8 * 1024 * 1024,
  maxCollectionRatio: 200,
  maxJsonDepth: 32,
  maxPasswordLength: 256,
  maxReceipts: 5000,
  /** 单个期次的打卡次数目标上限（订单跨期次总轮次可超过它）。 */
  maxTargetSessions: 3650,
  maxServiceDays: 3650,
  /** 订单全局轮次号上限（Kotlin Int）。 */
  maxSessionIndex: 2147483647,
  maxOwnerNickname: 30,
  maxAccountCategoryName: 30,
  maxTemplateCategoryName: 30,
  maxOrderTitle: 60,
  maxTemplateTitle: 40,
  maxTaskTitle: 40,
} as const;

/** 当前写出的便携 schema。 */
export const CURRENT_SCHEMA: SchemaVersion = 15;
/** 模板文件写出格式（contract v4）。 */
export const CURRENT_TEMPLATE_FORMAT = 4;
export const MONEY_MAX_CENTS = 9_999_999_999;

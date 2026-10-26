import Dexie, { type EntityTable, type IndexableType, type Table, type Transaction } from 'dexie';
import type { BackupDataSet, GameTemplateRow, TableRows, TemplateCategoryRow } from '../contracts/tables';
import { BUSINESS_TABLES, type SchemaVersion } from '../contracts/tables';
import { columnsFor } from '../backup/catalog';
import type { ColumnPresence } from '../backup/dataCodec';
import { normalizeDecodedDataset } from '../backup/normalize';
import { applyLocalColourMarks } from '../backup/normalize/localColours';
import { reconstructDerivedState } from '../domain/derivedState';

export interface DatasetMetaRow {
  id: string;
  datasetId: string;
  createdAt: number;
}

/** 本机附件字节表，不进入标准业务表目录。 */
export interface AttachmentBlobRowLocal {
  id: string;
  blob: Blob;
}

/**
 * @deprecated v2 及更早的本机颜色标记表。
 *
 * schema 15 用 `orders.orderColor` / `task_definitions.colorArgb` 承载颜色；
 * 这两个对象仓库在 Dexie 3 升级中先在事务内读完，再删除（不丢色）。
 */
export interface TaskColorMarkRowLocal {
  taskId: string;
  color: string;
  source?: 'order' | undefined;
}

/** @deprecated 见 `TaskColorMarkRowLocal`。 */
export interface OrderColorMarkRowLocal {
  orderId: string;
  color: string;
}

/**
 * 本机站内提醒（UF-053）。
 *
 * 只在本机生效：不进入 `.dgbk` 备份，也不同步安卓。恢复备份会清空，避免指向
 * 已被替换掉的订单；订单/任务删除时随级联清理。
 */
export interface LocalReminderRow {
  id: string;
  orderId: string;
  /** null = 整笔订单提醒；否则是该订单下的任务。 */
  taskId: string | null;
  /** 用户选择的提醒时刻（本地时间戳）。 */
  remindAt: number;
  note: string | null;
  createdAt: number;
  /** 用户点过「知道了」的时刻；非 null 不再弹出。 */
  acknowledgedAt: number | null;
}

/**
 * Dexie 本地版本 1：全部业务表 + 本机表。
 *
 * 导出它不是为了让产品代码复用，而是让迁移测试**真的**能从一个已安装的旧库升上来：
 * 只有真实旧 schema + 真实升级回调，才能证明"已安装用户升级"这条路径。
 */
export const LOCAL_SCHEMA_V1: Record<string, string> = {
  owners: 'id, &number, archivedAt',
  game_accounts: 'id, ownerId, archivedAt',
  owner_number_sequence: 'id',
  game_server_options: 'id, gameName, [gameName+sortOrder]',
  orders: 'id, accountId, type, cancelledAt',
  hosting_periods: 'id, orderId, renewalOperationId',
  order_price_changes: 'id, &operationId, orderId, periodId',
  task_definitions: 'id, orderId, periodId',
  task_occurrences: 'id, taskDefinitionId, gameDate, completionBatchId',
  completion_batches: 'id, &operationId',
  completion_batch_items: 'id, batchId',
  attachments: 'id, taskDefinitionId, occurrenceId',
  receipts: 'id, &operationId, orderId, periodId',
  receipt_corrections: 'id, &operationId, receiptId',
  order_creation_operations: 'operationId',
  game_templates: 'id, gameName',
  template_categories: 'id, templateId',
  template_tasks: 'id, templateId, categoryId',
  template_price_presets: 'id, templateId',
  template_seed_state: 'seedKey',
  reminder_settings: 'id',
  attachmentBlobs: 'id',
  task_color_marks: 'taskId',
  dataset_meta: 'id',
};

/** Dexie 本地版本 2：只补订单颜色标记仓库。 */
export const LOCAL_SCHEMA_V2: Record<string, string> = { order_color_marks: 'orderId' };

/** Dexie 本地版本 3：schema-15 业务表与索引。 */
export const LOCAL_SCHEMA_V3: Record<string, string | null> = {
  account_categories: 'id, &name, sortOrder',
  hosting_sessions: 'id, orderId, periodId, &[orderId+sessionIndex]',
  task_progress_events:
    'id, taskDefinitionId, scopePeriodId, scopeSessionId, gameDate, correctsEventId, &operationId, &[taskDefinitionId+sequence]',
  game_accounts: 'id, ownerId, archivedAt, categoryId',
  orders: 'id, accountId, type, cancelledAt, archivedAt, hostingMode',
  // 迁移前先在事务内读完颜色，再删除旧仓库（不丢色、不留孤儿）。
  task_color_marks: null,
  order_color_marks: null,
};

/** Dexie 本地版本 4：本机站内提醒（UF-053，不进入备份契约）。 */
export const LOCAL_SCHEMA_V4: Record<string, string> = {
  local_reminders: 'id, orderId, taskId, remindAt',
};

export class BusinessDatabase extends Dexie {
  owners!: EntityTable<TableRows['owners'], 'id'>;
  game_accounts!: EntityTable<TableRows['game_accounts'], 'id'>;
  account_categories!: EntityTable<TableRows['account_categories'], 'id'>;
  owner_number_sequence!: EntityTable<TableRows['owner_number_sequence'], 'id'>;
  game_server_options!: EntityTable<TableRows['game_server_options'], 'id'>;
  orders!: EntityTable<TableRows['orders'], 'id'>;
  hosting_periods!: EntityTable<TableRows['hosting_periods'], 'id'>;
  hosting_sessions!: EntityTable<TableRows['hosting_sessions'], 'id'>;
  order_price_changes!: EntityTable<TableRows['order_price_changes'], 'id'>;
  task_definitions!: EntityTable<TableRows['task_definitions'], 'id'>;
  task_occurrences!: EntityTable<TableRows['task_occurrences'], 'id'>;
  task_progress_events!: EntityTable<TableRows['task_progress_events'], 'id'>;
  completion_batches!: EntityTable<TableRows['completion_batches'], 'id'>;
  completion_batch_items!: EntityTable<TableRows['completion_batch_items'], 'id'>;
  attachments!: EntityTable<TableRows['attachments'], 'id'>;
  receipts!: EntityTable<TableRows['receipts'], 'id'>;
  receipt_corrections!: EntityTable<TableRows['receipt_corrections'], 'id'>;
  order_creation_operations!: EntityTable<TableRows['order_creation_operations'], 'operationId'>;
  game_templates!: EntityTable<TableRows['game_templates'], 'id'>;
  template_categories!: EntityTable<TableRows['template_categories'], 'id'>;
  template_tasks!: EntityTable<TableRows['template_tasks'], 'id'>;
  template_price_presets!: EntityTable<TableRows['template_price_presets'], 'id'>;
  template_seed_state!: EntityTable<TableRows['template_seed_state'], 'seedKey'>;
  reminder_settings!: EntityTable<TableRows['reminder_settings'], 'id'>;
  attachmentBlobs!: EntityTable<AttachmentBlobRowLocal, 'id'>;
  local_reminders!: EntityTable<LocalReminderRow, 'id'>;
  dataset_meta!: EntityTable<DatasetMetaRow, 'id'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores(LOCAL_SCHEMA_V1);
    this.version(2).stores(LOCAL_SCHEMA_V2);
    this.version(3)
      .stores(LOCAL_SCHEMA_V3)
      .upgrade((tx) => upgradeToSchema15(tx));
    this.version(4).stores(LOCAL_SCHEMA_V4);
  }
}

/**
 * 本机派生镜像：把 schema-15 的托管默认值映射回 Stage 4 之前的界面读取的
 * `serviceMode`/`serviceCount`。**只写本机行**，绝不进入便携目录。
 */
function legacyMirror(
  hostingMode: GameTemplateRow['hostingMode'] | TemplateCategoryRow['hostingMode'],
  targetSessions: number | null,
  serviceWeekdays: string | null,
  level: 'template' | 'category',
): { serviceMode: 'dates' | 'weekdays' | 'count' | undefined; serviceCount: number | null } {
  if (hostingMode === 'COUNT_BASED') {
    return { serviceMode: 'count', serviceCount: targetSessions };
  }
  if (hostingMode === null) {
    // 模板 null = 没有意见（读作按日期）；分类 null = 继承模板（旧界面用 undefined 表示）。
    return { serviceMode: level === 'template' ? 'dates' : undefined, serviceCount: null };
  }
  if (serviceWeekdays !== null && serviceWeekdays !== '') {
    return { serviceMode: 'weekdays', serviceCount: null };
  }
  // 显式按日期必须写成 'dates'，否则旧读取路径的 `??` 会把它当继承。
  return { serviceMode: 'dates', serviceCount: null };
}

function withMirror<T extends { hostingMode: string | null; targetSessions: number | null; serviceWeekdays: string | null }>(
  row: T,
  level: 'template' | 'category',
): T & { serviceMode?: 'dates' | 'weekdays' | 'count'; serviceCount?: number | null } {
  const mirrored = legacyMirror(
    row.hostingMode as GameTemplateRow['hostingMode'],
    row.targetSessions,
    row.serviceWeekdays,
    level,
  );
  const next = { ...row } as T & { serviceMode?: 'dates' | 'weekdays' | 'count'; serviceCount?: number | null };
  if (mirrored.serviceMode === undefined) {
    delete next.serviceMode;
  } else {
    next.serviceMode = mirrored.serviceMode;
  }
  if (mirrored.serviceCount !== null) next.serviceCount = mirrored.serviceCount;
  else delete next.serviceCount;
  return next;
}

/** Dexie 2 的本机库没有列清单信息：由真实仓库形状构造 ColumnPresence。 */
function localPresence(): ColumnPresence {
  const presence: ColumnPresence = {};
  for (const table of BUSINESS_TABLES) presence[table] = columnsFor(table);
  // 旧本机行**确实**带这两列，因此必须按"列存在"处理（区分于历史缺列）。
  presence.game_templates = [...columnsFor('game_templates'), 'serviceMode', 'serviceCount'];
  presence.template_categories = [...columnsFor('template_categories'), 'serviceMode', 'serviceCount'];
  // Dexie 2 没有 hosting_sessions 仓库。
  presence.hosting_sessions = null;
  return presence;
}

/**
 * Dexie `version(3)` 的业务升级。
 *
 * 全部读写都在同一个 versionchange 事务里；任何诊断抛出都会让整个事务回滚，
 * IndexedDB 保持在使用中的旧版本，本函数绝不会删除或重建数据集。
 */
async function upgradeToSchema15(tx: Transaction): Promise<void> {
  const readAll = async <T>(name: string): Promise<T[]> => {
    const table = tx.table(name);
    return (await table.toArray()) as T[];
  };

  // 先读旧颜色表（事务结束前它们仍然存在）。
  const orderMarks = await readAll<OrderColorMarkRowLocal>('order_color_marks');
  const taskMarks = await readAll<TaskColorMarkRowLocal>('task_color_marks');

  const data = {} as BackupDataSet;
  for (const table of BUSINESS_TABLES) {
    if (table === 'account_categories' || table === 'hosting_sessions' || table === 'task_progress_events') {
      (data as Record<string, unknown[]>)[table] = [];
      continue;
    }
    (data as Record<string, unknown[]>)[table] = await readAll<unknown>(table);
  }

  const presence = localPresence();
  normalizeDecodedDataset({
    data,
    columnsByTable: presence,
    schemaVersion: 12 as SchemaVersion,
  });

  // 未知 token 会在这里抛出，从而让整个 versionchange 事务回滚（不静默丢色）。
  applyLocalColourMarks(data.orders, data.task_definitions, orderMarks, taskMarks);

  // 升级后的本机库同样要按权威记录重建派生值（轮次完成度、累计缓存、订单完成）。
  // 这里没有事件表，因此只可能由 occurrence 历史与轮次/应做集推导，不会编造进度。
  reconstructDerivedState(data);

  // 新列给出文档化默认值（可空即 null），旧列值原样保留。
  for (const order of data.orders) {
    order.monthlyRefreshDays = order.monthlyRefreshDays ?? null;
    order.orderColor = order.orderColor ?? null;
    order.archivedAt = order.archivedAt ?? null;
    order.hostingMode = order.hostingMode ?? null;
    order.targetSessions = order.targetSessions ?? null;
  }
  for (const account of data.game_accounts) account.categoryId = account.categoryId ?? null;
  for (const period of data.hosting_periods) {
    period.monthlyRefreshDays = period.monthlyRefreshDays ?? null;
    period.serviceCount = period.serviceCount ?? null;
  }
  for (const task of data.task_definitions) {
    task.activeUntil = task.activeUntil ?? null;
    task.numericMode = task.numericMode ?? null;
    task.colorArgb = task.colorArgb ?? null;
  }
  for (const task of data.template_tasks) {
    task.activeFrom = task.activeFrom ?? null;
    task.activeUntil = task.activeUntil ?? null;
    task.numericMode = task.numericMode ?? null;
  }
  for (const template of data.game_templates) {
    template.serviceWeekdays = template.serviceWeekdays ?? null;
    template.defaultOrderTitle = template.defaultOrderTitle ?? null;
  }
  for (const category of data.template_categories) {
    category.serviceWeekdays = category.serviceWeekdays ?? null;
  }

  // 写回：只 bulkPut 真正可能变化的表，避免给未变表重写时间戳/顺序。
  await tx.table('orders').bulkPut(data.orders);
  await tx.table('game_accounts').bulkPut(data.game_accounts);
  await tx.table('hosting_periods').bulkPut(data.hosting_periods);
  await tx.table('task_definitions').bulkPut(data.task_definitions);
  await tx.table('task_occurrences').bulkPut(data.task_occurrences);
  // 历史批次的两处归一必须写回本机库：HOSTING_ALL 的 'all'/日期 → null/null，
  // 以及补建的打卡记录引用（否则本机数据本身就不符合新契约）。
  if (data.completion_batches.length > 0) {
    await tx.table('completion_batches').bulkPut(data.completion_batches);
  }
  if (data.completion_batch_items.length > 0) {
    await tx.table('completion_batch_items').bulkPut(data.completion_batch_items);
  }
  await tx.table('template_tasks').bulkPut(data.template_tasks);
  await tx.table('game_templates').bulkPut(data.game_templates);
  await tx.table('template_categories').bulkPut(data.template_categories);
  if (data.hosting_sessions.length > 0) await tx.table('hosting_sessions').bulkPut(data.hosting_sessions);

  // 本机派生镜像：让 Stage 4 之前的界面读到与迁移前一致的语义。
  await tx
    .table('game_templates')
    .bulkPut(data.game_templates.map((template) => withMirror(template, 'template')));
  await tx
    .table('template_categories')
    .bulkPut(data.template_categories.map((category) => withMirror(category, 'category')));
}

export function openBusinessDb(name: string): BusinessDatabase {
  const db = new BusinessDatabase(name);
  db.on('versionchange', () => db.close());
  return db;
}

export async function loadDataSet(db: BusinessDatabase): Promise<BackupDataSet> {
  const data = {} as BackupDataSet;
  for (const table of BUSINESS_TABLES) {
    const rows = await (db as unknown as Record<string, Table<unknown, IndexableType>>)[
      table
    ].toArray();
    (data as Record<string, unknown[]>)[table] = rows;
  }
  return data;
}

export async function writeDataSet(
  db: BusinessDatabase,
  data: BackupDataSet,
  attachments: Map<string, Blob>,
): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of BUSINESS_TABLES) {
      const tableAccess = (db as unknown as Record<string, Table<unknown, IndexableType>>)[
        table
      ];
      await tableAccess.clear();
      const rows = data[table] as unknown as unknown[];
      if (rows.length > 0) await tableAccess.bulkAdd(rows as never[]);
    }
    await db.attachmentBlobs.clear();
    const blobRows = [...attachments.entries()].map(([id, blob]) => ({ id, blob }));
    if (blobRows.length > 0) await db.attachmentBlobs.bulkAdd(blobRows);
    // 本机提醒同样不随备份走：恢复后旧提醒引用的订单已不存在，必须清空。
    await db.local_reminders.clear();
    // 颜色已随备份进入 orders.orderColor / task_definitions.colorArgb，
    // 恢复后不再有编号漂移问题；旧本机颜色表已在 Dexie 3 升级中删除。
  });
}

export async function clearBusinessDb(db: BusinessDatabase): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
}

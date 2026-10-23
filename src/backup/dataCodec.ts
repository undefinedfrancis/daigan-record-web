import { AppError } from '../contracts/errors';
import type { BackupDataSet, SchemaVersion, TableName } from '../contracts/tables';
import { BUSINESS_TABLES, CURRENT_SCHEMA, LIMITS } from '../contracts/tables';
import {
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_OPTIONAL_TABLES,
  LEGACY_REMINDER_COLUMN_ALIASES,
  TABLE_SPECS,
  readableColumnsFor,
} from './catalog';

export const DATA_FORMAT = 'daigan-backup-data';
export const DATA_FORMAT_VERSION = 1;

export type JsonCell = string | number | null;

export interface DataTableDocument {
  name: string;
  columns: string[];
  rows: JsonCell[][];
}

export interface DataDocument {
  format: typeof DATA_FORMAT;
  formatVersion: typeof DATA_FORMAT_VERSION;
  schemaVersion?: SchemaVersion;
  tables: DataTableDocument[];
}

export type ColumnPresence = Record<string, string[] | null>;

/**
 * 解码结果。
 *
 * `columnsByTable` 记录**文件里真实出现的列**（表缺失为 null）。规范化迁移必须用它
 * 区分"历史缺列"与"存了 null"：codec 会把缺列补成 null，若不留这份信息，
 * `category-service-defaults` 的分层映射将无法执行。
 */
export interface DecodedDataSet {
  data: BackupDataSet;
  columnsByTable: ColumnPresence;
}

/**
 * 在 `JSON.parse` 之前扫描原始文本：
 * - 深度超过 32 拒绝（避免解析器栈溢出）；
 * - 整数字面量超过 15 位有效数字拒绝（`JSON.parse` 会先四舍五入，导致校验失真）。
 */
export function preflightJson(text: string, maxDepth = LIMITS.maxJsonDepth): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth > maxDepth) {
        throw new AppError('BACKUP_LIMIT', `JSON 嵌套超过 ${maxDepth} 层`);
      }
      continue;
    }
    if (char === '}' || char === ']') {
      depth -= 1;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const prev = index === 0 ? '' : text[index - 1];
      if (/[0-9a-zA-Z_.$]/.test(prev)) continue;
      let cursor = index;
      let literal = '';
      while (cursor < text.length && /[-+0-9.eE]/.test(text[cursor])) {
        literal += text[cursor];
        cursor += 1;
      }
      index = cursor - 1;
      const isIntegerLiteral = /^-?\d+$/.test(literal);
      if (isIntegerLiteral) {
        const digits = literal.replace('-', '').replace(/^0+/, '');
        if (digits.length > 15) {
          throw new AppError('BACKUP_FORMAT', `整数超出安全范围：${literal}`);
        }
      }
    }
  }
  if (depth !== 0) {
    throw new AppError('BACKUP_FORMAT', 'JSON 结构不完整');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readSchemaVersion(value: unknown): SchemaVersion {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 7 && value <= CURRENT_SCHEMA) {
    return value as SchemaVersion;
  }
  throw new AppError('BACKUP_FORMAT', `不支持的数据库版本：${String(value)}`);
}

/**
 * 解码 data.json。schema 版本以清单为准（安卓 data.json 不写该字段，缺失时用清单版本）。
 *
 * 严格性：
 * - 只接受契约内的 24 张表；未知表、重复表、未知列、重复列、列序错乱一律拒绝；
 * - 缺列只允许出现在读取兼容白名单里，并补 null；
 * - legacy-only 列（`serviceMode`/`serviceCount`）只在 schema < 15 时可读。
 */
export function decodeData(text: string, schema: SchemaVersion): DecodedDataSet {
  preflightJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('BACKUP_FORMAT', 'data.json 不是有效 JSON');
  }
  if (!isRecord(parsed)) throw new AppError('BACKUP_FORMAT', 'data.json 顶层必须是对象');
  if (parsed.format !== DATA_FORMAT) {
    throw new AppError('BACKUP_FORMAT', 'data.json 格式标识不正确');
  }
  if (parsed.formatVersion !== DATA_FORMAT_VERSION) {
    throw new AppError('BACKUP_FORMAT', `不支持的数据格式版本：${String(parsed.formatVersion)}`);
  }
  if (parsed.schemaVersion !== undefined) {
    const declared = readSchemaVersion(parsed.schemaVersion);
    if (declared !== schema) {
      throw new AppError('BACKUP_FORMAT', `数据版本 ${declared} 与清单版本 ${schema} 不一致`);
    }
  }
  if (!Array.isArray(parsed.tables)) {
    throw new AppError('BACKUP_FORMAT', 'data.json 缺少表清单');
  }

  const seen = new Set<string>();
  const result = {} as BackupDataSet;
  const columnsByTable: ColumnPresence = {};
  for (const table of BUSINESS_TABLES) {
    (result as Record<string, unknown[]>)[table] = [];
    columnsByTable[table] = null;
  }

  for (const entry of parsed.tables) {
    if (!isRecord(entry)) throw new AppError('BACKUP_FORMAT', '表定义必须是对象');
    const name = entry.name;
    if (typeof name !== 'string') throw new AppError('BACKUP_FORMAT', '表名必须是字符串');
    if (!(BUSINESS_TABLES as readonly string[]).includes(name)) {
      throw new AppError('BACKUP_FORMAT', `未知业务表：${name}`);
    }
    if (seen.has(name)) throw new AppError('BACKUP_FORMAT', `重复表：${name}`);
    seen.add(name);

    const table = name as TableName;
    const spec = TABLE_SPECS[table];
    // 读取兼容白名单只对"低于当前便携 schema"的输入生效：schema 15 必须给出完整列集。
    const optionalColumns =
      schema < CURRENT_SCHEMA ? (LEGACY_OPTIONAL_COLUMNS[name] ?? new Set<string>()) : new Set<string>();
    if (!Array.isArray(entry.columns)) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 缺少列清单`);
    }
    // 列名兼容：网页端早期导出的提醒设置旧列名映射到现列名。
    const columns = entry.columns.map((column) => {
      if (typeof column !== 'string') {
        throw new AppError('BACKUP_FORMAT', `表 ${name} 列名必须是字符串`);
      }
      return LEGACY_REMINDER_COLUMN_ALIASES[column] ?? column;
    });
    const expectedNames = readableColumnsFor(table);
    const vnextNames = spec.columns.filter((column) => !column.legacyOnly).map((column) => column.name);
    // schema 15 的输入不得再携带已退役的 legacy 扩展列（先判退役，报错更精确）。
    const retired = columns.filter((column) => {
      const spec2 = spec.columns.find((item) => item.name === column);
      return spec2?.legacyOnly === true;
    });
    if (retired.length > 0 && schema >= CURRENT_SCHEMA) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 包含 schema ${CURRENT_SCHEMA} 已退役的列：${retired[0]}`);
    }
    const unknown = columns.filter((column) => !expectedNames.includes(column));
    if (unknown.length > 0) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 包含未知列：${unknown[0]}`);
    }
    const missing = vnextNames.filter((column) => !columns.includes(column));
    const unexpectedMissing = missing.filter((column) => !optionalColumns.has(column));
    if (unexpectedMissing.length > 0) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 缺少列：${unexpectedMissing[0]}`);
    }
    const orderPreserved = [...columns].every(
      (column, index) => column === expectedNames.filter((item) => columns.includes(item))[index],
    );
    if (!orderPreserved) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 列顺序不符`);
    }
    const deduped = new Set(columns);
    if (deduped.size !== columns.length) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 列清单重复`);
    }

    if (!Array.isArray(entry.rows)) throw new AppError('BACKUP_FORMAT', `表 ${name} 缺少行数据`);
    if (spec.singleton && entry.rows.length > 1) {
      throw new AppError('BACKUP_FORMAT', `表 ${name} 只允许一行设置`);
    }
    const rows: Record<string, JsonCell>[] = [];
    const everyColumn = [...vnextNames, ...expectedNames.filter((column) => !vnextNames.includes(column))];
    const columnSpecs = everyColumn.map(
      (column) => spec.columns.find((item) => item.name === column) as (typeof spec.columns)[number],
    );
    for (const rawRow of entry.rows) {
      if (!Array.isArray(rawRow)) throw new AppError('BACKUP_FORMAT', `表 ${name} 行必须是数组`);
      if (rawRow.length !== columns.length) {
        throw new AppError('BACKUP_FORMAT', `表 ${name} 行列数不符`);
      }
      const row: Record<string, JsonCell> = {};
      for (let index = 0; index < everyColumn.length; index += 1) {
        const columnSpec = columnSpecs[index];
        const sourceIndex = columns.indexOf(columnSpec.name);
        const cell = sourceIndex < 0 ? null : rawRow[sourceIndex];
        if (cell !== null && cell !== undefined && typeof cell !== 'string' && typeof cell !== 'number') {
          throw new AppError(
            'BACKUP_FORMAT',
            `表 ${name}.${columnSpec.name} 值类型必须是字符串、整数或 null`,
          );
        }
        const value = cell === undefined ? null : cell;
        // 历史缺列（仅限读取兼容白名单）允许为 null，即使该列在当前契约里非空：
        // 由规范化迁移补齐，而不是把旧文件直接拒绝。文件里显式给出的 null 仍然拒绝。
        if (value === null && !columnSpec.nullable && sourceIndex >= 0) {
          throw new AppError('BACKUP_FORMAT', `表 ${name}.${columnSpec.name} 不允许为空`);
        }
        if (columnSpec.type === 'INT' && value !== null) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
            throw new AppError('BACKUP_FORMAT', `表 ${name}.${columnSpec.name} 必须是安全整数`);
          }
        }
        if (columnSpec.type === 'TEXT' && value !== null && typeof value !== 'string') {
          throw new AppError('BACKUP_FORMAT', `表 ${name}.${columnSpec.name} 必须是字符串`);
        }
        row[columnSpec.name] = value as JsonCell;
      }
      if (spec.singleton && row[spec.primaryKey[0]] !== 0) {
        throw new AppError('BACKUP_FORMAT', `表 ${name} 的单例设置编号无效`);
      }
      rows.push(row);
    }
    (result as unknown as Record<string, Record<string, JsonCell>[]>)[name] = rows;
    columnsByTable[name] = [...columns];
  }

  for (const table of BUSINESS_TABLES) {
    if (!seen.has(table) && !LEGACY_OPTIONAL_TABLES.has(table)) {
      throw new AppError('BACKUP_FORMAT', `缺少业务表：${table}`);
    }
  }
  return { data: result as BackupDataSet, columnsByTable };
}

/**
 * 编码 data.json。
 *
 * 新导出**总是**写出完整的 schema-15 列集（不再是"全空则省略"），因此不含任何
 * legacy-only 列，也不会被旧端误读为旧格式。
 */
export function encodeData(data: BackupDataSet): string {
  const document: DataDocument = {
    format: DATA_FORMAT,
    formatVersion: DATA_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA,
    tables: BUSINESS_TABLES.map((table) => {
      const spec = TABLE_SPECS[table];
      const rows = data[table] as unknown as Record<string, JsonCell>[];
      const columns = spec.columns.filter((column) => !column.legacyOnly);
      return {
        name: table,
        columns: columns.map((column) => column.name),
        rows: rows.map((row) => columns.map((column) => normalizeCell(row[column.name]))),
      };
    }),
  };
  return JSON.stringify(document);
}

function normalizeCell(value: unknown): JsonCell {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AppError('BACKUP_FORMAT', `整数超出安全范围：${value}`);
    }
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new AppError('BACKUP_FORMAT', '业务表包含无法导出的值');
}

import { BUSINESS_TABLES, CURRENT_SCHEMA, CURRENT_TEMPLATE_FORMAT } from '../contracts/tables';
import {
  ENUM_DECLARATIONS,
  LEGACY_OPTIONAL_COLUMNS,
  LEGACY_OPTIONAL_TABLES,
  TABLE_SPECS,
  emitMetadata,
} from './catalog';

/**
 * 产品级契约元数据导出（供 `tools/interop/check-contract.mjs` parity 模式直连）。
 *
 * 全部内容来自运行时真实使用的声明：`TABLE_SPECS` 同时驱动导出编码、导入解码与严格校验，
 * 所以元数据不可能与产品行为分叉。**不是**从 contract.json 复制。
 */
export function buildContractMetadata() {
  const emitted = emitMetadata();
  return {
    ...emitted,
    portableSchemaVersion: CURRENT_SCHEMA,
    templateFormatVersion: CURRENT_TEMPLATE_FORMAT,
    tableOrder: [...BUSINESS_TABLES],
    legacyOptionalTables: [...LEGACY_OPTIONAL_TABLES].sort(),
    legacyOptionalColumns: Object.fromEntries(
      Object.entries(LEGACY_OPTIONAL_COLUMNS).map(([table, columns]) => [table, [...columns].sort()]),
    ),
    envelopeFormatVersion: 1,
    dexieVersion: 3,
    /** 检查器只要求"声明"，不比较物理索引形状；这里如实记录这一点。 */
    indexComparison: 'declared-only',
    tables: emitted.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => {
        const spec = TABLE_SPECS[table.name as keyof typeof TABLE_SPECS];
        const declared = spec.columns.find((item) => item.name === column.name);
        return {
          ...column,
          enum: declared?.enumName ?? null,
        };
      }),
    })),
    enums: { ...ENUM_DECLARATIONS },
  };
}

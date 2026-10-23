import type {
  BackupDataSet,
  GameTemplateRow,
  HostingMode,
  TemplateCategoryRow,
} from '../../contracts/tables';
import { DEFAULT_SERVICE_WEEKDAYS, LIMITS } from '../../contracts/tables';
import type { ColumnPresence } from '../dataCodec';
import { bailAll, type MigrationDiagnostic } from './diagnostics';

/** 迁移后写回模板/分类的一组托管默认值；null 表示"未声明"。 */
export interface ServiceDefaults {
  hostingMode: HostingMode | null;
  targetSessions: number | null;
  serviceWeekdays: string | null;
}

const DATE_RANGE_DEFAULTS: ServiceDefaults = {
  hostingMode: 'DATE_RANGE',
  targetSessions: null,
  serviceWeekdays: null,
};

const WEEKDAYS_DEFAULTS: ServiceDefaults = {
  hostingMode: 'DATE_RANGE',
  targetSessions: null,
  serviceWeekdays: DEFAULT_SERVICE_WEEKDAYS,
};

/** 模板级 null = 按日期，但它是"没有意见"，因此不写显式值。 */
const TEMPLATE_NULL_DEFAULTS: ServiceDefaults = {
  hostingMode: null,
  targetSessions: null,
  serviceWeekdays: null,
};

const CLEARED_DEFAULTS: ServiceDefaults = {
  hostingMode: null,
  targetSessions: null,
  serviceWeekdays: null,
};

type Objects = Record<string, string | number | null>;

function readCount(raw: unknown, objects: Objects, diagnostics: MigrationDiagnostic[]): number | null {
  if (raw === null || raw === undefined) {
    diagnostics.push({
      code: 'COUNT_TARGET_MISSING',
      objects,
      reason: 'count 服务模式缺少 serviceCount，绝不静默降级为 dates',
    });
    return null;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > LIMITS.maxTargetSessions) {
    diagnostics.push({
      code: 'COUNT_TARGET_MISSING',
      objects: { ...objects, serviceCount: String(raw) },
      reason: `count 模式的 serviceCount 必须在 1–${LIMITS.maxTargetSessions}`,
    });
    return null;
  }
  return raw;
}

/**
 * 单一 legacy `serviceMode` 取值 → 托管默认值。
 *
 * 分层映射（D-19 / R3）：
 * - **模板行** null = 按日期，写成 `hostingMode: null`（模板级 null 即按日期，且它是
 *   分类共识镜像，不写显式值）；
 * - **分类行有该列且为 null** = **显式 DATE_RANGE**（该 null 由保存路径把 'dates'
 *   归一而来，UI 也显示为 dates），绝不当作"继承"。
 */
function resolveLegacyMode(
  mode: unknown,
  level: 'template' | 'category',
  objects: Objects,
  count: unknown,
  diagnostics: MigrationDiagnostic[],
): ServiceDefaults | null {
  if (mode === null || mode === undefined) {
    return level === 'template' ? TEMPLATE_NULL_DEFAULTS : DATE_RANGE_DEFAULTS;
  }
  if (mode === 'dates') return DATE_RANGE_DEFAULTS;
  if (mode === 'weekdays') return WEEKDAYS_DEFAULTS;
  if (mode === 'count') {
    const target = readCount(count, objects, diagnostics);
    if (target === null) return null;
    return { hostingMode: 'COUNT_BASED', targetSessions: target, serviceWeekdays: null };
  }
  diagnostics.push({
    code: 'UNSUPPORTED_LEGACY_COLUMN_VALUE',
    objects: { ...objects, serviceMode: String(mode) },
    reason: `未知的服务模式 ${String(mode)}`,
  });
  return null;
}

function defaultsKey(defaults: ServiceDefaults): string {
  return `${defaults.hostingMode ?? ''}|${defaults.targetSessions ?? ''}|${defaults.serviceWeekdays ?? ''}`;
}

function applyDefaults(target: GameTemplateRow | TemplateCategoryRow, defaults: ServiceDefaults): void {
  target.hostingMode = defaults.hostingMode;
  target.targetSessions = defaults.targetSessions;
  target.serviceWeekdays = defaults.serviceWeekdays;
}

function defaultsOf(target: GameTemplateRow | TemplateCategoryRow): ServiceDefaults {
  return {
    hostingMode: target.hostingMode ?? null,
    targetSessions: target.targetSessions ?? null,
    serviceWeekdays: target.serviceWeekdays ?? null,
  };
}

/**
 * 执行 `category-service-defaults`（便携 schema < 15 的输入或 Dexie 2→3 升级）。
 *
 * 必须配合 `ColumnPresence`：codec 会把缺列补成 null，只有保留"文件里到底有没有这列"
 * 才能区分「历史缺列（应固化模板值）」与「存了 null（是显式 dates）」。
 */
export function applyCategoryServiceDefaults(
  data: BackupDataSet,
  columnsByTable: ColumnPresence,
): { templatesMigrated: number; categoriesMigrated: number; notes: string[] } {
  const diagnostics: MigrationDiagnostic[] = [];
  const notes: string[] = [];

  // 先按"列是否存在"抓取 legacy 取值，再统一删除，避免读到已删除的键。
  const templateColumns = columnsByTable.game_templates ?? null;
  const categoryColumns = columnsByTable.template_categories ?? null;
  const templateHasColumn = templateColumns !== null && templateColumns.includes('serviceMode');
  const categoryHasColumn = categoryColumns !== null && categoryColumns.includes('serviceMode');

  const legacyTemplate = new Map<string, { mode: unknown; count: unknown }>();
  if (templateHasColumn) {
    for (const template of data.game_templates) {
      const record = template as unknown as Record<string, unknown>;
      legacyTemplate.set(template.id, {
        mode: record.serviceMode ?? null,
        count: record.serviceCount ?? null,
      });
    }
  }
  const legacyCategory = new Map<string, { mode: unknown; count: unknown }>();
  if (categoryHasColumn) {
    for (const category of data.template_categories) {
      const record = category as unknown as Record<string, unknown>;
      // 保留 undefined：本机库里"根本没有这个键"等于"没有意见"（旧读取路径如此），
      // 而文件里该列存在时每个单元格都会写 null，不会出现 undefined。
      legacyCategory.set(category.id, {
        mode: record.serviceMode,
        count: record.serviceCount ?? null,
      });
    }
  }

  const templatesById = new Map(data.game_templates.map((row) => [row.id, row]));

  for (const template of data.game_templates) {
    const legacy = legacyTemplate.get(template.id);
    if (!legacy) continue;
    const resolved = resolveLegacyMode(legacy.mode, 'template', { templateId: template.id }, legacy.count, diagnostics);
    if (resolved) applyDefaults(template, resolved);
  }

  let categoriesMigrated = 0;
  for (const category of data.template_categories) {
    const objects = { categoryId: category.id, templateId: category.templateId };
    const legacy = legacyCategory.get(category.id);
    if (categoryHasColumn && legacy !== undefined && legacy.mode !== undefined) {
      const resolved = resolveLegacyMode(legacy.mode, 'category', objects, legacy.count, diagnostics);
      if (resolved) applyDefaults(category, resolved);
      categoriesMigrated += 1;
      continue;
    }
    // 该分类表早于扩展：历史读取口径是用模板值，因此把模板值**固化**到分类行。
    const template = templatesById.get(category.templateId);
    if (!template) continue;
    applyDefaults(category, defaultsOf(template));
    notes.push(`category ${category.id} 按模板 ${template.id} 的默认值固化（历史缺列）`);
    categoriesMigrated += 1;
  }

  if (diagnostics.length > 0) bailAll(diagnostics, '模板/分类的建单默认值无法安全迁移');

  // 模板行 = 分类共识镜像：一致才写，分歧写 null（永不被当作覆盖）。
  let templatesMigrated = 0;
  for (const template of data.game_templates) {
    const categories = data.template_categories.filter((row) => row.templateId === template.id);
    if (categories.length === 0) continue;
    const before = defaultsKey(defaultsOf(template));
    const keys = new Set(categories.map((row) => defaultsKey(defaultsOf(row))));
    applyDefaults(template, keys.size === 1 ? defaultsOf(categories[0]) : CLEARED_DEFAULTS);
    if (defaultsKey(defaultsOf(template)) !== before) templatesMigrated += 1;
  }

  // schema 15 的便携契约没有这两列：迁移后从行对象上彻底移除。
  for (const template of data.game_templates) {
    const record = template as unknown as Record<string, unknown>;
    delete record.serviceMode;
    delete record.serviceCount;
  }
  for (const category of data.template_categories) {
    const record = category as unknown as Record<string, unknown>;
    delete record.serviceMode;
    delete record.serviceCount;
  }

  return { templatesMigrated, categoriesMigrated, notes };
}

/**
 * 写入路径的同一套分层映射（保存模板时使用）。
 *
 * 与迁移共享同一个函数，避免"迁移按一套语义、保存按另一套语义"的二次歧义：
 * - `level === 'template'` 且 mode 为 null/缺省 → 不写显式值（模板 null 即按日期）；
 * - `level === 'category'` 且 mode 为 null → **显式 DATE_RANGE**。
 */
export function serviceDefaultsFromLegacyMode(
  mode: 'dates' | 'weekdays' | 'count' | null | undefined,
  count: number | null | undefined,
  level: 'template' | 'category',
): ServiceDefaults {
  if (mode === 'count') {
    const target = count ?? null;
    return { hostingMode: 'COUNT_BASED', targetSessions: target, serviceWeekdays: null };
  }
  if (mode === 'weekdays') return { ...WEEKDAYS_DEFAULTS };
  if (mode === 'dates') return { ...DATE_RANGE_DEFAULTS };
  return level === 'template' ? { ...TEMPLATE_NULL_DEFAULTS } : { ...DATE_RANGE_DEFAULTS };
}

/** 反方向：把 schema-15 默认值映射回 Stage 4 之前的旧界面字段。 */
export function legacyModeFromServiceDefaults(
  defaults: ServiceDefaults,
  level: 'template' | 'category',
): { serviceMode: 'dates' | 'weekdays' | 'count' | undefined; serviceCount: number | null } {
  if (defaults.hostingMode === 'COUNT_BASED') {
    return { serviceMode: 'count', serviceCount: defaults.targetSessions };
  }
  if (defaults.hostingMode === null) {
    return { serviceMode: level === 'template' ? 'dates' : undefined, serviceCount: null };
  }
  if (defaults.serviceWeekdays !== null && defaults.serviceWeekdays !== '') {
    return { serviceMode: 'weekdays', serviceCount: null };
  }
  return { serviceMode: 'dates', serviceCount: null };
}

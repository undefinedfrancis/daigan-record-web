import type { HostingMode } from '../contracts/tables';
import { DEFAULT_SERVICE_WEEKDAYS } from '../contracts/tables';
import { parseWeekdays } from './occurrences';

export type FormServiceMode = 'dates' | 'weekdays' | 'count';

/** 分类级建单默认值（模板分类行/草稿的结构子集）。 */
export interface TemplateServiceCategoryDefaults {
  hostingMode?: HostingMode | null;
  targetSessions?: number | null;
  serviceWeekdays?: string | null;
}

/** The subset of a template detail the new-order form needs to preselect its service mode. */
export interface TemplateServiceDefaultsInput extends TemplateServiceCategoryDefaults {
  /** Legacy mirror kept for the pre-schema-15 UI field; null when categories disagree. */
  serviceMode?: FormServiceMode | null;
  /** Legacy count mirror (pre-schema-15). */
  serviceCount?: number | null;
  /** 分类级默认值：只有模板自己没有意见时才参与“共识”判定。 */
  categories?: readonly TemplateServiceCategoryDefaults[];
}

export interface TemplateServiceFormDefaults {
  /**
   * 表单服务模式初值。
   *
   * `null` = 分层默认值没有意见（分类彼此不一致）：表单保留用户当前选择，
   * 由界面提示用户手动确认，绝不替用户挑一个分类。
   */
  serviceMode: FormServiceMode | null;
  serviceCount: number | null;
  /**
   * 精确服务星期集合（ISO 1–7，升序去重）；`[]` = 不限制服务日。
   *
   * 只有 `serviceMode === 'weekdays'` 时有意义；`count` / 无限制的 `dates` 一律为空，
   * 因此切换模板不会把上一个模板的星期限制留在表单里。
   */
  serviceWeekdays: number[];
  /** true = 分类彼此不一致且模板级没有声明。 */
  conflict: boolean;
  /** true = 值来自模板行本身，而不是分类共识或旧镜像兜底。 */
  explicit: boolean;
}

/**
 * 服务星期文本 → 升序去重的 ISO 集合。
 *
 * 复用 `domain/occurrences.parseWeekdays` 的解析与范围校验（1–7），再补上
 * “去重 + 升序”，让同一组星期总是得到同一个持久化字符串（`"1,3,5"`）。
 */
export function normalizeServiceWeekdays(value: string | null | undefined): number[] {
  return [...new Set(parseWeekdays(value ?? null))].sort((left, right) => left - right);
}

function countDefaults(
  targetSessions: number | null,
  explicit: boolean,
): TemplateServiceFormDefaults {
  return {
    serviceMode: 'count',
    serviceCount: targetSessions,
    serviceWeekdays: [],
    conflict: false,
    explicit,
  };
}

function dateDefaults(serviceWeekdays: number[], explicit: boolean): TemplateServiceFormDefaults {
  return {
    serviceMode: serviceWeekdays.length > 0 ? 'weekdays' : 'dates',
    serviceCount: null,
    serviceWeekdays,
    conflict: false,
    explicit,
  };
}

/**
 * 新建订单表单应从模板继承的“服务模式 + 服务次数 + 精确服务星期”。
 *
 * 优先级与安卓 `TemplateServiceDefaultsRule.resolve` / `applyTemplateDefaults` 同一口径：
 *
 * 1. **显式的模板级托管方式**优先。`COUNT_BASED` 带目标次数、清空星期；
 *    `DATE_RANGE` 的星期限制只读**模板级 `serviceWeekdays`**，没有就表示不限制。
 *    这一步绝不参考旧镜像 —— 旧镜像只是分类共识的派生值，用它覆盖显式值正是
 *    “显式按日期 + 1,3,5 的模板在网页端落回按日期并丢掉星期”的成因。
 * 2. 模板级没有意见时，取**各分类声明值的共识**：一致才采用，不一致则视为没有意见
 *    （`serviceMode: null` + `conflict`），不静默挑第一个分类。
 * 3. 分层默认值都为空时，才退回旧镜像 `serviceMode`（旧语义：`weekdays` = 周一至周五）。
 * 4. 仍无意见 → 按日期期限。
 */
export function resolveTemplateServiceDefaults(
  input: TemplateServiceDefaultsInput,
): TemplateServiceFormDefaults {
  if (input.hostingMode === 'COUNT_BASED') {
    return countDefaults(input.targetSessions ?? input.serviceCount ?? null, true);
  }
  if (input.hostingMode === 'DATE_RANGE') {
    return dateDefaults(normalizeServiceWeekdays(input.serviceWeekdays), true);
  }

  const declared = (input.categories ?? []).flatMap((category) => {
    if (category.hostingMode === 'COUNT_BASED') {
      return [countDefaults(category.targetSessions ?? null, false)];
    }
    if (category.hostingMode === 'DATE_RANGE') {
      return [dateDefaults(normalizeServiceWeekdays(category.serviceWeekdays), false)];
    }
    return [];
  });
  if (declared.length > 0) {
    const first = declared[0];
    const agree = declared.every(
      (item) =>
        item.serviceMode === first.serviceMode &&
        item.serviceCount === first.serviceCount &&
        item.serviceWeekdays.join(',') === first.serviceWeekdays.join(','),
    );
    return agree
      ? first
      : {
          serviceMode: null,
          serviceCount: null,
          serviceWeekdays: [],
          conflict: true,
          explicit: false,
        };
  }

  const legacyMode = input.serviceMode ?? null;
  if (legacyMode === 'count') {
    return countDefaults(input.serviceCount ?? null, false);
  }
  if (legacyMode === 'weekdays') {
    // 旧界面只有“周一至周五”这一种工作日口径，没有自定义星期。
    return dateDefaults(normalizeServiceWeekdays(DEFAULT_SERVICE_WEEKDAYS), false);
  }
  return dateDefaults([], false);
}

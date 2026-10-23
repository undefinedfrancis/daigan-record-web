/**
 * UF-036 模板默认订单标题的带入规则。
 *
 * 标题来源是**显式状态**（`none | auto | manual`），不靠"当前字符串是否等于某个模板标题"
 * 猜测用户意图：
 * - `manual`：用户手填/手改过，切换模板绝不覆盖；
 * - `none`：空标题（含用户主动清空），下一次套用模板可以带入；
 * - `auto`：上次由模板带入，再切模板时跟随新模板。
 */
export type TitleProvenance = 'none' | 'auto' | 'manual';

export interface TitleState {
  value: string;
  provenance: TitleProvenance;
}

/** 用户编辑标题：非空即手填（manual），清空回到 none。 */
export function editedTitle(value: string): TitleState {
  return { value, provenance: value.trim() ? 'manual' : 'none' };
}

/**
 * 套用模板标题。`next` 为模板的默认标题（没有默认标题时由调用方给出兜底文案）。
 *
 * 返回新状态；`manual` 原样返回。空 `next` 表示清空并按 `none` 处理。
 */
export function applyTemplateTitle(state: TitleState, next: string | null): TitleState {
  if (state.provenance === 'manual') return state;
  const value = (next ?? '').trim();
  if (!value) return { value: '', provenance: 'none' };
  return { value, provenance: 'auto' };
}

/** 标题下限（与订单标题规则一致：1–60）。 */
export const TITLE_MIN = 1;
export const TITLE_MAX = 60;

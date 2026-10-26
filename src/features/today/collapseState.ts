/**
 * 今日事项「分组折叠」状态（localStorage 记忆）。
 *
 * 两类分组共用一份记录，但键空间分开：
 * - 托管任务组：一个订单一个组，键就是订单 id（沿用旧数据，无需迁移）；
 * - 本周期任务组：同一订单在窗口内可能有多个归属日，键为 `periodic:<订单>:<归属日>`，
 *   这样收起某一天的组不会把托管组或同订单的其他归属日一起收起。
 */
export const COLLAPSED_KEY = 'daigan.today.collapsed';

/** 只依赖读写两个方法的存储抽象，便于测试与降级。 */
export type CollapseStore = Pick<Storage, 'getItem' | 'setItem'>;

/** 托管任务组的折叠键。 */
export function orderGroupKey(orderId: string): string {
  return orderId;
}

/** 本周期任务组的折叠键（订单 + 归属日）。 */
export function periodicGroupKey(orderId: string, gameDate: string): string {
  return `periodic:${orderId}:${gameDate}`;
}

/** 当前环境的 localStorage；隐私模式或非浏览器环境下返回 null。 */
function defaultStore(): CollapseStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读取已收起的分组键；损坏、非数组或存储不可用时退回空集合。 */
export function loadCollapsed(store: CollapseStore | null = defaultStore()): Set<string> {
  try {
    const raw = store?.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

/** 写入已收起的分组键；写入失败时只影响本次记忆。 */
export function saveCollapsed(ids: Set<string>, store: CollapseStore | null = defaultStore()): void {
  try {
    store?.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // 忽略：下次进入页面按默认展开显示。
  }
}

/** 切换一个分组的收起状态，返回新集合（不修改入参）。 */
export function nextCollapsed(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

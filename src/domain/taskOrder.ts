/**
 * 任务条目排序（`task_definitions.sortOrder`）。
 *
 * 背景（2026-10-27 用户反馈）：同一个订单里任务内容一样，但三张卡片的条目顺序各不相同。
 * 根因不是缺少字段 —— `sortOrder` 早就在备份契约里、安卓也按它排 —— 而是网页端
 * 今日事项的读取路径直接用了 Dexie 的**主键顺序**（uuid 字符串），从来没有按
 * `sortOrder` 排过；再加上用户希望能自己调顺序，于是把"排序"收成一处纯函数：
 *
 * - 读取：`sortTasksByOrder` 给出稳定顺序（`sortOrder` → `createdAt` → `id` 兜底）；
 * - 写入：`applyVisibleOrder` 只重排**本次可见**的条目，隐藏条目的槽位原地保留。
 *
 * 为什么不是简单地"给可见条目重新编号 0..n"：今日事项只显示今天该做的任务
 * （非触发日、未生效、期次外、已移除的任务都不在列表里）。如果按可见序号重排，
 * 看不见的任务会被挤到后面甚至撞号，跨端备份里就会出现两个任务同一个 sortOrder。
 */

export interface OrderableTask {
  id: string;
  sortOrder: number;
  createdAt: number;
}

/** 稳定比较：`sortOrder` 优先，其次创建时间，最后 id（历史数据有重复序号也不漂移）。 */
export function compareTaskOrder(left: OrderableTask, right: OrderableTask): number {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 按展示顺序返回新数组（不改入参）。 */
export function sortTasksByOrder<T extends OrderableTask>(rows: readonly T[]): T[] {
  return [...rows].sort(compareTaskOrder);
}

/** 把 `from` 位置的键移到 `to` 位置（拖拽落点预览/finalize 共用）。 */
export function moveKey(keys: readonly string[], from: number, to: number): string[] {
  const next = [...keys];
  if (next.length === 0) return next;
  const start = Math.min(Math.max(from, 0), next.length - 1);
  const target = Math.min(Math.max(to, 0), next.length - 1);
  if (start === target) return next;
  const [moved] = next.splice(start, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * 按 `orderedIds` 重排**可见**条目：可见条目按新顺序依次填回它们原本占的槽位，
 * 未出现在 `orderedIds` 里的任务（今日看不见的）保持原位置。
 *
 * 未知 id 与重复 id 一律忽略（页面可能带着过期快照提交）；空清单等于不改动。
 */
export function applyVisibleOrder<T extends OrderableTask>(
  rows: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const sorted = sortTasksByOrder(rows);
  if (orderedIds.length === 0) return sorted;

  const existing = new Set(sorted.map((row) => row.id));
  const visible: string[] = [];
  const visibleSet = new Set<string>();
  for (const id of orderedIds) {
    if (!existing.has(id) || visibleSet.has(id)) continue;
    visibleSet.add(id);
    visible.push(id);
  }
  if (visible.length === 0) return sorted;

  const byId = new Map(sorted.map((row) => [row.id, row]));
  // 可见条目在完整清单里占的槽位（升序）。
  const slots: number[] = [];
  sorted.forEach((row, index) => {
    if (visibleSet.has(row.id)) slots.push(index);
  });

  const next = [...sorted];
  for (let index = 0; index < visible.length; index += 1) {
    next[slots[index]] = byId.get(visible[index]) as T;
  }
  return next;
}

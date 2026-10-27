import type { TodayTaskItem } from '../../application/contracts';
import { ownerGroupKey } from './collapseState';

/**
 * 「本周期任务」的分组口径：**按老板**。
 *
 * 一个老板的多笔订单（不同版本）、以及同一订单的多个周期归属日，都收在同一个折叠里；
 * 组内再按「订单 + 归属日」切小标题，避免看混。这样就不会出现"同一老板的一个版本
 * 被拆成 4 个折叠"（按订单/归属日分组时的老问题）。
 */
export interface PeriodicOwnerGroup {
  /** 折叠键，直接用于 collapsed 集合。 */
  key: string;
  ownerId: string;
  ownerName: string;
  /** 组内出现过的账号标签（去重、保持出现顺序）。 */
  accountNames: string[];
  items: TodayTaskItem[];
}

export interface PeriodicBlock {
  key: string;
  orderId: string;
  orderTitle: string;
  /** 本周期归属日（触发日），补录落点。 */
  gameDate: string;
  items: TodayTaskItem[];
}

/** 按老板合并本周期任务；顺序保持输入顺序（同老板的多笔订单不重排）。 */
export function groupPeriodicByOwner(items: TodayTaskItem[]): PeriodicOwnerGroup[] {
  const map = new Map<string, PeriodicOwnerGroup>();
  for (const item of items) {
    // 老板缺失（历史脏数据）时退回昵称，避免所有条目挤进同一个空 key。
    const key = ownerGroupKey(item.ownerId || item.ownerName);
    const group = map.get(key) ?? {
      key,
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      accountNames: [],
      items: [],
    };
    if (!group.accountNames.includes(item.accountName)) group.accountNames.push(item.accountName);
    group.items.push(item);
    map.set(key, group);
  }
  return [...map.values()];
}

/** 组内按「订单 + 归属日」连续切片：同一段的条目共用一个标题。 */
export function periodicBlocks(items: TodayTaskItem[]): PeriodicBlock[] {
  const blocks: PeriodicBlock[] = [];
  for (const item of items) {
    const key = `${item.orderId}:${item.gameDate}`;
    const last = blocks[blocks.length - 1];
    if (last && last.key === key) last.items.push(item);
    else
      blocks.push({
        key,
        orderId: item.orderId,
        orderTitle: item.orderTitle,
        gameDate: item.gameDate,
        items: [item],
      });
  }
  return blocks;
}

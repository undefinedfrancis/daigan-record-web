import { describe, expect, it } from 'vitest';
import type { TodayTaskItem } from '../../src/application/contracts';
import type { ScopeCalendar } from '../../src/domain/scopeCalendar';
import {
  groupPeriodicByOwner,
  periodicBlocks,
} from '../../src/features/today/periodicGroups';
import { ownerGroupKey } from '../../src/features/today/collapseState';

/**
 * 2026-10-27 用户反馈回归：「本周期任务」要按**老板**折叠。
 * 老实现按「订单 + 归属日」分组，导致同一老板同一版本的不同触发日被拆成 4 个折叠。
 */

function task(over: Partial<TodayTaskItem>): TodayTaskItem {
  return {
    taskId: 'task-1',
    orderId: 'order-1',
    orderTitle: '原神 托管',
    ownerId: 'owner-1',
    ownerName: '#1 老板甲',
    accountName: '原神 · 官服',
    colorTag: null,
    periodId: null,
    occurrenceId: null,
    occurrenceKey: null,
    title: '签到',
    progressType: 'CHECKBOX',
    currentValue: '0',
    targetValue: '1',
    unit: null,
    completed: false,
    backfilled: false,
    windowStart: null,
    windowEnd: null,
    attachmentCount: 0,
    batchId: null,
    serviceCount: null,
    serviceRounds: 0,
    numericMode: null,
    cumulative: false,
    reachedTarget: false,
    sessionId: null,
    sessionIndex: null,
    awaitingSession: false,
    roundDate: null,
    gameDate: '2026-03-15',
    calendar: {} as ScopeCalendar,
    ...over,
  };
}

describe('本周期任务按老板分组', () => {
  it('同一订单的 4 个归属日只产生 1 个折叠（老实现会拆成 4 个）', () => {
    const groups = groupPeriodicByOwner([
      task({ taskId: 't1', title: '丹兑换', gameDate: '2026-03-01' }),
      task({ taskId: 't2', title: '剧诗', gameDate: '2026-03-05' }),
      task({ taskId: 't3', title: '深渊', gameDate: '2026-03-10' }),
      task({ taskId: 't4', title: '角色试用', gameDate: '2026-03-15' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe(ownerGroupKey('owner-1'));
    expect(groups[0]?.items).toHaveLength(4);
  });

  it('同一老板的两个版本（不同订单）也合并在同一个折叠里', () => {
    const groups = groupPeriodicByOwner([
      task({ taskId: 't1', orderId: 'order-1', orderTitle: '原神 托管', title: '大活动' }),
      task({ taskId: 't2', orderId: 'order-2', orderTitle: '原神7.1版本托管', title: '大活动' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.orderTitle)).toEqual([
      '原神 托管',
      '原神7.1版本托管',
    ]);
  });

  it('不同老板各自一个折叠，顺序按首次出现', () => {
    const groups = groupPeriodicByOwner([
      task({ taskId: 't1', ownerId: 'owner-2', ownerName: '#2 老板乙' }),
      task({ taskId: 't2', ownerId: 'owner-1', ownerName: '#1 老板甲' }),
      task({ taskId: 't3', ownerId: 'owner-2', ownerName: '#2 老板乙' }),
    ]);

    expect(groups.map((group) => group.ownerId)).toEqual(['owner-2', 'owner-1']);
    expect(groups[0]?.items).toHaveLength(2);
  });

  it('账号标签去重且保持出现顺序', () => {
    const groups = groupPeriodicByOwner([
      task({ taskId: 't1', accountName: '原神 · 官服' }),
      task({ taskId: 't2', accountName: '原神 · 官服' }),
      task({ taskId: 't3', accountName: '原神 · 渠道服' }),
    ]);

    expect(groups[0]?.accountNames).toEqual(['原神 · 官服', '原神 · 渠道服']);
  });

  it('缺少 ownerId 的历史数据退回按昵称分组，不同昵称不会被合并', () => {
    const groups = groupPeriodicByOwner([
      task({ taskId: 't1', ownerId: '', ownerName: '未知老板' }),
      task({ taskId: 't2', ownerId: '', ownerName: '未知老板' }),
      task({ taskId: 't3', ownerId: '', ownerName: '#9 另一老板' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.items).toHaveLength(2);
  });
});

describe('老板折叠内的小标题（版本 + 归属日）', () => {
  it('连续的同一订单同一归属日合成一段，切换订单或归属日就另起一段', () => {
    const blocks = periodicBlocks([
      task({ taskId: 't1', orderId: 'order-1', title: '大活动', gameDate: '2026-03-15' }),
      task({ taskId: 't2', orderId: 'order-1', title: '小活动1', gameDate: '2026-03-15' }),
      task({ taskId: 't3', orderId: 'order-1', title: '深渊', gameDate: '2026-03-10' }),
      task({ taskId: 't4', orderId: 'order-2', orderTitle: '原神7.1版本托管', title: '大活动' }),
    ]);

    expect(blocks.map((block) => `${block.orderTitle}@${block.gameDate}`)).toEqual([
      '原神 托管@2026-03-15',
      '原神 托管@2026-03-10',
      '原神7.1版本托管@2026-03-15',
    ]);
    expect(blocks[0]?.items.map((item) => item.title)).toEqual(['大活动', '小活动1']);
  });
});

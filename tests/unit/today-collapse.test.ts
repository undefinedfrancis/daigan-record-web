import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSED_KEY,
  loadCollapsed,
  nextCollapsed,
  orderGroupKey,
  ownerGroupKey,
  saveCollapsed,
  type CollapseStore,
} from '../../src/features/today/collapseState';

/**
 * 今日事项分组折叠状态：
 * - 「托管任务」按订单成组；
 * - 「本周期任务」**按老板**成组（2026-10-27 用户反馈：按刷新周期拆会把同一老板的
 *   一个版本拆成 4 个折叠，实际要的是老板一个折叠、内部再分版本/归属日）。
 */

function memoryStore(): CollapseStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('今日事项分组折叠键', () => {
  it('托管组直接用订单 id', () => {
    expect(orderGroupKey('order-1')).toBe('order-1');
  });

  it('本周期任务组只按老板：同一老板的多个版本/归属日共用一个键', () => {
    expect(ownerGroupKey('owner-1')).toBe('owner:owner-1');
    // 老板维度不带订单或日期，所以版本、归属日都不会再拆出新的折叠键。
    expect(ownerGroupKey('owner-1')).toBe(ownerGroupKey('owner-1'));
    expect(ownerGroupKey('owner-1')).not.toBe(ownerGroupKey('owner-2'));
  });

  it('老板组的键不会与同 id 的托管组撞车', () => {
    expect(ownerGroupKey('owner-1')).not.toBe(orderGroupKey('owner-1'));
  });
});

describe('折叠状态切换', () => {
  it('同一个键点一次收起、再点一次展开，且不改动传入的集合', () => {
    const initial = new Set<string>();
    const collapsed = nextCollapsed(initial, ownerGroupKey('owner-1'));
    expect(collapsed.has(ownerGroupKey('owner-1'))).toBe(true);
    expect(initial.size).toBe(0);

    const expanded = nextCollapsed(collapsed, ownerGroupKey('owner-1'));
    expect(expanded.has(ownerGroupKey('owner-1'))).toBe(false);
    // 原集合保持不变，便于 React 依赖比较。
    expect(collapsed.has(ownerGroupKey('owner-1'))).toBe(true);
  });

  it('只影响被点击的那一组', () => {
    let state = nextCollapsed(new Set<string>(), orderGroupKey('order-1'));
    state = nextCollapsed(state, ownerGroupKey('owner-1'));
    state = nextCollapsed(state, ownerGroupKey('owner-1'));

    expect(state.has(orderGroupKey('order-1'))).toBe(true);
    expect(state.has(ownerGroupKey('owner-1'))).toBe(false);
  });
});

describe('折叠状态记忆', () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  it('保存后能原样读回', () => {
    const ids = new Set([orderGroupKey('order-1'), ownerGroupKey('owner-2')]);
    saveCollapsed(ids, store);
    expect(JSON.parse(store.data.get(COLLAPSED_KEY) ?? '[]')).toHaveLength(2);
    expect([...loadCollapsed(store)].sort()).toEqual([...ids].sort());
  });

  it('没有记录时返回空集合', () => {
    expect(loadCollapsed(store).size).toBe(0);
  });

  it('记录损坏或是非数组时退回空集合，不抛错', () => {
    store.setItem(COLLAPSED_KEY, '{不是 JSON');
    expect(loadCollapsed(store).size).toBe(0);

    store.setItem(COLLAPSED_KEY, JSON.stringify({ orderId: 'x' }));
    expect(loadCollapsed(store).size).toBe(0);
  });

  it('只接受字符串条目，脏数据被忽略', () => {
    store.setItem(COLLAPSED_KEY, JSON.stringify(['order-1', 42, null, { a: 1 }]));
    expect([...loadCollapsed(store)]).toEqual(['order-1']);
  });

  it('存储不可用（隐私模式）时读写都安静退化', () => {
    const broken: CollapseStore = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: vi.fn(() => {
        throw new Error('denied');
      }),
    };
    expect(loadCollapsed(broken).size).toBe(0);
    expect(() => saveCollapsed(new Set(['order-1']), broken)).not.toThrow();
    expect(loadCollapsed(null).size).toBe(0);
    expect(() => saveCollapsed(new Set(['order-1']), null)).not.toThrow();
  });
});

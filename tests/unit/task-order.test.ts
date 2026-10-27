import { describe, expect, it } from 'vitest';
import {
  applyVisibleOrder,
  compareTaskOrder,
  moveKey,
  sortTasksByOrder,
} from '../../src/domain/taskOrder';

/**
 * 任务手动排序（2026-10-27 用户反馈）：
 * 同一订单内任务内容相同但顺序不一致，需要允许手动排序。
 *
 * 这里只测纯函数：**稳定排序** + **可见子集重排**。
 * 关键约束：今日事项只显示一部分任务（非触发日、未生效、跨期次），
 * 拖动可见条目时**不能把看不见的任务挤走**，它们的槽位必须原地保留。
 */

type Row = { id: string; sortOrder: number; createdAt: number; title: string };

function row(id: string, sortOrder: number, createdAt = 0): Row {
  return { id, sortOrder, createdAt, title: id };
}

describe('任务排序比较', () => {
  it('先按 sortOrder，再按 createdAt、id 兜底', () => {
    const rows = [row('b', 1, 20), row('a', 1, 10), row('z', 0, 99)];
    expect(sortTasksByOrder(rows).map((item) => item.id)).toEqual(['z', 'a', 'b']);
  });

  it('sortOrder 相同且时间戳相同时按 id 稳定兜底，不随机漂移', () => {
    const rows = [row('m', 3, 5), row('c', 3, 5)];
    expect(sortTasksByOrder(rows).map((item) => item.id)).toEqual(['c', 'm']);
  });

  it('不修改传入数组', () => {
    const rows = [row('b', 2), row('a', 1)];
    sortTasksByOrder(rows);
    expect(rows.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('compareTaskOrder 与排序结果一致', () => {
    expect(compareTaskOrder(row('a', 1, 1), row('b', 2, 0))).toBeLessThan(0);
    expect(compareTaskOrder(row('a', 2, 0), row('b', 1, 9))).toBeGreaterThan(0);
    expect(compareTaskOrder(row('a', 1, 1), row('a', 1, 1))).toBe(0);
  });
});

describe('拖拽位移计算', () => {
  it('向下拖把元素放到目标位置', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('向上拖把元素放到目标位置', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('原地不动返回同样的顺序', () => {
    expect(moveKey(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('越界索引按边界处理，不产生空洞', () => {
    expect(moveKey(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveKey(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });
});

describe('可见子集重排（今日事项只显示部分任务）', () => {
  const rows = [row('a', 0, 1), row('hidden', 1, 2), row('b', 2, 3), row('c', 3, 4)];

  it('可见任务互换后，被隐藏任务的槽位原地保留', () => {
    // 可见 = a / b / c；想变成 c / a / b
    const next = applyVisibleOrder(rows, ['c', 'a', 'b']);
    expect(next.map((item) => item.id)).toEqual(['c', 'hidden', 'a', 'b']);
  });

  it('只给一部分清单时，没列出的任务留在自己的槽位', () => {
    const next = applyVisibleOrder(rows, ['c', 'a']);
    expect(next.map((item) => item.id)).toEqual(['c', 'hidden', 'b', 'a']);
  });

  it('空清单表示不改动', () => {
    expect(applyVisibleOrder(rows, []).map((item) => item.id)).toEqual([
      'a',
      'hidden',
      'b',
      'c',
    ]);
  });

  it('忽略不属于该订单的 id，重复 id 只取第一次', () => {
    const next = applyVisibleOrder(rows, ['c', 'ghost', 'c', 'a']);
    expect(next.map((item) => item.id)).toEqual(['c', 'hidden', 'b', 'a']);
  });

  it('返回新数组，不修改入参', () => {
    const input = [...rows];
    const next = applyVisibleOrder(input, ['c', 'b', 'a']);
    expect(next).not.toBe(input);
    expect(input.map((item) => item.id)).toEqual(['a', 'hidden', 'b', 'c']);
  });

  it('sortOrder 有历史重复值时按稳定顺序重排，不丢行', () => {
    const duplicated = [row('a', 0, 1), row('b', 0, 2), row('c', 0, 3)];
    expect(applyVisibleOrder(duplicated, ['c', 'a', 'b']).map((item) => item.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

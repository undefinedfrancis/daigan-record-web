import { describe, expect, it } from 'vitest';
import {
  formatDateLabel,
  formatShortDateLabel,
  gameDateNote,
  localTodayDate,
} from '../../src/features/today/todayLabel';

/**
 * 今日事项页头日期（2026-10-27 用户反馈）：返图要能一眼看出是哪一天，
 * 所以显示公历日期 + 星期；游戏日与公历日不同时再补一句说明。
 */

describe('页头日期格式', () => {
  it('输出中文年月日与星期，月日不补零', () => {
    expect(formatDateLabel('2026-10-27')).toBe('2026年10月27日 星期二');
    expect(formatDateLabel('2026-03-08')).toBe('2026年3月8日 星期日');
    expect(formatDateLabel('2026-03-01')).toBe('2026年3月1日 星期日');
  });

  it('覆盖周一与闰日边界', () => {
    expect(formatDateLabel('2026-03-09')).toBe('2026年3月9日 星期一');
    expect(formatDateLabel('2024-02-29')).toBe('2024年2月29日 星期四');
    expect(formatDateLabel('2023-12-31')).toBe('2023年12月31日 星期日');
  });

  it('按订单时区取“今天”的公历日期', () => {
    // 上海 2026-10-27 01:00（刷新时间之前，游戏日仍是 10-26）。
    expect(localTodayDate(Date.UTC(2026, 9, 26, 17, 0), 'Asia/Shanghai')).toBe('2026-10-27');
    expect(localTodayDate(Date.UTC(2026, 9, 26, 15, 59), 'Asia/Shanghai')).toBe('2026-10-26');
  });
});

describe('订单分组头的短日期', () => {
  it('只留月日与周几，省出组头宽度', () => {
    expect(formatShortDateLabel('2026-10-27')).toBe('10月27日 周二');
    expect(formatShortDateLabel('2026-03-08')).toBe('3月8日 周日');
    expect(formatShortDateLabel('2024-02-29')).toBe('2月29日 周四');
  });
});

describe('游戏日说明', () => {
  it('同一天不重复说明', () => {
    expect(gameDateNote('2026-10-27', '2026-10-27')).toBeNull();
  });

  it('未到刷新时间时说明进度仍算前一天', () => {
    expect(gameDateNote('2026-10-27', '2026-10-26')).toBe(
      '游戏日 2026-10-26（未到每日刷新时间，仍计前一天）',
    );
  });

  it('缺日期时不显示说明', () => {
    expect(gameDateNote('', '2026-10-26')).toBeNull();
    expect(gameDateNote('2026-10-27', '')).toBeNull();
  });
});

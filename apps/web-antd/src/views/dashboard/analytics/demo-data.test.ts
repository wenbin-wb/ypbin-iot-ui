import { describe, expect, it } from 'vitest';

import { buildDemoOverview } from '../shared/iot-demo-data';

/**
 * 演示兜底数据的趋势增强字段守门用例。
 *
 * 为什么单列：`analytics` 的两个新页签与 TOP 规则卡在**后端未就绪时**看到的就是这组数据，
 * 量级必须自洽（趋势最后一天对得上今日指标卡、增长近 7 天和值对得上近 7 日新增），
 * 否则演示态会自相矛盾，评审/演示时一眼假。
 */
describe('运行总览演示数据：趋势增强字段', () => {
  const now = new Date('2026-10-14T08:00:00');
  const overview = buildDemoOverview(now);

  it('告警趋势：30 天、日期升序且格式正确、三级计数为非负整数', () => {
    expect(overview.alertTrend).toHaveLength(30);
    const dates = overview.alertTrend.map((point) => {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return point.date;
    });
    expect([...dates].toSorted()).toStrictEqual(dates);

    for (const point of overview.alertTrend) {
      for (const value of [point.critical, point.warning, point.info]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('告警趋势最后一天 = 今日新增告警（指标卡与趋势图不打架）', () => {
    const today = overview.alertTrend.at(-1);
    if (!today) {
      throw new Error('alertTrend 不应为空');
    }
    expect(today.critical + today.warning + today.info).toBe(
      overview.alertToday,
    );
    expect(today.date).toBe('2026-10-14');
  });

  it('设备增长：14 天、日期升序，最后 7 天之和 = 近 7 日新增设备', () => {
    expect(overview.deviceGrowthTrend).toHaveLength(14);
    const dates = overview.deviceGrowthTrend.map((point) => point.date);
    expect([...dates].toSorted()).toStrictEqual(dates);

    for (const point of overview.deviceGrowthTrend) {
      expect(Number.isInteger(point.added)).toBe(true);
      expect(point.added).toBeGreaterThanOrEqual(0);
    }
    const lastWeek = overview.deviceGrowthTrend
      .slice(-7)
      .reduce((sum, point) => sum + point.added, 0);
    expect(lastWeek).toBe(overview.newDevicesWeek);
  });

  it('规则 TOP：最多 5 条、按告警数降序，name 是规则名而不是 ruleId', () => {
    expect(overview.alertRuleTop.length).toBeGreaterThan(0);
    expect(overview.alertRuleTop.length).toBeLessThanOrEqual(5);

    const values = overview.alertRuleTop.map((item) => item.value);
    expect([...values].toSorted((left, right) => right - left)).toStrictEqual(
      values,
    );
    for (const item of overview.alertRuleTop) {
      expect(item.name.trim()).not.toBe('');
      expect(item.name).not.toMatch(/^\d+$/);
    }
  });

  it('确定性：同一基准时刻构造两次完全一致（演示/回归不跳数）', () => {
    expect(buildDemoOverview(now)).toStrictEqual(overview);
  });
});

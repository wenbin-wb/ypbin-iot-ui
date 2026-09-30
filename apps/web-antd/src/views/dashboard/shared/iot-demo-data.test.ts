import { describe, expect, it } from 'vitest';

import { buildDemoOverview } from './iot-demo-data';

/**
 * 演示数据守门测试：保证「量级自洽」承诺不随后续调整悄悄失效——
 * 图表与分析文案会交叉引用这些数字，任何一处对不上都会显得数据是假的。
 */
describe('buildDemoOverview', () => {
  const now = new Date('2026-09-30T08:00:00');
  const overview = buildDemoOverview(now);

  it('设备数三分量之和等于总数', () => {
    expect(
      overview.deviceOnline + overview.deviceOffline + overview.deviceDisabled,
    ).toBe(overview.deviceTotal);
  });

  it('在线率口径为 在线 /（总数 - 停用），且保留一位小数', () => {
    const expected =
      Math.round(
        (overview.deviceOnline /
          (overview.deviceTotal - overview.deviceDisabled)) *
          1000,
      ) / 10;
    expect(overview.onlineRate).toBe(expected);
    expect(overview.onlineRate).toBeGreaterThan(0);
    expect(overview.onlineRate).toBeLessThanOrEqual(100);
  });

  it('今日消息量 = 上行 + 下行', () => {
    expect(overview.messageToday).toBe(
      overview.messageUplinkToday + overview.messageDownlinkToday,
    );
  });

  it('待处理告警数与级别分布之和一致', () => {
    const sum = overview.severityDistribution.reduce(
      (acc, item) => acc + item.value,
      0,
    );
    expect(sum).toBe(overview.alertPending);
  });

  it('趋势序列：30 日消息 + 14 日在线，日期升序且格式为 yyyy-MM-dd', () => {
    expect(overview.messageTrend).toHaveLength(30);
    expect(overview.onlineTrend).toHaveLength(14);
    const dates = overview.messageTrend.map((point) => {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      return point.date;
    });
    // 升序断言不写在条件里：排序后与原序列全等即升序
    expect([...dates].toSorted()).toStrictEqual(dates);
    expect(overview.messageTrend[29]?.date).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
  });

  it('同种子确定性：两次调用结果完全一致（演示/回归不跳数）', () => {
    expect(buildDemoOverview(now)).toStrictEqual(overview);
  });

  it('协议分布与产品 TOP 均为非负整数', () => {
    for (const item of [
      ...overview.protocolDistribution,
      ...overview.productTop,
    ]) {
      expect(Number.isInteger(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
  });

  it('最近告警条目携带可翻译的级别/状态码', () => {
    for (const alert of overview.recentAlerts) {
      expect(['critical', 'info', 'warning']).toContain(alert.severity);
      expect(['acked', 'firing', 'resolved']).toContain(alert.state);
      expect(alert.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
  });
});

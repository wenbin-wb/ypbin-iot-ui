import { describe, expect, it } from 'vitest';

import { buildSparkline, parseThresholdSnapshot } from './sparkline';

/**
 * 曲线缩略的用例（用户口径 ③：展开行可看「该点位近期曲线缩略」）。
 *
 * 最该咬住的两点：① 坏质量/非数值点必须被**丢弃并计数**（不能当 0，否则曲线会凭空掉到谷底）；
 * ② 时间轴按实际 `ts` 映射（等距索引会造出假的时间关系）。
 */
function point(ts: number, value: null | string, quality: null | string = 'GOOD') {
  return { ts, value, quality };
}

describe('曲线缩略 buildSparkline', () => {
  it('正常序列生成折线路径，阈值线落在值域内', () => {
    const result = buildSparkline({
      points: [
        point(1000, '23.5'),
        point(2000, '24.5'),
        point(3000, '25.5'),
      ],
      threshold: 25,
      width: 100,
      height: 50,
    });
    expect(result.path.startsWith('M')).toBe(true);
    expect(result.plotted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.min).toBe(23.5);
    expect(result.max).toBe(25.5);
    expect(result.thresholdY).not.toBeNull();
  });

  it('坏质量与非数值点被丢弃并计数（**不当 0**，也不插值）', () => {
    const result = buildSparkline({
      points: [
        point(1000, '23.5'),
        point(2000, 'abc'),
        point(3000, '24.5', 'BAD'),
        point(4000, '25.5'),
      ],
    });
    expect(result.plotted).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.min).toBe(23.5);
    expect(result.max).toBe(25.5);
  });

  it('点数不足 2 ⇒ 空路径（页面显示「数据不足」，不画一条假的水平线）', () => {
    expect(buildSparkline({ points: [point(1000, '23.5')] }).path).toBe('');
    expect(buildSparkline({ points: [] }).path).toBe('');
  });

  it('全部值相同 ⇒ 居中水平线（不除零）', () => {
    const result = buildSparkline({
      points: [point(1000, '5'), point(2000, '5')],
      width: 10,
      height: 40,
    });
    expect(result.path).toContain('M0.0,20.0');
    expect(result.path).toContain('L10.0,20.0');
  });

  it('阈值在值域外时把值域撑开（阈值线不会跑到画布外面）', () => {
    const result = buildSparkline({
      points: [point(1000, '10'), point(2000, '20')],
      threshold: 100,
      height: 50,
    });
    expect(result.min).toBe(10);
    expect(result.max).toBe(20);
    expect(result.thresholdY).toBe(4);
  });

  it('阈值快照解析：`> 80` ⇒ 80、`<= 10（回差 0.5）` ⇒ 10、无数字 ⇒ null', () => {
    expect(parseThresholdSnapshot('> 80')).toBe(80);
    expect(parseThresholdSnapshot('<= 10（回差 0.5）')).toBe(10);
    expect(parseThresholdSnapshot('>= 0.1')).toBe(0.1);
    expect(parseThresholdSnapshot('设备上报中断')).toBeNull();
    expect(parseThresholdSnapshot(undefined)).toBeNull();
  });
});

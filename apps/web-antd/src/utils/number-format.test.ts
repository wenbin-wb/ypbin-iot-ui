/**
 * `formatCompact` 边界用例。
 *
 * 这个函数此前在 `dashboard/analytics/index.vue` 与 `dashboard/workspace/index.vue`
 * 各有一份逐字相同的实现（审查 05 §4.1）；抽出到 `src/utils/number-format.ts` 后，
 * 用本文件把**展示口径**钉死：阈值、保留位数、负数与空值行为，避免两页再次漂移。
 */
import { describe, expect, it } from 'vitest';

import { formatCompact } from './number-format';

describe('formatCompact · 阈值与保留位数', () => {
  it('0 / 小于 1000 ⇒ 原样字符串', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(1)).toBe('1');
    expect(formatCompact(999)).toBe('999');
  });

  it('1000 ⇒ 千位压缩、保留 1 位小数（边界含等号）', () => {
    expect(formatCompact(1000)).toBe('1.0K');
    expect(formatCompact(1500)).toBe('1.5K');
    expect(formatCompact(1200)).toBe('1.2K');
  });

  it('1.2 万 = 12000 ⇒ 12.0K', () => {
    expect(formatCompact(1.2 * 10_000)).toBe('12.0K');
  });

  it('百万 ⇒ 保留 2 位小数（边界含等号）', () => {
    expect(formatCompact(1_000_000)).toBe('1.00M');
    expect(formatCompact(1_234_567)).toBe('1.23M');
    expect(formatCompact(999_999)).toBe('1000.0K'); // 已知口径：先比例后四舍五入会进位
  });

  it('小数在 <1000 时原样输出（不强制取整）', () => {
    expect(formatCompact(12.5)).toBe('12.5');
  });
});

describe('formatCompact · 负数与空值', () => {
  it('负数按绝对值压缩后保留负号', () => {
    expect(formatCompact(-5)).toBe('-5');
    expect(formatCompact(-999)).toBe('-999');
    expect(formatCompact(-1500)).toBe('-1.5K');
    expect(formatCompact(-1_500_000)).toBe('-1.50M');
  });

  it('null / undefined / 非有限数 ⇒ 空值占位 `-`（不显示 NaN/Infinity）', () => {
    expect(formatCompact(null)).toBe('-');
    expect(formatCompact(undefined)).toBe('-');
    expect(formatCompact(Number.NaN)).toBe('-');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('-');
    expect(formatCompact(Number.NEGATIVE_INFINITY)).toBe('-');
  });
});

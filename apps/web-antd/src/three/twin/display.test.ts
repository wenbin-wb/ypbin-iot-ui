import { describe, expect, it } from 'vitest';

import {
  ALL_DISPLAY_TYPES,
  colorForRatio,
  isDisplayTypeSupported,
  SUPPORTED_DISPLAY_TYPES,
  toColorRatio,
  toRenderMode,
  toSwitchState,
} from './display';

/**
 * 展示形态 → 渲染模式（工单 #126）。
 *
 * 修复前 `displayType` 五种形态**渲染结果完全相同**（配置项说谎）。
 * 本文件钉住三件事：
 * 1. 映射正确（value/gauge/sparkline → label、switch → switch、color → color）；
 * 2. 「已实现」与「未实现」的划分明确（UI 依据它标注暂不支持）；
 * 3. 辅助解析（二态 / 数值比例 / 色阶）的边界不猜。
 */
describe('toRenderMode', () => {
  it('value → 数值标签', () => {
    expect(toRenderMode('value')).toBe('label');
  });

  it('switch → 开关', () => {
    expect(toRenderMode('switch')).toBe('switch');
  });

  it('color → 按值染色', () => {
    expect(toRenderMode('color')).toBe('color');
  });

  it('★ 未实现的 gauge / sparkline 回落为 label（而不是留空或报错）', () => {
    expect(toRenderMode('gauge')).toBe('label');
    expect(toRenderMode('sparkline')).toBe('label');
  });

  it('空 / 未知值也回落为 label（历史数据可能没有该字段）', () => {
    expect(toRenderMode(undefined)).toBe('label');
    expect(toRenderMode(null)).toBe('label');
    expect(toRenderMode('')).toBe('label');
    expect(toRenderMode('legacy-unknown')).toBe('label');
  });

  it('★ 每个 ALL_DISPLAY_TYPES 都有确定的渲染模式（无遗漏）', () => {
    for (const code of ALL_DISPLAY_TYPES) {
      const mode = toRenderMode(code);
      expect(['label', 'switch', 'color']).toContain(mode);
    }
  });
});

describe('isDisplayTypeSupported', () => {
  it('value / switch / color 已实现', () => {
    expect(isDisplayTypeSupported('value')).toBe(true);
    expect(isDisplayTypeSupported('switch')).toBe(true);
    expect(isDisplayTypeSupported('color')).toBe(true);
  });

  it('★ gauge / sparkline 未实现（UI 据此标注「暂不支持」）', () => {
    expect(isDisplayTypeSupported('gauge')).toBe(false);
    expect(isDisplayTypeSupported('sparkline')).toBe(false);
  });

  it('空 / 未知视为未实现', () => {
    expect(isDisplayTypeSupported(undefined)).toBe(false);
    expect(isDisplayTypeSupported(null)).toBe(false);
    expect(isDisplayTypeSupported('nope')).toBe(false);
  });

  it('★ 已实现集合是全集子集，且补集恰好是未实现的两个', () => {
    const supported = new Set(SUPPORTED_DISPLAY_TYPES);
    for (const item of supported) {
      expect(ALL_DISPLAY_TYPES).toContain(item);
    }
    const unsupported = ALL_DISPLAY_TYPES.filter((it) => !supported.has(it));
    expect(unsupported.toSorted()).toEqual(['gauge', 'sparkline']);
  });
});

describe('toSwitchState', () => {
  it('常见「开」表示', () => {
    for (const value of ['1', 'true', 'on', 'OPEN', 'opened']) {
      // 断言失败时能看出是哪个取值：用表达式消息而不是 expect 的第二参数
      expect({ input: value, state: toSwitchState(value) }).toEqual({
        input: value,
        state: true,
      });
    }
  });

  it('常见「关」表示', () => {
    for (const value of ['0', 'false', 'off', 'CLOSED', 'closed']) {
      expect({ input: value, state: toSwitchState(value) }).toEqual({
        input: value,
        state: false,
      });
    }
  });

  it('数字形态：非 0 即开', () => {
    expect(toSwitchState('2')).toBe(true);
    expect(toSwitchState('-1')).toBe(true);
  });

  it('★ 无法判定时返回 undefined（不猜开或关）', () => {
    expect(toSwitchState('running')).toBeUndefined();
    expect(toSwitchState('')).toBeUndefined();
    expect(toSwitchState(null)).toBeUndefined();
    expect(toSwitchState(undefined)).toBeUndefined();
  });
});

describe('toColorRatio / colorForRatio', () => {
  it('线性映射到 0~1', () => {
    expect(toColorRatio(0, 0, 100)).toBeCloseTo(0);
    expect(toColorRatio(50, 0, 100)).toBeCloseTo(0.5);
    expect(toColorRatio(100, 0, 100)).toBeCloseTo(1);
  });

  it('越界被裁剪到 0~1', () => {
    expect(toColorRatio(-10, 0, 100)).toBe(0);
    expect(toColorRatio(200, 0, 100)).toBe(1);
  });

  it('★ 缺 min/max 或 max<=min 时返回 undefined（不做无依据猜测）', () => {
    expect(toColorRatio(5, undefined, undefined)).toBeUndefined();
    expect(toColorRatio(5, 0, undefined)).toBeUndefined();
    expect(toColorRatio(5, undefined, 10)).toBeUndefined();
    expect(toColorRatio(5, 10, 10)).toBeUndefined();
    expect(toColorRatio('abc', 0, 100)).toBeUndefined();
  });

  it('色阶：0 绿、1 红、中间偏黄', () => {
    expect(colorForRatio(0)).toBe('rgb(34, 197, 94)');
    expect(colorForRatio(1)).toBe('rgb(239, 68, 68)');
    const mid = colorForRatio(0.5);
    expect(mid).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it('色阶入参越界也被裁剪（不会产生负值通道）', () => {
    expect(colorForRatio(-5)).toBe(colorForRatio(0));
    expect(colorForRatio(5)).toBe(colorForRatio(1));
  });
});

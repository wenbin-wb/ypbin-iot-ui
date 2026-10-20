import { describe, expect, it } from 'vitest';

import {
  BRAND_TEXT,
  brandTextColor,
  METRIC_CARD_BG,
  METRIC_VISUALS,
  metricTextColor,
} from './metric-visuals';

/**
 * 指标卡配色的**对比度回归闸门**（WCAG 2.1 §1.4.3 / §1.4.11）。
 *
 * 为什么要有这层：原实现用渐变裁切字做数值，实测在线率 `#0bd092` 对白底卡只有 **2.01:1**、
 * 今日消息 `#0da2e7` **2.86:1** —— 连「大文本 3:1」都不够，属于「核心指标看不清」的缺陷。
 * 改色之后如果没有用例守着，下次调色板很容易又调回浅色。
 *
 * 判据（本仓库取**更严**的一档）：
 * - 数值文字：对卡片底色 ≥ **4.5:1**（正文标准，比大文本的 3:1 更严）；
 * - 白色图标压在装饰渐变上：≥ **3:1**（图形对象标准）。
 */

/** `hsl(212 90% 40%)` / `hsl(222.34 10.43% 12.27%)` → `[r, g, b]`。 */
function hslToRgb(value: string): [number, number, number] {
  const matched = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/.exec(value);
  if (!matched) {
    throw new Error(`不是合法的 hsl() 颜色：${value}`);
  }
  const h = Number(matched[1]);
  const s = Number(matched[2]) / 100;
  const l = Number(matched[3]) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) {
    rgb = [c, x, 0];
  } else if (hp < 2) {
    rgb = [x, c, 0];
  } else if (hp < 3) {
    rgb = [0, c, x];
  } else if (hp < 4) {
    rgb = [0, x, c];
  } else if (hp < 5) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  const m = l - c / 2;
  return rgb.map((v) => Math.round((v + m) * 255)) as [number, number, number];
}

/** WCAG 相对亮度。 */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1:1 ~ 21:1）。 */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hslToRgb(a));
  const lb = relativeLuminance(hslToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 从 `linear-gradient(135deg, hsl(...), hsl(...))` 里取出两个色标。 */
function gradientStops(gradient: string): string[] {
  const stops = [...gradient.matchAll(/hsl\([^)]+\)/g)].map((m) => m[0]);
  if (stops.length < 2) {
    throw new Error(`渐变缺少两个色标：${gradient}`);
  }
  return stops;
}

const METRIC_KEYS = Object.keys(METRIC_VISUALS) as Array<
  keyof typeof METRIC_VISUALS
>;

describe('指标卡数值文字：对卡片底色 ≥ 4.5:1', () => {
  for (const key of METRIC_KEYS) {
    it(`${key}：亮色档（白底卡）`, () => {
      const ratio = contrastRatio(
        METRIC_VISUALS[key].textLight,
        METRIC_CARD_BG.light,
      );
      expect(
        ratio,
        `${key} 亮色数值 ${METRIC_VISUALS[key].textLight} 对白底只有 ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${key}：暗色档（深底卡）`, () => {
      const ratio = contrastRatio(
        METRIC_VISUALS[key].textDark,
        METRIC_CARD_BG.dark,
      );
      expect(
        ratio,
        `${key} 暗色数值 ${METRIC_VISUALS[key].textDark} 对深底只有 ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('装饰渐变上的白色图标：≥ 3:1（图形对象标准）', () => {
  const WHITE = 'hsl(0 0% 100%)';
  for (const key of METRIC_KEYS) {
    it(`${key}：两个色标都能托住白色图标`, () => {
      for (const stop of gradientStops(METRIC_VISUALS[key].grad)) {
        const ratio = contrastRatio(WHITE, stop);
        expect(
          ratio,
          `${key} 的渐变端点 ${stop} 对白色图标只有 ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('取色函数按主题切换', () => {
  it('metricTextColor 亮/暗返回不同色值，且与常量一致', () => {
    for (const key of METRIC_KEYS) {
      expect(metricTextColor(key, false)).toBe(METRIC_VISUALS[key].textLight);
      expect(metricTextColor(key, true)).toBe(METRIC_VISUALS[key].textDark);
      expect(metricTextColor(key, false)).not.toBe(metricTextColor(key, true));
    }
  });

  it('brandTextColor 与 device 卡同色（页头与指标卡同一套蓝）', () => {
    expect(brandTextColor(false)).toBe(BRAND_TEXT.light);
    expect(brandTextColor(true)).toBe(BRAND_TEXT.dark);
    expect(BRAND_TEXT.light).toBe(METRIC_VISUALS.device.textLight);
    expect(BRAND_TEXT.dark).toBe(METRIC_VISUALS.device.textDark);
  });
});

describe('对比度工具自检（防止用例本身算错而假绿）', () => {
  it('黑白对比度为 21:1，同色为 1:1', () => {
    expect(contrastRatio('hsl(0 0% 0%)', 'hsl(0 0% 100%)')).toBeCloseTo(21, 1);
    expect(contrastRatio('hsl(0 0% 100%)', 'hsl(0 0% 100%)')).toBeCloseTo(1, 5);
  });
});

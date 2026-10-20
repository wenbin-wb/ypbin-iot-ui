/**
 * 图表 12 色色盲友好调色板的**静态 + 纯函数**回归用例。
 *
 * ## 为什么需要这组用例
 *
 * 2026-10-20 审查发现图表配色是「4 语义族 × 3 明度」凑 12 色：同族只差明度，
 * 在红绿色盲（deuteranopia / protanopia）与灰度打印下相邻序列不可辨。
 * 本批把色板改为 Okabe-Ito 8 主色 + Paul Tol 4 补充（色相优先），并把色值落到
 * design-token（`--chart-1..12` 亮/暗两套）。这类问题**渲染层测不出来**，
 * 但是「顺序错 / 少一色 / 两档色相对不上 / 相邻明度太近」都能在源码与纯函数层断言：
 *
 * 1. **token 名与顺序**：12 个 `--chart-N` 必须 1..12 连续且与 `SERIES_TOKENS` 一致
 *    （顺序是「相邻明度差最大化」排出来的，重排会破坏色盲下的第二线索）；
 * 2. **无 :root 降级**：SSR/单测没有 CSS 变量时，`chartSeriesPalette()` 仍必须返回
 *    **12 个互不相同**的具体颜色（不能全落回同一个兜底色，更不能是黑/透明）；
 * 3. **灰度亮度自查**：用 WCAG 相对亮度算法比较相邻两色的亮度差。
 *
 * ## 灰度亮度自查的算法与阈值（辅助校验，不替代色盲模拟）
 *
 * 算法（WCAG 2.1 相对亮度）：
 *   `L = 0.2126*R' + 0.7152*G' + 0.0722*B'`，其中每个通道先按 sRGB 反伽马线性化
 *   （`c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`）。
 * 判据：相邻两色的 `|L[i] - L[i+1]| >= 0.08`。
 * 0.08 的依据：12 个分类色要在一张图上共存的现实约束下，相邻类别仍能在灰度下
 * 保留可感知的明度台阶（实测亮色档最小 0.113、暗色档最小 0.141，留出 ~30% 余量，
 * 避免以后微调色值立刻误伤）；它只是**辅助**判据 —— 真实可辨性还需色盲模拟、
 * 图例顺序与线型/标记等冗余编码配合，本用例不声称替代这些验证。
 *
 * 另附带校验（设计承诺，非审查强制）：亮色档对白底 ≥2.4:1、暗色档对暗底 ≥3.0:1
 * （WCAG 1.4.11 图形对象建议 3:1；12 色无法全部满足，亮色档取 2.5:1 为下限，
 * 实测最低 2.50:1，偏差已在 CSS 注释与汇报里登记）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHART_SERIES_COUNT,
  chartColor,
  chartSeriesColorAt,
  chartSeriesPalette,
  SERIES_TOKENS,
} from './chart-tokens';

/** 本测试所在目录：`apps/web-antd/src/utils`。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（`utils` → `src` → `web-antd` → `apps` → 根）。 */
const REPO_ROOT = resolve(HERE, '../../../..');

const DESIGN_TOKENS_DIR = resolve(
  REPO_ROOT,
  'packages/@core/base/design/src/design-tokens',
);

/** 相邻类别相对亮度差下限（依据见文件头注释）。 */
const MIN_ADJACENT_LUMINANCE_GAP = 0.08;

/** 亮色档 vs 白底、暗色档 vs 暗底的对比度下限（设计承诺，留 0.1 余量）。 */
const MIN_LIGHT_CONTRAST = 2.4;
const MIN_DARK_CONTRAST = 3;

/** 暗底 = dark.css 的 `--background: 222.34deg 10.43% 12.27%`。 */
const DARK_BACKGROUND_HSL: [number, number, number] = [222.34, 10.43, 12.27];

interface ChartTokenDefinition {
  /** `--chart-N` 的 N。 */
  index: number;
  /** H / S% / L%。 */
  hsl: [number, number, number];
}

/** 从 design-token CSS 中解析 `--chart-1..12`（按出现顺序）。 */
function readChartTokens(fileName: string): ChartTokenDefinition[] {
  const source = readFileSync(resolve(DESIGN_TOKENS_DIR, fileName), 'utf8');
  const matched = [
    ...source.matchAll(
      /--chart-(\d+):\s*([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\s*;/g,
    ),
  ];
  return matched.map((match) => ({
    hsl: [Number(match[2]), Number(match[3]), Number(match[4])],
    index: Number(match[1]),
  }));
}

/** HSL → RGB（与 chart-tokens 的内部实现同口径；测试独立实现以便互相校验）。 */
function hslToRgb([h, s, l]: [number, number, number]): [
  number,
  number,
  number,
] {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = h / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) {
    rgb = [chroma, x, 0];
  } else if (hp < 2) {
    rgb = [x, chroma, 0];
  } else if (hp < 3) {
    rgb = [0, chroma, x];
  } else if (hp < 4) {
    rgb = [0, x, chroma];
  } else if (hp < 5) {
    rgb = [x, 0, chroma];
  } else {
    rgb = [chroma, 0, x];
  }
  const m = lightness - chroma / 2;
  return rgb.map((channel) => Math.round((channel + m) * 255)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 相对亮度（sRGB 反伽马线性化）。 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 对比度（1~21）。 */
function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const sorted = [relativeLuminance(a), relativeLuminance(b)].toSorted(
    (left, right) => right - left,
  );
  const lighter = sorted[0] ?? 0;
  const darker = sorted[1] ?? 0;
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT_TOKENS = readChartTokens('default.css');
const DARK_TOKENS = readChartTokens('dark.css');
const WHITE: [number, number, number] = [255, 255, 255];
const DARK_BACKGROUND = hslToRgb(DARK_BACKGROUND_HSL);

describe('chart-tokens · token 名与顺序（12 色）', () => {
  it('default.css / dark.css 各有且仅有 --chart-1..12，序号连续升序', () => {
    for (const tokens of [LIGHT_TOKENS, DARK_TOKENS]) {
      expect(tokens).toHaveLength(CHART_SERIES_COUNT);
      expect(tokens.map((token) => token.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    }
  });

  it('chart-1..12 固定顺序（即色板顺序，不允许重排）', () => {
    expect(SERIES_TOKENS).toEqual([
      'chart-1',
      'chart-2',
      'chart-3',
      'chart-4',
      'chart-5',
      'chart-6',
      'chart-7',
      'chart-8',
      'chart-9',
      'chart-10',
      'chart-11',
      'chart-12',
    ]);
    expect(SERIES_TOKENS).toHaveLength(CHART_SERIES_COUNT);
  });

  it('亮/暗两档一一对应：同序号 H/S 相同，只有 L 按底色适配', () => {
    expect(DARK_TOKENS.map((token) => token.index)).toEqual(
      LIGHT_TOKENS.map((token) => token.index),
    );
    for (let index = 0; index < LIGHT_TOKENS.length; index += 1) {
      const light = LIGHT_TOKENS[index]?.hsl;
      const dark = DARK_TOKENS[index]?.hsl;
      expect(light?.[0]).toBeCloseTo(dark?.[0] ?? Number.NaN, 5);
      expect(light?.[1]).toBeCloseTo(dark?.[1] ?? Number.NaN, 5);
    }
    // 至少要有颜色确实做了亮/暗适配（否则「两套」名不副实）
    const adjusted = LIGHT_TOKENS.filter((token, index) => {
      return token.hsl[2] !== DARK_TOKENS[index]?.hsl[2];
    });
    expect(adjusted.length).toBeGreaterThan(0);
  });
});

describe('chart-tokens · 无 :root 时的降级色板', () => {
  it('happy-dom 无 CSS 变量 ⇒ 仍返回 12 个互不相同的具体颜色', () => {
    // 先确认前提成立：测试环境里确实读不到 token（否则本用例失去意义）
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      '--chart-1',
    );
    expect(raw.trim()).toBe('');

    const palette = chartSeriesPalette();
    expect(palette).toHaveLength(CHART_SERIES_COUNT);
    expect(new Set(palette).size).toBe(CHART_SERIES_COUNT);
    for (const color of palette) {
      expect(color).toMatch(/^rgba?\(/);
    }

    // 取色函数：12 个槽位互不相同，且越界稳定取模
    const slots = Array.from({ length: CHART_SERIES_COUNT }, (_, index) => {
      return chartSeriesColorAt(index);
    });
    expect(new Set(slots).size).toBe(CHART_SERIES_COUNT);
    expect(chartSeriesColorAt(CHART_SERIES_COUNT)).toBe(chartSeriesColorAt(0));
    expect(chartSeriesColorAt(Number.NaN)).toBe(chartSeriesColorAt(0));
  });

  it('降级色板与 default.css 的亮色档逐一对应（两套事实源不许漂移）', () => {
    const palette = chartSeriesPalette();
    LIGHT_TOKENS.forEach((token, index) => {
      const expected = hslToRgb(token.hsl);
      expect(palette[index], `chart-${index + 1} 降级色与亮色档不一致`).toBe(
        `rgb(${expected[0]}, ${expected[1]}, ${expected[2]})`,
      );
    });
  });

  it('语义 token 仍可解析：primary/success/warning/destructive 映射到对应色相（可区分）', () => {
    const semantic = [
      chartColor('primary'),
      chartColor('success'),
      chartColor('warning'),
      chartColor('destructive'),
      chartColor('primary-400'),
    ];
    expect(new Set(semantic.slice(0, 4)).size).toBe(4);
    // alpha 走 rgba 且被夹到 [0,1]
    expect(chartColor('primary', 0.35)).toMatch(
      /^rgba\(\d+, \d+, \d+, 0\.35\)$/,
    );
    expect(chartColor('primary', 2)).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
    expect(chartColor('primary', -1)).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
  });
});

describe('chart-tokens · WCAG 灰度亮度自查（辅助校验）', () => {
  it('亮色档：相邻类别 |ΔL| ≥ 0.08 且 12 色互不相同', () => {
    const rgb = LIGHT_TOKENS.map((token) => hslToRgb(token.hsl));
    expect(new Set(rgb.map((color) => color.join(','))).size).toBe(
      CHART_SERIES_COUNT,
    );
    for (let index = 1; index < rgb.length; index += 1) {
      const gap = Math.abs(
        relativeLuminance(rgb[index] as [number, number, number]) -
          relativeLuminance(rgb[index - 1] as [number, number, number]),
      );
      expect(
        gap,
        `亮色档 chart-${index} → chart-${index + 1} 相邻灰度亮度差 ${gap.toFixed(3)} 低于阈值 ${MIN_ADJACENT_LUMINANCE_GAP}`,
      ).toBeGreaterThanOrEqual(MIN_ADJACENT_LUMINANCE_GAP);
    }
  });

  it('暗色档：相邻类别 |ΔL| ≥ 0.08 且 12 色互不相同', () => {
    const rgb = DARK_TOKENS.map((token) => hslToRgb(token.hsl));
    expect(new Set(rgb.map((color) => color.join(','))).size).toBe(
      CHART_SERIES_COUNT,
    );
    for (let index = 1; index < rgb.length; index += 1) {
      const gap = Math.abs(
        relativeLuminance(rgb[index] as [number, number, number]) -
          relativeLuminance(rgb[index - 1] as [number, number, number]),
      );
      expect(
        gap,
        `暗色档 chart-${index} → chart-${index + 1} 相邻灰度亮度差 ${gap.toFixed(3)} 低于阈值 ${MIN_ADJACENT_LUMINANCE_GAP}`,
      ).toBeGreaterThanOrEqual(MIN_ADJACENT_LUMINANCE_GAP);
    }
  });

  it('与目标底色的对比度不低于设计下限（亮底 ≥2.4:1、暗底 ≥3.0:1）', () => {
    const lightContrasts = LIGHT_TOKENS.map((token) => {
      return contrastRatio(hslToRgb(token.hsl), WHITE);
    });
    expect(Math.min(...lightContrasts)).toBeGreaterThanOrEqual(
      MIN_LIGHT_CONTRAST,
    );

    const darkContrasts = DARK_TOKENS.map((token) => {
      return contrastRatio(hslToRgb(token.hsl), DARK_BACKGROUND);
    });
    expect(Math.min(...darkContrasts)).toBeGreaterThanOrEqual(
      MIN_DARK_CONTRAST,
    );
  });
});

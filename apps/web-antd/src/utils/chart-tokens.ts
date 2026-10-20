/**
 * 仪表盘图表配色令牌（**ECharts / canvas 专用**）。
 *
 * ## 为什么必须走这一层，而不是直接写颜色
 *
 * 1. **不能写 hex**：全站曾散落 48 处 6 位 hex，换主题色（`preferences.theme.colorPrimary`）或
 *    切换暗色时图表**不跟随**，等于同一份数据两套配色；改一处配色要满仓找。
 * 2. **不能写 `hsl(var(--primary))`**：ECharts 把颜色交给 canvas 的 `fillStyle`/`strokeStyle`，
 *    **canvas 不解析 CSS 变量**——非法色值会被静默忽略并落回默认色，图表直接糊掉。
 *
 * 所以在**渲染时**用 `getComputedStyle` 把语义 token 读出来，转成 canvas 能吃的 `rgb()/rgba()`
 * （token 在 `internal/tailwind-config/src/theme.css` 注册，亮/暗各一套，
 * 由 `@vben/preferences` 的 `updateCSSVariables` 在启动与切主题时写入 `:root`）。
 *
 * ## 取不到变量时怎么办
 *
 * SSR / 单测（happy-dom）里 `:root` 上没有这些变量。此时返回 `undefined`，
 * 调用方过滤后**不传 color**，让 ECharts 用它自带的调色板兜底 ——
 * 绝不返回黑色/透明，那会让「取不到值」伪装成「配色正常但看不清」。
 */

/** 可用语义 token（=`--` 之后的 CSS 变量名）。 */
export type ChartToken =
  | 'destructive'
  | 'destructive-400'
  | 'destructive-600'
  | 'muted-foreground'
  | 'primary'
  | 'primary-400'
  | 'primary-600'
  | 'success'
  | 'success-400'
  | 'success-600'
  | 'warning'
  | 'warning-400'
  | 'warning-600';

/**
 * 分类色板顺序：4 个语义族 × 500/400/600 三档 = 12 色，
 * 与看板 `IOT_BOARD_MAX_SERIES = 12` 对齐。
 *
 * 取舍（如实说明）：语义 token 只有 4 个色族，凑不出 12 个**互相高度可辨**的色相；
 * 这里用「同一族不同明度」保证序列之间仍可区分、且全部随主题与暗色自动适配。
 * 若后续需要 12 色色盲友好（Okabe-Ito 那类），正确做法是在
 * `internal/tailwind-config/src/theme.css` 增加 `--chart-1..12` 语义 token（亮/暗各一套），
 * 而不是回到散落的 hex —— 已作为后续项记在汇报里。
 */
const SERIES_TOKENS: ChartToken[] = [
  'primary',
  'success',
  'warning',
  'destructive',
  'primary-400',
  'success-400',
  'warning-400',
  'destructive-400',
  'primary-600',
  'success-600',
  'warning-600',
  'destructive-600',
];

/**
 * 读不到 CSS 变量时的降级色板（= ECharts 5 自带默认色板）。
 *
 * 为什么需要降级而不是返回 `undefined`：ECharts 的 option 类型要求 `color: string`，
 * 而 SSR/单测（happy-dom）里 `:root` 上没有 `--primary` 等变量；若返回 undefined，
 * 调用方要么被迫写 `as` 断言（用类型断言掩盖运行期差异），要么每个 call site 做条件展开。
 * 这里统一给一组**真实可见**的默认色：生产环境必然能读到 token，不会走该分支；
 * 单测里图表本身被 mock，只影响断言形状，且绝不会出现「黑色/透明」这类伪装。
 */
const ECHARTS_FALLBACK_PALETTE = [
  'rgb(84, 112, 198)',
  'rgb(145, 204, 117)',
  'rgb(250, 200, 88)',
  'rgb(238, 102, 102)',
  'rgb(115, 192, 222)',
  'rgb(59, 162, 114)',
  'rgb(252, 132, 82)',
  'rgb(154, 96, 180)',
  'rgb(234, 124, 204)',
  'rgb(162, 138, 90)',
  'rgb(126, 175, 214)',
  'rgb(200, 90, 90)',
] as const;

/** token 所属语义族的降级下标（保证 primary/success/warning/destructive 颜色可区分）。 */
const FALLBACK_INDEX_BY_FAMILY: Record<string, number> = {
  destructive: 3,
  primary: 0,
  success: 1,
  warning: 2,
};

/** 解析 `212 100% 45%` / `222.34deg 10.43% 12.27%` 这类 H S% L% 三元组。 */
function parseHslComponents(raw: string): [number, number, number] | null {
  const matched = /^([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/.exec(raw.trim());
  if (!matched) {
    return null;
  }
  const hue = Number(matched[1]);
  const saturation = Number(matched[2]);
  const lightness = Number(matched[3]);
  if (
    !Number.isFinite(hue) ||
    !Number.isFinite(saturation) ||
    !Number.isFinite(lightness)
  ) {
    return null;
  }
  return [hue, saturation, lightness];
}

/** HSL（H 角度 / S% / L%）→ 0-255 的 RGB。 */
function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
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
  const m = l - chroma / 2;
  return rgb.map((channel) => Math.round((channel + m) * 255)) as [
    number,
    number,
    number,
  ];
}

/**
 * 把语义 token 解析成 canvas 可用颜色。
 *
 * @param token 语义名（见 `ChartToken`）
 * @param alpha 0~1，需要半透明时传（面积图渐变、光斑等）
 * @returns `rgb(r, g, b)` / `rgba(r, g, b, a)`；读不到 token（SSR/单测）时返回降级色板
 */
export function chartColor(token: ChartToken, alpha?: number): string {
  const fallback = resolveFallbackColor(token, alpha);
  if (
    typeof document === 'undefined' ||
    typeof getComputedStyle !== 'function'
  ) {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${token}`)
    .trim();
  if (raw === '') {
    return fallback;
  }
  const components = parseHslComponents(raw);
  if (!components) {
    return fallback;
  }
  const [r, g, b] = hslToRgb(...components);
  if (alpha === undefined) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  // 夹到 0~1：图表配置里写错 alpha 不应该产出非法色值让整张图静默失效
  const safeAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

/** 降级色（语义族 → ECharts 默认色板；alpha 按需转 rgba）。 */
function resolveFallbackColor(token: ChartToken, alpha?: number): string {
  const family = token.split('-')[0] ?? '';
  const index = FALLBACK_INDEX_BY_FAMILY[family] ?? 0;
  const base = ECHARTS_FALLBACK_PALETTE[index] ?? ECHARTS_FALLBACK_PALETTE[0];
  if (alpha === undefined) {
    return base;
  }
  const numbers = base.match(/\d+/g)?.map(Number) ?? [84, 112, 198];
  const safeAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${numbers[0] ?? 84}, ${numbers[1] ?? 112}, ${numbers[2] ?? 198}, ${safeAlpha})`;
}

/**
 * 分类色板（最多 12 色）。读不到 token 的槽位由降级色板补齐 ⇒ 永远返回 12 色。
 */
export function chartSeriesPalette(): string[] {
  const colors: string[] = [];
  for (const token of SERIES_TOKENS) {
    const color = chartColor(token);
    if (color !== undefined) {
      colors.push(color);
    }
  }
  return colors;
}

/**
 * 取第 `index` 条序列的颜色（越界按调色板长度取模，保证同一序列每次渲染颜色稳定）。
 */
export function chartSeriesColorAt(index: number): string {
  const palette = chartSeriesPalette();
  const safe = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return palette[safe % palette.length] ?? ECHARTS_FALLBACK_PALETTE[0];
}

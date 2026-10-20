/**
 * 图表配色令牌（**ECharts / canvas 专用**）。
 *
 * ## 三层结构（为什么颜色要绕这一圈）
 *
 * 1. **色值事实源在 CSS 变量**（`packages/@core/base/design/src/design-tokens/{default,dark}.css`）：
 *    分类色板 `--chart-1..12` 亮/暗各一套，以及 `--primary/--success/...` 语义色。
 *    色板本身是 Okabe-Ito 8 主色 + Paul Tol 4 补充（12 色色盲友好，来源与亮度依据见 CSS 注释）。
 * 2. Tailwind 只注册 `--color-chart-N` 供 class 写法使用；图表**不**依赖这些 class。
 * 3. 本文件在**渲染时**用 `getComputedStyle` 读取变量，转成 canvas 能吃的 `rgb()/rgba()`。
 *
 * ## 为什么不能直接写颜色
 *
 * - **不能写 hex**：换主题/暗色时图表不跟随，同一份数据两套配色，且色板改动要满仓找；
 * - **不能写 `hsl(var(--chart-1))`**：ECharts 把颜色交给 canvas 的 `fillStyle`/`strokeStyle`，
 *   **canvas 不解析 CSS 变量**——非法色值被静默忽略并落回默认色，图表直接糊掉。
 *   所以必须有「读变量 → 转 rgb」这一层。
 *
 * ## 12 色分类色板
 *
 * `SERIES_TOKENS` 固定为 `chart-1..12`（与看板 `IOT_BOARD_MAX_SERIES = 12` 对齐）：
 * 原先用「4 语义族 × 3 明度」凑 12 色，同族只差明度，红绿色盲/灰度下相邻序列不可辨；
 * 现改为色相优先的色盲友好色板，顺序按「相邻类别相对亮度差最大化」排定。
 * 顺序、相邻亮度差、亮暗两档对应关系由 `chart-tokens.test.ts` 锁定。
 *
 * ## 暗色模式（本轮边界）
 *
 * 变量随主题切换（`dark.css` 覆盖 `--chart-*`），因此**新渲染**的图表自动使用暗色档；
 * 已经画在 canvas 上的图表不会自己重绘 —— 切主题/换主题色后由 `utils/use-chart-theme.ts`
 * 的 `useChartThemeRefresh()` 重新调用组件的渲染函数（`getComputedStyle` 重新读值，
 * `watch` 监听 `isDark` 与 `theme.colorPrimary`，`flush: 'post'` 保证读到新变量）。
 * 每个 ECharts 渲染点都必须接入该 composable，否则切主题后旧图保持旧色。
 *
 * ## 取不到变量时怎么办
 *
 * SSR / 单测（happy-dom）里 `:root` 上没有这些变量。此时返回与**亮色档一致**的具体 `rgb()`：
 * 12 色仍互不相同（不会出现「全是同一个兜底色」），也绝不返回黑色/透明——
 * 那会让「取不到值」伪装成「配色正常但看不清」。
 */

/** 分类色板槽位数（= 看板最大序列数）。 */
export const CHART_SERIES_COUNT = 12;

/** 分类色板序号（1..12，与 CSS `--chart-N` 的 N 对应）。 */
type ChartSeriesNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** 可用图表 token（=`--` 之后的 CSS 变量名）。 */
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
  | 'warning-600'
  | `chart-${ChartSeriesNumber}`;

/**
 * 分类色板顺序：`chart-1..12`（色盲友好，见文件头）。
 *
 * 顺序 = 相邻类别相对亮度差最大化的排列，**不要为了「好看」重排**：
 * 图表里相邻序列（尤其折线/柱状相邻两项）依赖明度差作为色盲下的第二线索。
 */
export const SERIES_TOKENS: readonly ChartToken[] = [
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
];

/**
 * 读不到 CSS 变量时的降级色板（**与亮色档 `--chart-1..12` 逐一对应**）。
 *
 * 为什么不直接用 ECharts 默认色板：默认色板没有做色盲优化，且会让
 * 「单测/SSR 的配色」与「生产配色」成为两套事实源。这里用亮色档的 rgb 值，
 * 由 `chart-tokens.test.ts` 与 `default.css` 交叉校验（改 CSS 必同步改这里，否则测试红）。
 */
const CHART_PALETTE_FALLBACK = [
  'rgb(0, 158, 115)', // chart-1 Okabe-Ito bluish green
  'rgb(70, 173, 231)', // chart-2 Okabe-Ito sky blue
  'rgb(213, 94, 0)', // chart-3 Okabe-Ito vermillion
  'rgb(186, 163, 47)', // chart-4 Tol sand
  'rgb(0, 114, 178)', // chart-5 Okabe-Ito blue
  'rgb(204, 121, 167)', // chart-6 Okabe-Ito reddish purple
  'rgb(0, 0, 0)', // chart-7 Okabe-Ito black（亮色档）
  'rgb(68, 170, 153)', // chart-8 Tol teal
  'rgb(51, 34, 136)', // chart-9 Tol indigo
  'rgb(177, 166, 14)', // chart-10 Okabe-Ito yellow（亮色档压暗）
  'rgb(136, 34, 85)', // chart-11 Tol wine
  'rgb(217, 150, 0)', // chart-12 Okabe-Ito orange（亮色档压暗）
] as const;

/**
 * 语义族 token 的降级槽位（0-based）：
 * primary→蓝、success→青绿、warning→橙、destructive→朱红，
 * 保证单测/SSR 里语义色之间亦可区分（与分类色板的语义色相保持一致）。
 */
const FALLBACK_INDEX_BY_FAMILY: Record<string, number> = {
  destructive: 2,
  primary: 4,
  success: 0,
  warning: 11,
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
 * 把 token 解析成 canvas 可用颜色。
 *
 * @param token token 名（见 `ChartToken`；分类色板用 `chart-1..12`）
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

/** 降级槽位：`chart-N` 精确对应第 N 色；语义族按 {@link FALLBACK_INDEX_BY_FAMILY}。 */
function fallbackIndexFor(token: ChartToken): number {
  const chartMatched = /^chart-(\d+)$/.exec(token);
  if (chartMatched) {
    const number = Number(chartMatched[1]);
    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= CHART_PALETTE_FALLBACK.length
    ) {
      return number - 1;
    }
  }
  const family = token.split('-')[0] ?? '';
  return FALLBACK_INDEX_BY_FAMILY[family] ?? 0;
}

/** 降级色（分类色板 → 同槽位；语义族 → 对应色相；alpha 按需转 rgba）。 */
function resolveFallbackColor(token: ChartToken, alpha?: number): string {
  const index = fallbackIndexFor(token);
  const base = CHART_PALETTE_FALLBACK[index] ?? CHART_PALETTE_FALLBACK[0];
  if (alpha === undefined) {
    return base;
  }
  const numbers = base.match(/\d+/g)?.map(Number) ?? [0, 158, 115];
  const safeAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${numbers[0] ?? 0}, ${numbers[1] ?? 158}, ${numbers[2] ?? 115}, ${safeAlpha})`;
}

/**
 * 分类色板（固定 12 色）。读不到 token 的槽位由降级色板补齐 ⇒ 永远返回 12 个不同颜色。
 */
export function chartSeriesPalette(): string[] {
  const colors: string[] = [];
  for (const token of SERIES_TOKENS) {
    colors.push(chartColor(token));
  }
  return colors;
}

/**
 * 取第 `index` 条序列的颜色（越界按调色板长度取模，保证同一序列每次渲染颜色稳定）。
 */
export function chartSeriesColorAt(index: number): string {
  const palette = chartSeriesPalette();
  const safe = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return palette[safe % palette.length] ?? CHART_PALETTE_FALLBACK[0];
}

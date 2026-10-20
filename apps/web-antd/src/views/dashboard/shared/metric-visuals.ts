import './metric-visuals.css';

/**
 * 仪表盘指标卡的视觉常量（分析页 / 工作台共用一份，避免两处逐字重复后再漂移）。
 *
 * **为什么数值色要分亮/暗两档，而不是继续用渐变文字**：
 * 原实现把数值做 `background: linear-gradient(...) + -webkit-text-fill-color: transparent`
 * 的渐变裁切字，实测（WCAG 2.1 相对亮度口径）对白底卡片只有：
 *   在线率 `hsl(161 90% 43%)` = **2.01:1**、今日消息 `hsl(199 89% 48%)` = **2.86:1**，
 * 连「大文本 3:1」的底线都不到（详见 `review-20261020/04-uiux-visual.md` P1-1）。
 * 而且 `-webkit-text-fill-color: transparent` 在 Windows 高对比度 / `forced-colors`
 * 模式下会被强制成透明 —— 数字**整块消失**。
 * 所以数值改为实色：亮色档深、暗色档浅，各自对**对应模式的卡片底色** ≥4.5:1（正文标准，
 * 比大文本 3:1 更严），由 `metric-visuals.test.ts` 逐色回归，改色即被门禁咬住。
 *
 * **渐变仍保留在「图标块底 + 卡片光斑」上**：那是图形元素（非文字），判据是 WCAG 1.4.11
 * 的 3:1，因此只把渐变端点压暗到白色图标 ≥3:1 即可，视觉上仍是原来的四色语言。
 */

/** 指标卡 key（分析页与工作台同一套）。 */
export type MetricKey = 'alert' | 'device' | 'message' | 'online';

export interface MetricVisual {
  /** 图标块底与卡片光斑共用的装饰渐变；两端点对白色图标均 ≥3:1（图形对象标准）。 */
  grad: string;
  /** 光斑 / 图标投影色。 */
  glow: string;
  /** 数值文字色 —— 暗色模式（深底卡，浅色档）。 */
  textDark: string;
  /** 数值文字色 —— 亮色模式（白底卡，深色档）。 */
  textLight: string;
}

/**
 * 四张指标卡的视觉定义（蓝=设备 / 绿=在线率 / 青=消息 / 橙=告警）。
 *
 * 色相沿用界面原有语义（不是任意取色）：告警橙与告警中心的 warning 一致，
 * 在线率绿与设备在线态一致。改动 lightness 只为过对比度门槛。
 */
export const METRIC_VISUALS: Record<MetricKey, MetricVisual> = {
  device: {
    grad: 'linear-gradient(135deg, hsl(212 85% 38%), hsl(212 85% 30%))',
    glow: 'hsl(212 85% 38% / 30%)',
    textLight: 'hsl(212 90% 40%)',
    textDark: 'hsl(212 85% 64%)',
  },
  online: {
    grad: 'linear-gradient(135deg, hsl(161 85% 30%), hsl(199 85% 34%))',
    glow: 'hsl(161 85% 30% / 30%)',
    textLight: 'hsl(161 90% 26%)',
    textDark: 'hsl(161 85% 58%)',
  },
  message: {
    grad: 'linear-gradient(135deg, hsl(199 85% 34%), hsl(161 85% 30%))',
    glow: 'hsl(199 85% 34% / 30%)',
    textLight: 'hsl(199 90% 32%)',
    textDark: 'hsl(199 85% 58%)',
  },
  alert: {
    grad: 'linear-gradient(135deg, hsl(32 85% 34%), hsl(16 85% 38%))',
    glow: 'hsl(32 85% 34% / 30%)',
    textLight: 'hsl(32 90% 32%)',
    textDark: 'hsl(32 85% 58%)',
  },
};

/**
 * 页头关键计数（设备总量 / 在线 / 待处理告警）与页头「今日徽章」用的品牌文字色。
 * 与 `device` 卡同色，保持页头与指标卡的视觉连续性。
 */
export const BRAND_TEXT: Record<'dark' | 'light', string> = {
  dark: METRIC_VISUALS.device.textDark,
  light: METRIC_VISUALS.device.textLight,
};

/**
 * 指标卡所在卡片的底色（= design-tokens 的 `--card`），亮/暗各一个。
 *
 * 这两个值不是用来渲染的，而是把「≥4.5:1」这个承诺的**前提**写在常量旁边：
 * 对比度用例（`metric-visuals.test.ts`）拿它当基准。若日后改了
 * `packages/@core/base/design/src/design-tokens/{default,dark}.css` 的 `--card`，
 * 用例会失败并提醒重新配数值色 —— 这正是我们要的联动。
 */
export const METRIC_CARD_BG: Record<'dark' | 'light', string> = {
  dark: 'hsl(222.34 10.43% 12.27%)',
  light: 'hsl(0 0% 100%)',
};

/** 按当前主题取指标数值色。 */
export function metricTextColor(key: MetricKey, isDark: boolean): string {
  const visual = METRIC_VISUALS[key];
  return isDark ? visual.textDark : visual.textLight;
}

/** 按当前主题取页头品牌文字色。 */
export function brandTextColor(isDark: boolean): string {
  return isDark ? BRAND_TEXT.dark : BRAND_TEXT.light;
}

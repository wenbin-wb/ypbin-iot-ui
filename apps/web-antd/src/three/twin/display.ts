/**
 * 展示形态 → 渲染模式（**纯函数，可单测**；工单 #126）。
 *
 * ## 为什么需要这一层
 *
 * 修复前，`displayType`（`value` / `gauge` / `switch` / `color` / `sparkline`）在
 * 绑定编辑器里可选、能存库、能回显，但**渲染侧零消费** —— 五种形态渲染结果完全相同
 * （都是一个数字泡泡标签）。用户花时间配了「仪表盘」「开关」，界面照旧显示数字，
 * 会认为功能坏了。这比缺功能更伤信任（「配置项说谎」）。
 *
 * 本模块把「某个 displayType 在画布上究竟怎么画」这件事收口成一个可测的纯函数，
 * 让 `data.ts` 的选项、`anchor-layer` 的分支、以及本文件的映射**三者一一对应**
 * （由单测钉住，避免再次出现「UI 能选、渲染不认」）。
 *
 * ## 设计取舍：为什么只实现 3 种
 *
 * - `label`（`value`）：始终实现 —— 最基础形态；
 * - `switch`（开关）：实现 —— 二值属性（0/1）在运维场景极常见，且**信息密度高**
 *   （一眼看出通断），用纯 CSS 就能表达，无额外渲染成本；
 * - `color`（按值染色）：实现 —— 只需把数值映射到色阶，同样接近零成本；
 * - `gauge` / `sparkline`：**本版本不实现**，在 UI 上显式标注「暂不支持，按数值显示」。
 *   理由：仪表盘需要画弧线、迷你折线需要保留历史序列，二者都要额外的渲染资源与
 *   数据通路（历史序列当前只存在于 IoTDB，未接）。**宁可在 UI 上诚实标注，
 *   也不做「能选但不生效」的半截功能**。
 */

/** 画布上的实际渲染模式。 */
export type TwinRenderMode = 'color' | 'label' | 'switch';

/** 后端 `TwinDisplayType` 的全部取值（与 `emit`/DDL 一致）。 */
export const ALL_DISPLAY_TYPES = [
  'value',
  'gauge',
  'switch',
  'color',
  'sparkline',
] as const;

/** 后端展示形态码。 */
export type TwinDisplayTypeCode = (typeof ALL_DISPLAY_TYPES)[number];

/**
 * 本版本**已实现**渲染的展示形态。
 *
 * 与 {@link ALL_DISPLAY_TYPES} 的差集即「UI 上要标注暂不支持」的部分。
 */
export const SUPPORTED_DISPLAY_TYPES: TwinDisplayTypeCode[] = [
  'value',
  'switch',
  'color',
];

/**
 * 展示形态 → 渲染模式。
 *
 * 未实现的形态（`gauge` / `sparkline`）**回退到 `label`**：让用户至少能看到数值，
 * 而不是空白或报错。UI 侧另有「暂不支持」提示，两者配合才诚实。
 *
 * @param displayType 展示形态码（可为空：历史数据可能没有该字段）
 * @returns 渲染模式
 */
export function toRenderMode(
  displayType?: null | string | TwinDisplayTypeCode,
): TwinRenderMode {
  switch (displayType) {
    case 'color': {
      return 'color';
    }
    case 'switch': {
      return 'switch';
    }
    // value / gauge / sparkline / 未知值 / 空 ⇒ 统一按数值标签渲染
    default: {
      return 'label';
    }
  }
}

/**
 * 该展示形态在当前版本是否已真正生效。
 *
 * UI 用它决定是否显示「暂不支持」标记——**不要**用它静默隐藏选项：
 * 隐藏会让历史配置（已存库的 gauge）在编辑时无从发现。
 *
 * @param displayType 展示形态码
 * @returns 是否已实现渲染
 */
export function isDisplayTypeSupported(
  displayType?: null | string | TwinDisplayTypeCode,
): boolean {
  return (SUPPORTED_DISPLAY_TYPES as string[]).includes(displayType ?? '');
}

/**
 * 把属性值解释为「开/关」二态（供 `switch` 模式渲染）。
 *
 * 兼容后端可能返回的各种表示：`0/1`、`true/false`、`on/off`、`open/closed`。
 * 无法判定时返回 `undefined`（由调用方渲染为「--」，**不猜**）。
 *
 * @param value 原始值文本
 * @returns 二态；无法判定时为 undefined
 */
export function toSwitchState(value?: null | string): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  // 空串必须**先**判掉：`Number('')` 是 0，否则空值会被误判成「关」——
  // 那等于告诉运维「这台设备是关的」，而实际上我们根本不知道。
  if (normalized === '') {
    return undefined;
  }
  if (['1', 'on', 'open', 'opened', 'true'].includes(normalized)) {
    return true;
  }
  if (['0', 'close', 'closed', 'false', 'off'].includes(normalized)) {
    return false;
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    return numeric !== 0;
  }
  return undefined;
}

/**
 * 把数值映射为色阶（供 `color` 模式渲染）。
 *
 * 用属性的 `min`/`max`（物模型定义）做线性映射；缺任一端时返回 `undefined`，
 * 由调用方回落为「按在线状态着色」——**不做无依据的猜测**。
 *
 * @param value 原始值
 * @param min 下界（可空）
 * @param max 上界（可空）
 * @returns 0（下界）~ 1（上界）；无法映射时 undefined
 */
export function toColorRatio(
  value: null | number | string | undefined,
  min?: null | number | string,
  max?: null | number | string,
): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  const low = typeof min === 'number' ? min : Number(min);
  const high = typeof max === 'number' ? max : Number(max);
  if (
    !Number.isFinite(numeric) ||
    !Number.isFinite(low) ||
    !Number.isFinite(high)
  ) {
    return undefined;
  }
  if (high <= low) {
    return undefined;
  }
  return Math.min(1, Math.max(0, (numeric - low) / (high - low)));
}

/**
 * 色阶插值：0 → 绿（正常），0.5 → 黄（注意），1 → 红（越界）。
 *
 * @param ratio 0~1 的比例（见 {@link toColorRatio}）
 * @returns CSS 颜色串
 */
export function colorForRatio(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  // 两段线性插值：绿(34,197,94) → 黄(245,158,11) → 红(239,68,68)
  // 用元组类型而不是数组索引：避免非空断言，也让「三通道」由类型保证
  const from: readonly [number, number, number] =
    clamped < 0.5 ? [34, 197, 94] : [245, 158, 11];
  const to: readonly [number, number, number] =
    clamped < 0.5 ? [245, 158, 11] : [239, 68, 68];
  const t = clamped < 0.5 ? clamped * 2 : (clamped - 0.5) * 2;
  const channel = (index: 0 | 1 | 2): number =>
    Math.round(from[index] + (to[index] - from[index]) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

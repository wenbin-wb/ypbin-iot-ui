/**
 * 数字展示小工具（dashboard 等**中性**层使用；不依赖 iot 视图）。
 *
 * 现存唯一函数是 `formatCompact`：把大数字压成 `1.2K` / `3.40M` 这类紧凑文案。
 * 抽出来的原因（审查 05 §4.1 剩余项）：`dashboard/analytics/index.vue` 与
 * `dashboard/workspace/index.vue` 各有一份**逐字相同**的实现，改口径要改两处、
 * 且两页很可能漂移成 `K/M` 与小写 `k/m` 混用。
 */

/** 「千」的阈值（`1_000`）。 */
const THOUSAND = 1000;

/** 「百万」的阈值（`1_000_000`）。 */
const MILLION = 1_000_000;

/** 千位压缩时保留的小数位。 */
const K_DIGITS = 1;

/** 百万位压缩时保留的小数位。 */
const M_DIGITS = 2;

/**
 * 空值占位。
 *
 * 与 `views/iot/shared/display.ts` 的 `EMPTY_TEXT` **同口径**（都是 `-`），
 * 但 `src/utils` 是中性层，不反向依赖 `views/iot`，故在此单独声明。
 * 两处如需同时改口径，改 `EMPTY_TEXT` 时同步改这里（展示层只有一个可见字符，风险可控）。
 */
const EMPTY_PLACEHOLDER = '-';

/**
 * 大数字紧凑展示：`1_234` → `1.2K`；`1_234_567` → `1.23M`。
 *
 * 口径（与抽出前的两份实现一致，避免两页展示漂移）：
 * - `>= 1_000_000`：`(n / 1_000_000).toFixed(2)` + `M`；
 * - `>= 1_000`：`(n / 1_000).toFixed(1)` + `K`；
 * - 其余按原样字符串（含小数、负数小值）；
 * - **负数**：按绝对值压缩后保留负号（`-1_500_000` → `-1.50M`）。抽出前两份实现
 *   会把大负数原样输出 `-1500000`（不压缩），口径不一致；当前调用点（设备数/消息数/
 *   待处理告警数）均为非负数，此处理属**预防性口径**，已在边界用例里锁定；
 * - `null` / `undefined` / 非有限数（NaN/Infinity）⇒ `-`（空值占位，不显示 `NaN`）。
 *
 * 已知边界（保持原口径不修，避免两页视觉变化）：`999_999` → `1000.0K`
 * （先算比例再四舍五入会进位到 1000.0；要修需同时调整两页展示预期，属独立变更）。
 */
export function formatCompact(value?: null | number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_PLACEHOLDER;
  }
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude >= MILLION) {
    return `${sign}${(magnitude / MILLION).toFixed(M_DIGITS)}M`;
  }
  if (magnitude >= THOUSAND) {
    return `${sign}${(magnitude / THOUSAND).toFixed(K_DIGITS)}K`;
  }
  return String(value);
}

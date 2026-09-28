/**
 * 告警页表格高度的「无自增长」契约（纯函数 + 具名常量，零依赖 ⇒ 用例可本机直跑）。
 *
 * 🔴 修过什么（2026-10 生产实测）：告警列表页**行数恒为 2，表体却持续增高**。
 *
 * 机制（vxe-table 4.20.6 源码为证）：
 * - `gridOptions.height: 'auto'` ⇒ 网格根元素 `height: 100%`（`grid.js` `computeStyles`），
 *   表体高度 = `getParentHeight()` = **父元素当前渲染高度** − 排除项（form/toolbar/pager/内边距）
 *   （`grid.js:1508`，`table.js:1470-1486/3310`）。
 * - 表格 `autoResize`（默认开）用 ResizeObserver 同时观察**表格自身**与**网格根的父元素**
 *   （`table.js:14617-14630`，`getParentElem` 取网格根 parentNode），尺寸一变就重算并**回写**
 *   表体 px 高度（`handleResizeEvent → handleLazyRecalculate → updateStyle`）。
 * - 与本仓正常页（设备台账等）的差异：那些页的表格壳 `h-full` 的父级是
 *   `Page auto-content-height` 的**确定高度**内容区；而告警页中间多了 antd `Tabs` ——
 *   `.ant-tabs-tabpane` 是 `flex:none; width:100%`（**高度 = 内容**），把确定高度链打断成
 *   「内容高度反推」链：父元素高度 ← 表格内容高度 ← 表体 px 高度 ← 父元素高度。
 *   于是观测回调每次「量父 → 写体」，写体又改父的渲染高度 → 自反馈。
 *
 * 🔧 修复 = 恢复确定高度链（与正常页同构）：`Tabs` 根 `h-full` 占满 Page 内容区，
 * tabpane 定高且为列 flex，两个表格壳 `flex-1 min-h-0` 吃剩余高度 ⇒ 表体高度只依赖
 * **外部确定高度**这一个输入，与自身/内容解耦，观测回调收敛。
 * 兜底：若未来某浏览器/某改动再引入自反馈，`detectRunawayGrowth` 连续 N 次增长超标
 * ⇒ 页面回退固定上限（见 `index.vue` 的看门狗，具名常量可配）。
 */

/** 表格高度模式：与设备台账一致 —— vxe 按父容器「确定高度」填满，不写死 px、不回填自身高度。 */
export const ALERTS_LAYOUT = {
  gridHeightMode: 'auto' as const,

  /** 恢复确定高度链所必需的样式标记（缺失即回归，`alerts-layout.test.ts` 读 SFC 断言）。 */
  requiredTabClass: 'h-full',
  requiredGridClasses: ['flex-1', 'min-h-0'] as const,
  requiredDeepRules: [
    ':deep(.ant-tabs-content) { height: 100%; }',
    ':deep(.ant-tabs-tabpane) { display: flex; flex-direction: column; height: 100%; overflow: hidden; }',
  ] as const,
} as const;

/**
 * 看门狗常量（「连续 N 次增长异常 ⇒ 回退固定值」的 N 与阈值，可配）。
 */
export const RUNAWAY_HEIGHT = {
  /** 表格渲染高度比视口可用高度大出该 px 即视为「异常高」 */
  excessPx: 32,
  /** 连续几个采样点都「异常高 + 严格递增」才判定失控（防抖动误杀） */
  requiredConsecutive: 6,
  /** 看门狗采样间隔 */
  intervalMs: 700,
  /** 高度变化小于该 px 视为稳定（看门狗提前收工） */
  stableDeltaPx: 2,
} as const;

export interface GridBodyHeightInput {
  /** 父容器确定高度（最终来自 `Page auto-content-height` 的内容区） */
  viewportHeightPx: number;
  /** form/toolbar/pager/内边距等排除项 */
  excludePx: number;
  headerPx: number;
  footerPx: number;
}

/**
 * 表体高度 = 外部确定高度 − 固定排除项 − 表头 − 表尾。
 *
 * 🔴 无自增长路径的证据（用例断言）：
 * 1. 入参里**没有**「行数」「上一次自身高度」这类会随内容/前一轮变化的值 ⇒ 输出只由外部输入决定；
 * 2. 1-Lipschitz（|f(a)−f(b)| ≤ |a−b|）：高度输入跑多高，输出**至多**跟着跑多高，绝不放大
 *    ⇒ 不存在「高度 → 高度」的正反馈放大；
 * 3. 输出恒 ≤ 输入的确定高度（有界）。
 */
export function resolveGridBodyHeight(input: GridBodyHeightInput): number {
  const { viewportHeightPx, excludePx, headerPx, footerPx } = input;
  return Math.max(
    0,
    Math.floor(viewportHeightPx - excludePx - headerPx - footerPx),
  );
}

export interface RunawayOptions {
  /** 视为「异常高」的门槛：采样高度必须大于该 px */
  thresholdPx: number;
  /** 连续多少个采样点都命中才判定失控 */
  requiredConsecutive: number;
}

/**
 * 自反馈环判据（纯函数）：最近 N 个采样点**全部**超过门槛且**严格递增**。
 *
 * 为什么是「递增」：自反馈环（量父 → 写体 → 父更高）的签名是单调持续增长；
 * 而正常固定高度链在采样误差内只会抖动（含持平/回落）⇒ 不会误杀。
 */
export function detectRunawayGrowth(
  samples: readonly number[],
  options: RunawayOptions,
): boolean {
  const { thresholdPx, requiredConsecutive } = options;
  if (samples.length < requiredConsecutive) {
    return false;
  }
  const tail = samples.slice(-requiredConsecutive);
  for (let i = 1; i < tail.length; i += 1) {
    const prev = tail[i - 1];
    const curr = tail[i];
    if (prev === undefined || curr === undefined || curr <= prev) {
      return false;
    }
  }
  return tail.every((heightPx) => heightPx > thresholdPx);
}

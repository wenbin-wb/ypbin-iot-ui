import { getCurrentScope, onScopeDispose, watch } from 'vue';

import { preferences, usePreferences } from '@vben/preferences';

/**
 * 主题（暗色 / 主题色）变化后，**让已经画好的 ECharts 图重绘**。
 *
 * ## 为什么 canvas 必须手动重绘
 *
 * ECharts 用 CanvasRenderer 把颜色**烤进位图**：`option` 里的 `color`/`lineStyle.color`
 * 是渲染那一刻的字符串常量，画完就与 DOM 无关了。而本项目的图表色来自
 * `#/utils/chart-tokens`（运行时 `getComputedStyle` 读 `--chart-*` / 语义 token），
 * 切主题只会更新 `:root` 上的 CSS 变量 —— **已经绘制过的 canvas 不会自己重算**，
 * 于是同一屏幕上「已渲染的图是旧色、新渲染的图是新色」。
 *
 * 为什么不能只靠 `useEcharts` 自带的 `watch([isDark, isActiveRef])`：
 * 它确实会在 `isDark` 变化时 `dispose → init → renderEcharts(cacheOptions)`，
 * 但重放的是**缓存下来的旧 option**，颜色仍是切换前 `getComputedStyle` 的读数 ⇒ 依旧旧色；
 * 而**主题色（`preferences.theme.colorPrimary`）变化时它完全不监听**，连重放都没有。
 * 所以正确做法是：主题变化后**用当前数据重建 option**再 `setOption`。
 *
 * ## 为什么监听这两个源
 *
 * - `usePreferences().isDark`：暗色与否决定 `design-tokens/{default,dark}.css` 里整套变量的取值，
 *   是「配色换了一整套」的总开关；
 * - `preferences.theme.colorPrimary`：内置主题/自定义主色只改这一项，但会连带重新生成
 *   `--primary-*` 色阶（`updateCSSVariables`），而 `--chart-*` 与语义色都按它派生；
 *   只监听 isDark 会漏掉「亮色主题之间换色」这一半场景。
 *
 * 其余偏好（语言、字号、紧凑度、圆角）不会改变色值，监听它们只会白重绘。
 *
 * ## 时序：为什么 `flush: 'post'`
 *
 * `@vben/preferences` 自己的 watcher 是默认 flush（'pre'），它负责把新变量写进 `:root`；
 * 我们用 'post' 排在它之后，回调里 `getComputedStyle` 才能读到**新值**。
 * 若改成同步/'pre'，会读到上一套色值 —— 看起来「重绘了但没生效」，比不重绘更难查。
 *
 * ## 用法
 *
 * ```ts
 * function renderCurrent(): void {
 *   renderEcharts(buildOption(props.points)); // 每次重建 option，颜色才会重新解析
 * }
 * onMounted(renderCurrent);
 * watch(() => props.points, renderCurrent, { deep: true, flush: 'post' });
 * useChartThemeRefresh(renderCurrent);        // ← 主题变化也走同一条渲染路径
 * ```
 *
 * 返回 `stop`：调用方可提前取消；组件卸载时由 `onScopeDispose` 自动停止
 * （同一组件重复调用不会留下悬挂 watcher）。
 */
export function useChartThemeRefresh(render: () => void): () => void {
  const { isDark } = usePreferences();

  const stop = watch(
    // 数组 watch 会分别追踪两个源：任一变化都触发一次（同一个 tick 内合并成一次回调）
    [isDark, () => preferences.theme.colorPrimary],
    () => {
      render();
    },
    { flush: 'post' },
  );

  // 在组件 scope 内调用时自动清理；在非 scope 环境（脚本/测试探针）里由调用方持 stop 自行处理
  if (getCurrentScope()) {
    onScopeDispose(stop);
  }

  return stop;
}

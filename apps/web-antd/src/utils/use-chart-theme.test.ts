/**
 * `useChartThemeRefresh` 的用例：**主题变化必须重新渲染，卸载后必须停**。
 *
 * 为什么需要这组用例：图表色是运行时从 CSS 变量读出来的（`chart-tokens.ts`），
 * 而 ECharts 把颜色烤进 canvas 位图 —— 切暗色/换主题色后旧图不会自己重算。
 * 这个 bug **在 happy-dom 里看不出来**（没有真实 canvas），只能断言「渲染函数被再次调用」：
 * 1. `isDark` 变化 ⇒ 再调一次（否则切暗色后已画的图还是亮色）；
 * 2. `preferences.theme.colorPrimary` 变化 ⇒ 再调一次（否则换主题色后图不变）；
 * 3. 同一 tick 内两个源都变 ⇒ 只重绘一次（不该重复 setOption）；
 * 4. 卸载之后不再调用（watcher 必须随 scope 清掉，否则组件销毁后仍会摸 chartRef）；
 * 5. 无关偏好（语言）变化**不**触发重绘（避免白重绘）。
 */
import { createApp, defineComponent, h, nextTick } from 'vue';

import type { Mock } from 'vitest';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChartThemeRefresh } from './use-chart-theme';

/**
 * 假的偏好状态：`isDark` 是只读 ref，`preferences` 是响应式对象。
 * 用真实响应式而不是 vi.fn()，才能验证「watch 真的追踪到了这两个源」。
 */
const prefs = vi.hoisted(() => {
  return {
    isDarkRef: null as any,
    preferencesState: null as any,
  };
});

vi.mock('@vben/preferences', async () => {
  const { reactive, ref } = await import('vue');
  const isDark = ref(false);
  const preferences = reactive({
    app: { locale: 'zh-CN' },
    theme: { colorPrimary: 'hsl(212 100% 45%)', mode: 'light' },
  });
  prefs.isDarkRef = isDark;
  prefs.preferencesState = preferences;
  return {
    preferences,
    updatePreferences: () => {},
    usePreferences: () => ({ isDark }),
  };
});

function mountProbe(render: () => void) {
  const Probe = defineComponent({
    name: 'ChartThemeProbe',
    setup() {
      useChartThemeRefresh(render);
      return () => h('div');
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp(Probe);
  app.mount(container);
  return app;
}

let mounted: ReturnType<typeof createApp> | undefined;
let render: Mock<() => void>;

beforeEach(() => {
  render = vi.fn(() => {});
  // 每个用例都从干净状态开始（mock 模块是模块级单例）
  prefs.isDarkRef.value = false;
  prefs.preferencesState.theme.colorPrimary = 'hsl(212 100% 45%)';
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

/** 让 watch 的 post 回调跑完。 */
async function flush() {
  await nextTick();
  await nextTick();
}

describe('useChartThemeRefresh', () => {
  it('挂载时不主动重绘（首帧由组件自己的 onMounted 负责，避免重复 setOption）', async () => {
    mounted = mountProbe(render);
    await flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('isDark 变化 ⇒ 重绘一次', async () => {
    mounted = mountProbe(render);
    await flush();

    prefs.isDarkRef.value = true;
    await flush();
    expect(render).toHaveBeenCalledTimes(1);

    prefs.isDarkRef.value = false;
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('主题色（preferences.theme.colorPrimary）变化 ⇒ 重绘一次', async () => {
    mounted = mountProbe(render);
    await flush();

    prefs.preferencesState.theme.colorPrimary = 'hsl(160 84% 39%)';
    await flush();
    expect(render).toHaveBeenCalledTimes(1);

    prefs.preferencesState.theme.colorPrimary = 'hsl(280 84% 50%)';
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('同一 tick 内 isDark 与主题色同时变 ⇒ 合并为一次重绘', async () => {
    mounted = mountProbe(render);
    await flush();

    prefs.isDarkRef.value = true;
    prefs.preferencesState.theme.colorPrimary = 'hsl(160 84% 39%)';
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('与配色无关的偏好（locale）变化不触发重绘', async () => {
    mounted = mountProbe(render);
    await flush();

    prefs.preferencesState.app.locale = 'en-US';
    await flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('卸载后不再重绘（watcher 随 scope 清理，不会摸已销毁的 chartRef）', async () => {
    mounted = mountProbe(render);
    await flush();

    mounted.unmount();
    mounted = undefined;

    prefs.isDarkRef.value = true;
    prefs.preferencesState.theme.colorPrimary = 'hsl(160 84% 39%)';
    await flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('返回的 stop 可提前取消（调用方主动解绑的场景）', async () => {
    const Probe = defineComponent({
      name: 'ChartThemeProbeStop',
      setup() {
        const stop = useChartThemeRefresh(render);
        stop();
        return () => h('div');
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    mounted = createApp(Probe);
    mounted.mount(container);
    await flush();

    prefs.isDarkRef.value = true;
    await flush();
    expect(render).not.toHaveBeenCalled();
  });
});

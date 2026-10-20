import { createApp, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import AnalyticsPage from './index.vue';

/**
 * 分析页运行时冒烟用例（与 workspace/index.test.ts 同口径）。
 *
 * 真实数据形态下：页头徽章与「新手快速上手」卡片必须渲染出来，帮助入口能打开共享抽屉；
 * 图表子组件走空态由 empty-state.test.ts 覆盖，这里只验证页面编排没断线。
 */
const { drawerApis, pushMock } = vi.hoisted(() => ({
  drawerApis: [] as Record<string, ReturnType<typeof vi.fn>>[],
  pushMock: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@vben/preferences', async () => {
  const { reactive, ref } = await import('vue');
  return {
    preferences: reactive({
      app: { accessMode: 'frontend', locale: 'zh-CN' },
      // 图表主题重绘（use-chart-theme.ts）监听 `theme.colorPrimary`，mock 必须按真实契约给上
      theme: { colorPrimary: 'hsl(212 100% 45%)', mode: 'light' },
    }),
    // 页面用 isDark 选指标卡数值色（亮/暗两档，均 >=4.5:1），这里固定亮色主题
    usePreferences: () => ({ isDark: ref(false) }),
    updatePreferences: () => {},
  };
});

vi.mock('@vben/plugins/echarts', async () => {
  const { defineComponent, h } = await import('vue');
  const EchartsUI = defineComponent({
    name: 'EchartsUIStub',
    setup: () => () => h('div', { class: 'echarts-stub' }),
  });
  return {
    EchartsUI,
    useEcharts: () => ({
      isActive: { value: false },
      renderEcharts: () => Promise.resolve(null),
    }),
  };
});

vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const SlotStub = (name: string) =>
    defineComponent({
      name,
      setup:
        (_props, { slots }) =>
        () =>
          h('div', [slots.default?.()]),
    });
  // 卡片要渲染 title（新增「告警最多的规则」卡片标题要能被断言到）
  const CardStub = defineComponent({
    name: 'AnalysisChartCard',
    props: { title: { default: '', type: String } },
    setup(props, { slots }) {
      return () => h('div', [h('h3', props.title), slots.default?.()]);
    },
  });
  // 页签要渲染 tabs 文案，并展开 4 个具名 slot（新增告警趋势/设备增长）
  const TabsStub = defineComponent({
    name: 'AnalysisChartsTabs',
    props: { tabs: { default: () => [], type: Array } },
    setup(props, { slots }) {
      return () =>
        h('div', [
          ...((props.tabs as { label: string }[]) ?? []).map((tab) =>
            h('span', { class: 'tab-label' }, tab.label),
          ),
          slots.default?.(),
          slots.trends?.(),
          slots.visits?.(),
          slots.alertTrends?.(),
          slots.growth?.(),
        ]);
    },
  });
  return {
    AnalysisChartCard: CardStub,
    AnalysisChartsTabs: TabsStub,
    useVbenDrawer: () => {
      const api = { close: vi.fn(), open: vi.fn(), setState: vi.fn() };
      drawerApis.push(api);
      return [SlotStub('DrawerStub'), api];
    },
  };
});

vi.mock('../shared/use-iot-overview', async () => {
  const { ref } = await import('vue');
  const overview = ref({
    alertPending: 3,
    alertResolvedToday: 1,
    alertRuleTop: [{ name: '电流超上限', value: 9 }],
    alertToday: 5,
    alertTrend: [{ critical: 1, date: '2026-10-14', info: 2, warning: 1 }],
    deviceDisabled: 1,
    deviceGrowthTrend: [{ added: 4, date: '2026-10-14' }],
    deviceOffline: 3,
    deviceOnline: 7,
    deviceTotal: 42,
    messageDownlinkToday: 200,
    messageToday: 1280,
    messageTrend: [],
    messageUplinkToday: 1080,
    newDevicesWeek: 3,
    onlineRate: 70,
    onlineTrend: [],
    pointTotal: 10,
    productTop: [],
    productTotal: 2,
    protocolDistribution: [],
    recentAlerts: [],
    severityDistribution: [],
  });
  return {
    // 返回契约必须与真实 composable 对齐（含 failed / demoReason）：
    // 页面据此渲染常驻失败态与「演示数据」提示，mock 少字段会让这两块永远测不到
    useIotOverview: () => ({
      demoReason: '演示原因',
      failed: false,
      load: () => {},
      // 页面渲染「演示数据」常驻提示（usingDemo=true 时 notice 非空）
      notice: {
        error: 'page.dashboard.overviewLoadFailedHint',
        title: 'page.dashboard.demoModeTitle',
        type: 'warning' as const,
      },
      loading: false,
      overview,
      usingDemo: true,
    }),
  };
});

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let app: ReturnType<typeof createApp> | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
  drawerApis.length = 0;
  pushMock.mockReset();
});

describe('分析页', () => {
  it('页头徽章与新手卡片渲染，帮助入口能打开共享抽屉', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    app = createApp({ render: () => h(AnalyticsPage) });
    app.mount(container);
    await nextTick();

    const text = container.textContent ?? '';
    expect(text).toContain('新手快速上手');
    expect(text).toContain('演示数据');
    expect(text).toContain('42');
    expect(text).not.toContain('overview ?');
    // 新增：两个趋势页签 + TOP 规则卡片（标题与规则名都要真的渲染出来）
    expect(text).toContain('告警趋势');
    expect(text).toContain('设备增长');
    expect(text).toContain('告警最多的规则');
    expect(text).toContain('电流超上限');

    const helpButton = [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.includes('术语看不懂？打开帮助'),
    );
    expect(helpButton, '未找到术语帮助入口').toBeTruthy();
    helpButton?.click();
    expect(drawerApis[0]?.open).toHaveBeenCalledTimes(1);
  });
});

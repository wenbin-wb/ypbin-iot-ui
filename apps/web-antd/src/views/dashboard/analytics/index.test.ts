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

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

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
          h('div', [slots.default?.(), slots.trends?.(), slots.visits?.()]),
    });
  return {
    AnalysisChartCard: SlotStub('AnalysisChartCard'),
    AnalysisChartsTabs: SlotStub('AnalysisChartsTabs'),
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
    alertToday: 5,
    deviceDisabled: 1,
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
    useIotOverview: () => ({
      failed: false,
      load: () => {},
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

    const helpButton = [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.includes('术语看不懂？打开帮助'),
    );
    expect(helpButton, '未找到术语帮助入口').toBeTruthy();
    helpButton?.click();
    expect(drawerApis[0]?.open).toHaveBeenCalledTimes(1);
  });
});

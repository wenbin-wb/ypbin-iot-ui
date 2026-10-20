import { createApp, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import AnalyticsAlertTrend from './analytics-alert-trend.vue';
import AnalyticsDeviceGrowth from './analytics-device-growth.vue';
import AnalyticsTrends from './analytics-trends.vue';
import AnalyticsVisitsData from './analytics-visits-data.vue';
import AnalyticsVisitsSales from './analytics-visits-sales.vue';
import AnalyticsVisitsSource from './analytics-visits-source.vue';
import AnalyticsVisits from './analytics-visits.vue';
import BoardWidgetCard from './board/board-widget-card.vue';
import { createBoardWidgetRuntime } from './board/board-utils';

/**
 * **主题变化 ⇒ 图表重绘**的组件级回归（10 个 ECharts 渲染点一次覆盖）。
 *
 * ## 为什么需要这组用例
 *
 * 图表色由 `#/utils/chart-tokens` 在**渲染时**用 `getComputedStyle` 从 CSS 变量读出，
 * 而 ECharts 把颜色烤进 canvas 位图：切暗色 / 换主题色后 `:root` 变量变了，
 * **已画好的图不会自己重算**。`useEcharts` 自带的 `watch(isDark)` 只会
 * `dispose → init → 重放缓存 option`，颜色仍是切换前的读数。
 * 于是症状是「新图新色、旧图旧色」同屏共存 —— 渲染层测不出来，只能断言
 * 「主题变化后 `renderEcharts` 被再次调用」。
 *
 * ## 为什么集中在一个文件里
 *
 * 这 10 个渲染点是**同一套接线**（`useChartThemeRefresh(renderCurrent)`），
 * 集中后一份 mock（echarts / preferences / 3 个 API）就能覆盖全部，
 * 不必在 10 个组件旁边各复制一份 setup；将来新增图表组件只要往下面的 `CHART_CASES`
 * 加一行，漏接主题重绘会立刻红。
 *
 * 每个用例都断言两件事：
 * 1. **挂载后已渲染**（首帧基线，防止「本来就没画」导致假绿）；
 * 2. **切暗色后 `renderEcharts` 调用数增加**（真的重绘，且重绘时重建了 option）。
 */
const { chartOptions, theme } = vi.hoisted(() => ({
  chartOptions: [] as Record<string, any>[],
  theme: {
    isDark: null as any,
    preferences: null as any,
    rerender: () => {},
  },
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
      renderEcharts: (options: Record<string, any>) => {
        chartOptions.push(options);
        return Promise.resolve(null);
      },
    }),
  };
});

vi.mock('@vben/preferences', async () => {
  const { reactive, ref } = await import('vue');
  const isDark = ref(false);
  const preferences = reactive({
    app: { accessMode: 'frontend', locale: 'zh-CN' },
    theme: { colorPrimary: 'hsl(212 100% 45%)', mode: 'light' },
  });
  theme.isDark = isDark;
  theme.preferences = preferences;
  return {
    preferences,
    updatePreferences: () => {},
    usePreferences: () => ({ isDark }),
  };
});

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getAccessOverview: vi.fn(),
    getTenantLedgerList: vi.fn(),
    getTenantList: vi.fn(),
  },
}));

vi.mock('#/api/iot/accessOverview', () => ({
  getAccessOverview: (...args: unknown[]) => mockApi.getAccessOverview(...args),
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    getTenantLedgerList: (...args: unknown[]) =>
      mockApi.getTenantLedgerList(...args),
  };
});

vi.mock('#/api/system/tenant', () => ({
  getTenantList: (...args: unknown[]) => mockApi.getTenantList(...args),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: ReturnType<typeof createApp> | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  chartOptions.length = 0;
  document.body.innerHTML = '';
});

/** 等 onMounted / watch(flush post) / async renderChart 全部落定。 */
async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountComponent(
  component: unknown,
  props: Record<string, unknown> = {},
) {
  document.body.innerHTML = '';
  chartOptions.length = 0;
  const container = document.createElement('div');
  document.body.append(container);
  mounted = createApp({ render: () => h(component as never, props) });
  mounted.mount(container);
  await flush();
  return container;
}

function lastOption(): Record<string, any> | undefined {
  return chartOptions.at(-1);
}

const TREND_POINTS = [
  { date: '2026-10-01', downlink: 1, uplink: 2 },
  { date: '2026-10-02', downlink: 2, uplink: 3 },
];

const ONLINE_POINTS = [
  { date: '2026-10-01', offline: 1, online: 9 },
  { date: '2026-10-02', offline: 2, online: 8 },
];

const ALERT_POINTS = [
  { critical: 1, date: '2026-10-01', info: 1, warning: 1 },
  { critical: 2, date: '2026-10-02', info: 2, warning: 2 },
];

const GROWTH_POINTS = [
  { added: 1, date: '2026-10-01' },
  { added: 2, date: '2026-10-02' },
];

const NAME_VALUES = [
  { name: 'mqtt', value: 3 },
  { name: 'modbus', value: 2 },
];

const SEVERITY_VALUES = [
  { name: 'critical', value: 2 },
  { name: 'warning', value: 1 },
];

/** 10 个渲染点：名字 → 组件 + 让首帧就能画图的最小 props。 */
const CHART_CASES: Array<{
  name: string;
  component: unknown;
  props: Record<string, unknown>;
  /** 可选的「首帧就已渲染」断言口径（默认 chartOptions.length > 0）。 */
  rendered?: () => boolean;
}> = [
  {
    component: AnalyticsTrends,
    name: '分析页·消息趋势',
    props: { points: TREND_POINTS },
  },
  {
    component: AnalyticsVisits,
    name: '分析页·在线趋势',
    props: { points: ONLINE_POINTS },
  },
  {
    component: AnalyticsAlertTrend,
    name: '分析页·告警趋势',
    props: { points: ALERT_POINTS },
  },
  {
    component: AnalyticsDeviceGrowth,
    name: '分析页·设备增长',
    props: { points: GROWTH_POINTS },
  },
  {
    component: AnalyticsVisitsData,
    name: '分析页·协议分布',
    props: { items: NAME_VALUES },
  },
  {
    component: AnalyticsVisitsSource,
    name: '分析页·告警级别分布',
    props: { items: SEVERITY_VALUES },
  },
  {
    component: AnalyticsVisitsSales,
    name: '分析页·产品设备数 TOP',
    props: { items: NAME_VALUES },
  },
  {
    component: BoardWidgetCard,
    name: '看板·仪表盘组件',
    props: {
      device: { deviceName: '演示设备', id: '9300012' },
      index: 0,
      runtime: {
        ...createBoardWidgetRuntime(),
        gaugeMax: 100,
        latest: {
          propertyId: 'temperature',
          quality: 'GOOD',
          ts: 1_790_400_000_000,
          value: '42',
        },
        loaded: true,
      },
      total: 1,
      widget: {
        deviceId: '9300012',
        id: 'w1',
        propertyId: 'temperature',
        title: '车间温度',
        type: 'gauge',
      },
    },
  },
];

describe('主题变化 ⇒ 图表重绘（canvas 不会自己重算颜色）', () => {
  for (const item of CHART_CASES) {
    it(`${item.name}：切暗色后再次渲染`, async () => {
      theme.isDark.value = false;
      await mountComponent(item.component, item.props);
      const baseline = chartOptions.length;
      expect(baseline, '首帧未渲染，用例前提不成立').toBeGreaterThan(0);

      theme.isDark.value = true;
      await flush();
      expect(
        chartOptions.length,
        `${item.name} 在暗色切换后没有重绘（canvas 会保留旧色）`,
      ).toBeGreaterThan(baseline);
    });
  }

  it('主题色变化（未切暗色）同样触发重绘', async () => {
    theme.isDark.value = false;
    await mountComponent(AnalyticsTrends, { points: TREND_POINTS });
    const baseline = chartOptions.length;
    expect(baseline).toBeGreaterThan(0);

    theme.preferences.theme.colorPrimary = 'hsl(160 84% 39%)';
    await flush();
    expect(chartOptions.length).toBeGreaterThan(baseline);
  });

  it('重绘用的是最新 props（不是缓存 option）', async () => {
    theme.isDark.value = false;
    const container = await mountComponent(AnalyticsTrends, {
      points: TREND_POINTS,
    });
    const before = lastOption();

    theme.isDark.value = true;
    await flush();
    expect(chartOptions.length).toBeGreaterThan(0);
    expect(lastOption()).not.toBe(before);
    // 重建 option 的证据：x 轴分类数与当前 props 一致
    expect((lastOption()?.xAxis as Record<string, any>)?.data).toEqual(
      TREND_POINTS.map((point) => point.date),
    );
    expect(container.querySelector('.echarts-stub')).toBeTruthy();
  });
});

// ===== 另外两个不在 dashboard 目录的渲染点（series-chart / 接入拓扑）=====
describe('设备历史曲线 + 租户接入拓扑：切暗色后再次渲染', () => {
  it('series-chart：model 渲染后切暗色会重绘', async () => {
    const { default: SeriesChart } = await import(
      '#/views/iot/devices/modules/series-chart.vue'
    );
    theme.isDark.value = false;
    await mountComponent(SeriesChart, {
      model: [
        {
          color: 'rgb(1, 2, 3)',
          data: [20, 21],
          name: '温度（℃）',
          propertyId: 'temperature',
          showSymbol: true,
          timestamps: [1_790_400_000_000, 1_790_400_001_000],
          yAxisIndex: 0,
        },
      ],
      units: ['℃'],
    });
    const baseline = chartOptions.length;
    expect(baseline, '首帧未渲染').toBeGreaterThan(0);

    theme.isDark.value = true;
    await flush();
    expect(chartOptions.length).toBeGreaterThan(baseline);
  });

  it('access-topology：拓扑渲染后切暗色会重绘', async () => {
    // eslint-disable-next-line unicorn/no-await-expression-member
    const { default: AccessTopology } = await import(
      '#/views/iot/tenant-ledger/modules/access-topology.vue'
    );
    mockApi.getAccessOverview.mockResolvedValue({
      metrics: {
        egressPendingCount: 0,
        nodeFencedCount: 0,
        reconcileDeferredCount: 0,
        renewFailureCount: 0,
        reported: true,
        reportLagMs: 1200,
        selfFencedCount: 0,
        specLoadDurationMaxMs: 2,
        tickDurationMaxMs: 3,
      },
      nodes: [
        {
          accessNode: 'access-a',
          holdingCount: 2,
          leaseAlive: true,
          leaseRemainingSec: 30,
          maxTenants: 5,
        },
      ],
    });
    mockApi.getTenantLedgerList.mockResolvedValue([
      { assignable: true, deviceCount: 5, tenantId: 't1' },
    ]);
    mockApi.getTenantList.mockResolvedValue([
      { code: 't1', id: 't1', name: '租户甲' },
    ]);

    theme.isDark.value = false;
    await mountComponent(AccessTopology);
    const baseline = chartOptions.length;
    expect(baseline, '首帧未渲染（拓扑数据未就绪）').toBeGreaterThan(0);

    theme.isDark.value = true;
    await flush();
    expect(chartOptions.length).toBeGreaterThan(baseline);
  });
});
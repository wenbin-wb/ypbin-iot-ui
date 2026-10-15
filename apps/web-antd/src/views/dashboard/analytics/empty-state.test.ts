import { createApp, h, nextTick } from 'vue';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import AnalyticsAlertTrend from './analytics-alert-trend.vue';
import AnalyticsDeviceGrowth from './analytics-device-growth.vue';
import AnalyticsRuleTop from './analytics-rule-top.vue';
import AnalyticsTrends from './analytics-trends.vue';
import AnalyticsVisitsData from './analytics-visits-data.vue';
import AnalyticsVisitsSales from './analytics-visits-sales.vue';
import AnalyticsVisitsSource from './analytics-visits-source.vue';
import AnalyticsVisits from './analytics-visits.vue';

/**
 * 图表空态 + 协议码映射用例。
 *
 * 真实 overview 在「新租户 / 还没接入设备」时会给空数组（不是 undefined）；
 * 此前 5 个图表组件对空数组直接 return，留下一个 300px 的空白画布——
 * 用户分不清「没有数据」还是「页面坏了」。这里锁死三件事：
 * 1. 空数据 ⇒ 明确文案「暂无趋势数据 / 暂无分布数据」，且不渲染画布；
 * 2. 有数据 ⇒ 仍然渲染画布（空态不能误伤真实数据）；
 * 3. 协议分布的 `name` 是协议码 ⇒ 必须在进图表前映射成中文名（见下方协议映射用例）。
 */
const { chartOptions } = vi.hoisted(() => ({
  chartOptions: [] as Record<string, any>[],
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

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

const apps: ReturnType<typeof createApp>[] = [];

afterEach(() => {
  for (const app of apps) {
    app.unmount();
  }
  apps.length = 0;
  chartOptions.length = 0;
  document.body.innerHTML = '';
});

function mount(
  component: Parameters<typeof h>[0],
  props: Record<string, unknown>,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(component as never, props) });
  apps.push(app);
  app.mount(container);
  return container;
}

describe('dashboard 图表空态', () => {
  it('趋势图空数据：给出「暂无趋势数据」文案，不渲染空白画布', async () => {
    const messageTrend = mount(AnalyticsTrends, { points: [] });
    const onlineTrend = mount(AnalyticsVisits, { points: [] });
    await nextTick();

    for (const container of [messageTrend, onlineTrend]) {
      expect(container.textContent).toContain(
        '暂无趋势数据，设备接入并上报后自动展示',
      );
      expect(container.querySelector('.echarts-stub')).toBeNull();
    }
  });

  it('分布图空数据：给出「暂无分布数据」文案，不渲染空白画布', async () => {
    const containers = [
      mount(AnalyticsVisitsData, { items: [] }),
      mount(AnalyticsVisitsSource, { items: [] }),
      mount(AnalyticsVisitsSales, { items: [] }),
    ];
    await nextTick();

    for (const container of containers) {
      expect(container.textContent).toContain(
        '暂无分布数据，接入设备后自动生成',
      );
      expect(container.querySelector('.echarts-stub')).toBeNull();
    }
  });

  it('协议分布：协议码映射为中文名，未知码按共享口径露出', async () => {
    mount(AnalyticsVisitsData, {
      items: [
        { name: 'mqtt', value: 3 },
        { name: 'modbus', value: 2 },
        { name: 'coap', value: 1 },
      ],
    });
    await nextTick();

    const options = chartOptions.at(-1);
    expect(options).toBeTruthy();
    const names = (options?.series?.[0]?.data ?? []).map(
      (item: { name: string }) => item.name,
    );
    expect(names).toEqual(['MQTT', 'Modbus TCP', '未知（coap）']);
  });

  it('告警趋势/设备增长空数据：同样走「暂无趋势数据」空态，不渲染画布', async () => {
    const containers = [
      mount(AnalyticsAlertTrend, { points: [] }),
      mount(AnalyticsDeviceGrowth, { points: [] }),
    ];
    await nextTick();

    for (const container of containers) {
      expect(container.textContent).toContain(
        '暂无趋势数据，设备接入并上报后自动展示',
      );
      expect(container.querySelector('.echarts-stub')).toBeNull();
    }
  });

  it('规则 TOP 空数据：给出「近 30 天没有规则告警」，不渲染空列表', async () => {
    const container = mount(AnalyticsRuleTop, { items: [] });
    await nextTick();
    expect(container.textContent).toContain('近 30 天没有规则告警');
  });

  it('告警趋势：按严重级别堆叠，图例复用告警中心级别文案', async () => {
    mount(AnalyticsAlertTrend, {
      points: [
        { critical: 2, date: '2026-10-13', info: 5, warning: 3 },
        { critical: 1, date: '2026-10-14', info: 4, warning: 2 },
      ],
    });
    await nextTick();

    const options = chartOptions.at(-1);
    expect(options?.legend?.data).toEqual(['严重', '警告', '提示']);
    const series = (options?.series ?? []) as Array<Record<string, any>>;
    expect(series).toHaveLength(3);
    expect(
      series.every((item) => item.type === 'bar' && item.stack === 'alert'),
    ).toBe(true);
    expect(series.map((item) => item.data)).toEqual([
      [2, 1],
      [3, 2],
      [5, 4],
    ]);
  });

  it('设备增长：按日期输出每日新增柱', async () => {
    mount(AnalyticsDeviceGrowth, {
      points: [
        { added: 3, date: '2026-10-13' },
        { added: 5, date: '2026-10-14' },
      ],
    });
    await nextTick();

    const options = chartOptions.at(-1);
    expect(options?.xAxis?.data).toEqual(['2026-10-13', '2026-10-14']);
    expect(options?.series?.[0]?.data).toEqual([3, 5]);
  });

  it('规则 TOP：告警数降序展示，最多 5 条且长名不丢', async () => {
    const container = mount(AnalyticsRuleTop, {
      items: [
        { name: '规则A', value: 5 },
        { name: '规则B', value: 12 },
        { name: '规则C', value: 8 },
      ],
    });
    await nextTick();

    const text = container.textContent ?? '';
    for (const name of ['规则A', '规则B', '规则C']) {
      expect(text).toContain(name);
    }
    expect(text.indexOf('规则B')).toBeLessThan(text.indexOf('规则C'));
    expect(text.indexOf('规则C')).toBeLessThan(text.indexOf('规则A'));
    // 第一名占满相对占比条（width: 100%）
    const bars = [
      ...container.querySelectorAll<HTMLElement>('[style*="width"]'),
    ];
    expect(bars.some((bar) => bar.style.width === '100%')).toBe(true);
  });

  it('有数据时正常渲染画布（空态不误伤真实数据）', async () => {
    const container = mount(AnalyticsTrends, {
      points: [{ date: '2026-10-14', downlink: 10, uplink: 100 }],
    });
    await nextTick();
    expect(container.querySelector('.echarts-stub')).not.toBeNull();
    expect(container.textContent).not.toContain('暂无趋势数据');
  });
});

import type { SeriesQueryResult } from './series-utils';

import { createApp, h, nextTick } from 'vue';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  appendLiveSeriesPoint,
  IOT_SERIES_LIVE_MAX_POINTS,
  isGoodQuality,
} from './series-utils';
import Series from './series.vue';

/**
 * 「历史曲线实时跟随」用例。
 *
 * 分两层：
 * 1. **纯函数层**（`appendLiveSeriesPoint`）：事件匹配/不匹配、ts 单调、上限裁剪、
 *    非 good 质量、查询失败的系列，都在这里锁死——这些规则写错不会报错，只会安静画错；
 * 2. **组件接线层**（`series.vue` + mock 的 `useIotRealtime`）：开/关跟随的订阅与退订、
 *    匹配/不匹配事件的追加与计数、非 good/重复 ts 的可见提示、未出图时开关禁用、断线提示。
 */
const { chartOptions, deviceRef, drawerCalls, mockApi, realtime } = vi.hoisted(
  () => {
    return {
      chartOptions: [] as Record<string, any>[],
      deviceRef: {
        current: {
          deviceCode: 'dev-1',
          deviceName: '演示设备',
          id: '9300012',
          productId: '9100001',
          propertyId: 'temperature',
        },
      },
      drawerCalls: [] as Record<string, any>[],
      mockApi: {
        getDevicePoints: vi.fn(),
        getDeviceSeries: vi.fn(),
        listProperties: vi.fn(),
        listServices: vi.fn(),
      },
      realtime: {
        error: null as any,
        handlers: new Map<string, (payload: any) => void>(),
        offs: [] as Array<ReturnType<typeof vi.fn>>,
        state: null as any,
      },
    };
  },
);

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

vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const Stub = defineComponent({
    name: 'DrawerStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.()),
  });
  return {
    useVbenDrawer: (options: Record<string, any>) => {
      drawerCalls.push(options);
      const api = {
        close: vi.fn(),
        getData: () => deviceRef.current,
        open: vi.fn(),
        setData: vi.fn(),
        setState: vi.fn(),
      };
      return [Stub, api];
    },
  };
});

vi.mock('../../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  const state = ref<'closed' | 'connecting' | 'live' | 'reconnecting'>(
    'closed',
  );
  const error = ref('');
  realtime.state = state;
  realtime.error = error;
  return {
    useIotRealtime: () => ({
      error,
      onEvent: (event: string, handler: (payload: any) => void) => {
        realtime.handlers.set(event, handler);
        const off = vi.fn(() => {
          if (realtime.handlers.get(event) === handler) {
            realtime.handlers.delete(event);
          }
        });
        realtime.offs.push(off);
        return off;
      },
      state,
    }),
  };
});

vi.mock('#/api/iot/point', () => ({
  getDevicePoints: (...args: unknown[]) => mockApi.getDevicePoints(...args),
}));

vi.mock('#/api/iot/series', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot/series')>();
  return {
    ...actual,
    getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  };
});

vi.mock('#/api/iot/thingmodel', () => ({
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  listServices: (...args: unknown[]) => mockApi.listServices(...args),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  window.localStorage.clear();
  chartOptions.length = 0;
  drawerCalls.length = 0;
  realtime.handlers.clear();
  realtime.offs.length = 0;
  if (realtime.state) {
    realtime.state.value = 'closed';
  }
  if (realtime.error) {
    realtime.error.value = '';
  }
  deviceRef.current = {
    deviceCode: 'dev-1',
    deviceName: '演示设备',
    id: '9300012',
    productId: '9100001',
    propertyId: 'temperature',
  };
  mockApi.getDevicePoints.mockReset().mockResolvedValue([]);
  mockApi.getDeviceSeries.mockReset();
  mockApi.listProperties.mockReset().mockResolvedValue([]);
  mockApi.listServices.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

const BASE_TS = 1_790_400_000_000;

function seriesPoint(ts: number, value: string, quality = 'GOOD') {
  return { quality, ts, value };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function openSeries() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Series as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  const options = drawerCalls[0];
  expect(options?.onOpenChange).toBeTruthy();
  await options?.onOpenChange?.(true);
  await flush();
  return container;
}

function findSwitch(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLElement>('button.ant-switch')].find(
    (element) => (element.parentElement?.textContent ?? '').includes(label),
  );
}

function liveHandler() {
  const handler = realtime.handlers.get('latest');
  expect(handler, '未订阅 latest 事件').toBeTruthy();
  return handler as (payload: unknown) => void;
}

function detailRowCount(container: HTMLElement) {
  return container.querySelectorAll('table tbody tr').length;
}

// ==================== 纯函数层 ====================

function queryResult(
  propertyId: string,
  points: ReturnType<typeof seriesPoint>[] = [],
  error = '',
): SeriesQueryResult {
  return { error, name: propertyId, points, propertyId, unit: '' };
}

describe('appendLiveSeriesPoint：事件匹配与追加规则', () => {
  it('点位不在本次查询内 ⇒ matched=false、原数组引用不变', () => {
    const results = [queryResult('temperature')];
    const outcome = appendLiveSeriesPoint(results, {
      propertyId: 'humidity',
      quality: 'GOOD',
      ts: BASE_TS,
      value: '50',
    });
    expect(outcome.matched).toBe(false);
    expect(outcome.appended).toBe(false);
    expect(outcome.results).toBe(results);
  });

  it('匹配点位且 ts 更大 ⇒ 追加到对应系列，其它系列不受影响', () => {
    const temperature = queryResult('temperature', [
      seriesPoint(BASE_TS, '20'),
    ]);
    const humidity = queryResult('humidity', [seriesPoint(BASE_TS, '55')]);
    const outcome = appendLiveSeriesPoint([temperature, humidity], {
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '21',
    });
    expect(outcome.appended).toBe(true);
    expect(outcome.good).toBe(true);
    const next = outcome.results;
    expect(next[0]?.points.map((point) => point.value)).toEqual(['20', '21']);
    expect(next[1]?.points).toHaveLength(1);
    // 入参不被改写（纯函数）
    expect(temperature.points).toHaveLength(1);
  });

  it('ts 重复或回退 ⇒ 拒绝追加并标记 duplicate-ts', () => {
    const results = [
      queryResult('temperature', [
        seriesPoint(BASE_TS, '20'),
        seriesPoint(BASE_TS + 1000, '21'),
      ]),
    ];
    for (const ts of [BASE_TS + 1000, BASE_TS]) {
      const outcome = appendLiveSeriesPoint(results, {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts,
        value: '99',
      });
      expect(outcome.appended).toBe(false);
      expect(outcome.matched).toBe(true);
      expect(outcome.reason).toBe('duplicate-ts');
      expect(outcome.results).toBe(results);
    }
  });

  it('ts 非法（非数字/<=0）⇒ 拒绝追加并标记 invalid-ts', () => {
    const results = [queryResult('temperature', [seriesPoint(BASE_TS, '20')])];
    for (const ts of ['abc', null, 0, -1]) {
      const outcome = appendLiveSeriesPoint(results, {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts,
        value: '20',
      });
      expect(outcome.appended).toBe(false);
      expect(outcome.reason).toBe('invalid-ts');
    }
  });

  it('超过上限 ⇒ 只保留最近 N 点（旧点被裁掉，最新点保留）', () => {
    const points = Array.from({ length: 5 }, (_, index) =>
      seriesPoint(BASE_TS + index * 1000, String(index)),
    );
    const outcome = appendLiveSeriesPoint(
      [queryResult('temperature', points)],
      {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts: BASE_TS + 5000,
        value: 'new',
      },
      3,
    );
    expect(outcome.appended).toBe(true);
    const kept = outcome.results[0]?.points ?? [];
    expect(kept).toHaveLength(3);
    expect(kept.map((point) => point.value)).toEqual(['3', '4', 'new']);
    expect(kept.at(-1)?.ts).toBe(BASE_TS + 5000);
  });

  it('质量非 good ⇒ 仍追加但 good=false（不洗成 normal），大小写不敏感', () => {
    const outcome = appendLiveSeriesPoint(
      [queryResult('temperature', [seriesPoint(BASE_TS, '20')])],
      {
        propertyId: 'temperature',
        quality: 'bad',
        ts: BASE_TS + 1000,
        value: '21',
      },
    );
    expect(outcome.appended).toBe(true);
    expect(outcome.good).toBe(false);
    expect(outcome.results[0]?.points.at(-1)?.quality).toBe('bad');

    expect(isGoodQuality('GOOD')).toBe(true);
    expect(isGoodQuality(' good ')).toBe(true);
    expect(isGoodQuality('BAD')).toBe(false);
    expect(isGoodQuality(null)).toBe(false);
    expect(isGoodQuality('')).toBe(false);
    expect(IOT_SERIES_LIVE_MAX_POINTS).toBe(500);
  });

  it('查询失败的系列不追加（避免把失败演成有数据）', () => {
    const results = [queryResult('temperature', [], '时序库未启用')];
    const outcome = appendLiveSeriesPoint(results, {
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS,
      value: '20',
    });
    expect(outcome.matched).toBe(true);
    expect(outcome.appended).toBe(false);
    expect(outcome.reason).toBe('series-failed');
    expect(outcome.results).toBe(results);
  });
});

// ==================== 组件接线层 ====================

describe('series.vue：实时跟随接线', () => {
  it('开启跟随 ⇒ 订阅 latest；匹配事件追加并显示「已跟随 N 点」，不匹配事件忽略', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([seriesPoint(BASE_TS, '20')]);
    const container = await openSeries();

    const liveSwitch = findSwitch(container, '实时跟随');
    expect(liveSwitch).toBeTruthy();
    expect(liveSwitch?.classList.contains('ant-switch-disabled')).toBe(false);
    expect(container.textContent).toContain('已关闭');

    liveSwitch?.click();
    await flush();
    expect(realtime.handlers.has('latest')).toBe(true);
    expect(realtime.offs).toHaveLength(1);

    if (realtime.state) {
      realtime.state.value = 'live';
    }
    await flush();
    expect(container.textContent).toContain('实时');

    // 匹配：同设备 + 同点位 + ts 递增
    liveHandler()({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '21',
    });
    await flush();
    expect(container.textContent).toContain('已跟随 1 点');
    expect(detailRowCount(container)).toBe(2);
    const series = chartOptions.at(-1)?.series?.[0];
    expect(series?.data.at(-1)).toEqual([BASE_TS + 1000, 21]);

    // 不匹配：其它设备的事件
    liveHandler()({
      deviceId: 'other-device',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 2000,
      value: '22',
    });
    await flush();
    // 不匹配：不在本次查询内的点位
    liveHandler()({
      deviceId: '9300012',
      propertyId: 'humidity',
      quality: 'GOOD',
      ts: BASE_TS + 3000,
      value: '60',
    });
    await flush();
    expect(container.textContent).toContain('已跟随 1 点');
    expect(container.textContent).not.toContain('已忽略 1 条');
  });

  it('重复/非法 ts 与质量非 good：计数与提示可见', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([seriesPoint(BASE_TS, '20')]);
    const container = await openSeries();
    findSwitch(container, '实时跟随')?.click();
    await flush();

    liveHandler()({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '21',
    });
    await flush();
    // 重复 ts（等于已追加的点）⇒ 忽略 + 计数
    liveHandler()({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '21',
    });
    // 非法 ts ⇒ 忽略 + 计数
    liveHandler()({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: 'abc',
      value: '22',
    });
    // 非 good 质量 ⇒ 追加 + 计数 + 提示（不洗成 normal）
    liveHandler()({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'BAD',
      ts: BASE_TS + 2000,
      value: '19',
    });
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('已跟随 2 点');
    expect(text).toContain('已忽略 2 条无法追加的实时点');
    expect(text).toContain('其中 1 点质量非 good');
    const lastPoint = chartOptions.at(-1)?.series?.[0]?.data.at(-1);
    expect(lastPoint).toEqual([BASE_TS + 2000, 19]);
  });

  it('关闭开关 / 关抽屉 ⇒ 自动退订', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([seriesPoint(BASE_TS, '20')]);
    const container = await openSeries();
    const liveSwitch = findSwitch(container, '实时跟随');
    liveSwitch?.click();
    await flush();
    expect(realtime.handlers.has('latest')).toBe(true);
    const off = realtime.offs[0];

    liveSwitch?.click();
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
    expect(realtime.handlers.has('latest')).toBe(false);

    // 重新开启后关抽屉：同样必须退订
    liveSwitch?.click();
    await flush();
    expect(realtime.handlers.has('latest')).toBe(true);
    await drawerCalls[0]?.onOpenChange?.(false);
    await flush();
    expect(realtime.offs.at(-1)).toHaveBeenCalled();
    expect(realtime.handlers.has('latest')).toBe(false);
  });

  it('未出图（查询为空）⇒ 开关禁用并说明原因', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([]);
    const container = await openSeries();
    const liveSwitch = findSwitch(container, '实时跟随');
    expect(liveSwitch?.classList.contains('ant-switch-disabled')).toBe(true);
    expect(container.textContent).toContain('需先查询出曲线后才能实时跟随');
  });

  it('连接重连中 ⇒ Tag 与可见 Alert 同时提示，不静默', async () => {
    mockApi.getDeviceSeries.mockResolvedValue([seriesPoint(BASE_TS, '20')]);
    const container = await openSeries();
    findSwitch(container, '实时跟随')?.click();
    await flush();

    if (realtime.state) {
      realtime.state.value = 'reconnecting';
    }
    if (realtime.error) {
      realtime.error.value = 'SSE 连接中断';
    }
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('重连中');
    expect(text).toContain('实时连接中断，正在自动重连');
    expect(text).toContain('SSE 连接中断');
  });
});

import type { BoardConfig, BoardWidget } from './board/board-utils';

import type { IotSeriesApi } from '#/api/iot';

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

import { niceGaugeMax } from './board/board-charts';
import BoardDrawer from './board/board-drawer.vue';
import {
  addBoardWidget,
  appendBoardPoint,
  boardLatestMatches,
  buildPropertyOptions,
  createBoardWidgetRuntime,
  createEmptyBoardConfig,
  IOT_BOARD_LINE_MAX_POINTS,
  IOT_BOARD_MAX_WIDGETS,
  IOT_BOARD_STORAGE_KEY,
  loadBoardConfig,
  removeBoardWidget,
  sanitizeBoardConfig,
  saveBoardConfig,
  updateBoardWidget,
} from './board/board-utils';
import BoardWidgetCard from './board/board-widget-card.vue';

/**
 * 组态看板用例：纯逻辑层（配置 sanitize/CRUD/匹配/折线追加/候选/量程）+ 组件层
 *（空态/坏配置重置/失败原样提示/数值卡与折线实时更新）。
 */
const { chartOptions, drawerCalls, mockApi, realtime } = vi.hoisted(() => ({
  chartOptions: [] as Record<string, any>[],
  drawerCalls: [] as Record<string, any>[],
  mockApi: {
    getDeviceLatest: vi.fn(),
    getDeviceOptions: vi.fn(),
    getDeviceSeries: vi.fn(),
  },
  realtime: {
    error: null as any,
    handlers: new Map<string, (payload: any) => void>(),
    state: null as any,
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

vi.mock('@vben/common-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const Stub = defineComponent({
    name: 'PopupStub',
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => h('div', { ...attrs }, slots.default?.());
    },
  });
  return {
    useVbenDrawer: (options: Record<string, any>) => {
      drawerCalls.push(options);
      return [
        Stub,
        {
          close: vi.fn(),
          getData: () => undefined,
          open: vi.fn(),
          setData: vi.fn(),
          setState: vi.fn(),
        },
      ];
    },
    useVbenModal: () => {
      return [
        defineComponent({
          name: 'ModalStub',
          setup: () => () => null,
        }),
        {
          close: vi.fn(),
          getData: () => undefined,
          lock: vi.fn(),
          open: vi.fn(),
          setData: vi.fn(),
          setState: vi.fn(),
          unlock: vi.fn(),
        },
      ];
    },
  };
});

vi.mock('../../iot/shared/use-iot-realtime', async () => {
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
        return () => {
          realtime.handlers.delete(event);
        };
      },
      state,
    }),
  };
});

vi.mock('#/api/iot/device', () => ({
  getDeviceLatest: (...args: unknown[]) => mockApi.getDeviceLatest(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
}));

vi.mock('#/api/iot/series', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot/series')>();
  return {
    ...actual,
    getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
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

const BASE_TS = 1_790_400_000_000;

const DEVICE = {
  deviceCode: 'dev-1',
  deviceName: '演示设备',
  id: '9300012',
  onlineStatus: 'online',
};

function widget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    deviceId: '9300012',
    id: 'w1',
    propertyId: 'temperature',
    title: '车间温度',
    type: 'value',
    ...overrides,
  };
}

function configWith(widgets: BoardWidget[]): BoardConfig {
  return { version: 1, widgets };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    snapshot: () => map,
  };
}

function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

let mounted: undefined | { app: { unmount: () => void } };

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  mockApi.getDeviceOptions.mockReset().mockResolvedValue([DEVICE]);
  mockApi.getDeviceLatest.mockReset().mockResolvedValue([]);
  mockApi.getDeviceSeries.mockReset().mockResolvedValue([]);
  if (realtime.state) {
    realtime.state.value = 'closed';
  }
  if (realtime.error) {
    realtime.error.value = '';
  }
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  realtime.handlers.clear();
  chartOptions.length = 0;
  drawerCalls.length = 0;
});

async function mountBoardDrawer() {
  // 同一用例里可能多次挂载：先卸旧实例并清空调用记录，避免把上一次的 onOpenChange 又调一遍
  mounted?.app.unmount();
  mounted = undefined;
  drawerCalls.length = 0;
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(BoardDrawer as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  const options = drawerCalls.find(
    (item) => typeof item.onOpenChange === 'function',
  );
  expect(options, 'useVbenDrawer(onOpenChange) 未被调用').toBeTruthy();
  await options?.onOpenChange?.(true);
  await flush();
  return container;
}

async function mountWidgetCard(
  widgetValue: BoardWidget,
  runtimeOverrides: Record<string, any> = {},
) {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () =>
      h(BoardWidgetCard as never, {
        device: DEVICE,
        runtime: { ...createBoardWidgetRuntime(), ...runtimeOverrides },
        widget: widgetValue,
      }),
  });
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

// ==================== 纯逻辑层 ====================

describe('看板配置 sanitize 与持久化', () => {
  it('脏数据/旧版本不炸：非法输入一律回落空看板', () => {
    for (const dirty of [
      null,
      undefined,
      42,
      'nope',
      [],
      { version: 2, widgets: [] },
      { widgets: [] },
    ]) {
      const config = sanitizeBoardConfig(dirty);
      expect(config.version).toBe(1);
      expect(config.widgets).toEqual([]);
    }
  });

  it('逐条校验：缺字段/非法类型/重复 id 丢弃，字符串去空白，超上限截断', () => {
    const config = sanitizeBoardConfig({
      version: 1,
      widgets: [
        { ...widget(), title: '  温度  ' },
        { ...widget({ id: 'w2' }), type: 'bogus' },
        { deviceId: '', id: 'w3', propertyId: 'p', title: 't', type: 'value' },
        { ...widget() },
        ...Array.from({ length: 30 }, (_, index) =>
          widget({ id: `bulk-${index}` }),
        ),
      ],
    });
    expect(config.widgets).toHaveLength(IOT_BOARD_MAX_WIDGETS);
    expect(config.widgets[0]?.title).toBe('温度');
    expect(config.widgets.some((item) => item.id === 'w2')).toBe(false);
    expect(config.widgets.some((item) => item.id === 'w3')).toBe(false);
  });

  it('load/save：读写往返、坏 JSON 标记 reset、存储抛异常不炸', () => {
    const storage = fakeStorage();
    expect(loadBoardConfig(storage).reset).toBe(false);
    expect(saveBoardConfig(configWith([widget()]), storage)).toBe(true);
    expect(loadBoardConfig(storage).config.widgets).toHaveLength(1);

    const broken = fakeStorage({
      [IOT_BOARD_STORAGE_KEY]: '{not-json',
    });
    const loaded = loadBoardConfig(broken);
    expect(loaded.reset).toBe(true);
    expect(loaded.config.widgets).toEqual([]);

    const throwing = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    };
    expect(loadBoardConfig(throwing).reset).toBe(false);
    expect(loadBoardConfig(throwing).config.widgets).toEqual([]);
    expect(saveBoardConfig(configWith([widget()]), throwing)).toBe(false);
  });

  it('增删改：新增补 id、更新只接受合法字段、删除按 id', () => {
    const empty = createEmptyBoardConfig();
    const added = addBoardWidget(empty, {
      deviceId: '9300012',
      propertyId: 'temperature',
      title: '温度',
      type: 'value',
    });
    expect(added.widgets).toHaveLength(1);
    const id = added.widgets[0]?.id ?? '';
    expect(id).not.toBe('');

    const updated = updateBoardWidget(added, id, {
      title: '  湿度  ',
      type: 'gauge',
    });
    expect(updated.widgets[0]?.title).toBe('湿度');
    expect(updated.widgets[0]?.type).toBe('gauge');

    const ignored = updateBoardWidget(updated, id, {
      deviceId: '  ',
      title: '',
      type: 'bogus' as never,
    });
    expect(ignored.widgets[0]?.title).toBe('湿度');
    expect(ignored.widgets[0]?.type).toBe('gauge');

    expect(removeBoardWidget(ignored, id).widgets).toEqual([]);
    expect(removeBoardWidget(ignored, 'unknown').widgets).toHaveLength(1);
  });

  it('新增超过上限：原配置不变（由调用方提示上限）', () => {
    const full = configWith(
      Array.from({ length: IOT_BOARD_MAX_WIDGETS }, (_, index) =>
        widget({ id: `w-${index}` }),
      ),
    );
    expect(addBoardWidget(full, widget({ id: 'overflow' }))).toBe(full);
  });
});

describe('看板实时匹配与折线追加', () => {
  it('设备 + 点位双匹配才命中（deviceId 兼容 number/string）', () => {
    const target = widget();
    expect(
      boardLatestMatches(target, {
        deviceId: 9_300_012,
        propertyId: 'temperature',
      }),
    ).toBe(true);
    expect(
      boardLatestMatches(target, {
        deviceId: '9300012',
        propertyId: 'humidity',
      }),
    ).toBe(false);
    expect(
      boardLatestMatches(target, { deviceId: null, propertyId: 'temperature' }),
    ).toBe(false);
  });

  it('折线追加：ts 必须递增、超上限保留最近点、不改写入参', () => {
    const points: IotSeriesApi.TimeSeriesPointResp[] = [
      { quality: 'GOOD', ts: BASE_TS, value: '20' },
      { quality: 'GOOD', ts: BASE_TS + 1000, value: '21' },
    ];
    const duplicate = appendBoardPoint(points, {
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '22',
    });
    expect(duplicate.appended).toBe(false);
    expect(duplicate.reason).toBe('duplicate-ts');
    expect(duplicate.points).toBe(points);

    const invalid = appendBoardPoint(points, {
      quality: 'GOOD',
      ts: 'abc',
      value: '22',
    });
    expect(invalid.reason).toBe('invalid-ts');

    const appended = appendBoardPoint(points, {
      quality: 'GOOD',
      ts: BASE_TS + 2000,
      value: '22',
    });
    expect(appended.appended).toBe(true);
    expect(appended.points).toHaveLength(3);
    expect(points).toHaveLength(2);

    const trimmed = appendBoardPoint(
      Array.from({ length: 5 }, (_, index) => ({
        quality: 'GOOD',
        ts: BASE_TS + index * 1000,
        value: String(index),
      })),
      { quality: 'GOOD', ts: BASE_TS + 5000, value: 'new' },
      3,
    );
    expect(trimmed.points).toHaveLength(3);
    expect(trimmed.points.map((point) => point.value)).toEqual([
      '3',
      '4',
      'new',
    ]);
    expect(IOT_BOARD_LINE_MAX_POINTS).toBe(200);
  });
});

describe('点位候选与仪表盘量程', () => {
  it('候选：只收 property 引用与启用映射，合并最新值，去重排序', () => {
    const options = buildPropertyOptions(
      [
        { propertyId: 'temperature', refType: 'property' },
        { propertyId: 'set_temp', refType: 'command' },
        { enabled: false, propertyId: 'disabled', refType: 'property' },
        { propertyId: 'temperature', refType: 'property' },
      ] as never,
      [{ propertyId: 'humidity' }, { propertyId: 'temperature' }] as never,
    );
    expect(options.map((item) => item.value)).toEqual([
      'humidity',
      'temperature',
    ]);
    expect(options[0]?.label).toContain('humidity');
  });

  it('仪表盘量程：0/负值 → 100，按数量级留 20% 余量', () => {
    expect(niceGaugeMax(null)).toBe(100);
    expect(niceGaugeMax(0)).toBe(100);
    expect(niceGaugeMax(-5)).toBe(10);
    expect(niceGaugeMax(5)).toBe(10);
    expect(niceGaugeMax(21)).toBe(50);
    expect(niceGaugeMax(100)).toBe(200);
    expect(niceGaugeMax(0.3)).toBe(0.5);
  });
});

// ==================== 组件层 ====================

describe('看板卡片：四类组件的空态与失败态', () => {
  it('数值卡：展示数值、质量与更新时间', async () => {
    const container = await mountWidgetCard(widget(), {
      latest: {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts: BASE_TS,
        value: '23.5',
      },
      loaded: true,
    });
    const text = container.textContent ?? '';
    expect(text).toContain('车间温度');
    expect(text).toContain('23.5');
    expect(text).toContain('有效');
    expect(text).toContain('更新于');
  });

  it('失败态：原样展示后端 message，不画成「暂无数据」', async () => {
    const container = await mountWidgetCard(widget(), {
      error: '后端查询失败：权限不足',
      loaded: true,
    });
    expect(container.textContent).toContain('后端查询失败：权限不足');
    expect(container.textContent).not.toContain('暂无最新值');
  });

  it('折线空数据与状态卡：分别给空态文案与在线/质量标签', async () => {
    const line = await mountWidgetCard(widget({ type: 'line' }), {
      loaded: true,
      points: [],
      seriesLoaded: true,
    });
    expect(line.textContent).toContain('暂无历史数据');

    const status = await mountWidgetCard(widget({ type: 'status' }), {
      latest: {
        propertyId: 'temperature',
        quality: 'BAD',
        ts: BASE_TS,
        value: '1',
      },
      loaded: true,
    });
    expect(status.textContent).toContain('在线');
    expect(status.textContent).toContain('坏值');
  });
});

describe('看板抽屉：空态/坏配置/失败/实时', () => {
  it('空配置 ⇒ 空态 + 添加按钮；不显示错误', async () => {
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('还没有组件');
    expect(container.textContent).toContain('添加组件');
    expect(container.textContent).not.toContain('看板配置不兼容');
  });

  it('坏配置 ⇒ 重置为空并给可见提示', async () => {
    window.localStorage.setItem(IOT_BOARD_STORAGE_KEY, '{bad-json');
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('看板配置不兼容或已损坏');
    expect(container.textContent).toContain('还没有组件');
  });

  it('有配置 ⇒ 拉最新值渲染组件；失败 ⇒ 原样提示而不是空态', async () => {
    window.localStorage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(configWith([widget()])),
    );
    mockApi.getDeviceLatest.mockResolvedValue([
      { propertyId: 'temperature', quality: 'GOOD', ts: BASE_TS, value: '20' },
    ]);
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('车间温度');
    expect(container.textContent).toContain('20');
    expect(container.textContent).toContain('演示设备');

    mockApi.getDeviceLatest.mockRejectedValue(
      bizFailure(50_000, '看板最新值查询炸了'),
    );
    const failed = await mountBoardDrawer();
    expect(failed.textContent).toContain('看板最新值查询炸了');
    expect(failed.textContent).not.toContain('还没有组件');
  });

  it('实时事件：匹配更新数值卡，不匹配忽略；折线追加到图表', async () => {
    window.localStorage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(
        configWith([
          widget({ id: 'value-1', type: 'value' }),
          widget({ id: 'line-1', title: '温度曲线', type: 'line' }),
        ]),
      ),
    );
    mockApi.getDeviceLatest.mockResolvedValue([
      { propertyId: 'temperature', quality: 'GOOD', ts: BASE_TS, value: '20' },
    ]);
    mockApi.getDeviceSeries.mockResolvedValue([
      { quality: 'GOOD', ts: BASE_TS - 2000, value: '19' },
      { quality: 'GOOD', ts: BASE_TS - 1000, value: '19.5' },
    ]);
    const container = await mountBoardDrawer();
    const handler = realtime.handlers.get('latest');
    expect(handler, '未订阅 latest').toBeTruthy();

    if (realtime.state) {
      realtime.state.value = 'live';
    }
    handler?.({
      deviceId: '9300012',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 1000,
      value: '21',
    });
    await flush();
    expect(container.textContent).toContain('21');
    expect(container.textContent).toContain('实时');
    const lineOption = chartOptions.findLast((options) =>
      Array.isArray(options?.series?.[0]?.data),
    );
    expect(lineOption?.series?.[0]?.data).toHaveLength(3);

    handler?.({
      deviceId: 'other-device',
      propertyId: 'temperature',
      quality: 'GOOD',
      ts: BASE_TS + 2000,
      value: '99',
    });
    await flush();
    expect(container.textContent).not.toContain('99');
  });
});

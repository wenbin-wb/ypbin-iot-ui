import type { BoardConfig, BoardWidget } from './board/board-utils';

import type { IotSeriesApi } from '#/api/iot';

import { createApp, h, nextTick } from 'vue';

import { i18n } from '@vben/locales';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { $t } from '#/locales';

import {
  buildBoardLineOption,
  buildGaugeOption,
  buildMultiLineOption,
  niceGaugeMax,
  resolveGaugeBounds,
  seriesColorAt,
} from './board/board-charts';
import BoardDrawer from './board/board-drawer.vue';
import {
  addBoardWidget,
  appendBoardPoint,
  boardLatestMatches,
  boardLatestMatchesWidget,
  boardWidgetPropertyIds,
  buildPropertyOptions,
  createBoardWidgetRuntime,
  createEmptyBoardConfig,
  formatBoardValue,
  IOT_BOARD_DEFAULT_WINDOW_MINUTES,
  IOT_BOARD_LINE_MAX_POINTS,
  IOT_BOARD_MAX_DECIMALS,
  IOT_BOARD_MAX_SERIES,
  IOT_BOARD_MAX_WIDGETS,
  IOT_BOARD_STORAGE_KEY,
  isBoardWidgetFieldVisible,
  isMultiPointWidgetType,
  loadBoardConfig,
  moveBoardWidget,
  moveWidget,
  planBoardLoad,
  removeBoardWidget,
  resolveBoardBoolean,
  resolveBoardWindowMs,
  sanitizeBoardConfig,
  sanitizeBoardPropertyIds,
  sanitizeBoardWidget,
  sanitizeBoardWidgetList,
  saveBoardConfig,
  toBoardPayloadWidget,
  updateBoardWidget,
} from './board/board-utils';
import BoardWidgetCard from './board/board-widget-card.vue';

/**
 * 组态看板用例：纯逻辑层（配置 sanitize/CRUD/匹配/折线追加/候选/量程/排序/加载决策/格式化）+
 * 组件层（空态/坏配置重置/失败原样提示/数值卡与折线实时更新/开关·多序列·表格三类新组件/
 * 拖拽与「上移下移」按钮排序/后端共享持久化与本地草稿回退/上传确认）。
 */
const { chartOptions, drawerCalls, mockApi, modalConfirms, realtime, toast } =
  vi.hoisted(() => ({
    chartOptions: [] as Record<string, any>[],
    drawerCalls: [] as Record<string, any>[],
    mockApi: {
      getDashboardBoard: vi.fn(),
      getDeviceLatest: vi.fn(),
      getDeviceOptions: vi.fn(),
      getDeviceSeries: vi.fn(),
      saveDashboardBoard: vi.fn(),
    },
    modalConfirms: [] as Record<string, any>[],
    realtime: {
      error: null as any,
      handlers: new Map<string, (payload: any) => void>(),
      state: null as any,
    },
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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
          getValues: vi.fn().mockResolvedValue({}),
          lock: vi.fn(),
          open: vi.fn(),
          reset: vi.fn(),
          setData: vi.fn(),
          setFieldError: vi.fn(),
          setState: vi.fn(),
          unlock: vi.fn(),
          validate: vi.fn().mockResolvedValue({ valid: true }),
        },
      ];
    },
  };
});

// Modal.confirm 是人机确认入口：拦下来（记录参数）才能在用例里驱动「是否上传本地草稿」两条分支
vi.mock('ant-design-vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    message: {
      ...actual.message,
      error: (...args: unknown[]) => toast.error(...args),
      success: (...args: unknown[]) => toast.success(...args),
      warning: (...args: unknown[]) => toast.warning(...args),
    },
    Modal: {
      ...actual.Modal,
      confirm: (options: Record<string, any>) => {
        modalConfirms.push(options);
        return { destroy: vi.fn(), update: vi.fn() };
      },
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

vi.mock('#/api/iot/board', () => ({
  getDashboardBoard: (...args: unknown[]) => mockApi.getDashboardBoard(...args),
  saveDashboardBoard: (...args: unknown[]) =>
    mockApi.saveDashboardBoard(...args),
}));

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
  // 新键的事实源是**已提交进本仓**的 page.json（上面 setupI18n 已加载）。
  // 🔴 曾经这里按仓规去读仓外的 temp/i18n-requests-frontend-board-v2.json 并预置，
  // 结果 CI 检出里没有该目录 ⇒ ENOENT 把「校验与构建」打红（本地有、CI 没有，属"本机假绿"）。
  // 现在改为：**仓外文件只是可选加速**——存在就合（保持本地改文案即可见），不存在就跳过，
  // 此时断言依赖的仍是随包发布的真实语言包。
  const { existsSync, readFileSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const requestFile = 'i18n-requests-frontend-board-v2.json';
  let workspaceRoot = dirname(fileURLToPath(import.meta.url));
  let found = join(workspaceRoot, 'temp', requestFile);
  for (;;) {
    if (existsSync(found)) {
      break;
    }
    const parent = resolve(workspaceRoot, '..');
    if (parent === workspaceRoot) {
      found = '';
      break;
    }
    workspaceRoot = parent;
    found = join(workspaceRoot, 'temp', requestFile);
  }
  if (found === '') {
    return;
  }
  const i18nRequest = JSON.parse(readFileSync(found, 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  for (const [locale, entries] of Object.entries(i18nRequest)) {
    const messages: Record<string, any> = {};
    for (const [key, value] of Object.entries(
      entries as Record<string, string>,
    )) {
      const parts = key.split('.');
      let node = messages;
      for (const part of parts.slice(0, -1)) {
        node[part] ??= {};
        node = node[part];
      }
      node[parts.at(-1) as string] = value;
    }
    i18n.global.mergeLocaleMessage(locale, messages);
  }
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

function bulkId(prefix: string, index: number): string {
  return [prefix, String(index)].join('-');
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

function readLocalDraft(): Record<string, any> {
  const raw = window.localStorage.getItem(IOT_BOARD_STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

let mounted: undefined | { app: { unmount: () => void } };

async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  mockApi.getDashboardBoard.mockReset().mockResolvedValue({ widgets: [] });
  mockApi.saveDashboardBoard.mockReset().mockResolvedValue(null);
  mockApi.getDeviceOptions.mockReset().mockResolvedValue([DEVICE]);
  mockApi.getDeviceLatest.mockReset().mockResolvedValue([]);
  mockApi.getDeviceSeries.mockReset().mockResolvedValue([]);
  modalConfirms.length = 0;
  toast.error.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
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
  props: Record<string, any> = {},
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
        index: 0,
        runtime: { ...createBoardWidgetRuntime(), ...runtimeOverrides },
        total: 1,
        widget: widgetValue,
        ...props,
      }),
  });
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

/** 取当前看板卡片顺序（DOM 顺序即渲染顺序）。 */
function cardOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-widget-id]')].map(
    (element) => (element as HTMLElement).dataset.widgetId ?? '',
  );
}

function buttonByLabel(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === label,
  );
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
          widget({ id: bulkId('bulk', index) }),
        ),
      ],
    });
    expect(config.widgets).toHaveLength(IOT_BOARD_MAX_WIDGETS);
    expect(config.widgets[0]?.title).toBe('温度');
    expect(config.widgets.some((item) => item.id === 'w2')).toBe(false);
    expect(config.widgets.some((item) => item.id === 'w3')).toBe(false);
  });

  it('新增组件类型：布尔/多序列/表格合法，未知类型仍被丢弃', () => {
    const list = sanitizeBoardWidgetList([
      { ...widget({ id: 'b1', type: 'boolean' }) },
      {
        ...widget({ id: 'm1', type: 'multi-line' }),
        propertyIds: ['temperature', '  humidity ', 'temperature', ''],
      },
      {
        ...widget({ id: 't1', type: 'table' }),
        propertyIds: ['a', 'b'],
        decimals: 2,
        unit: '℃',
      },
      // 类型是**不可信输入**（后端只保证非空字符串），这里按 unknown 注入
      { ...widget({ id: 'bad', type: 'pie' as never }) },
    ]);
    expect(list.map((item) => item.id)).toEqual(['b1', 'm1', 't1']);
    expect(list[1]?.propertyIds).toEqual(['temperature', 'humidity']);
    expect(list[2]?.decimals).toBe(2);
    expect(list[2]?.unit).toBe('℃');
  });

  it('可选字段只在合法时才进配置：小数位/量程/窗口各自有边界', () => {
    const parsed = sanitizeBoardWidget({
      ...widget({ id: 'g1', type: 'gauge' }),
      decimals: 99,
      max: 'abc',
      min: -5,
      windowMinutes: 0,
    });
    expect(parsed?.decimals).toBeUndefined();
    expect(parsed?.max).toBeUndefined();
    expect(parsed?.min).toBe(-5);
    expect(parsed?.windowMinutes).toBeUndefined();

    const list = sanitizeBoardWidgetList([
      { ...widget({ id: 'm1', type: 'multi-line' }), propertyIds: [] },
    ]);
    // 多点位类型至少留一条序列（回落单点位），否则卡片画不出任何东西
    expect(list[0]?.propertyIds).toEqual(['temperature']);
  });

  it('多点位列表清洗：去空白/去重/保序/截断到上限', () => {
    const ids = sanitizeBoardPropertyIds(
      Array.from({ length: IOT_BOARD_MAX_SERIES + 5 }, (_, index) =>
        ['p', String(index)].join(''),
      ),
    );
    expect(ids).toHaveLength(IOT_BOARD_MAX_SERIES);
    expect(sanitizeBoardPropertyIds('temperature')).toEqual([]);
  });

  it('load/save：读写往返、坏 JSON 标记 reset、存储抛异常不炸、dirty 标记透传', () => {
    const storage = fakeStorage();
    expect(loadBoardConfig(storage).reset).toBe(false);
    expect(saveBoardConfig(configWith([widget()]), storage)).toBe(true);
    expect(loadBoardConfig(storage).config.widgets).toHaveLength(1);
    expect(loadBoardConfig(storage).dirty).toBe(false);

    // 未同步草稿必须能被再次读出（否则刷新即丢用户改动）
    expect(saveBoardConfig(configWith([widget()]), storage, true)).toBe(true);
    expect(loadBoardConfig(storage).dirty).toBe(true);

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

  it('更新可选字段：显式空值=清除，越界值=忽略，多点位类型保持至少一条序列', () => {
    const base = configWith([
      {
        ...widget({ id: 'g1', type: 'gauge' }),
        decimals: 2,
        max: 50,
        min: -10,
        unit: 'kPa',
        windowMinutes: 60,
      },
    ]);
    const cleared = updateBoardWidget(base, 'g1', {
      decimals: undefined,
      max: undefined,
      min: undefined,
      unit: '',
      windowMinutes: undefined,
    });
    expect(cleared.widgets[0]?.decimals).toBeUndefined();
    expect(cleared.widgets[0]?.max).toBeUndefined();
    expect(cleared.widgets[0]?.min).toBeUndefined();
    expect(cleared.widgets[0]?.unit).toBeUndefined();
    expect(cleared.widgets[0]?.windowMinutes).toBeUndefined();

    const invalid = updateBoardWidget(base, 'g1', {
      decimals: 99,
      unit: 'kPa',
      windowMinutes: 0,
    });
    expect(invalid.widgets[0]?.decimals).toBeUndefined();
    expect(invalid.widgets[0]?.windowMinutes).toBeUndefined();

    const multi = updateBoardWidget(
      configWith([{ ...widget({ id: 'm1', type: 'multi-line' }) }]),
      'm1',
      { propertyIds: [] },
    );
    expect(multi.widgets[0]?.propertyIds).toEqual(['temperature']);
  });

  it('新增超过上限：原配置不变（由调用方提示上限）', () => {
    const full = configWith(
      Array.from({ length: IOT_BOARD_MAX_WIDGETS }, (_, index) =>
        widget({ id: bulkId('w', index) }),
      ),
    );
    expect(addBoardWidget(full, widget({ id: 'overflow' }))).toBe(full);
  });

  it('toBoardPayloadWidget 载荷是纯对象：undefined 字段不出现（不给后端送 null 噪声）', () => {
    const payload = toBoardPayloadWidget({
      ...widget({ id: 'g1', type: 'gauge' }),
      decimals: 1,
      min: -5,
      max: 50,
      unit: 'kPa',
      windowMinutes: 120,
    });
    expect(payload).toEqual({
      decimals: 1,
      deviceId: '9300012',
      id: 'g1',
      max: 50,
      min: -5,
      propertyId: 'temperature',
      title: '车间温度',
      type: 'gauge',
      unit: 'kPa',
      windowMinutes: 120,
    });
    expect(Object.hasOwn(toBoardPayloadWidget(widget()), 'unit')).toBe(false);
  });
});

describe('拖拽排序纯函数', () => {
  it('moveWidget：插入语义（其余元素让位，不是交换）且不改写入参', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveWidget(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveWidget(list, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveWidget(list, 1, 1)).toBe(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moveWidget：越界/非整数/单元素一律原样返回（引用不变）', () => {
    const list = ['a', 'b'];
    for (const [from, to] of [
      [-1, 0],
      [0, 2],
      [5, 0],
      [0.5, 1],
      [Number.NaN, 0],
    ] as [number, number][]) {
      expect(moveWidget(list, from, to)).toBe(list);
    }
    const single = ['only'];
    expect(moveWidget(single, 0, 0)).toBe(single);
  });

  it('moveBoardWidget：按 id 上移/下移一位，找不到 id 原样返回', () => {
    const config = configWith([
      widget({ id: 'a' }),
      widget({ id: 'b' }),
      widget({ id: 'c' }),
    ]);
    expect(moveBoardWidget(config, 'c', -1).widgets.map((w) => w.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    // 按钮只传 ±1；越界 offset 是空操作（引用不变，避免无意义 PUT）
    expect(moveBoardWidget(config, 'a', 5)).toBe(config);
    expect(moveBoardWidget(config, 'a', -5)).toBe(config);
    expect(moveBoardWidget(config, 'unknown', 1)).toBe(config);
    // 边界：首位上移/末位下移都是空操作，引用不变（避免无意义 PUT）
    expect(moveBoardWidget(config, 'a', -1)).toBe(config);
    expect(moveBoardWidget(config, 'c', 1)).toBe(config);
  });
});

describe('平台 / 本地草稿加载决策', () => {
  const remoteOk = (widgets: BoardWidget[]) => ({ ok: true, widgets });
  const localDraft = configWith([widget({ id: 'local-1' })]);

  it('平台有配置 ⇒ 平台为准（即使本地有草稿）', () => {
    const plan = planBoardLoad(remoteOk([widget({ id: 'remote-1' })]), {
      config: localDraft,
      dirty: false,
      reset: false,
    });
    expect(plan.source).toBe('platform');
    expect(plan.config.widgets.map((w) => w.id)).toEqual(['remote-1']);
    expect(plan.localDraftAvailable).toBe(false);
  });

  it('平台空数组 = 无配置（不是损坏）⇒ 回落本地草稿并提示上传', () => {
    const plan = planBoardLoad(remoteOk([]), {
      config: localDraft,
      dirty: false,
      reset: false,
    });
    expect(plan.source).toBe('local-draft');
    expect(plan.localDraftAvailable).toBe(true);
    expect(plan.config.widgets.map((w) => w.id)).toEqual(['local-1']);
    expect(plan.remoteError).toBe('');
  });

  it('平台空 + 本地空 ⇒ 空看板，不提示上传', () => {
    const plan = planBoardLoad(remoteOk([]), {
      config: createEmptyBoardConfig(),
      dirty: false,
      reset: false,
    });
    expect(plan.source).toBe('empty');
    expect(plan.localDraftAvailable).toBe(false);
  });

  it('getBoard 失败 ⇒ 回落本地草稿并原样带上原因；无草稿则空看板 + 原因', () => {
    const withDraft = planBoardLoad(
      { error: '读取平台看板配置失败：网络炸了', ok: false },
      { config: localDraft, dirty: false, reset: false },
    );
    expect(withDraft.source).toBe('local-draft');
    expect(withDraft.remoteError).toContain('网络炸了');

    const withoutDraft = planBoardLoad(
      { error: '读取平台看板配置失败：网络炸了', ok: false },
      { config: createEmptyBoardConfig(), dirty: false, reset: false },
    );
    expect(withoutDraft.source).toBe('empty');
    expect(withoutDraft.remoteError).toContain('网络炸了');
  });

  it('本地草稿标记 dirty（上次 PUT 失败）⇒ 优先本地，不被平台覆盖', () => {
    const plan = planBoardLoad(remoteOk([widget({ id: 'remote-1' })]), {
      config: localDraft,
      dirty: true,
      reset: false,
    });
    expect(plan.source).toBe('local-draft');
    expect(plan.config.widgets.map((w) => w.id)).toEqual(['local-1']);
    // 已经按用户意愿保留本地，就不再提示「是否上传」（由保存按钮显式触发）
    expect(plan.localDraftAvailable).toBe(false);
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

  it('多点位组件：propertyIds 里任一点位都能命中，设备不同仍忽略', () => {
    const multi = widget({ id: 'm1', type: 'multi-line' });
    multi.propertyIds = ['temperature', 'humidity'];
    expect(boardWidgetPropertyIds(multi)).toEqual(['temperature', 'humidity']);
    expect(
      boardLatestMatchesWidget(multi, {
        deviceId: '9300012',
        propertyId: 'humidity',
      }),
    ).toBe(true);
    expect(
      boardLatestMatchesWidget(multi, {
        deviceId: 'other',
        propertyId: 'humidity',
      }),
    ).toBe(false);
    // 单点位组件即使被硬塞 propertyIds，也会带上主点位（后端必填字段那个）
    const single = widget({ id: 'v1' });
    single.propertyIds = ['humidity'];
    expect(boardWidgetPropertyIds(single)).toEqual(['temperature', 'humidity']);
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

  it('折线窗口：配置优先，非法/缺省回落 24 小时', () => {
    expect(resolveBoardWindowMs(widget())).toBe(
      IOT_BOARD_DEFAULT_WINDOW_MINUTES * 60 * 1000,
    );
    expect(resolveBoardWindowMs(widget({ windowMinutes: 60 }))).toBe(3_600_000);
    expect(resolveBoardWindowMs(widget({ windowMinutes: 0 as never }))).toBe(
      IOT_BOARD_DEFAULT_WINDOW_MINUTES * 60 * 1000,
    );
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

  it('量程决策：用户配置优先，未配置才自适应', () => {
    // 显式双端：原样尊重（现场仪表的量程是业务口径）
    expect(resolveGaugeBounds(-10, 50, 999, 100)).toEqual({
      max: 50,
      min: -10,
    });
    // 只配下限：上限按当前值自适应
    expect(resolveGaugeBounds(0, undefined, 21, 100)).toEqual({
      max: 50,
      min: 0,
    });
    // 只配上限：下限 0
    expect(resolveGaugeBounds(undefined, 80, 21, 100)).toEqual({
      max: 80,
      min: 0,
    });
    // 都没配：自适应值与维护值取大（避免实时涨值后指针顶格）
    expect(resolveGaugeBounds(undefined, undefined, 21, 30)).toEqual({
      max: 50,
      min: 0,
    });
  });
});

describe('数值格式化与布尔真值表', () => {
  it('formatBoardValue：配了小数位才格式化，文本点原样展示', () => {
    expect(formatBoardValue('23.456', 2)).toBe('23.46');
    expect(formatBoardValue('23.456')).toBe('23.456');
    expect(formatBoardValue('ON', 2)).toBe('ON');
    expect(formatBoardValue(null, 2)).toBe('');
    expect(formatBoardValue(' 12 ', 0)).toBe('12');
    // 超过上限的小数位视为非法 → 原样展示（不假装 0 位）
    expect(formatBoardValue('1.234', IOT_BOARD_MAX_DECIMALS + 1)).toBe('1.234');
  });

  it('resolveBoardBoolean：真值表命中才判定，其余一律未知（不猜成关）', () => {
    for (const on of [true, 1, '1', 'ON', 'on', 'true', 'YES', 'start', 1]) {
      expect(resolveBoardBoolean(on as never)).toBe('on');
    }
    for (const off of [false, 0, '0', 'OFF', 'false', 'No', 'stop']) {
      expect(resolveBoardBoolean(off as never)).toBe('off');
    }
    for (const unknown of [null, undefined, '', '  ', 'AUTO', 2, 'enabled?']) {
      expect(resolveBoardBoolean(unknown as never)).toBe('unknown');
    }
  });

  it('表单字段显隐映射：只有相关组件类型才显示对应字段', () => {
    expect(isBoardWidgetFieldVisible('propertyIds', 'multi-line')).toBe(true);
    expect(isBoardWidgetFieldVisible('propertyIds', 'table')).toBe(true);
    expect(isBoardWidgetFieldVisible('propertyIds', 'value')).toBe(false);
    expect(isBoardWidgetFieldVisible('propertyId', 'table')).toBe(false);
    expect(isBoardWidgetFieldVisible('windowMinutes', 'line')).toBe(true);
    expect(isBoardWidgetFieldVisible('windowMinutes', 'gauge')).toBe(false);
    expect(isBoardWidgetFieldVisible('gaugeMax', 'gauge')).toBe(true);
    expect(isBoardWidgetFieldVisible('gaugeMax', 'value')).toBe(false);
    expect(isBoardWidgetFieldVisible('unit', 'boolean')).toBe(false);
    expect(isBoardWidgetFieldVisible('unit', 'bogus' as never)).toBe(false);
    expect(isMultiPointWidgetType('table')).toBe(true);
  });

  it('图表 option：多序列一序列一点位且颜色稳定；仪表盘尊重自定义量程', () => {
    const multi = buildMultiLineOption(
      [
        {
          points: [{ quality: 'GOOD', ts: BASE_TS, value: '1' }],
          propertyId: 'a',
        },
        {
          points: [{ quality: 'GOOD', ts: BASE_TS, value: 'x' }],
          propertyId: 'b',
        },
      ],
      ['温度', '湿度'],
    );
    // echarts 的 series/legend 类型是「对象 | 对象数组」联合，测试里显式收窄成数组逐个断言
    const multiSeries = multi.series as Record<string, any>[];
    expect(multiSeries).toHaveLength(2);
    expect(multiSeries[0]?.name).toBe('温度');
    expect(multiSeries[1]?.name).toBe('湿度');
    expect(multiSeries[0]?.data).toEqual([[BASE_TS, 1]]);
    // 非数值点为 null（断点），与单序列同口径
    expect(multiSeries[1]?.data).toEqual([[BASE_TS, null]]);
    expect(multiSeries[0]?.lineStyle?.color).toBe(seriesColorAt(0));
    expect(multiSeries[1]?.lineStyle?.color).toBe(seriesColorAt(1));
    // 调色板取模：越界下标颜色循环（12 色）
    expect(seriesColorAt(0)).toBe(seriesColorAt(12));
    expect((multi.legend as Record<string, any>)?.show).toBe(true);

    const gauge = buildGaugeOption(12, 50, -10);
    const gaugeSeries = (gauge.series as Record<string, any>[])[0];
    expect(gaugeSeries?.max).toBe(50);
    expect(gaugeSeries?.min).toBe(-10);

    const single = buildBoardLineOption(
      [{ quality: 'GOOD', ts: BASE_TS, value: '20' }],
      '温度',
    );
    expect((single.series as Record<string, any>[])[0]?.name).toBe('温度');
  });
});

// ==================== 组件层 ====================

describe('看板卡片：各组件类型的空态与失败态', () => {
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

  it('开关卡：真值表命中显示开/关，未知值显示未知（不猜成关）', async () => {
    const on = await mountWidgetCard(widget({ type: 'boolean' }), {
      latest: {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts: BASE_TS,
        value: 'ON',
      },
      loaded: true,
    });
    expect(on.querySelector('[data-widget-type="boolean"]')).toBeTruthy();
    expect(on.textContent).toContain($t('page.iot.board.booleanOn'));

    const off = await mountWidgetCard(widget({ id: 'b2', type: 'boolean' }), {
      latest: {
        propertyId: 'temperature',
        quality: 'GOOD',
        ts: BASE_TS,
        value: 'false',
      },
      loaded: true,
    });
    expect(off.textContent).toContain($t('page.iot.board.booleanOff'));

    const unknown = await mountWidgetCard(
      widget({ id: 'b3', type: 'boolean' }),
      {
        latest: {
          propertyId: 'temperature',
          quality: 'GOOD',
          ts: BASE_TS,
          value: 'AUTO',
        },
        loaded: true,
      },
    );
    expect(unknown.textContent).toContain($t('page.iot.board.booleanUnknown'));
  });

  it('表格卡：按点位顺序给出键/值/质量/时间四列，缺失点位给占位不编造', async () => {
    const target = widget({ id: 't1', type: 'table' });
    target.propertyIds = ['temperature', 'humidity'];
    const container = await mountWidgetCard(target, {
      latestList: [
        {
          propertyId: 'temperature',
          quality: 'GOOD',
          ts: BASE_TS,
          value: '23.5',
        },
      ],
      loaded: true,
    });
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('temperature');
    expect(rows[0]?.textContent).toContain('23.5');
    expect(rows[1]?.textContent).toContain('humidity');
    expect(rows[1]?.textContent).toContain('-');
    // 小屏卡片化版本同时存在（sm:hidden / sm:table 双形态）
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
  });

  it('多序列折线：seriesLoaded 且有点位才画图，全空给空态', async () => {
    const target = widget({ id: 'm1', type: 'multi-line' });
    target.propertyIds = ['temperature', 'humidity'];
    const empty = await mountWidgetCard(target, {
      loaded: true,
      multiSeries: [
        { points: [], propertyId: 'temperature' },
        { points: [], propertyId: 'humidity' },
      ],
      seriesLoaded: true,
    });
    expect(empty.textContent).toContain('暂无历史数据');

    const ready = await mountWidgetCard(target, {
      loaded: true,
      multiSeries: [
        {
          points: [{ quality: 'GOOD', ts: BASE_TS, value: '20' }],
          propertyId: 'temperature',
        },
        {
          points: [{ quality: 'GOOD', ts: BASE_TS, value: '60' }],
          propertyId: 'humidity',
        },
      ],
      seriesLoaded: true,
    });
    expect(ready.querySelector('.echarts-stub')).toBeTruthy();
    const option = chartOptions.findLast(
      (item) => Array.isArray(item?.series) && item.series.length === 2,
    );
    expect(option?.series?.[0]?.data).toEqual([[BASE_TS, 20]]);
    expect(option?.series?.[1]?.data).toEqual([[BASE_TS, 60]]);
  });
});

describe('看板抽屉：后端共享持久化 / 本地草稿 / 排序', () => {
  it('平台空 + 本地空 ⇒ 空态 + 添加按钮；不显示错误', async () => {
    const container = await mountBoardDrawer();
    expect(mockApi.getDashboardBoard).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('还没有组件');
    expect(container.textContent).toContain('添加组件');
    expect(container.textContent).not.toContain('看板配置不兼容');
    expect(container.textContent).not.toContain(
      $t('page.iot.board.localDraftNotice'),
    );
  });

  it('平台有配置 ⇒ 平台为准并写回本地（dirty=false）', async () => {
    mockApi.getDashboardBoard.mockResolvedValue({
      widgets: [widget({ id: 'remote-1' })],
    });
    mockApi.getDeviceLatest.mockResolvedValue([
      { propertyId: 'temperature', quality: 'GOOD', ts: BASE_TS, value: '20' },
    ]);
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('车间温度');
    expect(container.textContent).toContain('20');
    expect(container.textContent).toContain(
      $t('page.iot.board.sourcePlatform'),
    );
    expect(readLocalDraft().dirty).toBe(false);
    expect(readLocalDraft().widgets).toHaveLength(1);
  });

  it('坏本地配置 + 平台空 ⇒ 重置为空并给可见提示', async () => {
    window.localStorage.setItem(IOT_BOARD_STORAGE_KEY, '{bad-json');
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('看板配置不兼容或已损坏');
    expect(container.textContent).toContain('还没有组件');
  });

  it('getBoard 失败 ⇒ 回落本地草稿并如实标注「本地草稿（未同步）」，不静默降级', async () => {
    window.localStorage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(configWith([widget({ id: 'local-1' })])),
    );
    mockApi.getDashboardBoard.mockRejectedValue(
      bizFailure(50_000, '平台看板查询炸了'),
    );
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('车间温度');
    // 如实标注「本地草稿（未同步到平台）」，而不是只有内部状态
    expect(container.textContent).toContain(
      '当前为本地草稿（未同步到平台）：平台读取失败或尚未配置，本页展示并保存的都是本机草稿。',
    );
    expect(container.textContent).toContain('平台看板查询炸了');
  });

  it('小屏（390px）：抽屉与表格卡都用「不横向溢出」的结构（无固定宽表、卡片化兜底）', async () => {
    // 抽屉里禁止横向滚动，只有纵向
    const drawerHost = document.createElement('div');
    document.body.append(drawerHost);
    const target = widget({ id: 't1', type: 'table' });
    target.propertyIds = ['temperature', 'humidity'];
    const container = await mountWidgetCard(
      target,
      {
        latestList: [
          {
            propertyId: 'temperature',
            quality: 'GOOD',
            ts: BASE_TS,
            value: '23.5',
          },
        ],
        loaded: true,
      },
      { index: 0, total: 3 },
    );
    // 表格是 table-fixed + w-full（列宽按比例收敛，不撑破 390px）
    const table = container.querySelector('table');
    expect(table?.className).toContain('table-fixed');
    expect(table?.className).toContain('w-full');
    // 小屏走卡片化列表，且每行用 truncate 截断长点位名
    const cards = [...container.querySelectorAll('ul li')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.truncate')).toBeTruthy();
    // 卡片主体允许收缩（min-w-0），拖拽手柄不参与撑宽
    expect(container.firstElementChild?.className).toContain('min-w-0');
  });

  it('平台空 + 本地有草稿 ⇒ 弹出「是否上传」，确认后 PUT 并清 dirty', async () => {
    window.localStorage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(configWith([widget({ id: 'local-1' })])),
    );
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('车间温度');
    expect(modalConfirms).toHaveLength(1);
    expect(modalConfirms[0]?.content).toContain(
      $t('page.iot.board.uploadDraftConfirm'),
    );

    await modalConfirms[0]?.onOk?.();
    await flush();
    expect(mockApi.saveDashboardBoard).toHaveBeenCalledTimes(1);
    expect(mockApi.saveDashboardBoard.mock.calls[0]?.[0]).toEqual([
      {
        deviceId: '9300012',
        id: 'local-1',
        propertyId: 'temperature',
        title: '车间温度',
        type: 'value',
      },
    ]);
    expect(readLocalDraft().dirty).toBe(false);
    expect(container.textContent).toContain(
      $t('page.iot.board.sourcePlatform'),
    );
  });

  it('「暂不上传」⇒ 不 PUT，保持本地草稿标注', async () => {
    window.localStorage.setItem(
      IOT_BOARD_STORAGE_KEY,
      JSON.stringify(configWith([widget({ id: 'local-1' })])),
    );
    const container = await mountBoardDrawer();
    await modalConfirms[0]?.onCancel?.();
    await flush();
    expect(mockApi.saveDashboardBoard).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      $t('page.iot.board.localDraftNotice'),
    );
  });

  it('保存按钮：PUT 成功后提示成功、source=platform；失败则保留本地草稿并明确报错', async () => {
    mockApi.getDashboardBoard.mockResolvedValue({
      widgets: [widget({ id: 'remote-1' })],
    });
    const container = await mountBoardDrawer();
    expect(container.textContent).toContain('车间温度');

    const saveButton = [...container.querySelectorAll('button')].find(
      (element) =>
        element.textContent?.includes($t('page.iot.board.saveToPlatform')),
    );
    expect(saveButton, '未找到保存到平台按钮').toBeTruthy();
    saveButton?.click();
    await flush();
    expect(mockApi.saveDashboardBoard).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);

    mockApi.saveDashboardBoard.mockRejectedValue(
      bizFailure(50_000, '平台保存炸了'),
    );
    saveButton?.click();
    await flush();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]?.[0]).toContain(
      '保存到平台失败：平台保存炸了',
    );
    // 失败必须保留本地草稿并置 dirty，不许假装成功
    expect(readLocalDraft().dirty).toBe(true);
    expect(readLocalDraft().widgets).toHaveLength(1);
    expect(container.textContent).toContain(
      $t('page.iot.board.localDraftNotice'),
    );
  });

  it('拖拽排序：dragstart + drop 完成插入式重排，并把新顺序 PUT 到平台', async () => {
    mockApi.getDashboardBoard.mockResolvedValue({
      widgets: [widget({ id: 'a' }), widget({ id: 'b' }), widget({ id: 'c' })],
    });
    const container = await mountBoardDrawer();
    expect(cardOrder(container)).toEqual(['a', 'b', 'c']);

    const cards = [...container.querySelectorAll('[data-widget-id]')];
    cards[2]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
    cards[0]?.dispatchEvent(new Event('drop', { bubbles: true }));
    await flush();

    expect(cardOrder(container)).toEqual(['c', 'a', 'b']);
    expect(
      mockApi.saveDashboardBoard.mock.calls
        .at(-1)?.[0]
        ?.map((item: any) => item.id),
    ).toEqual(['c', 'a', 'b']);
  });

  it('上移/下移按钮：键盘/触屏可完成排序，边界按钮禁用', async () => {
    mockApi.getDashboardBoard.mockResolvedValue({
      widgets: [widget({ id: 'a' }), widget({ id: 'b' })],
    });
    const container = await mountBoardDrawer();

    const firstCard = container.querySelector('[data-widget-id="a"]');
    const up = firstCard
      ? buttonByLabel(firstCard as HTMLElement, $t('page.iot.board.moveUp'))
      : undefined;
    const down = firstCard
      ? buttonByLabel(firstCard as HTMLElement, $t('page.iot.board.moveDown'))
      : undefined;
    expect(up, '首卡未渲染上移按钮').toBeTruthy();
    expect(down, '首卡未渲染下移按钮').toBeTruthy();
    expect((up as HTMLButtonElement)?.disabled).toBe(true);
    expect((down as HTMLButtonElement)?.disabled).toBe(false);

    (down as HTMLButtonElement)?.click();
    await flush();
    expect(cardOrder(container)).toEqual(['b', 'a']);
    expect(
      mockApi.saveDashboardBoard.mock.calls
        .at(-1)?.[0]
        ?.map((item: any) => item.id),
    ).toEqual(['b', 'a']);

    // 重新取 DOM：重排后卡片被重建
    const lastCard = container.querySelector('[data-widget-id="a"]');
    const lastDown = buttonByLabel(
      lastCard as HTMLElement,
      $t('page.iot.board.moveDown'),
    );
    expect((lastDown as HTMLButtonElement)?.disabled).toBe(true);
  });

  it('实时事件：匹配更新数值卡（多点位组件按点位集合命中）；折线追加到图表', async () => {
    const multi = widget({ id: 'multi-1', type: 'multi-line' });
    multi.propertyIds = ['temperature', 'humidity'];
    mockApi.getDashboardBoard.mockResolvedValue({
      widgets: [
        widget({ id: 'value-1', type: 'value' }),
        widget({ id: 'line-1', title: '温度曲线', type: 'line' }),
        multi,
      ],
    });
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
    const lineOption = chartOptions.findLast(
      (options) =>
        Array.isArray(options?.series?.[0]?.data) &&
        options.series.length === 1 &&
        options.series[0].name === '温度曲线',
    );
    expect(lineOption?.series?.[0]?.data).toHaveLength(3);
    const multiOption = chartOptions.findLast(
      (options) =>
        Array.isArray(options?.series) && options.series.length === 2,
    );
    expect(multiOption?.series?.[0]?.data).toHaveLength(3);

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

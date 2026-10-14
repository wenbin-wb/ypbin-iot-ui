import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import AlertsPage from './index.vue';

/**
 * 告警中心 × SSE 接线用例（真实页面 + 表格适配层打桩）。
 *
 * 守门的不变量：
 * 1. `alert` 事件会刷新列表与摘要（走既有 `reloadAll`，不新造刷新路径）；
 * 2. 连发多条 `alert` 在去抖窗口内合并为**一次**刷新（批量确认/恢复不打请求风暴）；
 * 3. 连接进入 reconnecting ⇒ 页面出现「实时连接中断」可见提示（失败不得静默）。
 */
const { captured, mockApi, realtimeMock } = vi.hoisted(() => ({
  captured: { api: null as any, options: null as any },
  mockApi: {
    ackAlerts: vi.fn(),
    createAlertRule: vi.fn(),
    getAlertPage: vi.fn(),
    getAlertPresets: vi.fn(),
    getAlertRulePage: vi.fn(),
    getAlertSummary: vi.fn(),
    getDeviceOptions: vi.fn(),
    getDeviceSeries: vi.fn(),
    getPublishedProductOptions: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
    setAlertRulesEnabled: vi.fn(),
    silenceAlerts: vi.fn(),
    updateAlertRule: vi.fn(),
  },
  realtimeMock: {
    error: null as any,
    handlers: new Map<string, Array<(payload: unknown) => void>>(),
    state: null as any,
  },
}));

vi.mock('#/api/iot', () => ({
  ackAlerts: (...args: unknown[]) => mockApi.ackAlerts(...args),
  createAlertRule: (...args: unknown[]) => mockApi.createAlertRule(...args),
  getAlertPage: (...args: unknown[]) => mockApi.getAlertPage(...args),
  getAlertPresets: (...args: unknown[]) => mockApi.getAlertPresets(...args),
  getAlertRulePage: (...args: unknown[]) => mockApi.getAlertRulePage(...args),
  getAlertSummary: (...args: unknown[]) => mockApi.getAlertSummary(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
  getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  getPublishedProductOptions: (...args: unknown[]) =>
    mockApi.getPublishedProductOptions(...args),
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  listServices: (...args: unknown[]) => mockApi.listServices(...args),
  setAlertRulesEnabled: (...args: unknown[]) =>
    mockApi.setAlertRulesEnabled(...args),
  silenceAlerts: (...args: unknown[]) => mockApi.silenceAlerts(...args),
  updateAlertRule: (...args: unknown[]) => mockApi.updateAlertRule(...args),
}));

/** 实时订阅打桩：把页面注册的 handler 抓出来，测试里手动触发事件。 */
vi.mock('../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  const state = ref('live');
  const error = ref('');
  realtimeMock.state = state;
  realtimeMock.error = error;
  return {
    useIotRealtime: () => ({
      error,
      onEvent: (event: string, handler: (payload: unknown) => void) => {
        const list = realtimeMock.handlers.get(event) ?? [];
        list.push(handler);
        realtimeMock.handlers.set(event, list);
        return () => {
          const current = realtimeMock.handlers.get(event) ?? [];
          realtimeMock.handlers.set(
            event,
            current.filter((item) => item !== handler),
          );
        };
      },
      state,
    }),
  };
});

vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', { class: 'page-stub' }, slots.default?.()),
  }),
  useVbenDrawer: () => [
    defineComponent({ name: 'DrawerStub', setup: () => () => null }),
    { close: vi.fn(), open: vi.fn(), setData: vi.fn() },
  ],
}));

vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    const GridStub = defineComponent({
      name: 'GridStub',
      setup: () => () => h('div', { class: 'grid-stub' }),
    });
    const api = {
      grid: { $el: undefined, reactData: { tableLoading: false } },
      query: vi.fn(),
      setGridOptions: vi.fn(),
      setLoading: vi.fn(),
    };
    captured.api ??= api;
    captured.options ??= options;
    return [GridStub, api];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/iot/alerts', query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  realtimeMock.handlers.clear();
  captured.api = null;
  captured.options = null;
  mockApi.getAlertSummary.mockResolvedValue({
    ackedCount: '0',
    activeCount: '0',
    criticalCount: '0',
    resolvedLast24h: '0',
  });
  mockApi.getAlertPage.mockResolvedValue({
    items: [],
    page: '1',
    pageSize: '10',
    total: '0',
  });
  mockApi.getAlertRulePage.mockResolvedValue({
    items: [],
    page: '1',
    pageSize: '10',
    total: '0',
  });
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await nextTick();
  await nextTick();
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(AlertsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  await flush();
  return { app, container };
}

/** 比 index.vue 里的 500ms 去抖窗口多留 300ms 余量。 */
function waitForDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

describe('告警中心 × SSE：alert 事件去抖刷新', () => {
  it('连发多条 alert ⇒ 只触发一次列表刷新 + 一次摘要刷新', async () => {
    const handle = await mountPage();
    mounted = handle;

    // 进页面时摘要已拉一次
    expect(mockApi.getAlertSummary).toHaveBeenCalledTimes(1);
    const handlers = realtimeMock.handlers.get('alert') ?? [];
    expect(handlers).toHaveLength(1);

    handlers[0]?.({});
    handlers[0]?.({});
    handlers[0]?.({});
    // 去抖窗口内：不得刷新
    expect(captured.api.query).not.toHaveBeenCalled();
    expect(mockApi.getAlertSummary).toHaveBeenCalledTimes(1);

    await waitForDebounce();
    await flush();

    // 列表（instanceGuard.request ⇒ gridApi.query）与摘要各一次
    expect(captured.api.query).toHaveBeenCalledTimes(1);
    expect(mockApi.getAlertSummary).toHaveBeenCalledTimes(2);
  });

  it('实时连接进入 reconnecting ⇒ 页面出现「实时连接中断」提示（错误原因可见）', async () => {
    const handle = await mountPage();
    mounted = handle;

    expect(handle.container.innerHTML).not.toContain('实时连接中断');

    realtimeMock.state.value = 'reconnecting';
    realtimeMock.error.value = 'realtime stream HTTP 502';
    await nextTick();

    const html = handle.container.innerHTML;
    expect(html).toContain('实时连接中断');
    expect(html).toContain('realtime stream HTTP 502');
  });
});

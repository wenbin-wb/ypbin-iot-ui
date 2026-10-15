import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';
import { useAccessStore } from '@vben/stores';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { deviceStatusTouchesDevices } from '#/api/iot/realtime';

import DevicesPage from './index.vue';

/**
 * 设备台账 × `device-status` 实时事件用例。
 *
 * 守门的不变量：
 * 1. 单台 `{deviceId}` / 批量 `{deviceIds}` / 删除 `{deviceIds|deletedIds}` 命中当前可见行
 *    才去抖 800ms 刷新当前页；
 * 2. 无关设备的事件不产生任何请求；窗口内连发多条合并为一次刷新；
 * 3. 实时状态 Tag / 断线提示可见（reconnecting 是 warning，不阻塞页面）；
 * 4. 无 accessToken 时不建立 SSE 连接（useIotRealtime 的真实实现）。
 *
 * 页面用打桩的 useIotRealtime + 表格适配层；真实 useIotRealtime 通过 importActual 单独验证。
 */

const { fakeRealtimeClient, gridApiMock, mockApi, realtimeMock, routeState } =
  vi.hoisted(() => ({
    fakeRealtimeClient: {
      connect: vi.fn(),
      dispose: vi.fn(),
      instances: 0,
    },
    gridApiMock: {
      grid: { getData: vi.fn() },
      query: vi.fn(),
    },
    mockApi: {
      getActiveAlertCounts: vi.fn(),
      getDevicePage: vi.fn(),
    },
    realtimeMock: {
      error: null as any,
      handlers: new Map<string, Array<(payload: unknown) => void>>(),
      state: null as any,
    },
    routeState: { query: {} as Record<string, unknown> },
  }));

vi.mock('#/api/iot/realtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot/realtime')>();
  class FakeIotRealtimeClient {
    constructor() {
      fakeRealtimeClient.instances += 1;
    }

    connect() {
      fakeRealtimeClient.connect();
    }

    dispose() {
      fakeRealtimeClient.dispose();
    }
  }
  return { ...actual, IotRealtimeClient: FakeIotRealtimeClient };
});

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

vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  getActiveAlertCounts: (...args: unknown[]) =>
    mockApi.getActiveAlertCounts(...args),
  getDeviceNameMap: vi.fn(),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getPublishedProductOptions: vi.fn(),
  updateDeviceStatus: vi.fn(),
}));

vi.mock('#/api/iot/device', () => ({
  batchDeleteDevices: vi.fn(),
  batchUpdateDeviceStatus: vi.fn(),
  exportDevicesCsv: vi.fn(),
}));

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: vi.fn(),
  downloadByBlob: vi.fn(),
}));

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
    void options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup:
        (_props: unknown, { slots }: any) =>
        () =>
          h('div', { class: 'grid-stub' }, [slots['toolbar-tools']?.()]),
    });
    return [GridStub, gridApiMock];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeState.query }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-device-realtime' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.grid.getData.mockReset();
  gridApiMock.grid.getData.mockReturnValue([{ id: '1001' }, { id: '1002' }]);
  fakeRealtimeClient.connect.mockReset();
  fakeRealtimeClient.dispose.mockReset();
  fakeRealtimeClient.instances = 0;
  realtimeMock.handlers.clear();
  realtimeMock.state.value = 'live';
  realtimeMock.error.value = '';
  routeState.query = {};
  useAccessStore().setAccessCodes(['*:*:*']);
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
  await nextTick();
  await nextTick();
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush();
  return { container };
}

/** 比 index.vue 的 800ms 去抖窗口多留 300ms 余量。 */
function waitForDebounce() {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

function deviceStatusHandlers() {
  return realtimeMock.handlers.get('device-status') ?? [];
}

describe('deviceStatusTouchesDevices（纯函数）', () => {
  it('单台 / 批量 / deletedIds 别名命中可见行；无关 id 不命中', () => {
    const visible = ['1001', '1002'];
    expect(deviceStatusTouchesDevices({ deviceId: '1001' }, visible)).toBe(
      true,
    );
    expect(deviceStatusTouchesDevices({ deviceId: 9999 }, visible)).toBe(false);
    expect(
      deviceStatusTouchesDevices({ deviceIds: ['9999', '1002'] }, visible),
    ).toBe(true);
    expect(deviceStatusTouchesDevices({ deletedIds: ['1001'] }, visible)).toBe(
      true,
    );
    expect(deviceStatusTouchesDevices({ deviceIds: ['9999'] }, visible)).toBe(
      false,
    );
  });

  it('无设备上下文保守刷新；可见行为空不刷新', () => {
    expect(deviceStatusTouchesDevices({}, ['1001'])).toBe(true);
    expect(deviceStatusTouchesDevices({ status: 1 }, ['1001'])).toBe(true);
    expect(deviceStatusTouchesDevices({ deviceId: '1001' }, [])).toBe(false);
  });
});

describe('设备台账 × device-status：命中可见行才去抖刷新', () => {
  it('单台事件命中当前行 ⇒ 去抖后刷新一次', async () => {
    await mountPage();
    const handlers = deviceStatusHandlers();
    expect(handlers).toHaveLength(1);

    handlers[0]?.({ deviceId: '1001', status: 0 });
    // 去抖窗口内不得立即刷新
    expect(gridApiMock.query).not.toHaveBeenCalled();

    await waitForDebounce();
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('批量 deviceIds 命中当前行 ⇒ 刷新', async () => {
    await mountPage();
    const handlers = deviceStatusHandlers();

    handlers[0]?.({ deviceIds: ['9999', '1002'], status: 1 });
    await waitForDebounce();

    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('删除事件（deviceIds 与 deletedIds 别名）命中当前行 ⇒ 刷新', async () => {
    await mountPage();
    const handlers = deviceStatusHandlers();

    handlers[0]?.({ deviceIds: ['1001'] });
    await waitForDebounce();
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);

    handlers[0]?.({ deletedIds: ['1002'] });
    await waitForDebounce();
    expect(gridApiMock.query).toHaveBeenCalledTimes(2);
  });

  it('无关设备事件 ⇒ 不刷新', async () => {
    await mountPage();
    const handlers = deviceStatusHandlers();

    handlers[0]?.({ deviceId: '9999' });
    handlers[0]?.({ deviceIds: ['8888', '7777'] });
    await waitForDebounce();

    expect(gridApiMock.query).not.toHaveBeenCalled();
  });

  it('窗口内连发多条 ⇒ 合并为一次刷新', async () => {
    await mountPage();
    const handlers = deviceStatusHandlers();

    handlers[0]?.({ deviceId: '1001' });
    handlers[0]?.({ deviceIds: ['1002'] });
    handlers[0]?.({ deviceIds: ['1001'] });
    expect(gridApiMock.query).not.toHaveBeenCalled();

    await waitForDebounce();
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('实时状态 Tag：live/connecting/reconnecting 可见，断线给出错误原因且不阻塞列表', async () => {
    const handle = await mountPage();

    expect(handle.container.innerHTML).toContain('实时连接');

    realtimeMock.state.value = 'connecting';
    await nextTick();
    expect(handle.container.innerHTML).toContain('实时连接中');

    realtimeMock.state.value = 'reconnecting';
    realtimeMock.error.value = 'realtime stream HTTP 502';
    await nextTick();
    const html = handle.container.innerHTML;
    // i18n 合并前回落到 key，同样可识别
    expect(html).toMatch(/实时中断|realtime\.reconnecting/);
    expect(html).toContain('realtime stream HTTP 502');
    // 断线只是提示：工具栏/列表仍可操作（页面没有整体错误态）
    expect(handle.container.querySelector('.grid-stub')).toBeTruthy();
  });
});

describe('useIotRealtime：无 token 不建连', () => {
  it('accessToken 为空时不实例化 SSE 客户端；有 token 后建连', async () => {
    const actual = await vi.importActual<
      typeof import('../shared/use-iot-realtime')
    >('../shared/use-iot-realtime');

    useAccessStore().setAccessToken(null);
    const offWithoutToken = actual
      .useIotRealtime()
      .onEvent('device-status', () => {});
    expect(fakeRealtimeClient.instances).toBe(0);
    expect(fakeRealtimeClient.connect).not.toHaveBeenCalled();

    useAccessStore().setAccessToken('test-token');
    const offWithToken = actual
      .useIotRealtime()
      .onEvent('device-status', () => {});
    expect(fakeRealtimeClient.instances).toBe(1);
    expect(fakeRealtimeClient.connect).toHaveBeenCalledTimes(1);

    offWithoutToken();
    offWithToken();
    expect(fakeRealtimeClient.dispose).toHaveBeenCalledTimes(1);
  });
});

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

import { $t } from '#/locales';

import DevicesPage from './index.vue';

/**
 * 设备详情**深链**用例（审查 06 §4 P3：抽屉不可分享/刷新丢失/后退直接离开列表）。
 *
 * 行为约定（实现见 `composables/use-device-drawers.ts`）：
 * 1. 打开详情 ⇒ `router.replace({query:{deviceId}})`（replace 不产生历史栈垃圾）；
 * 2. 关闭详情抽屉 ⇒ 从 URL 移除 deviceId（刷新/复制 URL 不会再弹出已关掉的抽屉）；
 * 3. 带 `?deviceId=` 挂载 / 浏览器前进后退改变该参数 ⇒ 自动打开对应设备详情；
 * 4. id 不在当前页或未知 ⇒ **仍按 `{ id }` 打开**（详情各区块自行按 id 取数并展示失败），
 *    不静默忽略、也不伪造设备档案字段；
 * 5. 与 `?productId=` / `?action=create` 共存：`action=create` 优先（不叠加两个抽屉），
 *    一次性参数照旧被清理。
 *
 * 打桩口径：抽屉生命周期由 `useVbenDrawer` 桩模拟（open/close 会回调 host 的 onOpenChange，
 * 与 vben 真实行为同构）；`vue-router` 桩的 replace 会同步更新 route.query（模拟真实导航），
 * 这样 `watch(route.query.deviceId)` 的同步逻辑才能被真实触发。
 */

const { drawerHosts, gridApiMock, mockApi, routeRef, routerCalls } = vi.hoisted(
  () => ({
    drawerHosts: [] as any[],
    gridApiMock: {
      grid: { getData: vi.fn() },
      query: vi.fn(),
    },
    mockApi: {
      getActiveAlertCounts: vi.fn(),
      getDevicePage: vi.fn(),
    },
    routeRef: { state: null as any },
    routerCalls: { replace: [] as any[] },
  }),
);

const DEMO_ROW = {
  deviceCode: 'DEMO-001',
  deviceName: '演示设备',
  id: '1001',
  productId: '9100001',
  status: 1,
};

vi.mock('#/api/iot/realtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot/realtime')>();
  class FakeIotRealtimeClient {
    connect() {}

    dispose() {}
  }
  return { ...actual, IotRealtimeClient: FakeIotRealtimeClient };
});

/** 实时订阅打桩：本用例只关心深链，不建立真实 SSE。 */
vi.mock('../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  return {
    useIotRealtime: () => ({
      authError: ref(''),
      error: ref(''),
      onEvent: () => () => {},
      state: ref('closed'),
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

/**
 * 抽屉桩：记录 host（connectedComponent）抽屉的 options 与 api，
 * 并让 open/close 回调 host 的 onOpenChange —— 与 vben 的抽屉状态机同构
 * （否则「关闭抽屉清 URL」这条链路在用例里根本不会被触发）。
 */
vi.mock('@vben/common-ui', async () => {
  const { defineComponent: define, h: render } = await import('vue');
  return {
    Page: define({
      name: 'PageStub',
      setup:
        (_props, { slots }) =>
        () =>
          render('div', { class: 'page-stub' }, slots.default?.()),
    }),
    useVbenDrawer: (options: any = {}) => {
      const isHost = Boolean(options.connectedComponent);
      const api: any = {
        close: vi.fn(() => {
          options.onOpenChange?.(false);
        }),
        getData: vi.fn(),
        open: vi.fn(() => {
          options.onOpenChange?.(true);
        }),
        setData: vi.fn(() => api),
        setState: vi.fn(() => api),
      };
      if (isHost) {
        drawerHosts.push({ api, options });
      }
      return [
        define({ name: 'DrawerStub', setup: () => () => null }),
        api,
      ];
    },
  };
});

/**
 * 表格适配层桩：
 * - Grid 只渲染「行操作」槽并给一条演示行（深链写入 query 需要真实点击路径）；
 * - VbenTableAction 把 actions/dropdown-actions 渲染成按钮，用例按文案点击。
 */
vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    props: {
      actions: { default: () => [], type: Array },
      dropdownActions: { default: () => [], type: Array },
    },
    setup(props: any) {
      return () =>
        h(
          'div',
          { class: 'table-action-stub' },
          [...(props.actions ?? []), ...(props.dropdownActions ?? [])].map(
            (action: any) =>
              h(
                'button',
                {
                  'data-testid': `row-action-${action.text}`,
                  onClick: action.onClick,
                },
                action.text,
              ),
          ),
        );
    },
  }),
  useVbenVxeGrid: (options: any) => {
    void options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup:
        (_props: unknown, { slots }: any) =>
        () =>
          h('div', { class: 'grid-stub' }, [
            slots['toolbar-tools']?.(),
            slots.action?.({ row: DEMO_ROW }),
          ]),
    });
    return [GridStub, gridApiMock];
  },
}));

/** vue-router 桩：replace 同步写回 route.query（模拟真实导航，watch 才能被触发）。 */
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  const state = reactive({ query: {} as Record<string, any> });
  routeRef.state = state;
  return {
    useRoute: () => state,
    useRouter: () => ({
      push: vi.fn(),
      replace: (location: any) => {
        routerCalls.replace.push(location);
        state.query = location?.query ?? {};
        return Promise.resolve();
      },
    }),
  };
});

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-device-deeplink' });
});

beforeEach(async () => {
  drawerHosts.length = 0;
  routerCalls.replace.length = 0;
  gridApiMock.query.mockReset();
  gridApiMock.grid.getData.mockReset();
  gridApiMock.grid.getData.mockReturnValue([]);
  mockApi.getActiveAlertCounts.mockReset();
  mockApi.getActiveAlertCounts.mockResolvedValue({});
  mockApi.getDevicePage.mockReset();
  mockApi.getDevicePage.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  });
  routeRef.state.query = {};
  const { useAccessStore } = await import('@vben/stores');
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush(times = 12) {
  for (let index = 0; index < times; index += 1) {
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

/**
 * 按 connectedComponent 的组件名取宿主抽屉。
 *
 * 不按声明顺序取：`use-device-batch` 会先声明批量标签/批量命令两个 connected 抽屉
 * （顺序：batch-tags → batch-command → form → detail → availability → series），
 * 按序取会把断言打到错误抽屉上（用例假红/假绿）。组件名来自 SFC 编译后的 `__name`。
 */
function hostByName(name: string) {
  const host = drawerHosts.find(
    (item) => (item.options.connectedComponent?.__name ?? '') === name,
  );
  expect(host, `找不到 connectedComponent=${name} 的抽屉宿主`).toBeTruthy();
  return host;
}

function detailHost() {
  return hostByName('detail');
}

function formHost() {
  return hostByName('form');
}

function lastReplaceQuery() {
  return routerCalls.replace.at(-1)?.query;
}

describe('深链：带 ?deviceId= 挂载自动打开详情', () => {
  it('★ 列表里有该设备 ⇒ 用完整行打开抽屉（query 保持）', async () => {
    gridApiMock.grid.getData.mockReturnValue([DEMO_ROW]);
    routeRef.state.query = { deviceId: '1001' };

    await mountPage();

    const host = detailHost();
    expect(host.api.setData).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: '演示设备', id: '1001' }),
    );
    expect(host.api.open).toHaveBeenCalledTimes(1);
    expect(routeRef.state.query.deviceId).toBe('1001');
    // 挂载即消费：不需要再 replace 一次同样的 query
    expect(routerCalls.replace).toHaveLength(0);
  });
});

describe('深链：unknown id 的明确行为', () => {
  it('★ 未知/不在当前页的 id ⇒ 仍按 {id} 打开详情（不静默忽略、不伪造档案字段）', async () => {
    routeRef.state.query = { deviceId: 'missing-9001' };

    await mountPage();

    const host = detailHost();
    expect(host.api.setData).toHaveBeenCalledWith({ id: 'missing-9001' });
    expect(host.api.open).toHaveBeenCalledTimes(1);
    // URL 保持（刷新/分享仍指向同一设备；详情页自己的失败态负责告知用户）
    expect(routeRef.state.query.deviceId).toBe('missing-9001');
  });
});

describe('深链：打开/关闭抽屉与 URL 双向同步', () => {
  it('★ 点行内「详情」⇒ replace 写入 deviceId；关闭抽屉 ⇒ 移除 deviceId', async () => {
    gridApiMock.grid.getData.mockReturnValue([DEMO_ROW]);
    const { container } = await mountPage();
    const host = detailHost();
    expect(routerCalls.replace).toHaveLength(0);

    // 行内「设备详情」入口（文案来自 page.iot.device.detail）
    const detailButton = container.querySelector<HTMLButtonElement>(
      `[data-testid="row-action-${$t('page.iot.device.detail')}"]`,
    );
    expect(detailButton, '行内缺少「设备详情」入口').toBeTruthy();
    detailButton?.click();
    await flush();
    expect(host.api.setData).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1001' }),
    );
    expect(lastReplaceQuery()).toEqual({ deviceId: '1001' });
    // 用 replace 而不是 push：不产生历史栈垃圾（后退仍是上一页）
    expect(routerCalls.replace.at(-1)?.query.deviceId).toBe('1001');

    // 模拟用户关闭抽屉（vben 会回调 host onOpenChange(false)）
    host.options.onOpenChange(false);
    await flush();
    expect(lastReplaceQuery()).toEqual({});
    expect(routeRef.state.query.deviceId).toBeUndefined();
  });
});

describe('深链：外部 URL 变化（浏览器后退/前进）同步抽屉', () => {
  it('★ query 出现设备 ⇒ 自动打开；query 被移除 ⇒ 关闭抽屉', async () => {
    await mountPage();
    const host = detailHost();
    expect(host.api.setData).not.toHaveBeenCalled();

    // 「前进」到一条深链
    routeRef.state.query = { deviceId: '1002' };
    await flush();
    expect(host.api.setData).toHaveBeenCalledWith({ id: '1002' });
    expect(host.api.open).toHaveBeenCalledTimes(1);

    // 「后退」离开深链 ⇒ 抽屉必须关闭（否则 URL 与界面不一致）
    routeRef.state.query = {};
    await flush();
    expect(host.api.close).toHaveBeenCalledTimes(1);
  });
});

describe('深链：与 ?productId= / ?action=create 共存', () => {
  it('★ only productId ⇒ 不弹任何抽屉、不改 deviceId', async () => {
    routeRef.state.query = { productId: 'p9' };
    await mountPage();

    expect(formHost().api.open).not.toHaveBeenCalled();
    expect(detailHost().api.open).not.toHaveBeenCalled();
    expect(routeRef.state.query).toEqual({ productId: 'p9' });
    expect(routerCalls.replace).toHaveLength(0);
  });

  it('★ action=create 优先：不叠加详情抽屉，一次性参数照旧清理', async () => {
    routeRef.state.query = {
      action: 'create',
      deviceId: '1001',
      productId: 'p9',
    };
    await mountPage();

    // 新建表单打开并预选产品（既有链路不变）
    expect(formHost().api.setData).toHaveBeenCalledWith({ productId: 'p9' });
    expect(formHost().api.open).toHaveBeenCalledTimes(1);
    // 详情不叠加打开（避免两个抽屉盖在一起）
    expect(detailHost().api.open).not.toHaveBeenCalled();
    // 一次性参数消费后清空（含 deviceId）
    expect(lastReplaceQuery()).toEqual({});
  });
});

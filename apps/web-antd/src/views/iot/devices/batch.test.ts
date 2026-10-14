import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';
import { useAccessStore } from '@vben/stores';

import { message } from 'ant-design-vue';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import DevicesPage from './index.vue';

/**
 * 设备台账「批量启停/删除」用例。
 *
 * 为什么必须有：批量写入口一次作用于多台设备（停用会停止采集、删除不可恢复），
 * 一旦参数发错（ids/status 反了、空选也发请求、失败还清空勾选）就是批量事故。
 * 这里锁四件事：
 * 1. **权限门禁**：按钮按 `iot:device:update` / `iot:device:delete` 显示；
 * 2. **禁用态**：未勾选时按钮禁用且点击不发请求；
 * 3. **请求参数与善后**：ids/status 原样、成功后清空勾选（ref + vxe 视觉态）并刷新；
 * 4. **失败语义**：原样展示后端 message，不清空勾选、不刷新（不把失败当成功）。
 *
 * 组件用桩替换抽屉/表格（真实 vxe 挂载不必要且慢），但 i18n、权限指令、antd 都是真的。
 */

const { captured, gridApiMock, mockApi, requestClientMock } = vi.hoisted(
  () => ({
    captured: { options: null as any },
    gridApiMock: {
      grid: { clearCheckboxRow: vi.fn() },
      query: vi.fn(),
    },
    mockApi: {
      batchDeleteDevices: vi.fn(),
      batchUpdateDeviceStatus: vi.fn(),
      getActiveAlertCounts: vi.fn(),
      getDevicePage: vi.fn(),
    },
    requestClientMock: {
      delete: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    },
  }),
);

vi.mock('#/api/request', () => ({ requestClient: requestClientMock }));

// 批量端点单独从全路径导入（见 index.vue 注释）：这里对应地只桩这一个模块。
vi.mock('#/api/iot/device', () => ({
  batchDeleteDevices: (...args: unknown[]) =>
    mockApi.batchDeleteDevices(...args),
  batchUpdateDeviceStatus: (...args: unknown[]) =>
    mockApi.batchUpdateDeviceStatus(...args),
}));

// 页面其余设备 API 仍走聚合器；固定 mock 与 status-toggle.test.ts 同口径。
vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  getActiveAlertCounts: (...args: unknown[]) =>
    mockApi.getActiveAlertCounts(...args),
  getDeviceNameMap: vi.fn(),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getPublishedProductOptions: vi.fn(),
  updateDeviceStatus: vi.fn(),
}));

vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.()),
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
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      emits: ['checkbox-change'],
      setup: (_props: unknown, { emit, slots }: any) => {
        return () =>
          h('div', { class: 'grid-stub' }, [
            // 模拟 vxe 勾选两行后 emit checkbox-change
            h(
              'button',
              {
                class: 'emit-checkbox',
                'data-testid': 'emit-checkbox',
                onClick: () =>
                  emit('checkbox-change', {
                    records: [{ id: '1001' }, { id: '1002' }],
                  }),
              },
              'select',
            ),
            slots['toolbar-tools']?.(),
          ]);
      },
    });
    return [GridStub, gridApiMock];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-device-batch' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  for (const fn of Object.values(requestClientMock)) fn.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.grid.clearCheckboxRow.mockReset();
  captured.options = null;
  // 默认全权限；权限用例会自行收窄后再挂载
  useAccessStore().setAccessCodes(['*:*:*']);
});

afterEach(() => {
  vi.restoreAllMocks();
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

function bizFailure(code: number, messageText: string) {
  return Object.assign(new Error(messageText), {
    response: { data: { code, data: null, message: messageText } },
  });
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

/** 点表格桩的按钮，模拟 vxe 勾选 1001/1002 两行。 */
async function selectRows(container: HTMLElement) {
  (
    container.querySelector(
      '[data-testid="emit-checkbox"]',
    ) as HTMLButtonElement
  ).click();
  await nextTick();
}

function batchButton(container: HTMLElement, name: string) {
  return container.querySelector(
    `[data-testid="batch-${name}"]`,
  ) as HTMLButtonElement | null;
}

/** 沿 Vue 内部组件链找指定名字的祖先组件（Popconfirm 的浮层只在展开时挂载，查 DOM 不可靠）。 */
function findAncestorComponent(el: Element, name: string): any | null {
  let node: any = (el as any).__vueParentComponent;
  while (node) {
    const typeName = node.type?.name ?? node.type?.__name ?? '';
    if (typeName.includes(name)) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** 组件实例上的 prop 可能落在 `props`（声明过的）或 `vnode.props`（透传的监听器）里。 */
function componentProp(node: any, name: string) {
  return node?.props?.[name] ?? node?.vnode?.props?.[name];
}

/** 触发 Popconfirm 的 confirm 回调（等价用户点确认按钮；浮层 DOM 走 Teleport 且懒挂载）。 */
function triggerConfirm(node: any) {
  const handler = componentProp(node, 'onConfirm');
  if (typeof handler === 'function') {
    handler();
    return;
  }
  node?.emit?.('confirm');
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

describe('设备台账批量运维', () => {
  it('★ 勾选列与 checkboxConfig 显式接线（缺了它们批量按钮就是摆设）', async () => {
    await mountPage();
    const columns = captured.options?.gridOptions?.columns ?? [];
    expect(columns.some((column: any) => column.type === 'checkbox')).toBe(
      true,
    );
    expect(captured.options?.gridOptions?.checkboxConfig).toBeTruthy();
  });

  it('★ 批量按钮按权限显示：只有 update 权限时不渲染「批量删除」', async () => {
    useAccessStore().setAccessCodes(['iot:device:update']);

    const container = await mountPage();

    expect(batchButton(container, 'enable'), '缺少批量启用').toBeTruthy();
    expect(batchButton(container, 'disable'), '缺少批量停用').toBeTruthy();
    expect(
      batchButton(container, 'delete'),
      '无 iot:device:delete 权限却渲染了批量删除',
    ).toBeNull();
  });

  it('★ 未勾选任何行时批量按钮禁用，点击不发请求', async () => {
    const container = await mountPage();

    for (const name of ['enable', 'disable', 'delete']) {
      const button = batchButton(container, name);
      expect(button, `缺少批量按钮 ${name}`).toBeTruthy();
      expect(button?.hasAttribute('disabled'), `${name} 未禁用`).toBe(true);
    }

    batchButton(container, 'enable')?.click();
    await flush();
    expect(mockApi.batchUpdateDeviceStatus).not.toHaveBeenCalled();
    expect(mockApi.batchDeleteDevices).not.toHaveBeenCalled();
  });

  it('★ 批量启用：ids + status=1 原样提交，成功后清空勾选并刷新', async () => {
    const container = await mountPage();
    await selectRows(container);
    expect(batchButton(container, 'enable')?.hasAttribute('disabled')).toBe(
      false,
    );

    batchButton(container, 'enable')?.click();
    await flush();

    expect(mockApi.batchUpdateDeviceStatus).toHaveBeenCalledTimes(1);
    expect(mockApi.batchUpdateDeviceStatus).toHaveBeenCalledWith(
      ['1001', '1002'],
      1,
    );
    // 成功善后：清空 vxe 勾选 + 刷新列表 + 按钮回到禁用态（selectedIds 已清）
    expect(gridApiMock.grid.clearCheckboxRow).toHaveBeenCalledTimes(1);
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
    expect(batchButton(container, 'enable')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('★ 批量停用：Popconfirm 讲清停止采集后果，确认后 status=0', async () => {
    const container = await mountPage();
    await selectRows(container);

    const disableButton = batchButton(container, 'disable');
    expect(disableButton).toBeTruthy();
    const popconfirm = findAncestorComponent(
      disableButton as Element,
      'Popconfirm',
    );
    expect(popconfirm, '批量停用必须由 Popconfirm 包裹').toBeTruthy();
    // 未点确认不得发请求
    expect(mockApi.batchUpdateDeviceStatus).not.toHaveBeenCalled();
    // 文案必须解释后果（i18n 未合并时回落 key，同样可识别）
    expect(String(componentProp(popconfirm, 'title') ?? '')).toMatch(
      /停止采集|batchDisableConfirm/,
    );

    // 直接触发 Popconfirm 的 confirm 回调（等价于用户点确认按钮）
    triggerConfirm(popconfirm);
    await flush();

    expect(mockApi.batchUpdateDeviceStatus).toHaveBeenCalledWith(
      ['1001', '1002'],
      0,
    );
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('★ 批量删除：Popconfirm 讲清不可恢复，确认后调删除接口并清空刷新', async () => {
    const container = await mountPage();
    await selectRows(container);

    const deleteButton = batchButton(container, 'delete');
    expect(deleteButton).toBeTruthy();
    const popconfirm = findAncestorComponent(
      deleteButton as Element,
      'Popconfirm',
    );
    expect(popconfirm, '批量删除必须由 Popconfirm 包裹').toBeTruthy();
    expect(mockApi.batchDeleteDevices).not.toHaveBeenCalled();
    expect(String(componentProp(popconfirm, 'title') ?? '')).toMatch(
      /不可恢复|batchDeleteConfirm/,
    );

    triggerConfirm(popconfirm);
    await flush();

    expect(mockApi.batchDeleteDevices).toHaveBeenCalledWith(['1001', '1002']);
    expect(gridApiMock.grid.clearCheckboxRow).toHaveBeenCalledTimes(1);
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('★ 批量失败：原样展示后端 message，不清空勾选、不刷新', async () => {
    const container = await mountPage();
    await selectRows(container);

    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => ({}) as any);
    mockApi.batchUpdateDeviceStatus.mockRejectedValueOnce(
      bizFailure(50_001, '批量停用被拒绝：设备不属于当前租户'),
    );

    batchButton(container, 'enable')?.click();
    await flush();

    expect(errorSpy).toHaveBeenCalledWith('批量停用被拒绝：设备不属于当前租户');
    // 失败不假装成功：不刷新、不清勾选（用户可直接重试）
    expect(gridApiMock.query).not.toHaveBeenCalled();
    expect(gridApiMock.grid.clearCheckboxRow).not.toHaveBeenCalled();
    expect(batchButton(container, 'enable')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('★ 翻页/筛选触发新查询时清空旧勾选（不会误操作上一页设备）', async () => {
    const container = await mountPage();
    await selectRows(container);
    expect(batchButton(container, 'enable')?.hasAttribute('disabled')).toBe(
      false,
    );

    mockApi.getDevicePage.mockResolvedValueOnce({ items: [], total: '0' });
    const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
    expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
    await query({ page: { currentPage: 2, pageSize: 10 } });
    await nextTick();

    // 新查询开始即清空 selectedIds ⇒ 批量按钮回到禁用态
    expect(batchButton(container, 'enable')?.hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('★ API 契约：批量启停走 PUT /batch/status、批量删除走 POST /batch/delete', async () => {
    const actual =
      await vi.importActual<typeof import('#/api/iot/device')>(
        '#/api/iot/device',
      );

    await actual.batchUpdateDeviceStatus(['1001', '1002'], 0);
    expect(requestClientMock.put).toHaveBeenCalledWith(
      '/iot/devices/batch/status',
      { ids: ['1001', '1002'], status: 0 },
    );

    await actual.batchDeleteDevices(['1001']);
    expect(requestClientMock.post).toHaveBeenCalledWith(
      '/iot/devices/batch/delete',
      { ids: ['1001'] },
    );

    // 空 ids 短路：不发注定无意义的请求
    requestClientMock.put.mockClear();
    requestClientMock.post.mockClear();
    await actual.batchUpdateDeviceStatus([], 1);
    await actual.batchDeleteDevices([]);
    expect(requestClientMock.put).not.toHaveBeenCalled();
    expect(requestClientMock.post).not.toHaveBeenCalled();
  });
});

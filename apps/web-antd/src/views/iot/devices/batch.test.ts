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
      grid: {
        clearCheckboxRow: vi.fn(),
        // 当前页可见行（删除后页码回落要用）；默认空，用例按需设置
        getData: vi.fn((): Record<string, unknown>[] => []),
        // vxe 分页状态；默认不提供（= 不做页码判断），页码用例显式设置
        reactData: undefined as any,
      },
      query: vi.fn(),
      setLoading: vi.fn(),
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

vi.mock('#/api/request', () => ({
  handleSessionExpired: vi.fn(),
  requestClient: requestClientMock,
}));

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
      setup: (_props: unknown, { slots }: any) => {
        // 勾选走 gridEvents.checkboxChange（生产口径）：vben 的 Grid 把未声明 attrs 透传到根 div，
        // vxe 的 checkbox-change 只绑在内层 VxeGrid 上（自定义事件不冒泡）⇒ 模板 @checkbox-change
        // 收不到。用桩 emit 会让用例恒真、掩盖"批量按钮在真实页面恒禁用"这个缺陷。
        const events = options?.gridEvents ?? {};
        return () =>
          h('div', { class: 'grid-stub' }, [
            h(
              'button',
              {
                class: 'emit-checkbox',
                'data-testid': 'emit-checkbox',
                onClick: () =>
                  events.checkboxChange?.({
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
  gridApiMock.setLoading.mockReset();
  gridApiMock.grid.clearCheckboxRow.mockReset();
  gridApiMock.grid.getData.mockReset();
  gridApiMock.grid.getData.mockReturnValue([]);
  gridApiMock.grid.reactData = undefined;
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

describe('查询守卫（P1-3：在途查询不得静默丢弃 + 客户端超时可见）', () => {
  it('★ 在途时点工具栏刷新：意图不被丢弃，本轮结束后补发一次（ajax.query 共 2 次）', async () => {
    await mountPage();
    const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
    expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
    mockApi.getDevicePage.mockResolvedValue({ items: [], total: '0' });

    // 模拟「已有一个查询在途」（vxe 用 reactData.tableLoading 表示在途）
    const reactData = { tableLoading: true };
    gridApiMock.grid.reactData = reactData;
    const inflight = query({ page: { currentPage: 1, pageSize: 10 } });

    // 在途时用户点工具栏刷新：vxe 的 commitProxy 会直接 return（ajax.query 不会被调用），
    // 页面能做的只有通过 gridEvents 登记意图，由守卫在本轮结束后补发。
    captured.options.gridEvents.toolbarButtonClick({ code: 'reload' });
    expect(mockApi.getDevicePage).toHaveBeenCalledTimes(1);

    // 本轮结束（vxe 把 tableLoading 复位）⇒ 守卫补发
    reactData.tableLoading = false;
    await inflight;
    await flush();

    // 补发走 `issue()` ⇒ 直接调 `gridApi.query()`（= 生产里的 commitProxy('query')）。
    // 桩的 gridApi.query 不会真的再进 ajax.query，所以这里断言的是「补发被触发」这件事本身：
    // 在途期间 query 调用数必须是 0（被丢弃），周期结束后必须恰好补发 1 次。
    expect(
      gridApiMock.query,
      '被丢弃的那次刷新必须在周期结束后补发一次',
    ).toHaveBeenCalledTimes(1);
    // 补发期间的可见 loading 要拉起再交还（用户能看见动作被接住）
    expect(gridApiMock.setLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('★ 查到空页但总数 > 0：自动改查最后一页（本页空了 ≠ 没有设备）', async () => {
    await mountPage();
    const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
    // 用户停在第 3 页，数据已被删到只剩 11 条（=> 最后一页是第 2 页）
    const reactData = {
      tablePage: { currentPage: 3, pageSize: 10, total: 25 },
    };
    gridApiMock.grid.reactData = reactData;
    mockApi.getDevicePage.mockResolvedValue({ items: [], total: '11' });

    await query({ page: { currentPage: 3, pageSize: 10 } });

    expect(reactData.tablePage.currentPage, '空页必须改查最后一页').toBe(2);
    await flush();
    // 改页后由守卫补发一次查询（否则页码改了但表格仍是空的）
    expect(gridApiMock.query, '改页后必须重新查询').toHaveBeenCalledTimes(1);
  });

  it('★ 查询客户端超时：不再无限挂起，页面给出可见的「查询超时」并结束 loading', async () => {
    const container = await mountPage();
    // 永不 resolve 的请求（模拟后端挂起/网络黑洞）
    mockApi.getDevicePage.mockImplementation(() => new Promise(() => {}));
    const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;

    let timeoutError: unknown;
    vi.useFakeTimers();
    try {
      const settled = query({ page: { currentPage: 1, pageSize: 10 } }).catch(
        (error: unknown) => {
          timeoutError = error;
        },
      );
      // 守卫的 15s 超时
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      await nextTick();
      expect(
        String((timeoutError as Error | undefined)?.message ?? ''),
        '超时必须抛出（而不是永远挂起）',
      ).toMatch(/查询超时|queryTimeout/);
      expect(container.innerHTML, '超时必须可见，不能只留在控制台').toMatch(
        /查询超时|queryTimeout/,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  it('★ 禁用原因 Tooltip：未勾选时批量按钮外层 Tooltip 写明「请先勾选目标」', async () => {
    const container = await mountPage();
    const button = batchButton(container, 'enable');
    expect(button).toBeTruthy();
    const tooltip = findAncestorComponent(button as Element, 'Tooltip');
    expect(
      tooltip,
      '禁用态必须给出原因（灰按钮不能没有任何解释）',
    ).toBeTruthy();
    expect(String(componentProp(tooltip, 'title') ?? '')).toMatch(
      /请先勾选目标|disabledSelectFirst/,
    );
    // 外层 span 承接鼠标事件（antd 的 disabled 按钮不触发 mouseenter），且可被键盘聚焦
    const wrapper = (button as Element).parentElement as HTMLElement | null;
    expect(wrapper?.getAttribute('tabindex'), '禁用包裹层必须可聚焦').toBe('0');
  });

  it('★ 播报口径：部分未生效时按后端实际台数播报（不报勾选数）', async () => {
    const container = await mountPage();
    await selectRows(container);
    const warnSpy = vi
      .spyOn(message, 'warning')
      .mockImplementation(() => ({}) as any);
    // 勾选 2 台，后端只生效 1 台（另一台已被他人删除 / 状态未变）
    mockApi.batchUpdateDeviceStatus.mockResolvedValueOnce(1);

    batchButton(container, 'enable')?.click();
    await flush();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const text = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(text).toMatch(/未生效|batchPartialDone/);
    expect(text).toContain('1');
  });

  it('★ 播报口径：实际生效 0 台 ⇒ 明确说「没有设备发生变更」', async () => {
    const container = await mountPage();
    await selectRows(container);
    const infoSpy = vi
      .spyOn(message, 'info')
      .mockImplementation(() => ({}) as any);
    mockApi.batchUpdateDeviceStatus.mockResolvedValueOnce(0);

    batchButton(container, 'enable')?.click();
    await flush();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0]?.[0] ?? '')).toMatch(
      /没有设备发生变更|batchNoChange/,
    );
  });

  it('★ 删空当前页 ⇒ 回退到上一页再查询（否则停在空页并误报「还没有设备」）', async () => {
    const container = await mountPage();
    await selectRows(container);
    // 第 2 页、每页 10 条、删除前共 11 条；本页可见 2 行且全部被删 ⇒ 回退到第 1 页
    const tablePage = { currentPage: 2, pageSize: 10, total: 11 };
    gridApiMock.grid.reactData = { tablePage };
    gridApiMock.grid.getData.mockReturnValue([{ id: '1001' }, { id: '1002' }]);
    mockApi.batchDeleteDevices.mockResolvedValueOnce(2);
    const infoSpy = vi
      .spyOn(message, 'info')
      .mockImplementation(() => ({}) as any);

    // Popconfirm 浮层是懒挂载的（Teleport），直接触发 confirm 回调等价用户点「确定」
    triggerConfirm(
      findAncestorComponent(
        batchButton(container, 'delete') as Element,
        'Popconfirm',
      ),
    );
    await flush();

    expect(mockApi.batchDeleteDevices).toHaveBeenCalledWith(['1001', '1002']);
    expect(tablePage.currentPage, '删空本页后必须回退到上一页').toBe(1);
    expect(gridApiMock.query, '回退页码后要重新查询').toHaveBeenCalledTimes(1);
    expect(
      infoSpy.mock.calls.some((call) =>
        String(call[0]).match(/已自动回到上一页|pageRollbackHint/),
      ),
      '回退页码要给可见提示（不能默默跳页）',
    ).toBe(true);
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

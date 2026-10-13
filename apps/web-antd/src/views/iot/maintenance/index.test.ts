import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import MaintenancePage from './index.vue';

/**
 * 维护窗口列表页（`maintenance/index.vue`）的行为用例。
 *
 * 覆盖三块此前无覆盖的逻辑：
 * 1. **三态**：失败不许画成「还没有维护窗口」（该页空态的真实含义是「计划停机不会被排除、
 *    可用率偏低」，把查询失败说成这件事会误导运维）；
 * 2. **设备名解析是展示增强、不是列表前提**：解析失败要回落裸 deviceId 而**不**让整页失败；
 *    且必须**一次批量**解析（N+1 规避）；
 * 3. **交互**：关闭窗口（仅未结束的窗口才有该动作）成功才刷新；空态引导的「接入向导」入口要能打开抽屉。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）。
 */

const { captured, drawerApis, gridApiMock, gridStub, mockApi } = vi.hoisted(() => ({
  captured: { options: null as any },
  /** useVbenDrawer 调用顺序：0=表单，1=接入向导抽屉。 */
  drawerApis: [] as any[],
  gridApiMock: { query: vi.fn() },
  gridStub: { renderAction: false, renderEmpty: false, row: null as any },
  mockApi: {
    closeMaintenanceWindow: vi.fn(),
    getDeviceNameMap: vi.fn(),
    getMaintenanceWindowList: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  closeMaintenanceWindow: (...args: unknown[]) =>
    mockApi.closeMaintenanceWindow(...args),
  getDeviceNameMap: (...args: unknown[]) => mockApi.getDeviceNameMap(...args),
  getMaintenanceWindowList: (...args: unknown[]) =>
    mockApi.getMaintenanceWindowList(...args),
}));

vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', slots.default?.()),
  }),
  useVbenDrawer: () => {
    const api: any = { close: vi.fn(), open: vi.fn(), setData: vi.fn() };
    api.setData.mockReturnValue(api);
    drawerApis.push(api);
    return [
      defineComponent({ name: 'DrawerStub', setup: () => () => null }),
      api,
    ];
  },
}));

vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    props: { actions: { default: () => [], type: Array } },
    setup(props) {
      return () =>
        h(
          'div',
          (props.actions as any[]).map((action) =>
            h(
              'button',
              {
                'data-action': action.text,
                onClick: () => action.popConfirm?.confirm?.(),
              },
              action.text,
            ),
          ),
        );
    },
  }),
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', { class: 'grid-stub' }, [
            slots['toolbar-tools']?.(),
            gridStub.renderEmpty
              ? h('div', { class: 'grid-empty' }, slots.empty?.())
              : undefined,
            gridStub.renderAction && slots.action
              ? h('div', slots.action({ row: gridStub.row }))
              : undefined,
          ]),
    });
    return [GridStub, gridApiMock];
  },
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

const OPEN_WINDOW = { deviceId: 'd-1', endTs: undefined, id: 'w-1' };
const CLOSED_WINDOW = { deviceId: 'd-1', endTs: '2026-01-02 00:00:00', id: 'w-2' };

let mounted: undefined | { app: { unmount: () => void } };

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(MaintenancePage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

async function runQuery() {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return await query({ page: { currentPage: 1, pageSize: 10 } });
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  for (const fn of Object.values(gridApiMock)) fn.mockReset();
  drawerApis.length = 0;
  captured.options = null;
  gridStub.renderAction = false;
  gridStub.renderEmpty = false;
  gridStub.row = null;
  mockApi.getDeviceNameMap.mockResolvedValue({});
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('maintenance/index.vue 三态', () => {
  it('查询失败 ⇒ 原样展示后端 message + 失败标题，且**不出现**「还没有维护窗口」', async () => {
    const backendMessage = '查询被拒绝：无对应权限';
    mockApi.getMaintenanceWindowList.mockRejectedValue(
      bizFailure(40_303, backendMessage),
    );
    gridStub.renderEmpty = true;

    const container = await mountPage();
    await expect(runQuery()).rejects.toThrow(backendMessage);
    await nextTick();

    const html = container.innerHTML;
    expect(html).toContain(backendMessage);
    expect(html).toContain('维护窗口列表加载失败');
    expect(html).not.toContain('还没有维护窗口');
  });

  it('确实没有窗口 ⇒ 展示空态引导（写明「为什么是空的」）且不是失败态', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([]);
    gridStub.renderEmpty = true;

    const container = await mountPage();
    await expect(runQuery()).resolves.toEqual([]);
    await nextTick();

    const html = container.innerHTML;
    expect(html).toContain('还没有维护窗口');
    expect(html).not.toContain('维护窗口列表加载失败');
  });

  it('有数据 ⇒ 补上 deviceName：有 deviceId 用映射名、无 deviceId 标「租户全部设备」', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([
      { deviceId: 'd-1', id: 'w-1' },
      { id: 'w-2' },
    ]);
    mockApi.getDeviceNameMap.mockResolvedValue({ 'd-1': '产线 A 网关' });

    await mountPage();
    const rows = await runQuery();

    expect(rows).toEqual([
      { deviceId: 'd-1', deviceName: '产线 A 网关', id: 'w-1' },
      { deviceName: '租户全部设备', id: 'w-2' },
    ]);
    // N+1 规避：一次批量（只带本页出现过的 deviceId），绝不按行发请求
    expect(mockApi.getDeviceNameMap).toHaveBeenCalledTimes(1);
    expect(mockApi.getDeviceNameMap).toHaveBeenCalledWith(['d-1']);
  });

  it('★ 设备名解析失败 ⇒ 回落到裸 deviceId，**整页列表照旧成功**（不引入新的权限依赖）', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([{ deviceId: 'd-1', id: 'w-1' }]);
    mockApi.getDeviceNameMap.mockRejectedValue(bizFailure(40_303, '无设备列表权限'));

    const container = await mountPage();
    await expect(runQuery()).resolves.toEqual([
      { deviceId: 'd-1', deviceName: 'd-1', id: 'w-1' },
    ]);
    await nextTick();
    expect(container.innerHTML).not.toContain('维护窗口列表加载失败');
  });
});

describe('maintenance/index.vue 交互', () => {
  it('★ 关闭未结束的窗口（确认后）⇒ 调 closeMaintenanceWindow(id) 并刷新', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([OPEN_WINDOW]);
    mockApi.closeMaintenanceWindow.mockResolvedValue(null);
    gridStub.renderAction = true;
    gridStub.row = OPEN_WINDOW;

    const container = await mountPage();
    const btn = container.querySelector(
      'button[data-action="关闭窗口"]',
    ) as HTMLButtonElement;
    expect(btn, '未渲染出「关闭窗口」动作').toBeTruthy();

    btn.click();
    await nextTick();
    await Promise.resolve();

    expect(mockApi.closeMaintenanceWindow).toHaveBeenCalledWith('w-1');
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('关闭失败 ⇒ **不得**刷新（不能把失败当成功）', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([OPEN_WINDOW]);
    mockApi.closeMaintenanceWindow.mockRejectedValue(bizFailure(50_001, '已结束'));
    gridStub.renderAction = true;
    gridStub.row = OPEN_WINDOW;

    const container = await mountPage();
    (
      container.querySelector('button[data-action="关闭窗口"]') as HTMLButtonElement
    ).click();
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();

    expect(gridApiMock.query).not.toHaveBeenCalled();
  });

  it('★ 已结束的窗口（有 endTs）不提供「关闭窗口」动作', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([CLOSED_WINDOW]);
    gridStub.renderAction = true;
    gridStub.row = CLOSED_WINDOW;

    const container = await mountPage();
    expect(container.querySelector('button[data-action="关闭窗口"]')).toBeNull();
  });

  it('工具栏「接入向导」⇒ 打开向导抽屉', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([]);

    const container = await mountPage();
    const guide = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('接入向导'),
    ) as HTMLButtonElement | undefined;
    expect(guide, '未渲染出「接入向导」按钮').toBeTruthy();

    guide?.click();
    await nextTick();
    // 0=表单抽屉，1=接入向导抽屉
    expect(drawerApis[1]?.open).toHaveBeenCalled();
    expect(drawerApis[0]?.open).not.toHaveBeenCalled();
  });

  it('工具栏「声明维护窗口」⇒ 打开表单抽屉且 setData(null)', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([]);

    const container = await mountPage();
    const create = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('声明维护窗口'),
    ) as HTMLButtonElement | undefined;
    expect(create, '未渲染出「声明维护窗口」按钮').toBeTruthy();

    create?.click();
    await nextTick();
    expect(drawerApis[0]?.setData).toHaveBeenCalledWith(null);
    expect(drawerApis[0]?.open).toHaveBeenCalled();
  });

  it('★ 空态引导里的「接入向导」按钮同样能打开抽屉（空态→下一步可达）', async () => {
    mockApi.getMaintenanceWindowList.mockResolvedValue([]);
    gridStub.renderEmpty = true;

    const container = await mountPage();
    await runQuery();
    await nextTick();

    // 工具栏里也有同名按钮 ⇒ 只在空态容器里找
    const guideBtn = container.querySelector(
      '.grid-empty button',
    ) as HTMLButtonElement | null;
    expect(guideBtn).toBeTruthy();

    guideBtn?.click();
    await nextTick();
    expect(drawerApis[1]?.open).toHaveBeenCalled();
  });
});

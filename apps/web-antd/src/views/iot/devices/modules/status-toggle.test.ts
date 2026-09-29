import { createApp, h, nextTick } from 'vue';

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

import DevicesPage from '../index.vue';

/**
 * 设备台账「启停开关」（G7′）的用例。
 *
 * ## 为什么必须有
 *
 * 启停是本批新增的**唯一写入口**，而它的价值全在「联动」上：把 `status` 写进库不算完成，
 * 必须真的让接入侧停止采集——那由后端 `DeviceSpecServiceImpl` 的 `status=1` 过滤负责
 * （该侧由 `DeviceSpecServiceImplTest` 的两个变异哨兵咬住，去掉过滤即转红）。
 * 前端这一侧要守住的是**另外三件事**：
 *
 * 1. **槽真的挂上了**：`status` 列没有 `slots.default` 的话，开关在页面上根本不存在，
 *    用户依然只能用删除设备来停采（正是 G7′ 要消灭的现状）。
 * 2. **码值口径正确**：只有显式 `1` 才算启用（与后端 `EntityStatus` 一致，
 *    `null/undefined` 按启用处理，对齐 DB 默认值）。口径反了会让「已停用」标记画错行。
 * 3. **开关受控**：`checked` 由行的 `status` 决定，不做乐观翻转——
 *    否则慢请求期间界面会先显示一个尚未生效的状态。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让这些用例一起红。
 */

const { captured, statusRow, mockApi } = vi.hoisted(() => ({
  captured: { options: null as any },
  /** 表格桩渲染 `#status` 槽时传给它的行（真实 vxe 也是这么把行传进作用域槽的）。 */
  statusRow: { value: null as any },
  mockApi: {
    getDevicePage: vi.fn(),
    getActiveAlertCounts: vi.fn(),
    updateDeviceStatus: vi.fn(),
    getDeviceNameMap: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  getActiveAlertCounts: (...args: unknown[]) =>
    mockApi.getActiveAlertCounts(...args),
  getDeviceNameMap: (...args: unknown[]) => mockApi.getDeviceNameMap(...args),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getPublishedProductOptions: vi.fn(),
  updateDeviceStatus: (...args: unknown[]) =>
    mockApi.updateDeviceStatus(...args),
}));

vi.mock('@vben/common-ui', () => ({
  Page: {
    name: 'PageStub',
    setup:
      (_props: unknown, { slots }: any) =>
      () =>
        h('div', slots.default?.()),
  },
  useVbenDrawer: () => [
    { name: 'DrawerStub', setup: () => () => null },
    { close: vi.fn(), open: vi.fn(), setData: vi.fn() },
  ],
}));

vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: { name: 'TableActionStub', setup: () => () => null },
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = {
      name: 'GridStub',
      // 把 `#status` 槽用 `statusRow.value` 渲染出来（模拟 vxe 传行对象）
      setup:
        (_props: unknown, { slots }: any) =>
        () =>
          h(
            'div',
            { class: 'status-cell' },
            slots.status?.({ row: statusRow.value }),
          ),
    };
    return [GridStub, { query: vi.fn() }];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let mounted: undefined | { app: { unmount: () => void } };

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-device-status' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getDeviceNameMap.mockResolvedValue({});
  mockApi.getActiveAlertCounts.mockResolvedValue({});
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

/** 挂载设备台账页，并用给定的一行渲染 `#status` 槽，返回该单元格元素。 */
async function renderStatusCell(status: null | number | undefined) {
  statusRow.value = {
    id: '1001',
    deviceCode: 'DEV-001',
    deviceName: '水表-001',
    protocol: 'modbus',
    endpoint: 'tcp://127.0.0.1:15002',
    status,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  await nextTick();
  mounted = { app };
  const cell = container.querySelector('.status-cell');
  expect(cell, '表格桩没有渲染 `#status` 槽').toBeTruthy();
  return cell as HTMLElement;
}

describe('设备台账启停开关（G7′）', () => {
  it('★ `status` 列挂着 default 槽（没有它，页面上就没有启停写入口）', () => {
    // 先挂一次让页面把 gridOptions 交给表格桩
    return renderStatusCell(1).then(() => {
      const columns = captured.options?.gridOptions?.columns ?? [];
      const statusColumn = columns.find((c: any) => c.field === 'status');
      expect(statusColumn, '表格没有 status 列').toBeTruthy();
      expect(
        statusColumn.slots?.default,
        'status 列必须挂 default 槽（开关画在槽里）',
      ).toBe('status');
    });
  });

  it('启用的设备：开关勾选、且不得出现「已停用」标记', async () => {
    const cell = await renderStatusCell(1);
    const switchEl = cell.querySelector('.ant-switch');
    expect(switchEl, '启用行没有渲染开关').toBeTruthy();
    expect(switchEl?.classList.contains('ant-switch-checked')).toBe(true);
    expect(cell.textContent).not.toContain('已停用');
  });

  it('停用的设备：开关不勾选，且出现「已停用」标记', async () => {
    const cell = await renderStatusCell(0);
    const switchEl = cell.querySelector('.ant-switch');
    expect(switchEl, '停用行没有渲染开关').toBeTruthy();
    expect(switchEl?.classList.contains('ant-switch-checked')).toBe(false);
    expect(cell.textContent).toContain('已停用');
  });

  it('★ `status` 缺失时按「启用」处理（对齐 DB 默认值 1，不能画成停用）', async () => {
    const cell = await renderStatusCell(undefined);
    const switchEl = cell.querySelector('.ant-switch');
    expect(switchEl?.classList.contains('ant-switch-checked')).toBe(true);
    expect(cell.textContent).not.toContain('已停用');
  });

  it('★ 停用是破坏性动作 ⇒ 必须由 Popconfirm 包住开关（不是点一下就停采）', async () => {
    const cell = await renderStatusCell(1);
    // ⚠️ 判据不能查 `.ant-popconfirm` DOM：antd 的 Popconfirm **只在展开时才挂载浮层**
    // （且走 Teleport，不在本单元格内），未点击时 DOM 里什么都没有 ⇒ 查 DOM 永远为假，
    // 那样一条「断言必须存在」的用例会变成恒红，而正确实现也会被判失败。
    // 可靠的判据是**组件树**：单元格里的 Switch 必须有一个 Popconfirm 祖先。
    const switchEl = cell.querySelector('.ant-switch');
    expect(switchEl, '启用行没有渲染开关').toBeTruthy();
    // 沿 Vue 的内部 vnode 链向上找 Popconfirm 组件
    let node: any = (switchEl as any).__vueParentComponent;
    const chain: string[] = [];
    while (node) {
      const name = node.type?.name ?? node.type?.__name ?? '';
      if (name) chain.push(name);
      node = node.parent;
    }
    expect(
      chain.some((n) => n.includes('Popconfirm')),
      `开关必须被 Popconfirm 包住（实际祖先链：${chain.join(' > ')}）`,
    ).toBe(true);
    // 未点击确认前**不得**发起任何请求（确认框的作用就是不点不发）
    expect(mockApi.updateDeviceStatus).not.toHaveBeenCalled();
  });
});

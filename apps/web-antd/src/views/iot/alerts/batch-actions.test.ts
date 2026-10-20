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
 * 告警中心「批量处置」生产口径用例（P0-1 / P1-9 / P1-12）。
 *
 * 🔴 为什么要专门守「接线」：vben 的 `<Grid>` 包装组件没有 `defineEmits`，模板上的
 * `@checkbox-change` 会作为 fallthrough attr 落到根 div，而 vxe 的真实勾选事件只经
 * `gridEvents.checkboxChange` 转发（`packages/effects/plugins/src/vxe-table/use-vxe-grid.vue`）。
 * 旧实现两处都写在模板上 ⇒ `selectedIds` 恒空、批量按钮恒禁用，页面看起来完全正常。
 *
 * 因此本文件的 Grid 桩**只通过 `gridEvents` 触发勾选**（不 emit、不碰模板监听）：
 * 若页面把接线改回模板监听，这里会立刻变红——这正是不用「测试里直接 emit」的原因。
 */

const { captured, mockApi, realtimeMock } = vi.hoisted(() => ({
  captured: { optionsList: [] as any[] },
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
    handleSessionExpired: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
    setAlertRulesEnabled: vi.fn(),
    silenceAlerts: vi.fn(),
    updateAlertRule: vi.fn(),
  },
  realtimeMock: {
    authError: null as any,
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

vi.mock('#/api/iot/alert', () => ({
  exportAlertsCsv: vi.fn(),
}));

/** 会话过期入口打桩：只断言「重新登录」按钮真的调用它，不在用例里执行登出。 */
vi.mock('#/api/request', () => ({
  handleSessionExpired: (...args: unknown[]) =>
    mockApi.handleSessionExpired(...args),
}));

/**
 * 实时订阅打桩。
 *
 * `authError` 是本轮新增的对外字段（401→unauthorized / 403→forbidden），页面据此渲染
 * 常驻鉴权失败 Alert；这里提供同形态的 ref，用于断言页面消费契约。
 */
vi.mock('../shared/use-iot-realtime', async () => {
  const { ref } = await import('vue');
  const state = ref('live');
  const error = ref('');
  const authError = ref('');
  realtimeMock.state = state;
  realtimeMock.error = error;
  realtimeMock.authError = authError;
  return {
    useIotRealtime: () => ({
      authError,
      error,
      onEvent: (event: string, handler: (payload: unknown) => void) => {
        const list = realtimeMock.handlers.get(event) ?? [];
        list.push(handler);
        realtimeMock.handlers.set(event, list);
        return () => {
          realtimeMock.handlers.set(
            event,
            (realtimeMock.handlers.get(event) ?? []).filter(
              (item) => item !== handler,
            ),
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

/**
 * 生产口径的 Grid 桩：**只**经 `options.gridEvents.checkboxChange` 触发勾选。
 *
 * 不声明 `emits`、不响应模板 attrs —— 与真实 vben `<Grid>` 的行为一致（模板监听收不到）。
 * 同时渲染 `toolbar-tools` 插槽，让批量按钮真实出现在 DOM 里。
 */
vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    const gridIndex = captured.optionsList.length;
    captured.optionsList.push(options);
    const GridStub = defineComponent({
      name: `GridStub${gridIndex}`,
      setup: (_props: unknown, { slots }: any) => {
        const events = options?.gridEvents ?? {};
        const emitCheckbox = (records: any[]) => {
          // 只有 gridEvents 这条路径；模板上的 @checkbox-change 在本桩上永远不会被调用
          events.checkboxChange?.({ records });
        };
        return () =>
          h('div', { class: `grid-stub-${gridIndex}` }, [
            h(
              'button',
              {
                'data-testid': `grid-checkbox-${gridIndex}`,
                onClick: () =>
                  emitCheckbox(
                    gridIndex === 0
                      ? [{ id: 'a1' }, { id: 'a2' }]
                      : [{ id: 'r1' }, { id: 'r2' }],
                  ),
              },
              'select',
            ),
            slots['toolbar-tools']?.(),
          ]);
      },
    });
    const api = {
      grid: { $el: undefined, reactData: { tableLoading: false } },
      query: vi.fn(),
      setGridOptions: vi.fn(),
      setLoading: vi.fn(),
    };
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
  await initStores(app, { namespace: 'test-alerts-batch' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  realtimeMock.handlers.clear();
  captured.optionsList.length = 0;
  mockApi.getAlertSummary.mockResolvedValue({
    ackedCount: '0',
    activeCount: '2',
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
  mockApi.ackAlerts.mockResolvedValue(2);
  mockApi.silenceAlerts.mockResolvedValue(2);
  mockApi.setAlertRulesEnabled.mockResolvedValue(2);
  mockApi.handleSessionExpired.mockResolvedValue(undefined);
  realtimeMock.state.value = 'live';
  realtimeMock.error.value = '';
  realtimeMock.authError.value = '';
});

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush(times = 12) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  mounted = { app };
  return container;
}

/** 按 `data-testid` 取元素（不依赖按钮文案，i18n 变化不会让用例假红）。 */
function byTestId<T extends HTMLElement>(
  container: HTMLElement,
  id: string,
): null | T {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

/** 点开规则页签（antd Tabs 真实渲染，非激活面板懒加载）。 */
async function openRulesTab(container: HTMLElement) {
  const tabs = [...container.querySelectorAll<HTMLElement>('.ant-tabs-tab')];
  // 规则页签是第二个；用文案匹配更稳（两个页签文案都来自语言包）
  const ruleTab = tabs.find(
    (tab) => tab.textContent?.includes('规则') ?? false,
  );
  expect(ruleTab, '未找到「告警规则」页签').toBeTruthy();
  ruleTab?.click();
  await flush();
}

/**
 * 点开 Popconfirm 并确认。
 *
 * antd 的浮层只在展开时挂载、且走 Teleport 到 body；关闭后旧浮层可能仍留在 DOM（隐藏），
 * 因此必须排除 `.ant-popover-hidden` 并取**最后一个可见**浮层，否则会点到上一次的确认按钮。
 */
function lastVisiblePopover(): HTMLElement | undefined {
  const popovers = [...document.querySelectorAll<HTMLElement>('.ant-popover')];
  // 从后往前找第一个可见浮层：关闭后的旧浮层仍留在 DOM 里（隐藏），
  // 且 antd 的 Popconfirm 只在展开时挂载 ⇒ 「最后一个可见」才是当前这次确认。
  for (let index = popovers.length - 1; index >= 0; index -= 1) {
    const candidate = popovers[index];
    if (candidate && !candidate.classList.contains('ant-popover-hidden')) {
      return candidate;
    }
  }
  return undefined;
}

async function confirmPopconfirm() {
  const popup = lastVisiblePopover();
  expect(popup, '没有出现二次确认浮层').toBeTruthy();
  const okButton = [
    ...(popup?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((button) => button.classList.contains('ant-btn-primary'));
  expect(okButton, '二次确认浮层里没有「确认」按钮').toBeTruthy();
  okButton?.click();
  await flush();
}

describe('告警列表：批量确认 / 批量静默（P0-1 接线）', () => {
  it('★ 勾选后批量按钮可用，点击真的调用 API（接线只走 gridEvents.checkboxChange）', async () => {
    const container = await mountPage();

    const ackButton = byTestId<HTMLButtonElement>(container, 'batch-ack');
    const silenceButton = byTestId<HTMLButtonElement>(
      container,
      'batch-silence',
    );
    expect(ackButton, '批量确认按钮未渲染').toBeTruthy();
    expect(silenceButton, '批量静默按钮未渲染').toBeTruthy();
    // 未勾选：禁用（与旧缺陷一致，这是正常态）
    expect(ackButton?.disabled).toBe(true);
    expect(silenceButton?.disabled).toBe(true);

    // 生产口径勾选：只有 gridEvents 这条路径能到达页面
    byTestId<HTMLButtonElement>(container, 'grid-checkbox-0')?.click();
    await flush();

    // 🔴 关键断言：selectedIds 非空 ⇒ 按钮可用（旧实现在这里恒为 true/disabled）
    expect(byTestId<HTMLButtonElement>(container, 'batch-ack')?.disabled).toBe(
      false,
    );
    expect(
      byTestId<HTMLButtonElement>(container, 'batch-silence')?.disabled,
    ).toBe(false);

    byTestId<HTMLButtonElement>(container, 'batch-ack')?.click();
    await flush();
    expect(mockApi.ackAlerts).toHaveBeenCalledTimes(1);
    expect(mockApi.ackAlerts).toHaveBeenCalledWith(['a1', 'a2']);

    // 二次勾选后静默：确认批量静默也走同一套接线（不能只测一个按钮）
    byTestId<HTMLButtonElement>(container, 'grid-checkbox-0')?.click();
    await flush();
    byTestId<HTMLButtonElement>(container, 'batch-silence')?.click();
    await flush();
    expect(mockApi.silenceAlerts).toHaveBeenCalledTimes(1);
    expect(mockApi.silenceAlerts).toHaveBeenCalledWith(['a1', 'a2'], 60);
  });
});

describe('告警规则：批量启用 / 停用（P0-1 + P1-9 + P1-12）', () => {
  it('★ 勾选后批量按钮可用，且必须先二次确认（Popconfirm）才调用 API', async () => {
    const container = await mountPage();
    await openRulesTab(container);

    const enableButton = byTestId<HTMLButtonElement>(
      container,
      'batch-rule-enable',
    );
    const disableButton = byTestId<HTMLButtonElement>(
      container,
      'batch-rule-disable',
    );
    expect(enableButton, '批量启用按钮未渲染').toBeTruthy();
    expect(disableButton, '批量停用按钮未渲染').toBeTruthy();
    expect(enableButton?.disabled).toBe(true);
    expect(disableButton?.disabled).toBe(true);

    // 生产口径勾选（Grid 桩只经 gridEvents.checkboxChange 转发）
    byTestId<HTMLButtonElement>(container, 'grid-checkbox-1')?.click();
    await flush();
    expect(
      byTestId<HTMLButtonElement>(container, 'batch-rule-enable')?.disabled,
    ).toBe(false);
    expect(
      byTestId<HTMLButtonElement>(container, 'batch-rule-disable')?.disabled,
    ).toBe(false);

    // 停用是危险操作：第一次点击只弹确认，**不得**直接发请求
    byTestId<HTMLButtonElement>(container, 'batch-rule-disable')?.click();
    await flush();
    expect(mockApi.setAlertRulesEnabled).not.toHaveBeenCalled();
    // 确认文案里的条数必须取「已选数」（2 条）
    expect(lastVisiblePopover()?.textContent ?? '').toContain('2');
    await confirmPopconfirm();
    expect(mockApi.setAlertRulesEnabled).toHaveBeenCalledTimes(1);
    expect(mockApi.setAlertRulesEnabled).toHaveBeenCalledWith(
      ['r1', 'r2'],
      false,
    );

    // 启用同样要确认（两个按钮都要有，不是只给停用加）
    byTestId<HTMLButtonElement>(container, 'grid-checkbox-1')?.click();
    await flush();
    byTestId<HTMLButtonElement>(container, 'batch-rule-enable')?.click();
    await flush();
    expect(mockApi.setAlertRulesEnabled).toHaveBeenCalledTimes(1);
    await confirmPopconfirm();
    expect(mockApi.setAlertRulesEnabled).toHaveBeenCalledTimes(2);
    expect(mockApi.setAlertRulesEnabled).toHaveBeenLastCalledWith(
      ['r1', 'r2'],
      true,
    );
  });
});

describe('实时流鉴权失败：页面必须常驻可见（P1-1），401 给重新登录入口', () => {
  it('★ unauthorized ⇒ 常驻 Alert + 「重新登录」按钮调用 handleSessionExpired', async () => {
    const container = await mountPage();
    realtimeMock.authError.value = 'unauthorized';
    await flush();

    const html = container.innerHTML;
    expect(html).toContain('实时连接鉴权失败');
    const reloginButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => (button.textContent ?? '').includes('重新登录'));
    expect(reloginButton, '缺少「重新登录」按钮').toBeTruthy();

    reloginButton?.click();
    await flush();
    expect(mockApi.handleSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('★ forbidden ⇒ 只说明无实时权限，不出现「重新登录」按钮（登出解决不了 403）', async () => {
    const container = await mountPage();
    realtimeMock.authError.value = 'forbidden';
    await flush();

    const html = container.innerHTML;
    expect(html).toContain('无实时数据权限');
    const reloginButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => (button.textContent ?? '').includes('重新登录'));
    expect(reloginButton).toBeUndefined();
  });
});

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

import AlertsPage from './index.vue';

/**
 * 告警中心「首次越界时间」筛选的**真实 vxe 接线**用例。
 *
 * 为什么必须用真实 vxe：`submitOnChange` 的链路是
 * 「表单值变化 → 防抖 → `formApi.validateAndSubmit()` → 校验通过才 `handleSubmit`
 * → `gridApi.reload(formValues)` → proxy `ajax.query`」，其中「校验失败是否会阻止查询」
 * 「reload 是否回第 1 页」都发生在 vxe/表单内部，用桩表格自答自话证明不了任何事。
 *
 * 守门的不变量：
 * 1. 选了范围 ⇒ 请求带 `from/to`，格式必须是 `yyyy-MM-dd HH:mm:ss`；
 * 2. 起点 > 终点 ⇒ **不发请求** + 表单项就地提示（阻止查询，不是发出去再报错）；
 * 3. 清空范围 ⇒ 请求不再带 from/to（空值不传参）；
 * 4. 筛选变化 ⇒ 回到第 1 页（vxe `reload` 语义），且与既有 state 筛选共存。
 */
const { captured, mockApi } = vi.hoisted(() => ({
  captured: { apis: [] as any[] },
  mockApi: {
    ackAlerts: vi.fn(),
    getAlertPage: vi.fn(),
    getAlertRulePage: vi.fn(),
    getAlertSummary: vi.fn(),
    getDeviceOptions: vi.fn(),
    getDeviceSeries: vi.fn(),
    getPublishedProductOptions: vi.fn(),
    listProperties: vi.fn(),
    setAlertRulesEnabled: vi.fn(),
    silenceAlerts: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  ackAlerts: (...args: unknown[]) => mockApi.ackAlerts(...args),
  getAlertPage: (...args: unknown[]) => mockApi.getAlertPage(...args),
  getAlertRulePage: (...args: unknown[]) => mockApi.getAlertRulePage(...args),
  getAlertSummary: (...args: unknown[]) => mockApi.getAlertSummary(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
  getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  getPublishedProductOptions: (...args: unknown[]) =>
    mockApi.getPublishedProductOptions(...args),
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  setAlertRulesEnabled: (...args: unknown[]) =>
    mockApi.setAlertRulesEnabled(...args),
  silenceAlerts: (...args: unknown[]) => mockApi.silenceAlerts(...args),
}));

/** 只把「页面壳」替换成空壳；表格适配器保持真实（被测链路就在里面）。 */
vi.mock('@vben/common-ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
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
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/iot/alerts', query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('#/adapter/vxe-table', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    useVbenVxeGrid: (...args: any[]) => {
      const [Grid, api] = actual.useVbenVxeGrid(...args);
      captured.apis.push(api);
      return [Grid, api];
    },
  };
});

const TIME_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function pageRows(page: number, size: number, total: number) {
  const start = (page - 1) * size;
  const count = Math.max(0, Math.min(size, total - start));
  return {
    items: Array.from({ length: count }, (_v, index) => ({
      deviceCode: `DEV-${start + index}`,
      deviceId: '1',
      deviceName: `设备${start + index}`,
      id: String(start + index + 1),
      severity: 'WARNING',
      state: 'FIRING',
    })),
    page: String(page),
    pageSize: String(size),
    total: String(total),
  };
}

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-alert-time-range' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  captured.apis = [];
  mockApi.getAlertPage.mockImplementation(async (params: any) =>
    pageRows(Number(params?.page ?? 1), Number(params?.pageSize ?? 20), 13),
  );
  mockApi.getAlertRulePage.mockResolvedValue({
    items: [],
    page: '1',
    pageSize: '10',
    total: '0',
  });
  mockApi.getAlertSummary.mockResolvedValue({
    ackedCount: '0',
    activeCount: '0',
    criticalCount: '0',
    resolvedLast24h: '0',
  });
  mockApi.getDeviceOptions.mockResolvedValue([]);
  mockApi.getPublishedProductOptions.mockResolvedValue([]);
  mockApi.listProperties.mockResolvedValue([]);
  mockApi.getDeviceSeries.mockResolvedValue([]);
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

/** `submitOnChange` 的防抖窗口（默认 300ms）之后再把微任务/渲染刷干净。 */
async function waitForAutoSubmit() {
  await new Promise((resolve) => setTimeout(resolve, 450));
  await flush();
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(AlertsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  await flush();
  return container;
}

/** 页面里第一个 grid 是告警实例表。 */
function instanceApi() {
  const api = captured.apis[0];
  expect(api, '页面没有把实例表交给 useVbenVxeGrid').toBeTruthy();
  return api;
}

/** 走真实表单通道改筛选值（等价于用户在 RangePicker / Select 里改动）。 */
async function setFormValues(values: Record<string, unknown>) {
  await instanceApi().formApi.setValues(values);
  await waitForAutoSubmit();
}

/** 最近一次 `getAlertPage` 的查询参数。 */
function lastQueryParams() {
  const calls = mockApi.getAlertPage.mock.calls;
  expect(calls.length, '没有任何实例查询请求').toBeGreaterThan(0);
  return calls.at(-1)?.[0] as Record<string, any>;
}

describe('首次越界时间：范围并入查询（真实 vxe 表单链路）', () => {
  it('★ 选择范围 ⇒ 请求带 from/to，且格式为 yyyy-MM-dd HH:mm:ss', async () => {
    await mountPage();
    mockApi.getAlertPage.mockClear();

    await setFormValues({
      firstTsRange: ['2026-10-01 00:00:00', '2026-10-02 12:30:00'],
    });

    const params = lastQueryParams();
    expect(params.from).toBe('2026-10-01 00:00:00');
    expect(params.to).toBe('2026-10-02 12:30:00');
    expect(params.from).toMatch(TIME_RANGE_PATTERN);
    expect(params.to).toMatch(TIME_RANGE_PATTERN);
    // 时间范围不是表单字段名的透传：绝不能把 firstTsRange 数组原样发给后端
    expect(params.firstTsRange).toBeUndefined();
  });

  it('★ 与既有 state 筛选共存：同一次请求既有 from/to 又有 state', async () => {
    await mountPage();
    mockApi.getAlertPage.mockClear();

    await setFormValues({
      firstTsRange: ['2026-10-01 00:00:00', '2026-10-02 00:00:00'],
      state: 'FIRING',
    });

    const params = lastQueryParams();
    expect(params.state).toBe('FIRING');
    expect(params.from).toBe('2026-10-01 00:00:00');
    expect(params.to).toBe('2026-10-02 00:00:00');
  });

  it('★ 清空范围 ⇒ 请求不再带 from/to（空值不传参）', async () => {
    const container = await mountPage();
    await setFormValues({
      firstTsRange: ['2026-10-01 00:00:00', '2026-10-02 00:00:00'],
    });
    expect(lastQueryParams().from).toBeDefined();

    mockApi.getAlertPage.mockClear();
    await setFormValues({ firstTsRange: [] });

    const params = lastQueryParams();
    expect('from' in params).toBe(false);
    expect('to' in params).toBe(false);
    // 清空后页面仍是正常列表（不是错误态）
    expect(container.innerHTML).not.toContain(
      $t('page.iot.alert.timeRangeInvalid'),
    );
  });
});

describe('首次越界时间：起点 > 终点必须阻止查询并提示', () => {
  it('★ 非法区间 ⇒ 不发请求 + 表单项就地显示错误文案', async () => {
    const container = await mountPage();
    mockApi.getAlertPage.mockClear();

    await setFormValues({
      firstTsRange: ['2026-10-03 00:00:00', '2026-10-02 00:00:00'],
    });

    // 表单校验失败 ⇒ vxe 的 submit 链路被拦在 handleSubmit 之前，不产生请求
    expect(mockApi.getAlertPage).not.toHaveBeenCalled();
    // 错误提示必须**页面级可见**（不是只在 hover 气泡里、更不是静默拒绝）
    const errorAlert = container.querySelector<HTMLElement>(
      '[data-testid="time-range-error"]',
    );
    expect(errorAlert, '非法时间范围缺少可见提示').toBeTruthy();
    expect(errorAlert?.textContent).toContain(
      $t('page.iot.alert.timeRangeInvalid'),
    );

    // 改回合法范围 ⇒ 提示消失且恢复查询
    mockApi.getAlertPage.mockClear();
    await setFormValues({
      firstTsRange: ['2026-10-01 00:00:00', '2026-10-02 00:00:00'],
    });
    expect(
      container.querySelector('[data-testid="time-range-error"]'),
    ).toBeNull();
    expect(lastQueryParams().from).toBe('2026-10-01 00:00:00');
  });
});

describe('首次越界时间：筛选变化回到第 1 页', () => {
  it('★ 在第 2 页改筛选 ⇒ 查询回 page=1（沿用 vxe reload 语义）', async () => {
    const container = await mountPage();
    const api = instanceApi();
    const pager = api.grid.getProxyInfo().pager;

    // 先翻到第 2 页（真 pager，触发 commitProxy('query')）
    pager.currentPage = 2;
    const pending = api.query();
    await flush();
    await pending;
    await flush();
    expect(lastQueryParams().page).toBe(2);

    mockApi.getAlertPage.mockClear();
    await setFormValues({
      firstTsRange: ['2026-10-01 00:00:00', '2026-10-02 00:00:00'],
    });

    const params = lastQueryParams();
    expect(params.page).toBe(1);
    expect(params.from).toBe('2026-10-01 00:00:00');
    // 翻页回到 1 后分页器状态也必须是 1（DOM/内部状态一致）
    expect(api.grid.getProxyInfo().pager.currentPage).toBe(1);
    expect(container.querySelectorAll('.vxe-body--row').length).toBeGreaterThan(
      0,
    );
  });
});

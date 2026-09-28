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
 * 告警中心列表的**刷新语义**用例（真实 vxe-table，只打桩 `getAlertPage`）。
 *
 * 为什么必须用**真实 vxe**：本页的列表数据**不落在页面自己的 ref 上**，而是由
 * `proxyConfig.ajax.query` 交给 vxe 的 proxy 通道（页面源码里没有任何 `push`/`concat`）。
 * 「刷新会不会让列表越长越长」这个问题，只有在**真表格 + 真 proxy** 下才问得出答案：
 * 用桩表格自答自话时，被测对象是桩自己的 append/replace，结论无效。
 *
 * 守门的不变量：
 * 1. **连续 N 次刷新 ⇒ 行数恒等于本页条数**（不得出现 N × 页大小）；
 * 2. **翻页 / 换页大小 ⇒ 行数等于新的一页**（不得把上一页并进来）；
 * 3. **空页 ⇒ 行数 0 且走空态**（不得留着上一页的行）；
 * 4. **乱序返回不得污染状态**：慢的旧请求（无论成功失败）不许覆盖新请求的结果
 *    —— 这是「同一时刻只能有一个在途请求（后发覆盖前发）」要挡住的真实竞态。
 *
 * 后端已核实是真 `LIMIT` 分页（`AlertInstanceServiceImpl.page` → `selectPage`），
 * 且活动实例有 `uk_alert_active(tenant_id, active_dedup_key)` 唯一索引兜底，
 * 所以「行数 > 本页条数」只可能来自前端把分页结果做了合并。
 */
const { mockApi, captured } = vi.hoisted(() => ({
  captured: { apis: [] as any[] },
  mockApi: {
    ackAlerts: vi.fn(),
    getAlertPage: vi.fn(),
    getAlertRulePage: vi.fn(),
    getAlertSummary: vi.fn(),
    setAlertRulesEnabled: vi.fn(),
    silenceAlerts: vi.fn(),
    getDeviceOptions: vi.fn(),
    getPublishedProductOptions: vi.fn(),
    listProperties: vi.fn(),
    getDeviceSeries: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  ackAlerts: (...args: unknown[]) => mockApi.ackAlerts(...args),
  getAlertPage: (...args: unknown[]) => mockApi.getAlertPage(...args),
  getAlertRulePage: (...args: unknown[]) => mockApi.getAlertRulePage(...args),
  getAlertSummary: (...args: unknown[]) => mockApi.getAlertSummary(...args),
  setAlertRulesEnabled: (...args: unknown[]) =>
    mockApi.setAlertRulesEnabled(...args),
  silenceAlerts: (...args: unknown[]) => mockApi.silenceAlerts(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
  getPublishedProductOptions: (...args: unknown[]) =>
    mockApi.getPublishedProductOptions(...args),
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
}));

/** 只把「页面壳」替换成空壳；**表格适配器保持真实**（这正是被测链路）。 */
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

/**
 * 包一层真实 `useVbenVxeGrid`，把页面内部的 gridApi 抓出来。
 * 「点工具栏刷新」「翻页」在真表格里最终都落到 `gridApi.query()` / pager 的
 * `commitProxy('query')`，所以这样触发最忠实。
 */
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

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */

/** 按**真实分页语义**生成一页数据：`total` 决定最后一页有几条。 */
function pageOf(page: number, size: number, total: number) {
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
      triggerValue: '88',
    })),
    page: String(page),
    pageSize: String(size),
    total: String(total),
  };
}

/** 手动可控的 promise（用来制造「乱序返回」）。 */
function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {
    reject = rej;
    resolve = res;
  });
  return { promise, reject, resolve };
}

/** 让已排队的微任务/渲染跑完（不等待被卡的请求）。 */
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  await nextTick();
  await nextTick();
}

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  // 页面把两个 TabPane 都挂在权限码上：不放开则整页不渲染
  useAccessStore().setAccessCodes(['*:*:*']);
});

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  captured.apis = [];
  mockApi.getAlertSummary.mockResolvedValue({
    ackedCount: '0',
    activeCount: '0',
    criticalCount: '0',
    resolvedLast24h: '0',
  });
  mockApi.getAlertRulePage.mockResolvedValue({
    items: [],
    page: '1',
    pageSize: '10',
    total: '0',
  });
  mockApi.ackAlerts.mockResolvedValue(0);
  mockApi.silenceAlerts.mockResolvedValue(0);
  mockApi.setAlertRulesEnabled.mockResolvedValue(0);
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

/** 挂载页面并等真实 vxe 把表格挂上来。 */
async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(AlertsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  await nextTick();
  await flush();
  return { app, container };
}

/** 页面里的**第一个** grid 是告警实例表（第二个是规则表）。 */
function instanceApi() {
  const api = captured.apis[0];
  expect(api, '页面没有把实例表交给 useVbenVxeGrid').toBeTruthy();
  return api;
}

/** 真表格当前承载的行数（DOM 行数一并核对，避免只看内部字段）。 */
function rowCount(container: HTMLElement) {
  const grid = instanceApi().grid;
  const data = typeof grid?.getData === 'function' ? grid.getData() : undefined;
  const internal = Array.isArray(data)
    ? data.length
    : (grid?.getTableData?.()?.fullData?.length ?? 0);
  const dom = container.querySelectorAll('.vxe-body--row').length;
  expect(dom, 'DOM 行数与内部行数必须一致').toBe(internal);
  return internal;
}

/** 真 pager 上的当前页信息（页面请求参数就是它）。 */
function pager() {
  return instanceApi().grid.getProxyInfo().pager;
}

/** 走页面真实入口刷新（等价于点工具栏刷新按钮）。 */
async function refresh() {
  const promise = instanceApi().query();
  await flush();
  return promise;
}

describe('告警中心列表：刷新 = 整体替换（不得生长）', () => {
  it('★ 连续 5 次刷新 ⇒ 行数恒等于本页条数（不是 5 × 页大小）', async () => {
    mockApi.getAlertPage.mockImplementation(async (params: any) =>
      pageOf(Number(params?.page ?? 1), Number(params?.pageSize ?? 20), 137),
    );

    const handle = await mountPage();
    mounted = handle;
    const size = Number(pager().pageSize);
    expect(size).toBeGreaterThan(0);

    for (let i = 1; i <= 5; i += 1) {
      await refresh();
      expect(rowCount(handle.container), `第 ${i} 次刷新后行数`).toBe(size);
    }
  });

  it('★ 翻页 ⇒ 行数等于新页条数（不合并上一页）', async () => {
    let asked = 1;
    mockApi.getAlertPage.mockImplementation(async (params: any) => {
      asked = Number(params?.page ?? 1);
      const size = Number(params?.pageSize ?? 20);
      // total = 一页 + 3 ⇒ 第 2 页必然只有 3 条
      return pageOf(asked, size, size + 3);
    });

    const handle = await mountPage();
    mounted = handle;
    const size = Number(pager().pageSize);
    await refresh();
    expect(rowCount(handle.container)).toBe(size);

    // 走真 pager：改当前页 → 触发 commitProxy('query')
    pager().currentPage = 2;
    await refresh();
    expect(asked).toBe(2);
    expect(rowCount(handle.container), '第 2 页只有 3 条').toBe(3);
  });

  it('★ 空页 ⇒ 行数 0 且显示空态（不残留上一页的行）', async () => {
    mockApi.getAlertPage.mockImplementation(async (params: any) =>
      pageOf(Number(params?.page ?? 1), Number(params?.pageSize ?? 20), 53),
    );

    const handle = await mountPage();
    mounted = handle;
    await refresh();
    expect(rowCount(handle.container)).toBeGreaterThan(0);

    // 换筛选条件后没有任何告警
    mockApi.getAlertPage.mockImplementation(async () => ({
      items: [],
      page: '1',
      pageSize: String(pager().pageSize),
      total: '0',
    }));
    await refresh();
    expect(rowCount(handle.container), '空页必须清空').toBe(0);
    expect(handle.container.innerHTML).toContain('当前筛选条件下暂无告警');
  });
});

describe('告警中心列表：至多一个在途请求（并发守卫）', () => {
  it('★ 前一个查询还在途时再点刷新 ⇒ 不会出现两个 ajax.query 同时在途', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const stale = deferred<any>();
    mockApi.getAlertPage.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await stale.promise;
      } finally {
        inFlight -= 1;
      }
    });

    const handle = await mountPage();
    mounted = handle;

    const first = refresh(); // 慢请求，占住在途位
    const second = refresh(); // 在途期间再点一次
    await flush();

    // vxe `commitProxy` 在 `tableLoading` 期间对再来的 query 直接 return ⇒ 天然不并发
    expect(maxInFlight).toBe(1);

    stale.resolve(pageOf(1, Number(pager().pageSize), 137) as any as never);
    await Promise.allSettled([first, second]);
    await flush();
    expect(maxInFlight).toBe(1);
  });

  it('★ 在途时再刷新 ⇒ 原周期结束后自动补发最新一次（不丢点击，trailing）', async () => {
    const handle = await mountPage();
    mounted = handle;

    let calls = 0;
    let slowNext = false;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    mockApi.getAlertPage.mockImplementation(async (params: any) => {
      calls += 1;
      if (slowNext) {
        slowNext = false; // 只卡第一个（慢）请求
        await slowGate;
      }
      return pageOf(
        Number(params?.page ?? 1),
        Number(params?.pageSize ?? 20),
        137,
      );
    });

    slowNext = true;
    const first = refresh(); // 慢请求，占住在途位
    // 走真实事件路径（等价于用户点工具栏刷新按钮）：vxe 尝试 commitProxy ⇒ 被丢弃 ⇒
    // 我们的 `toolbarButtonClick` 监听登记意图，周期结束后由守卫补发
    (
      instanceApi().grid as unknown as {
        dispatchEvent: (type: string, params: Record<string, unknown>) => void;
      }
    ).dispatchEvent('toolbar-button-click', { code: 'reload', button: {} });

    await flush();
    expect(calls, '被丢弃的刷新不得并发发出第二个请求').toBe(1);

    releaseSlow();
    await Promise.allSettled([first]);
    // 等守卫的补发跑完（宏任务 + 空闲轮询）
    await new Promise((resolve) => setTimeout(resolve, 80));
    await flush();

    expect(calls, '周期结束后必须补发最新一次，不丢点击').toBe(2);
    expect(rowCount(handle.container), '补发后行数 = 本页条数').toBe(
      Number(pager().pageSize),
    );
  });
});

describe('告警中心摘要：乱序返回不得让旧计数盖掉新计数', () => {
  it('★ 慢的旧摘要请求后到，不得把「确认后」的计数回退成确认前', async () => {
    const staleSummary = deferred<any>();
    mockApi.getAlertSummary
      .mockImplementationOnce(() => staleSummary.promise) // ① 进页面：慢
      .mockImplementationOnce(async () => ({
        // ② 确认后 `reloadAll()`：快，活动数已经降下来
        ackedCount: '1',
        activeCount: '0',
        criticalCount: '0',
        resolvedLast24h: '0',
      }));
    mockApi.getAlertPage.mockImplementation(async (params: any) =>
      pageOf(Number(params?.page ?? 1), Number(params?.pageSize ?? 20), 137),
    );
    mockApi.ackAlerts.mockResolvedValue(1);

    const handle = await mountPage();
    mounted = handle;
    await flush();
    expect(
      mockApi.getAlertSummary,
      '① 进页面的摘要请求已发出',
    ).toHaveBeenCalledTimes(1);

    // 走真实用户路径：点行内「确认」⇒ onAck ⇒ reloadAll() ⇒ 再拉一次摘要
    const ackButton = [...handle.container.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === '确认',
    );
    expect(ackButton, '行内「确认」按钮应当渲染出来').toBeTruthy();
    ackButton?.click();
    await flush();

    // ★ 修复的核心：① 还在途 ⇒ ② 只**排队**，不发第二个请求（修前这里已经是 2）
    expect(
      mockApi.getAlertSummary,
      '旧摘要在途时，新摘要必须排队而不是并发发出',
    ).toHaveBeenCalledTimes(1);

    // ① 的旧响应现在才回来（计数是确认前的）
    staleSummary.resolve({
      ackedCount: '0',
      activeCount: '1',
      criticalCount: '1',
      resolvedLast24h: '0',
    } as any as never);
    await flush();
    expect(mockApi.getAlertSummary, '① 结束后② 才开始').toHaveBeenCalledTimes(
      2,
    );

    // 页面必须停留在**确认后**的计数上（0 活动 / 1 已确认）
    const html = handle.container.innerHTML;
    expect(html).toContain('活动告警 0 条');
    expect(html).toContain('已确认 1 条');
    expect(html).not.toContain('活动告警 1 条');
  });
});

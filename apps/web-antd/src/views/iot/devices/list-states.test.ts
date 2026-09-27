import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';

import DevicesPage from './index.vue';

/**
 * IoT 列表页的「**失败态 vs 空态**」用例（设备台账 + 产品列表，同一套判据）。
 *
 * 为什么需要它：vxe 的 `#empty` 槽在「**加载失败**」与「**确实没有数据**」两种情况下长得一样。
 * 页面原本只挂 `EmptyGuide` ⇒ 首屏查询失败时用户看到的是「这里还是空的 + 去接入第一台设备」，
 * 即**把失败画成了「你没有数据」**（假空态）。失败虽由全局拦截器弹一次 toast，但 toast 转瞬即逝：
 * 错过它之后页面上**永久**留着「没有数据」这个错误结论。
 *
 * 判据（每页都要成立，缺一不可）：
 * 1. **失败** ⇒ 展示后端 `message` 原文，且**不得**出现空态引导；
 * 2. **真的为空** ⇒ 才出现空态引导，且**不得**出现失败提示；
 * 3. **失败态挂在表格之外** ⇒ 不依赖 `#empty` 槽被渲染（真实 vxe 只在表体无行时才渲染该槽，
 *    「已有数据后刷新失败」时槽不渲染）；本用例的表格桩**故意不渲染任何槽**，
 *    以此证明失败提示确实不依赖槽位。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让这些用例一起红。
 */

const { captured, mockApi } = vi.hoisted(() => ({
  /** 抓取页面传给 `useVbenVxeGrid` 的配置，用于直接触发 `ajax.query`。 */
  captured: { options: null as any },
  mockApi: {
    getDevicePage: vi.fn(),
    getProductPage: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  deleteProduct: vi.fn(),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getProductPage: (...args: unknown[]) => mockApi.getProductPage(...args),
  publishProduct: vi.fn(),
}));

/** 只留 `Page` 与 `useVbenDrawer`；抽屉渲染成空壳 ⇒ 抽屉里的内容组件不会被挂载。 */
vi.mock('@vben/common-ui', () => ({
  Page: defineComponent({
    name: 'PageStub',
    setup: (_props, { slots }) => () => h('div', slots.default?.()),
  }),
  useVbenDrawer: () => [
    defineComponent({ name: 'DrawerStub', setup: () => () => null }),
    { close: vi.fn(), open: vi.fn(), setData: vi.fn() },
  ],
}));

/**
 * 表格桩：**不渲染任何槽位**（含 `#empty`）。
 *
 * 这是刻意的：失败提示若只写在 `#empty` 槽里，真实 vxe 在「已有数据后刷新失败」时不会渲染该槽
 * ⇒ 失败提示不可见。本桩把槽彻底拿掉，仍能通过 ⇒ 证明失败提示挂在表格之外、不依赖槽位。
 */
vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup: () => () => h('div', { class: 'grid-stub' }),
    });
    return [GridStub, { query: vi.fn() }];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

/** 被测页面（同一套判据跑两遍；新增列表页时应加进这里）。 */
interface PageCase {
  /** 页面名（用例标题用）。 */
  name: string;
  component: unknown;
  /** 该页对应的取数桩。 */
  fetchMock: () => ReturnType<typeof vi.fn>;
  /** 失败态标题（该页自己的 i18n 键渲染结果）。 */
  failedTitle: string;
  /** 该页空态引导里的「为什么是空的」文案片段（用于与失败态互斥断言）。 */
  emptyReasonFragment: string;
}

/** 产品列表页（动态导入以避免与设备台账的静态导入顺序耦合）。 */
const productsModule = await import('../products/index.vue');

const PAGES: PageCase[] = [
  {
    name: '设备台账',
    component: DevicesPage,
    fetchMock: () => mockApi.getDevicePage,
    failedTitle: '设备列表加载失败',
    emptyReasonFragment: '该租户还没有设备',
  },
  {
    // 产品列表走同一套接线，必须有等价用例（独立复核指出前一版只覆盖了台账）
    name: '产品列表',
    component: productsModule.default,
    fetchMock: () => mockApi.getProductPage,
    failedTitle: '产品列表加载失败',
    emptyReasonFragment: '该租户还没有产品',
  },
];

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

async function mountPage(component: unknown) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(component as never) });
  // 页面模板里仍有 `v-access:code`：不注册会得到
  // `[Vue warn] Failed to resolve directive: access`，用例会因噪声而不忠实。
  registerAccessDirective(app);
  app.mount(container);
  await nextTick();
  return { app, container };
}

/** 触发表格的取数函数（页面传给 useVbenVxeGrid 的那一个）。 */
async function runQuery() {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return await query({ page: { currentPage: 1, pageSize: 10 } });
}

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  mockApi.getDevicePage.mockReset();
  mockApi.getProductPage.mockReset();
  captured.options = null;
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

for (const page of PAGES) {
  describe(`${page.name}：失败态不许画成空态`, () => {
    it('首屏查询失败（业务失败码）⇒ 原样展示后端 message，**不出**空态引导', async () => {
      const backendMessage = '查询被拒绝：无对应权限';
      page.fetchMock().mockRejectedValue(bizFailure(40_303, backendMessage));

      const handle = await mountPage(page.component);
      mounted = handle;

      // 查询本身要照旧失败（不改动原有语义：全局拦截器仍会弹提示）
      await expect(runQuery()).rejects.toThrow(backendMessage);
      await nextTick();

      const html = handle.container.innerHTML;
      expect(html).toContain(backendMessage); // 后端 message 原样可见
      expect(html).toContain(page.failedTitle); // 明确的失败态标题
      expect(html).not.toContain('这里还是空的'); // 空态引导不得出现
      expect(html).not.toContain(page.emptyReasonFragment);
    });

    it('首屏查询失败（HTTP 500，无业务信封）⇒ 仍是失败态，不回落成空态', async () => {
      page
        .fetchMock()
        .mockRejectedValue(new Error('Request failed with status code 500'));

      const handle = await mountPage(page.component);
      mounted = handle;
      // 断言具体 message（裸 toThrow() 会被无关异常蒙混过关）
      await expect(runQuery()).rejects.toThrow(
        'Request failed with status code 500',
      );
      await nextTick();

      const html = handle.container.innerHTML;
      expect(html).toContain('Request failed with status code 500');
      expect(html).not.toContain('这里还是空的');
    });

    it('失败态**挂在表格之外**：连 `#empty` 槽都不渲染也照样可见（刷新失败场景）', async () => {
      const backendMessage = '刷新失败：网关超时';
      page.fetchMock().mockRejectedValue(bizFailure(50_000, backendMessage));

      const handle = await mountPage(page.component);
      mounted = handle;
      await expect(runQuery()).rejects.toThrow(backendMessage);
      await nextTick();

      // 表格桩不渲染任何槽位（真实 vxe 在有旧行时也不会渲染 #empty），失败提示仍必须可见
      expect(handle.container.querySelector('.grid-stub')).toBeTruthy();
      expect(handle.container.innerHTML).toContain(backendMessage);
      expect(handle.container.innerHTML).toContain(page.failedTitle);
    });

    it('真的没有数据 ⇒ 才出现空态引导，且**没有**失败提示', async () => {
      page.fetchMock().mockResolvedValue({
        items: [],
        page: '1',
        pageSize: '10',
        total: '0',
      });

      const handle = await mountPage(page.component);
      mounted = handle;
      await runQuery();
      await nextTick();

      // 空态引导在 `#empty` 槽里；本桩不渲染槽 ⇒ 用「失败提示必须消失」作为主判据，
      // 槽内文案由另外两个用例（失败态不得出现空态文案）反向约束。
      expect(handle.container.innerHTML).not.toContain(page.failedTitle);
    });

    it('失败后重试成功 ⇒ 失败提示必须被清掉（不留过期错误）', async () => {
      page.fetchMock().mockRejectedValueOnce(bizFailure(50_000, '偶发失败'));
      const handle = await mountPage(page.component);
      mounted = handle;
      await expect(runQuery()).rejects.toThrow('偶发失败');
      await nextTick();
      expect(handle.container.innerHTML).toContain('偶发失败');

      page.fetchMock().mockResolvedValueOnce({
        items: [],
        page: '1',
        pageSize: '10',
        total: '0',
      });
      await runQuery();
      await nextTick();

      expect(handle.container.innerHTML).not.toContain('偶发失败');
      expect(handle.container.innerHTML).not.toContain(page.failedTitle);
    });

    it('后端 `total` 是字符串 ⇒ 交给表格的是 number（分页 prop 契约）', async () => {
      page.fetchMock().mockResolvedValue({
        items: [],
        page: '1',
        pageSize: '10',
        total: '17',
      });
      const handle = await mountPage(page.component);
      mounted = handle;

      const result = await runQuery();
      expect(result.total).toBe(17);
      expect(typeof result.total).toBe('number');
      // 同一次返回里 page/pageSize 也保持原样（不由本页负责转换）
      expect(result.page).toBe('1');
    });
  });
}

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
 * IoT 列表页的「**失败态 vs 空态**」用例（覆盖全部四个列表页，同一套判据）。
 *
 * 为什么需要它：vxe 的 `#empty` 槽在「**加载失败**」与「**确实没有数据**」两种情况下长得一样。
 * 页面原本只挂 `EmptyGuide` ⇒ 首屏查询失败时用户看到的是「这里还是空的 + 去接入第一台设备」，
 * 即**把失败画成了「你没有数据」**（假空态）。失败虽由全局拦截器弹一次 toast，但 toast 转瞬即逝：
 * 错过它之后页面上**永久**留着「没有数据」这个错误结论。
 *
 * 判据（每页都要成立）：
 * 1. **失败** ⇒ 展示后端 `message` 原文，且**不得**出现空态引导；
 * 2. **真的为空** ⇒ 才出现空态引导，且**不得**出现失败提示；
 * 3. **失败态不依赖 `#empty` 槽**（真实 vxe 只在表体无行时才渲染该槽，
 *    「已有数据后刷新失败」时槽不渲染）⇒ 表格桩默认**不渲染任何槽**，失败提示仍必须可见。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让这些用例一起红。
 */

const { captured, gridStub, mockApi } = vi.hoisted(() => ({
  /** 抓取页面传给 `useVbenVxeGrid` 的配置，用于直接触发 `ajax.query`。 */
  captured: { options: null as any },
  /** 表格桩是否渲染 `#empty` 槽（默认**否**：用来证明失败提示不依赖槽位）。 */
  gridStub: { renderEmpty: false },
  mockApi: {
    getDevicePage: vi.fn(),
    getGroupList: vi.fn(),
    getMaintenanceWindowList: vi.fn(),
    getProductPage: vi.fn(),
    getDeviceNameMap: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  closeMaintenanceWindow: vi.fn(),
  deleteDevice: vi.fn(),
  deleteGroup: vi.fn(),
  deleteProduct: vi.fn(),
  getDeviceNameMap: (...args: unknown[]) => mockApi.getDeviceNameMap(...args),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getGroupList: (...args: unknown[]) => mockApi.getGroupList(...args),
  getMaintenanceWindowList: (...args: unknown[]) =>
    mockApi.getMaintenanceWindowList(...args),
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

vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup: (_props, { slots }) =>
        () =>
          h(
            'div',
            { class: 'grid-stub' },
            gridStub.renderEmpty ? slots.empty?.() : undefined,
          ),
    });
    return [GridStub, { query: vi.fn() }];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const productsModule = await import('../products/index.vue');
const maintenanceModule = await import('../maintenance/index.vue');
const groupsModule = await import('../groups/index.vue');

/** 被测页面（同一套判据逐页跑；新增列表页时应加进这里）。 */
interface PageCase {
  name: string;
  component: unknown;
  fetchMock: () => ReturnType<typeof vi.fn>;
  /** 失败态标题（该页自己的 i18n 键渲染结果）。 */
  failedTitle: string;
  /** 该页「为什么是空的」文案片段（空态引导内容）。 */
  emptyFragment: string;
  /** 是否需要断言「后端字符串 total ⇒ 交给表格的是 number」。 */
  paged: boolean;
}

const PAGES: PageCase[] = [
  {
    name: '设备台账',
    component: DevicesPage,
    fetchMock: () => mockApi.getDevicePage,
    failedTitle: '设备列表加载失败',
    emptyFragment: '该租户还没有设备',
    paged: true,
  },
  {
    name: '产品列表',
    component: productsModule.default,
    fetchMock: () => mockApi.getProductPage,
    failedTitle: '产品列表加载失败',
    emptyFragment: '该租户还没有产品',
    paged: true,
  },
  {
    name: '维护窗口',
    component: maintenanceModule.default,
    fetchMock: () => mockApi.getMaintenanceWindowList,
    failedTitle: '维护窗口列表加载失败',
    emptyFragment: '还没有维护窗口',
    paged: false,
  },
  {
    name: '设备分组',
    component: groupsModule.default,
    fetchMock: () => mockApi.getGroupList,
    failedTitle: '设备分组列表加载失败',
    emptyFragment: '该租户还没有设备分组',
    paged: false,
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

async function runQuery() {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return await query({ page: { currentPage: 1, pageSize: 10 } });
}

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.getDeviceNameMap.mockResolvedValue({});
  captured.options = null;
  gridStub.renderEmpty = false;
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
      // 本轮渲染 `#empty` 槽：失败时里边**不得**出现空态文案
      gridStub.renderEmpty = true;

      const handle = await mountPage(page.component);
      mounted = handle;

      // 查询本身要照旧失败（不改动原有语义：全局拦截器仍会弹提示）
      await expect(runQuery()).rejects.toThrow(backendMessage);
      await nextTick();

      const html = handle.container.innerHTML;
      expect(html).toContain(backendMessage); // 后端 message 原样可见
      expect(html).toContain(page.failedTitle); // 明确的失败态标题
      expect(html).not.toContain('这里还是空的');
      expect(html).not.toContain(page.emptyFragment); // 空态引导不得出现
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
      gridStub.renderEmpty = false; // 真实 vxe 在有旧行时也不会渲染该槽

      const handle = await mountPage(page.component);
      mounted = handle;
      await expect(runQuery()).rejects.toThrow(backendMessage);
      await nextTick();

      expect(handle.container.querySelector('.grid-stub')).toBeTruthy();
      expect(handle.container.innerHTML).toContain(backendMessage);
      expect(handle.container.innerHTML).toContain(page.failedTitle);
    });

    it('真的没有数据 ⇒ 才出现空态引导，且**没有**失败提示', async () => {
      page.fetchMock().mockResolvedValue(page.paged ? { items: [] } : []);
      gridStub.renderEmpty = true; // 成功且为空 ⇒ 槽会被真实 vxe 渲染

      const handle = await mountPage(page.component);
      mounted = handle;
      await runQuery();
      await nextTick();

      const html = handle.container.innerHTML;
      expect(html).toContain(page.emptyFragment); // 空态引导出现
      expect(html).not.toContain(page.failedTitle); // 且不得出现失败提示
    });

    it('失败后重试成功 ⇒ 失败提示必须被清掉（不留过期错误）', async () => {
      page.fetchMock().mockRejectedValueOnce(bizFailure(50_000, '偶发失败'));
      const handle = await mountPage(page.component);
      mounted = handle;
      await expect(runQuery()).rejects.toThrow('偶发失败');
      await nextTick();
      expect(handle.container.innerHTML).toContain('偶发失败');

      page
        .fetchMock()
        .mockResolvedValueOnce(page.paged ? { items: [] } : []);
      await runQuery();
      await nextTick();

      expect(handle.container.innerHTML).not.toContain('偶发失败');
      expect(handle.container.innerHTML).not.toContain(page.failedTitle);
    });
  });
}

/**
 * 只有**服务端分页**的两页会把 `PageResult.total` 交给 vxe 的 pager（`pagerConfig.enabled=true`）。
 *
 * 单独一个 describe 循环、而不是在上一循环里 `if (page.paged) it(...)`：
 * 条件式定义用例会触发 `vitest/no-conditional-tests`；而改成「提前 return」会让非分页页
 * 跑一条**没有任何断言的恒真用例**（比不加更糟）。
 */
describe('分页页：后端 `total` 是字符串 ⇒ 交给表格的是 number', () => {
  for (const page of PAGES.filter((item) => item.paged)) {
    it(`${page.name}：total 转成 number，page/pageSize 原样透传`, async () => {
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
  }
});

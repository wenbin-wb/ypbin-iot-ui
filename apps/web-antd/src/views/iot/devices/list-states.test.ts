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
 * 设备台账列表的「**失败态 vs 空态**」用例。
 *
 * 为什么需要它：vxe 的 `#empty` 插槽在「**加载失败**」与「**确实没有数据**」两种情况下
 * 长得一模一样。页面上原本只挂了 `EmptyGuide` ⇒ 首屏查询失败时，用户看到的是
 * 「这里还是空的 + 去接入第一台设备」，即**把失败画成了「你没有数据」**（假空态）。
 * 失败虽然由全局请求拦截器弹一次 toast，但 toast 转瞬即逝：错过它之后，
 * 页面上永久留着「没有数据」这个**错误结论**。
 *
 * 所以本用例钉住两条判据（缺一不可）：
 * 1. **失败** ⇒ 展示后端 `message` 原文，且**不得**出现空态引导；
 * 2. **真的为空** ⇒ 才出现空态引导，且**不得**出现失败提示。
 *
 * 用真实 vue-i18n（不 mock `#/locales`）：文案编译不过会让这个用例也一起红。
 */

const { captured, mockGetDevicePage } = vi.hoisted(() => ({
  /** 抓取页面传给 `useVbenVxeGrid` 的配置，用于直接触发 `ajax.query`。 */
  captured: { options: null as any },
  mockGetDevicePage: vi.fn(),
}));

vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  getDevicePage: (...args: unknown[]) => mockGetDevicePage(...args),
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
 * 表格桩：**渲染 `#empty` 槽位**（这正是被测行为所在），其余槽位忽略。
 * 真实 `useVbenVxeGrid` 需要 vxe 全量运行时，与本用例要验证的「失败/空态分流」无关。
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
      setup: (_props, { slots }) =>
        () => h('div', { class: 'grid-stub' }, slots.empty?.()),
    });
    return [GridStub, { query: vi.fn() }];
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
});

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

/** 挂载页面并返回容器；`#empty` 槽位由表格桩渲染出来。 */
async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  // 页面模板里仍有 `v-access:code`（租户台账按钮）：不注册会得到
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
  mockGetDevicePage.mockReset();
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('设备台账列表：失败态不许画成空态', () => {
  it('首屏查询失败（业务失败码）⇒ 原样展示后端 message，**不出**空态引导', async () => {
    const backendMessage = '设备列表查询被拒绝：无 iot:device:list 权限';
    mockGetDevicePage.mockRejectedValue(bizFailure(40_303, backendMessage));

    const handle = await mountPage();
    mounted = handle;

    // 查询本身要照旧失败（不改动原有语义：全局拦截器仍会弹提示）
    await expect(runQuery()).rejects.toThrow(backendMessage);
    await nextTick();

    const html = handle.container.innerHTML;
    expect(html).toContain(backendMessage); // 后端 message 原样可见
    expect(html).toContain('设备列表加载失败'); // 明确的失败态标题
    expect(html).not.toContain('这里还是空的'); // 空态引导不得出现
    expect(html).not.toContain('接入向导');
  });

  it('首屏查询失败（HTTP 500，无业务信封）⇒ 仍是失败态，不回落成空态', async () => {
    mockGetDevicePage.mockRejectedValue(
      new Error('Request failed with status code 500'),
    );

    const handle = await mountPage();
    mounted = handle;
    // 断言具体 message（而不是裸 toThrow()）：既能咬人，也让失败信息可读
    await expect(runQuery()).rejects.toThrow(
      'Request failed with status code 500',
    );
    await nextTick();

    const html = handle.container.innerHTML;
    expect(html).toContain('Request failed with status code 500');
    expect(html).not.toContain('这里还是空的');
  });

  it('真的没有数据 ⇒ 才出现空态引导，且**没有**失败提示', async () => {
    mockGetDevicePage.mockResolvedValue({
      items: [],
      page: '1',
      pageSize: '10',
      total: '0',
    });

    const handle = await mountPage();
    mounted = handle;
    await runQuery();
    await nextTick();

    const html = handle.container.innerHTML;
    expect(html).toContain('这里还是空的');
    expect(html).not.toContain('设备列表加载失败');
  });

  it('失败后重试成功 ⇒ 失败提示必须被清掉（不留过期错误）', async () => {
    mockGetDevicePage.mockRejectedValueOnce(bizFailure(50_000, '偶发失败'));
    const handle = await mountPage();
    mounted = handle;
    await expect(runQuery()).rejects.toThrow('偶发失败');
    await nextTick();
    expect(handle.container.innerHTML).toContain('偶发失败');

    mockGetDevicePage.mockResolvedValueOnce({
      items: [],
      page: '1',
      pageSize: '10',
      total: '0',
    });
    await runQuery();
    await nextTick();

    const html = handle.container.innerHTML;
    expect(html).not.toContain('偶发失败');
    expect(html).toContain('这里还是空的');
  });

  it('后端 `total` 是字符串 ⇒ 交给表格的是 number（分页 prop 契约）', async () => {
    mockGetDevicePage.mockResolvedValue({
      items: [],
      page: '1',
      pageSize: '10',
      total: '17',
    });
    const handle = await mountPage();
    mounted = handle;

    const result = await runQuery();
    expect(result.total).toBe(17);
    expect(typeof result.total).toBe('number');
    // 同一次返回里 page/pageSize 也保持原样（不由本页负责转换）
    expect(result.page).toBe('1');
  });
});

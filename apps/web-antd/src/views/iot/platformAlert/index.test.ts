import { createApp, defineComponent, h, nextTick } from 'vue';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import PlatformAlertPage from './index.vue';

/**
 * 平台自告警页（`platformAlert/index.vue`）的查询接线用例。
 *
 * 回归问题（P2-4）：切筛选只调 `query()`，而 vxe 的 `query` **不重置页码**
 * （只有 `reload`/`initial` 会重置）⇒ 先翻到第 3 页再改筛选仍请求 page=3，
 * 结果只有 1 页时表格空白、筛选条却显示「已筛选」，用户误判「没有严重告警」。
 *
 * 同时锁住本轮新增的「静默丢弃」守卫接线：pageChange/工具栏刷新必须登记意图
 * （否则慢查询在途时点刷新/翻页会被 vxe 直接吞掉且无任何反馈）。
 */

const { apiMock, captured, gridApiMock, gridState } = vi.hoisted(() => ({
  apiMock: { getPlatformAlerts: vi.fn() },
  captured: { options: null as any },
  gridState: { currentPage: 1 },
  gridApiMock: {
    grid: {
      reactData: { tableLoading: false },
      setCurrentPage: vi.fn(),
    },
    query: vi.fn(),
    setLoading: vi.fn(),
  },
}));

gridApiMock.grid.setCurrentPage = vi.fn(async (page: number) => {
  gridState.currentPage = page;
});

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot')>();
  return { ...actual, ...apiMock };
});

vi.mock('@vben/access', () => ({
  useAccess: () => ({ hasAccessByCodes: () => true }),
}));

vi.mock('@vben/common-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/common-ui')>();
  return {
    ...actual,
    Page: defineComponent({
      name: 'PageStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', slots.default?.()),
    }),
  };
});

vi.mock('#/adapter/vxe-table', () => ({
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    return [
      defineComponent({ name: 'GridStub', setup: () => () => null }),
      gridApiMock,
    ];
  },
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

let mounted: undefined | { app: { unmount: () => void } };

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(PlatformAlertPage as never) });
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

/** 沿 Vue 组件链找到绑定了 `@change` 的 antd Select（即页面的筛选回调）。 */
function findFilterChangeHandler(container: HTMLElement): any {
  const anchor = container.querySelector('.ant-select');
  expect(anchor, '未渲染出筛选 Select').toBeTruthy();
  let node: any = (anchor as any)?.__vueParentComponent;
  while (node) {
    const handler = node.props?.onChange ?? node.vnode?.props?.onChange;
    if (typeof handler === 'function') {
      return handler;
    }
    node = node.parent;
  }
  return null;
}

function runQuery(page = 1) {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return query({ page: { currentPage: page, pageSize: 20 } });
}

beforeEach(() => {
  apiMock.getPlatformAlerts.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.setLoading.mockReset();
  gridApiMock.grid.setCurrentPage.mockClear();
  gridState.currentPage = 1;
  captured.options = null;
  apiMock.getPlatformAlerts.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 20,
    total: '0',
  });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('platformAlert/index.vue 查询接线', () => {
  it('ajax.query 把字符串 total 转成 number（Long 序列化口径）', async () => {
    await mountPage();
    const result = await runQuery(2);

    expect(apiMock.getPlatformAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 20 }),
    );
    expect(result.total).toBe(0);
  });

  it('★ 切筛选先回第 1 页再查询（P2-4：不再带着旧页码看到空页）', async () => {
    const container = await mountPage();
    gridState.currentPage = 3;
    gridApiMock.query.mockClear();

    const onChange = findFilterChangeHandler(container);
    expect(onChange, '筛选 Select 未绑定 @change 回调').toBeTypeOf('function');
    await onChange();
    await flush();

    // ① 页码被显式重置为 1（vxe 的 query 不重置页码）
    expect(gridApiMock.grid.setCurrentPage).toHaveBeenCalledWith(1);
    expect(gridState.currentPage).toBe(1);
    // ② 重置后才发起查询（走守卫的 request 入口）
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
  });

  it('守卫接线：翻页/工具栏刷新事件已注册（意图登记入口存在）', async () => {
    await mountPage();
    const gridEvents = captured.options?.gridEvents;
    expect(typeof gridEvents?.pageChange).toBe('function');
    expect(typeof gridEvents?.toolbarButtonClick).toBe('function');
    // 真实事件回调不应抛错（守卫变量在 setup 结束时已就位）
    expect(() => {
      gridEvents.pageChange();
      gridEvents.toolbarButtonClick({ code: 'reload' });
      gridEvents.toolbarButtonClick({ code: 'other' });
    }).not.toThrow();
  });
});

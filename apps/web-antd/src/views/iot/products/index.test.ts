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

import ProductsPage from './index.vue';

/**
 * 产品列表页（`products/index.vue` + `data.ts`）的行为锁：
 * 1. 搜索表单字段与筛选值**真实透传**给 `getProductPage`（分页参数仍由页面补齐）；
 * 2. 协议/数据格式/物模型状态列的 CellTag 选项是中文且覆盖后端大小写变体；
 * 3. `createTime` 中文化、可空字段统一空值占位、操作列已收窄为 220。
 *
 * 用真实 vue-i18n（不 mock `#/locales`），文案编译不过会让用例一起红。
 */

const { captured, drawerApis, gridApiMock, mockApi } = vi.hoisted(() => ({
  captured: { options: null as any },
  drawerApis: [] as any[],
  gridApiMock: { query: vi.fn() },
  mockApi: {
    deleteProduct: vi.fn(),
    getProductPage: vi.fn(),
    publishProduct: vi.fn(),
  },
}));

vi.mock('#/api/iot', () => ({
  deleteProduct: (...args: unknown[]) => mockApi.deleteProduct(...args),
  getProductPage: (...args: unknown[]) => mockApi.getProductPage(...args),
  publishProduct: (...args: unknown[]) => mockApi.publishProduct(...args),
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
    props: {
      actions: { default: () => [], type: Array },
      dropdownActions: { default: () => [], type: Array },
    },
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    captured.options = options;
    const GridStub = defineComponent({
      name: 'GridStub',
      setup: () => () => h('div', { class: 'grid-stub' }),
    });
    return [GridStub, gridApiMock];
  },
}));

// 弹层/引导内容与筛选无关：桩掉，避免把详情页（5 页签）的重依赖拖进列表测试。
vi.mock('./modules/detail.vue', () => ({
  default: defineComponent({ name: 'DetailStub', setup: () => () => null }),
}));
vi.mock('./modules/form.vue', () => ({
  default: defineComponent({ name: 'FormStub', setup: () => () => null }),
}));
vi.mock('../onboarding/modules/empty-guide.vue', () => ({
  default: defineComponent({ name: 'EmptyGuideStub', setup: () => () => null }),
}));
vi.mock('../onboarding/modules/guide.vue', () => ({
  default: defineComponent({ name: 'GuideStub', setup: () => () => null }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores, useAccessStore } = await import('@vben/stores');
  await initStores(app, { namespace: 'test' });
  // 页面模板里有 `v-access:code`：不授权按钮会被指令摘掉
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(ProductsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

async function runQuery(formValues?: Record<string, unknown>) {
  const query = captured.options?.gridOptions?.proxyConfig?.ajax?.query;
  expect(query, '页面没有把 ajax.query 交给表格').toBeTypeOf('function');
  return await query({ page: { currentPage: 1, pageSize: 10 } }, formValues);
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  for (const fn of Object.values(gridApiMock)) fn.mockReset();
  drawerApis.length = 0;
  captured.options = null;
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('products/index.vue 搜索透传', () => {
  it('搜索表单字段 = keyword/protocol/modelStatus，筛选值真实透传给 getProductPage', async () => {
    mockApi.getProductPage.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 10,
      total: '17',
    });

    await mountPage();

    const schema = captured.options?.formOptions?.schema as any[];
    expect(schema.map((item) => item.fieldName)).toEqual([
      'keyword',
      'protocol',
      'modelStatus',
    ]);
    expect(schema[0]?.component).toBe('Input');
    expect(schema[1]?.component).toBe('Select');
    expect(schema[2]?.component).toBe('Select');

    const result = await runQuery({
      keyword: 'meter',
      modelStatus: 'draft',
      protocol: 'modbus',
    });

    expect(mockApi.getProductPage).toHaveBeenCalledWith({
      keyword: 'meter',
      modelStatus: 'draft',
      page: 1,
      pageSize: 10,
      protocol: 'modbus',
    });
    // total 是 long 序列化字符串 ⇒ 页面必须转成 number 再交给 vxe 分页
    expect(result).toEqual({
      items: [],
      page: 1,
      pageSize: 10,
      total: 17,
    });
  });
});

describe('products/data.ts 列中文展示', () => {
  it('协议/数据格式/物模型状态为 CellTag 中文选项（含大小写变体），时间/空值统一', async () => {
    const { useColumns } = await import('./data');
    const columns = useColumns() as any[];
    const column = (field: string) =>
      columns.find((item) => item.field === field);

    const protocol = column('protocol')?.cellRender;
    expect(protocol?.name).toBe('CellTag');
    expect(
      protocol?.options?.find((item: any) => item.value === 'modbus')?.label,
    ).toBe('Modbus TCP');
    expect(
      protocol?.options?.find((item: any) => item.value === 'MODBUS')?.label,
    ).toBe('Modbus TCP');
    expect(
      protocol?.options?.some(
        (item: any) => item.value === 'tcp' && item.label === 'TCP 透传',
      ),
    ).toBe(true);

    const dataFormat = column('dataFormat')?.cellRender?.options;
    expect(dataFormat?.find((item: any) => item.value === 'json')?.label).toBe(
      'JSON',
    );
    expect(
      dataFormat?.find((item: any) => item.value === 'binary')?.label,
    ).toBe('二进制');

    const modelStatus = column('modelStatus')?.cellRender?.options;
    expect(
      modelStatus?.find((item: any) => item.value === 'published')?.label,
    ).toBe('已发布');
    expect(
      modelStatus?.find((item: any) => item.value === 'DRAFT')?.label,
    ).toBe('草稿');

    expect(
      column('createTime')?.formatter?.({ cellValue: '2026-01-01T00:00:00' }),
    ).toBe('2026-01-01 00:00:00');
    expect(column('deviceType')?.formatter?.({ cellValue: undefined })).toBe(
      '-',
    );
    // 操作列从 330 收窄，低频动作已进 dropdownActions
    expect(column('action')?.width).toBe(220);
  });
});

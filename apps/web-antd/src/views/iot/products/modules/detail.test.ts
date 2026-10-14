import type { IotProductApi } from '#/api/iot';

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

import Detail from './detail.vue';

/**
 * 产品详情（`products/modules/detail.vue`）的运行时分支用例。
 *
 * 为什么需要组件级：详情页有「产品详情拉取失败但物模型/版本仍各自加载」「非草稿只读」
 * 「TSL 本地语法校验」等多条运行期分支，typecheck / 构建都跑不到。
 *
 * 这里用真实 vue-i18n + 真实 antdv，只替换网络层、抽屉/弹窗外壳与权限来源；
 * 不 mock `#/locales`，避免结构性地漏掉文案编译错误。
 */

const { apiMock, drawerCalls } = vi.hoisted(() => ({
  apiMock: {
    deleteCommand: vi.fn(),
    deleteEvent: vi.fn(),
    deleteProperty: vi.fn(),
    deleteService: vi.fn(),
    exportTsl: vi.fn(),
    getProductDetail: vi.fn(),
    getProductVersions: vi.fn(),
    importTsl: vi.fn(),
    listCommands: vi.fn(),
    listEvents: vi.fn(),
    listProperties: vi.fn(),
    listServices: vi.fn(),
    newProductDraft: vi.fn(),
    publishProduct: vi.fn(),
    // thingmodel-form.vue 在模块加载期会 import 这些；虽然本用例不打开编辑器，也要保证解析得到
    createCommand: vi.fn(),
    createEvent: vi.fn(),
    createProperty: vi.fn(),
    createService: vi.fn(),
    updateCommand: vi.fn(),
    updateEvent: vi.fn(),
    updateProperty: vi.fn(),
    updateService: vi.fn(),
  },
  drawerCalls: [] as any[],
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/api/iot')>();
  return { ...actual, ...apiMock };
});

vi.mock('@vben/common-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/common-ui')>();
  const drawerApi = {
    close: vi.fn(),
    getData: () => ({
      id: '9100001',
      productCode: 'demo-product',
      productName: '演示产品',
    }),
    open: vi.fn(),
    setData: vi.fn(() => drawerApi),
    setState: vi.fn(),
  };
  const modalApi = {
    close: vi.fn(),
    open: vi.fn(),
    setData: vi.fn(() => modalApi),
    setState: vi.fn(),
  };
  const DrawerStub = defineComponent({
    name: 'DrawerStub',
    setup:
      (_props, { slots }) =>
      () =>
        h('div', { class: 'drawer-stub' }, slots.default?.()),
  });
  const ModalStub = defineComponent({
    name: 'ModalStub',
    setup: () => () => null,
  });
  return {
    ...actual,
    useVbenDrawer: (options: Record<string, unknown>) => {
      drawerCalls.push(options);
      return [DrawerStub, drawerApi];
    },
    useVbenModal: (options: Record<string, unknown>) => {
      drawerCalls.push(options);
      return [ModalStub, modalApi];
    },
  };
});

vi.mock('@vben/stores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vben/stores')>();
  const { reactive } = await import('vue');
  const accessStore = reactive({ accessCodes: ['*:*:*'] });
  return {
    ...actual,
    useAccessStore: () => accessStore,
    useUserStore: () => reactive({ userRoles: [] as string[] }),
  };
});

vi.mock('@vben/preferences', () => ({
  preferences: { app: { accessMode: 'frontend', locale: 'zh-CN' } },
  updatePreferences: () => {},
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// 设备页签的内嵌列表用桩替换：本用例只验证「宿主把 productId 接进去、按钮还在」，
// 列表自身的查询/三态由 devices/list-states.test.ts 同类桩用例负责，避免在 detail 用例里
// 引入真实 vxe 挂载与设备接口请求。
vi.mock('./device-list.vue', () => ({
  default: defineComponent({
    name: 'DeviceListStub',
    props: { productId: { default: '', type: String } },
    setup(props, { expose }) {
      expose({ reload: () => {} });
      return () =>
        h('div', {
          class: 'device-list-stub',
          'data-product-id': props.productId,
        });
    },
  }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  drawerCalls.length = 0;
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.getProductDetail.mockResolvedValue({
    id: '9100001',
    modelStatus: 'published',
    productCode: 'demo-product',
    productName: '演示产品',
  } as IotProductApi.ProductResp);
  apiMock.getProductVersions.mockResolvedValue([]);
  apiMock.listServices.mockResolvedValue([]);
  apiMock.listProperties.mockResolvedValue([]);
  apiMock.listCommands.mockResolvedValue([]);
  apiMock.listEvents.mockResolvedValue([]);
  apiMock.exportTsl.mockResolvedValue({});
  apiMock.importTsl.mockResolvedValue({ errors: [], successCount: 0 });
});

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

/** 挂载 `detail.vue`，并触发抽屉 `onOpenChange(true)` 完成首屏加载。 */
async function openDetail() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(Detail as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await flush(2);

  const opened = drawerCalls.find(
    (options) => typeof options?.onOpenChange === 'function',
  );
  expect(opened, 'useVbenDrawer(onOpenChange) 未被调用').toBeTruthy();
  await opened.onOpenChange(true);
  await flush();
  return container;
}

function clickTab(container: HTMLElement, text: string) {
  const tabs = [
    ...container.querySelectorAll('.ant-tabs-tab'),
  ] as HTMLElement[];
  const tab = tabs.find((item) => item.textContent?.includes(text));
  expect(tab, `未找到页签：${text}`).toBeTruthy();
  tab?.click();
}

function clickButton(container: HTMLElement, text: string) {
  // 必须限定在当前 active 页签内：antd Tabs 会把非激活面板也留在 DOM 里，
  // 概览页签同样有「导入 TSL」按钮，全局取第一个会点到隐藏按钮。
  const activePane = container.querySelector('.ant-tabs-tabpane-active');
  const buttons = [
    ...(activePane ?? container).querySelectorAll('button'),
  ] as HTMLElement[];
  const button = buttons.find((item) => item.textContent?.includes(text));
  expect(button, `未找到按钮：${text}`).toBeTruthy();
  button?.click();
}

describe('products/modules/detail.vue 运行时分支', () => {
  it('非草稿产品：物模型页签展示只读提示，不出现「新增服务」入口', async () => {
    const container = await openDetail();
    clickTab(container, '物模型');
    await flush();

    const html = container.innerHTML;
    expect(html).toContain('已发布产品的物模型为**只读**');
    // 只读态不能出现「新增服务」入口；空态文案里的「请先新增服务」不算入口
    expect(html).not.toContain('>新增服务<');
  });

  it('物模型加载失败：模型页签原样展示错误；版本列表独立加载成功，不被连带清空', async () => {
    apiMock.listServices.mockRejectedValue(new Error('物模型服务查询失败'));
    apiMock.getProductVersions.mockResolvedValue([
      { id: 'v1', modelStatus: 'published', versionNo: '1.0.0' },
    ]);

    const container = await openDetail();
    clickTab(container, '物模型');
    await flush();
    // modelError 的展示口径是「后端 message 原样」，fallback 只在后端没给 message 时用
    expect(container.innerHTML).toContain('物模型服务查询失败');

    clickTab(container, '版本');
    await flush();
    expect(container.innerHTML).toContain('1.0.0');
  });

  it('服务列表为空：物模型页签显示空态，且不请求属性/命令/事件三张表', async () => {
    apiMock.listServices.mockResolvedValue([]);

    const container = await openDetail();
    clickTab(container, '物模型');
    await flush();

    expect(container.innerHTML).toContain(
      '该产品还没有服务；属性/命令/事件都挂在服务下，请先新增服务',
    );
    expect(apiMock.listProperties).not.toHaveBeenCalled();
    expect(apiMock.listCommands).not.toHaveBeenCalled();
    expect(apiMock.listEvents).not.toHaveBeenCalled();
  });

  it('设备页签：内嵌 DeviceList 收到 productId，保留「添加设备」按钮，不再出现「需后端补 productId」提示', async () => {
    const container = await openDetail();
    clickTab(container, '设备');
    await flush();

    const stub = container.querySelector('.device-list-stub');
    expect(stub, '设备页签未挂载 DeviceList').toBeTruthy();
    expect((stub as HTMLElement | null)?.dataset.productId).toBe('9100001');

    const addButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('添加设备'),
    );
    expect(addButton, '未保留「添加设备」入口').toBeTruthy();
    expect(container.innerHTML).not.toContain('需要后端补 productId');
  });

  it('tsl 导入：空文本与非法 JSON 都在本地拦截，不把注定失败的请求发给后端', async () => {
    apiMock.getProductDetail.mockResolvedValue({
      id: '9100001',
      modelStatus: 'draft',
      productCode: 'demo-product',
      productName: '演示产品',
    } as IotProductApi.ProductResp);

    const container = await openDetail();
    clickTab(container, 'TSL 导入导出');
    await flush();

    clickButton(container, '导入 TSL');
    await flush();
    expect(container.innerHTML).toContain('请先粘贴或导出 TSL JSON');
    expect(apiMock.importTsl).not.toHaveBeenCalled();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    textarea.value = 'not-json';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    clickButton(container, '导入 TSL');
    await flush();
    expect(container.innerHTML).toContain('TSL 不是合法 JSON');
    expect(apiMock.importTsl).not.toHaveBeenCalled();
  });
});

const SERVICE_A = {
  description: '',
  id: 's-a',
  serviceId: 'svcA',
  serviceName: '服务 A',
  serviceOption: 'r',
};
const SERVICE_B = {
  description: '',
  id: 's-b',
  serviceId: 'svcB',
  serviceName: '服务 B',
  serviceOption: 'r',
};

describe('products/modules/detail.vue 补充分支（元素表独立性 / TSL / 服务切换）', () => {
  it('★ 三张元素表各自独立：属性表失败不牵连命令与事件，也不把整页画成「物模型加载失败」', async () => {
    apiMock.listServices.mockResolvedValue([SERVICE_A]);
    apiMock.listProperties.mockRejectedValue(new Error('属性表查询失败'));
    apiMock.listCommands.mockResolvedValue([{ id: 'c1', identifier: 'cmd-A' }]);
    apiMock.listEvents.mockResolvedValue([{ id: 'e1', identifier: 'evt-A' }]);

    const container = await openDetail();
    clickTab(container, '物模型');
    await flush();

    const html = container.innerHTML;
    // loadServiceElements 用 Promise.allSettled：一张表失败，另外两张必须照旧有数据
    expect(html).toContain('cmd-A');
    expect(html).toContain('evt-A');
    // 元素级失败不构成整页失败（modelError 只在 loadModel 本身抛错时设置）
    expect(html).not.toContain('物模型加载失败');
  });

  it('★ TSL 导入成功：解析后的文档交给后端、刷新；后端逐项报错则只展示、不刷新', async () => {
    apiMock.getProductDetail.mockResolvedValue({
      id: '9100001',
      modelStatus: 'draft',
      productCode: 'demo-product',
      productName: '演示产品',
    } as IotProductApi.ProductResp);
    apiMock.listServices.mockResolvedValue([SERVICE_A]);

    const container = await openDetail();
    clickTab(container, 'TSL 导入导出');
    await flush();

    const setTsl = (text: string) => {
      const textarea = container.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // 1) 后端全部接受 ⇒ 调接口 + 成功后 reloadAll（服务列表被重查）
    setTsl(JSON.stringify({ properties: [] }));
    await flush();
    apiMock.importTsl.mockResolvedValue({ errors: [], successCount: 2 });
    const servicesCallsBefore = apiMock.listServices.mock.calls.length;
    clickButton(container, '导入 TSL');
    await flush();

    expect(apiMock.importTsl).toHaveBeenCalledTimes(1);
    expect(apiMock.importTsl.mock.calls[0]?.[0]).toBe('9100001');
    expect(apiMock.importTsl.mock.calls[0]?.[1]).toEqual({ properties: [] });
    expect(apiMock.listServices.mock.calls.length).toBeGreaterThan(
      servicesCallsBefore,
    );

    // 2) 后端逐项报错 ⇒ 错误可见，且**不**触发 reloadAll
    setTsl(JSON.stringify({ properties: [1] }));
    await flush();
    apiMock.importTsl.mockResolvedValue({
      errors: ['属性 1 非法'],
      successCount: 0,
    });
    const servicesCallsBeforeError = apiMock.listServices.mock.calls.length;
    clickButton(container, '导入 TSL');
    await flush();

    expect(container.innerHTML).toContain('属性 1 非法');
    expect(apiMock.listServices.mock.calls.length).toBe(
      servicesCallsBeforeError,
    );
  });

  it('★ 导出 TSL：拉取文档并回填文本框（页面可核对），不只是下载', async () => {
    apiMock.exportTsl.mockResolvedValue({ profile: { productKey: 'pk-1' } });
    // happy-dom 不实现 ObjectURL；本用例只关心「文档是否回填到页面」，故给下载打桩
    const urlAny = URL as unknown as Record<string, unknown>;
    const originalCreate = urlAny.createObjectURL;
    const originalRevoke = urlAny.revokeObjectURL;
    urlAny.createObjectURL = vi.fn(() => 'blob:stub');
    urlAny.revokeObjectURL = vi.fn();

    try {
      const container = await openDetail();
      clickTab(container, 'TSL 导入导出');
      await flush();
      clickButton(container, '导出 TSL');
      await flush();

      expect(apiMock.exportTsl).toHaveBeenCalledWith('9100001');
      const textarea = container.querySelector(
        'textarea',
      ) as HTMLTextAreaElement;
      expect(textarea.value).toContain('"productKey": "pk-1"');
    } finally {
      urlAny.createObjectURL = originalCreate;
      urlAny.revokeObjectURL = originalRevoke;
    }
  });

  it('★ 切换服务：只重查该服务下的三张表，不重查服务列表（不扇出整个产品）', async () => {
    apiMock.listServices.mockResolvedValue([SERVICE_A, SERVICE_B]);

    const container = await openDetail();
    clickTab(container, '物模型');
    await flush();

    const servicesCallsBefore = apiMock.listServices.mock.calls.length;
    const serviceBButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('svcB'),
    ) as HTMLButtonElement | undefined;
    expect(serviceBButton, '未渲染出服务 B 的选择按钮').toBeTruthy();

    serviceBButton?.click();
    await flush();

    expect(apiMock.listServices.mock.calls.length).toBe(servicesCallsBefore);
    expect(apiMock.listProperties).toHaveBeenLastCalledWith('9100001', 's-b');
    expect(apiMock.listCommands).toHaveBeenLastCalledWith('9100001', 's-b');
    expect(apiMock.listEvents).toHaveBeenLastCalledWith('9100001', 's-b');
  });
});

import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';
import { useAccessStore } from '@vben/stores';

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

import DevicesPage from './index.vue';

/**
 * 设备台账「批量下发命令」入口 + 抽屉运行时用例（真实 i18n、真实 antdv、真实权限指令）。
 *
 * 只替换网络层与表格/抽屉容器，其余全走真实实现。两条硬纪律：
 * 1. **绝不依赖仓外 temp/i18n-requests-*.json**（CI 检出没有该目录 ⇒ ENOENT 打红 CI）；
 *    断言用真实 i18n 实例翻出来的文案（未合并时回落 key，同样可识别）；
 * 2. **部分失败绝不能显示成整体成功**：`accepted=true, ok=false` 必须是「已提交未送达」，
 *    `accepted=false` 必须是「未受理」——这是本能力最容易做错、后果最重的一处。
 */

const { batchCommandState, drawerCalls, fileMock, gridApiMock, mockApi } =
  vi.hoisted(() => ({
    batchCommandState: {
      component: null as any,
      // 真实内容组件自己的 useVbenDrawer（带 onConfirm/onOpenChange），与父页面的容器抽屉分开记，
      // 否则「打开内容抽屉」与「父页面注册容器」会互相覆盖（见仓内 batch-tags.test.ts 同款处理）。
      own: { api: null as any, options: null as any },
      page: { api: null as any },
    },
    drawerCalls: [] as any[],
    fileMock: { downloadByBlob: vi.fn() },
    gridApiMock: {
      grid: {
        clearCheckboxRow: vi.fn(),
        // 显式标注返回类型：否则 vi.fn(() => []) 被推断成返回 never[]，mockReturnValue 放不进设备对象
        getCheckboxRecords: vi.fn((): Record<string, unknown>[] => []),
      },
      query: vi.fn(),
    },
    mockApi: {
      getActiveAlertCounts: vi.fn(),
      getDevicePage: vi.fn(),
      listCommands: vi.fn(),
      listProperties: vi.fn(),
      listServices: vi.fn(),
      resendDeviceCommand: vi.fn(),
      sendBatchDeviceCommands: vi.fn(),
    },
  }));

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: vi.fn(),
  downloadByBlob: (...args: unknown[]) => fileMock.downloadByBlob(...args),
}));

/**
 * 聚合器用**部分 mock**（importOriginal）：页面还依赖聚合器里的常量/其它导出，
 * 全量替换会让「别人的代码缺导出」把本用例打红——那是测试替身的缺陷，不是被测代码的缺陷。
 */
vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    deleteDevice: vi.fn(),
    getActiveAlertCounts: (...args: unknown[]) =>
      mockApi.getActiveAlertCounts(...args),
    getDeviceNameMap: vi.fn(),
    getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
    getPublishedProductOptions: vi.fn(),
    listCommands: (...args: unknown[]) => mockApi.listCommands(...args),
    listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
    listServices: (...args: unknown[]) => mockApi.listServices(...args),
    resendDeviceCommand: (...args: unknown[]) =>
      mockApi.resendDeviceCommand(...args),
    sendBatchDeviceCommands: (...args: unknown[]) =>
      mockApi.sendBatchDeviceCommands(...args),
    updateDeviceStatus: vi.fn(),
  };
});

vi.mock('#/api/iot/device', () => ({
  batchDeleteDevices: vi.fn(),
  batchUpdateDeviceStatus: vi.fn(),
  exportDevicesCsv: vi.fn(),
}));

vi.mock('#/api/iot/tag', () => ({
  batchRemoveDeviceTags: vi.fn(),
  batchSetDeviceTags: vi.fn(),
}));

vi.mock('@vben/common-ui', () => {
  function createDrawerApi() {
    let data: unknown;
    const api: any = {
      close: vi.fn(),
      getData: () => data,
      lock: vi.fn(),
      open: vi.fn(),
      setData: vi.fn((value: unknown) => {
        data = value;
        return api;
      }),
      setState: vi.fn(),
      unlock: vi.fn(),
    };
    return api;
  }
  return {
    Page: defineComponent({
      name: 'PageStub',
      setup:
        (_props, { slots }) =>
        () =>
          h('div', slots.default?.()),
    }),
    useVbenDrawer: (options: any = {}) => {
      const api = createDrawerApi();
      const connected = options.connectedComponent;
      if (connected && connected === batchCommandState.component) {
        batchCommandState.page.api = api;
        drawerCalls.push({ api, options });
      }
      // 内容组件自己的抽屉：靠 onConfirm/onOpenChange 识别（它没有 connectedComponent）
      if (typeof options.onOpenChange === 'function') {
        batchCommandState.own.api = api;
        batchCommandState.own.options = options;
      }
      const DrawerStub = defineComponent({
        name: 'DrawerStub',
        inheritAttrs: false,
        setup(_props: unknown, { attrs, slots }: any) {
          // 父页面注册的是容器抽屉（renderless，只把内容组件挂出来）；
          // 内容组件自己的抽屉没有 connectedComponent ⇒ 必须渲染它的默认插槽，
          // 否则整个弹窗内容为空，DOM 级断言全部退化成「空白等于失败」。
          if (connected) {
            return () =>
              connected === batchCommandState.component
                ? h(connected, attrs)
                : null;
          }
          return () => h('div', { ...attrs }, slots.default?.());
        },
      });
      return [DrawerStub, api];
    },
  };
});

vi.mock('#/adapter/vxe-table', () => ({
  VbenTableAction: defineComponent({
    name: 'TableActionStub',
    setup: () => () => null,
  }),
  useVbenVxeGrid: (options: any) => {
    gridApiMock.grid.getCheckboxRecords.mockReturnValue([
      {
        deviceCode: 'D-1',
        deviceId: '1001',
        deviceName: '泵房温度',
        id: '1001',
        productId: 'p1',
      },
      {
        deviceCode: 'D-2',
        deviceId: '1002',
        deviceName: '车间湿度',
        id: '1002',
        productId: 'p1',
      },
    ]);
    /**
     * 勾选走 **gridEvents.checkboxChange**（生产口径），不走模板事件。
     *
     * 为什么用例必须照这个口径打：vben 的 <Grid> 把未声明 attrs 透传到根 div，而 vxe 的
     * checkbox-change 只在内层 VxeGrid 上绑定（自定义事件不冒泡）⇒ 模板 @checkbox-change
     * **永远收不到**。用桩 emit('checkbox-change') 会让用例"恒真"，掩盖这个真实缺陷
     * （既有 batch.test.ts 就是这么写的，所以它没能发现线上批量按钮恒禁用）。
     */
    const gridEvents = options?.gridEvents ?? {};
    const GridStub = defineComponent({
      name: 'GridStub',
      setup(_props: unknown, { slots }: any) {
        return () =>
          h('div', { class: 'grid-stub' }, [
            h(
              'button',
              {
                'data-testid': 'emit-checkbox',
                onClick: () =>
                  gridEvents.checkboxChange?.({
                    records: [{ id: '1001' }, { id: '1002' }],
                  }),
              },
              'select',
            ),
            slots['toolbar-tools']?.(),
          ]);
      },
    });
    return [GridStub, gridApiMock];
  },
}));

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('./modules/batch-command.vue', async () => {
  // 父页面用例用桩替换内容组件（避免真实抽屉的 vben 容器依赖）；
  // 抽屉自身的用例走 importActual 拿真实实现。
  const { defineComponent: dc, h: hh } = await import('vue');
  const Stub = dc({
    name: 'BatchCommandStub',
    emits: ['success'],
    setup(_props: unknown, { emit }: any) {
      return () =>
        hh(
          'button',
          {
            'data-testid': 'batch-command-success',
            onClick: () => emit('success', { delivered: 1, total: 1 }),
          },
          'success',
        );
    },
  });
  batchCommandState.component = Stub;
  return { default: Stub };
});

let ActualBatchCommand: any;

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-batch-command' });
  useAccessStore().setAccessCodes(['*:*:*']);
  const actual = await vi.importActual<{ default: unknown }>(
    './modules/batch-command.vue',
  );
  ActualBatchCommand = actual.default;
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  fileMock.downloadByBlob.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.grid.clearCheckboxRow.mockReset();
  drawerCalls.length = 0;
  batchCommandState.own.api = null;
  batchCommandState.own.options = null;
  batchCommandState.page.api = null;
  useAccessStore().setAccessCodes(['*:*:*']);

  mockApi.listServices.mockResolvedValue([{ id: 's1', serviceId: 'svc' }]);
  mockApi.listProperties.mockResolvedValue([
    {
      accessMode: 'RW',
      dataType: 'int',
      identifier: 'setpoint',
      propertyName: '设定值',
    },
  ]);
  mockApi.listCommands.mockResolvedValue([
    { commandName: '重启', identifier: 'reboot', inputParams: '[]' },
  ]);
  mockApi.sendBatchDeviceCommands.mockResolvedValue({
    accepted: 0,
    delivered: 0,
    rejected: 0,
    results: [],
    total: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountPage() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

/**
 * 触发设备台账表格的勾选。
 *
 * ⚠️ 同一 DOM 里可能有多张表：导入抽屉里也有一张（它自己的桩同样渲染了 emit-checkbox）。
 * 台账表是**最后渲染**的那一张，故取最后一个，避免勾错目标（勾错就会变成"按钮仍然禁用"）。
 */
async function selectRows(container: HTMLElement) {
  const buttons = [
    ...container.querySelectorAll('[data-testid="emit-checkbox"]'),
  ] as HTMLButtonElement[];
  buttons.at(-1)?.click();
  await nextTick();
}

function entryButton(container: HTMLElement) {
  return container.querySelector(
    '[data-testid="batch-command"]',
  ) as HTMLButtonElement | null;
}

/**
 * 在真实 antd Select 上选中一个目标标识（**真实交互路径**：点开下拉 → 点选项）。
 *
 * 用 DOM 驱动而不是直接改组件内部状态：本能力的要点之一就是「用户确实是从物模型下拉里选的」，
 * 绕过下拉的测试会漏掉「下拉根本没渲染/没有候选」这类真实故障。
 */
async function pickIdentifier(container: HTMLElement, label: string) {
  const select = container.querySelector(
    '[data-testid="batch-command-identifier"]',
  ) as HTMLElement | null;
  expect(select, '未找到目标标识下拉').toBeTruthy();
  // antd 的下拉浮层挂在 body 上，且是懒渲染 ⇒ 先点开、再在 body 里找选项
  (select?.querySelector('.ant-select-selector') as HTMLElement)?.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true }),
  );
  await flush();
  const option = [...document.querySelectorAll('.ant-select-item-option')].find(
    (element) => element.textContent?.includes(label),
  ) as HTMLElement | undefined;
  expect(option, `下拉里没有选项 ${label}`).toBeTruthy();
  option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flush();
}

/** 挂真实抽屉组件并触发打开（devices 由 data 传入）。 */
async function mountBatchCommand(devices: unknown[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(ActualBatchCommand) });
  app.mount(container);
  mounted = { app };
  await flush();
  batchCommandState.own.api.setData({ devices });
  await batchCommandState.own.options.onOpenChange(true);
  await flush();
  return { container, call: batchCommandState.own, app };
}

/** 「确认下发」按钮（用 data-testid，不依赖文案：i18n 未合并时文案是原始 key）。 */
function submitButton(container: HTMLElement) {
  return container.querySelector('[data-testid="batch-command-submit"]') as
    | HTMLButtonElement
    | undefined;
}

const TWO_DEVICES = [
  {
    deviceCode: 'D-1',
    deviceId: '1001',
    deviceName: '泵房温度',
    productId: 'p1',
  },
  {
    deviceCode: 'D-2',
    deviceId: '1002',
    deviceName: '车间湿度',
    productId: 'p1',
  },
];

describe('devices/index.vue 批量下发入口', () => {
  it('★ 权限门禁：无 iot:debug:send 时不渲染入口', async () => {
    useAccessStore().setAccessCodes(['iot:device:update']);
    const container = await mountPage();
    expect(entryButton(container)).toBeNull();
  });

  it('★ 有 iot:debug:send 时渲染入口；未勾选禁用且点击不打开抽屉', async () => {
    useAccessStore().setAccessCodes(['iot:debug:send']);
    const container = await mountPage();
    const button = entryButton(container);
    expect(button).toBeTruthy();
    expect(button?.hasAttribute('disabled')).toBe(true);

    button?.click();
    await flush();
    // 父页面总会注册容器抽屉，所以不能断言「没有抽屉调用」；
    // 正确口径是「没有打开、也没有把设备交给它」。
    expect(batchCommandState.page.api.setData).not.toHaveBeenCalled();
    expect(batchCommandState.page.api.open).not.toHaveBeenCalled();
  });

  it('★ 勾选接线走 gridEvents.checkboxChange（模板 @checkbox-change 收不到，会让按钮恒禁用）', async () => {
    const container = await mountPage();
    // 桩 Grid 只在 gridEvents.checkboxChange 存在时才会真正改变勾选
    await selectRows(container);
    expect(entryButton(container)?.hasAttribute('disabled')).toBe(false);
  });

  it('★ 勾选后入口可用，点击把设备对象（含 productId/名称）交给抽屉并打开', async () => {
    useAccessStore().setAccessCodes(['iot:debug:send']);
    const container = await mountPage();
    await selectRows(container);

    expect(entryButton(container)?.hasAttribute('disabled')).toBe(false);
    entryButton(container)?.click();
    await flush();

    expect(drawerCalls).toHaveLength(1);
    expect(drawerCalls[0]?.api.setData).toHaveBeenCalledWith({
      devices: [
        {
          deviceCode: 'D-1',
          deviceId: '1001',
          deviceName: '泵房温度',
          productId: 'p1',
        },
        {
          deviceCode: 'D-2',
          deviceId: '1002',
          deviceName: '车间湿度',
          productId: 'p1',
        },
      ],
    });
    expect(drawerCalls[0]?.api.open).toHaveBeenCalledTimes(1);
  });
});

describe('batch-command.vue 三态结果展示', () => {
  it('★ 混合结果：已送达/已提交未送达/未受理三态各自展示，汇总明确说「部分失败」', async () => {
    mockApi.sendBatchDeviceCommands.mockResolvedValue({
      accepted: '2',
      delivered: '1',
      rejected: '1',
      results: [
        {
          accepted: true,
          deviceId: '1001',
          message: '已下发，等待设备回执',
          ok: true,
          requestId: 'req-ok',
          statusCode: 'sent',
        },
        {
          accepted: true,
          deviceId: '1002',
          errorCode: 'NO_SUBSCRIBER',
          message: '平台已受理但未送达（设备未连接）',
          ok: false,
          requestId: 'req-offline',
          statusCode: 'failed',
        },
      ],
      total: '3',
    });
    // 第三条通过 results 之外补不了；这里用 3 条 results 重设
    mockApi.sendBatchDeviceCommands.mockResolvedValue({
      accepted: '2',
      delivered: '1',
      rejected: '1',
      results: [
        {
          accepted: true,
          deviceId: '1001',
          message: '已下发，等待设备回执',
          ok: true,
          requestId: 'req-ok',
          statusCode: 'sent',
        },
        {
          accepted: true,
          deviceId: '1002',
          errorCode: 'NO_SUBSCRIBER',
          message: '平台已受理但未送达（设备未连接）',
          ok: false,
          requestId: 'req-offline',
          statusCode: 'failed',
        },
        {
          accepted: false,
          code: 'DEVICE_DISABLED',
          deviceId: '1003',
          message: '设备已停用，不参与批量下发',
        },
      ],
      total: '3',
    });

    const { container } = await mountBatchCommand([
      ...TWO_DEVICES,
      {
        deviceCode: 'D-3',
        deviceId: '1003',
        deviceName: '停用设备',
        productId: 'p1',
      },
    ]);
    await pickIdentifier(container, '设定值');
    submitButton(container)?.click();
    await flush();

    const text = container.textContent ?? '';
    // 三态文案都在（用真实 i18n 实例翻出来的文案断言；未合并时回落 key，同样可识别）
    expect(text).toContain($t('page.iot.device.batchCommand.stateDelivered'));
    expect(container.textContent).toContain(
      $t('page.iot.device.batchCommand.stateNotDelivered'),
    );
    expect(text).toContain($t('page.iot.device.batchCommand.stateRejected'));
    // 汇总必须如实：不能出现「全部 3 台已送达」
    expect(text).not.toContain(
      $t('page.iot.device.batchCommand.resultAllDelivered', ['3']),
    );
    expect(text).toContain(
      $t('page.iot.device.batchCommand.resultPartial', ['3', '1', '1', '1']),
    );
    // NO_SUBSCRIBER 要能一眼看出「设备未连接」
    expect(text).toContain(
      $t('page.iot.device.batchCommand.deliveryNoSubscriber'),
    );
    // DEVICE_DISABLED 要指引下一步（去设备台账启用）
    expect(text).toContain($t('page.iot.device.batchCommand.nextDisabled'));
    // requestId 可复制（CopyText 渲染了该值）
    expect(text).toContain('req-ok');
    expect(text).toContain('req-offline');
  });

  it('★ 全部送达：汇总明确说「全部 N 台已送达」', async () => {
    mockApi.sendBatchDeviceCommands.mockResolvedValue({
      accepted: '2',
      delivered: '2',
      rejected: '0',
      results: [
        {
          accepted: true,
          deviceId: '1001',
          ok: true,
          requestId: 'r1',
          statusCode: 'sent',
        },
        {
          accepted: true,
          deviceId: '1002',
          ok: true,
          requestId: 'r2',
          statusCode: 'sent',
        },
      ],
      total: '2',
    });
    const { container } = await mountBatchCommand(TWO_DEVICES);
    await pickIdentifier(container, '设定值');
    submitButton(container)?.click();
    await flush();
    expect(container.textContent).toContain(
      $t('page.iot.device.batchCommand.resultAllDelivered', ['2']),
    );
  });

  it('★ 整批级失败：原样展示后端 message，且不出现任何「已送达」成功文案', async () => {
    mockApi.sendBatchDeviceCommands.mockRejectedValue(
      Object.assign(new Error('设备 ID 列表不能为空'), {
        response: {
          data: { code: 50_000, data: null, message: '设备 ID 列表不能为空' },
        },
      }),
    );
    const { container } = await mountBatchCommand(TWO_DEVICES);
    await pickIdentifier(container, '设定值');
    submitButton(container)?.click();
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('设备 ID 列表不能为空');
    expect(text).not.toContain(
      $t('page.iot.device.batchCommand.resultAllDelivered', ['2']),
    );
    // 没有结果区（resultSummary 未设置）
    expect(text).not.toContain($t('page.iot.device.batchCommand.resultTitle'));
  });

  it('★ 客户端校验：未选目标标识时不发请求并给 warning', async () => {
    const { container } = await mountBatchCommand(TWO_DEVICES);
    submitButton(container)?.click();
    await flush();
    expect(mockApi.sendBatchDeviceCommands).not.toHaveBeenCalled();
    // identifierPlaceholder 存在说明下拉在；校验文案出现即「先拦一道」
    const text = container.textContent ?? '';
    expect(text).toContain($t('page.iot.device.batchCommand.noProperty'));
  });

  it('★ CSV 导出：用当前逐台结果生成，失败行不被美化', async () => {
    mockApi.sendBatchDeviceCommands.mockResolvedValue({
      accepted: '2',
      delivered: '1',
      rejected: '1',
      results: [
        {
          accepted: true,
          deviceId: '1001',
          ok: true,
          requestId: 'req-ok',
          statusCode: 'sent',
        },
        {
          accepted: false,
          code: 'DEVICE_DISABLED',
          deviceId: '1002',
          message: '设备已停用',
        },
      ],
      total: '2',
    });
    const { container } = await mountBatchCommand(TWO_DEVICES);
    await pickIdentifier(container, '设定值');
    submitButton(container)?.click();
    await flush();

    const exportButton = container.querySelector(
      '[data-testid="batch-command-export"]',
    ) as HTMLButtonElement | null;
    expect(exportButton, '未找到导出按钮').toBeTruthy();
    exportButton?.click();
    await flush();

    expect(fileMock.downloadByBlob).toHaveBeenCalledTimes(1);
    const blob = fileMock.downloadByBlob.mock.calls[0]?.[0] as Blob;
    const text = await blob.text();
    expect(text).toContain($t('page.iot.device.batchCommand.stateDelivered'));
    expect(text).toContain($t('page.iot.device.batchCommand.stateRejected'));
    expect(text).toContain('DEVICE_DISABLED');
    // 前置 BOM（Excel 不乱码）：\uFEFF 的码点
    expect(text.codePointAt(0)).toBe(65_279);
  });
});

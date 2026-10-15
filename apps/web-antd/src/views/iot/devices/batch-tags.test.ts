import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';
import { useAccessStore } from '@vben/stores';

import { message } from 'ant-design-vue';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import DevicesPage from './index.vue';

/**
 * 设备台账「批量打标签 / 批量移除标签」用例。
 *
 * 覆盖：弹层表单 schema 与 mode 切换、请求参数（trim/去重）、created/updated/removed 数量提示、
 * 失败原样提示且不关闭、提交中防重复、入口权限、成功后清空勾选 + 刷新。
 *
 * 表格/抽屉/表单用桩；i18n、权限指令、antd message 是真的。
 */

const {
  batchTagsState,
  captured,
  componentDrawer,
  fileMock,
  formApi,
  formOptions,
  gridApiMock,
  mockApi,
  routeState,
} = vi.hoisted(() => ({
  batchTagsState: {
    api: null as any,
    component: null as any,
    options: null as any,
  },
  captured: { options: null as any },
  componentDrawer: { api: null as any, options: null as any },
  fileMock: {
    downloadBlobSafe: vi.fn(),
    downloadByBlob: vi.fn(),
  },
  formApi: {
    getValues: vi.fn(),
    reset: vi.fn(),
    setState: vi.fn(),
    validate: vi.fn(),
  },
  formOptions: { current: null as any },
  gridApiMock: {
    grid: { clearCheckboxRow: vi.fn() },
    query: vi.fn(),
  },
  mockApi: {
    batchRemoveDeviceTags: vi.fn(),
    batchSetDeviceTags: vi.fn(),
    getActiveAlertCounts: vi.fn(),
    getDevicePage: vi.fn(),
  },
  routeState: { query: {} as Record<string, unknown> },
}));

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: fileMock.downloadBlobSafe,
  downloadByBlob: fileMock.downloadByBlob,
}));

vi.mock('#/api/iot/tag', () => ({
  batchRemoveDeviceTags: (...args: unknown[]) =>
    mockApi.batchRemoveDeviceTags(...args),
  batchSetDeviceTags: (...args: unknown[]) =>
    mockApi.batchSetDeviceTags(...args),
}));

vi.mock('#/api/iot', () => ({
  deleteDevice: vi.fn(),
  getActiveAlertCounts: (...args: unknown[]) =>
    mockApi.getActiveAlertCounts(...args),
  getDeviceNameMap: vi.fn(),
  getDevicePage: (...args: unknown[]) => mockApi.getDevicePage(...args),
  getPublishedProductOptions: vi.fn(),
  updateDeviceStatus: vi.fn(),
}));

vi.mock('#/api/iot/device', () => ({
  batchDeleteDevices: vi.fn(),
  batchUpdateDeviceStatus: vi.fn(),
  exportDevicesCsv: vi.fn(),
}));

vi.mock('#/adapter/form', () => ({
  useVbenForm: (options: any) => {
    formOptions.current = options;
    return [
      defineComponent({ name: 'FormStub', setup: () => () => null }),
      formApi,
    ];
  },
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
      // 内容组件自己的 useVbenDrawer（带 onConfirm）用于组件级用例驱动
      if (typeof options.onConfirm === 'function') {
        componentDrawer.options = options;
        componentDrawer.api = api;
      }
      const connected = options.connectedComponent;
      if (connected && connected === batchTagsState.component) {
        batchTagsState.api = api;
        batchTagsState.options = options;
      }
      const DrawerStub = defineComponent({
        name: 'DrawerStub',
        inheritAttrs: false,
        setup(_props: unknown, { attrs }: any) {
          return () =>
            connected === batchTagsState.component ? h(connected, attrs) : null;
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
    captured.options = options;
    // 生产口径：勾选事件来自 gridEvents.checkboxChange（vben 的 Grid 把未声明 attrs 透传到根 div，
    // vxe 的 checkbox-change 只绑在内层 VxeGrid 上 ⇒ 模板 @checkbox-change 收不到，见 batch.test.ts）
    const events = options?.gridEvents ?? {};
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
                  events.checkboxChange?.({
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
  useRoute: () => ({ query: routeState.query }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// 父页面用例用桩替换批量标签内容组件；组件级用例用 importActual 绕过 mock 直接测真实实现。
vi.mock('./modules/batch-tags.vue', () => {
  const Stub = defineComponent({
    name: 'BatchTagsStub',
    emits: ['success'],
    setup(_props: unknown, { emit }: any) {
      return () =>
        h(
          'button',
          {
            'data-testid': 'batch-tags-success',
            onClick: () =>
              emit('success', { created: 1, removed: 0, updated: 0 }),
          },
          'success',
        );
    },
  });
  batchTagsState.component = Stub;
  return { default: Stub };
});

let ActualBatchTags: any;

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-batch-tags' });
  useAccessStore().setAccessCodes(['*:*:*']);
  const actualBatchTagsModule = await vi.importActual<{
    default: unknown;
  }>('./modules/batch-tags.vue');
  ActualBatchTags = actualBatchTagsModule.default;
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  for (const fn of Object.values(formApi)) fn.mockReset();
  for (const fn of Object.values(fileMock)) fn.mockReset();
  gridApiMock.query.mockReset();
  gridApiMock.grid.clearCheckboxRow.mockReset();
  captured.options = null;
  componentDrawer.api = null;
  componentDrawer.options = null;
  batchTagsState.api = null;
  batchTagsState.options = null;
  formOptions.current = null;
  routeState.query = {};
  useAccessStore().setAccessCodes(['*:*:*']);

  formApi.validate.mockResolvedValue({ valid: true });
  formApi.getValues.mockResolvedValue({});
  mockApi.batchSetDeviceTags.mockResolvedValue({
    created: 0,
    removed: 0,
    updated: 0,
  });
  mockApi.batchRemoveDeviceTags.mockResolvedValue({
    created: 0,
    removed: 0,
    updated: 0,
  });

  vi.spyOn(message, 'success').mockImplementation(() => undefined as never);
  vi.spyOn(message, 'error').mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

function bizFailure(code: number, messageText: string) {
  return Object.assign(new Error(messageText), {
    response: { data: { code, data: null, message: messageText } },
  });
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountActualBatchTags() {
  const successSpy = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({
    render: () => h(ActualBatchTags, { onSuccess: successSpy }),
  });
  app.mount(container);
  mounted = { app };
  await nextTick();
  return { container, successSpy };
}

async function openTagsDrawer(
  mode: 'remove' | 'set',
  deviceIds: string[] = ['1', '2'],
) {
  componentDrawer.api.setData({ deviceIds, mode });
  await componentDrawer.options.onOpenChange(true);
  await flush();
}

async function mountDevices() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(DevicesPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  return container;
}

async function selectRows(container: HTMLElement) {
  (
    container.querySelector(
      '[data-testid="emit-checkbox"]',
    ) as HTMLButtonElement
  ).click();
  await nextTick();
}

function batchTagButton(container: HTMLElement, mode: 'remove' | 'set') {
  return container.querySelector(
    `[data-testid="batch-tag-${mode}"]`,
  ) as HTMLButtonElement | null;
}

describe('devices/modules/batch-tags.vue 表单与提交', () => {
  it('★ 打标签：schema 为 tagKey/tagValue，请求参数 trim 后提交，成功提示 created/updated 并 emit success', async () => {
    const { successSpy } = await mountActualBatchTags();
    const fields = formOptions.current?.schema as any[];
    expect(fields.map((field) => field.fieldName)).toEqual([
      'tagKey',
      'tagValue',
    ]);
    expect(fields.every((field) => field.component === 'Input')).toBe(true);

    await openTagsDrawer('set');
    formApi.getValues.mockResolvedValue({
      tagKey: '  env  ',
      tagValue: ' prod ',
    });
    mockApi.batchSetDeviceTags.mockResolvedValue({
      created: 1,
      removed: 0,
      updated: 1,
    });

    await componentDrawer.options.onConfirm();
    await flush();

    expect(mockApi.batchSetDeviceTags).toHaveBeenCalledTimes(1);
    expect(mockApi.batchSetDeviceTags).toHaveBeenCalledWith(
      ['1', '2'],
      'env',
      'prod',
    );
    expect(successSpy).toHaveBeenCalledWith({
      created: 1,
      removed: 0,
      updated: 1,
    });
    expect(vi.mocked(message.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(message.success).mock.calls[0]?.[0])).toMatch(
      /新增 1|batchTagSetDone/,
    );
    expect(componentDrawer.api.lock).toHaveBeenCalledTimes(1);
    expect(componentDrawer.api.close).toHaveBeenCalledTimes(1);
  });

  it('★ 移除标签：schema 切到 Select tags，tagKeys trim/去重后提交，成功提示 removed 数量', async () => {
    await mountActualBatchTags();

    await openTagsDrawer('remove');
    const schemaCall = formApi.setState.mock.calls.at(-1)?.[0] as any;
    const field = schemaCall?.schema?.find(
      (item: any) => item.fieldName === 'tagKeys',
    );
    expect(field?.component).toBe('Select');
    expect(field?.componentProps?.mode).toBe('tags');

    formApi.getValues.mockResolvedValue({
      tagKeys: [' env ', 'env', '', 'zone'],
    });
    mockApi.batchRemoveDeviceTags.mockResolvedValue({
      created: 0,
      removed: 3,
      updated: 0,
    });

    await componentDrawer.options.onConfirm();
    await flush();

    expect(mockApi.batchRemoveDeviceTags).toHaveBeenCalledTimes(1);
    expect(mockApi.batchRemoveDeviceTags).toHaveBeenCalledWith(
      ['1', '2'],
      ['env', 'zone'],
    );
    expect(vi.mocked(message.success)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(message.success).mock.calls[0]?.[0])).toMatch(
      /删除 3|batchTagRemoveDone/,
    );
    expect(componentDrawer.api.close).toHaveBeenCalledTimes(1);
  });

  it('★ 失败：原样展示后端 message，不关闭抽屉并解锁可重试', async () => {
    await mountActualBatchTags();
    await openTagsDrawer('set');
    formApi.getValues.mockResolvedValue({ tagKey: 'env', tagValue: 'prod' });
    mockApi.batchSetDeviceTags.mockRejectedValue(
      bizFailure(50_001, '标签键已存在：env'),
    );

    await componentDrawer.options.onConfirm();
    await flush();

    expect(vi.mocked(message.error).mock.calls[0]?.[0]).toBe(
      '标签键已存在：env',
    );
    expect(vi.mocked(message.success)).not.toHaveBeenCalled();
    expect(componentDrawer.api.close).not.toHaveBeenCalled();
    expect(componentDrawer.api.unlock).toHaveBeenCalledTimes(1);
  });

  it('★ 提交中重复触发只发一次请求（drawer lock + 程序性防重）', async () => {
    await mountActualBatchTags();
    await openTagsDrawer('set');
    formApi.getValues.mockResolvedValue({ tagKey: 'env', tagValue: 'prod' });

    let resolveBatch!: (value: {
      created: number;
      removed: number;
      updated: number;
    }) => void;
    mockApi.batchSetDeviceTags.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBatch = resolve;
        }),
    );

    const first = componentDrawer.options.onConfirm();
    await flush();
    expect(mockApi.batchSetDeviceTags).toHaveBeenCalledTimes(1);

    const second = componentDrawer.options.onConfirm();
    await flush();
    expect(mockApi.batchSetDeviceTags).toHaveBeenCalledTimes(1);

    resolveBatch({ created: 2, removed: 0, updated: 0 });
    await first;
    await second;

    expect(componentDrawer.api.close).toHaveBeenCalledTimes(1);
  });

  it('★ 表单校验不通过：不发请求（校验先于 lock）', async () => {
    await mountActualBatchTags();
    await openTagsDrawer('set');
    formApi.validate.mockResolvedValue({ valid: false });

    await componentDrawer.options.onConfirm();
    await flush();

    expect(mockApi.batchSetDeviceTags).not.toHaveBeenCalled();
    expect(componentDrawer.api.lock).not.toHaveBeenCalled();
  });
});

describe('devices/index.vue 批量标签入口', () => {
  it('★ 权限门禁：仅 iot:tag:create 时只出现「批量打标签」', async () => {
    useAccessStore().setAccessCodes(['iot:tag:create']);
    const container = await mountDevices();
    expect(batchTagButton(container, 'set')).toBeTruthy();
    expect(batchTagButton(container, 'remove')).toBeNull();
  });

  it('★ 权限门禁：仅 iot:tag:delete 时只出现「批量移除标签」', async () => {
    useAccessStore().setAccessCodes(['iot:tag:delete']);
    const container = await mountDevices();
    expect(batchTagButton(container, 'set')).toBeNull();
    expect(batchTagButton(container, 'remove')).toBeTruthy();
  });

  it('★ 权限门禁：既无 tag 权限时两个入口都不渲染', async () => {
    useAccessStore().setAccessCodes(['iot:device:update']);
    const container = await mountDevices();
    expect(batchTagButton(container, 'set')).toBeNull();
    expect(batchTagButton(container, 'remove')).toBeNull();
  });

  it('★ 未勾选时入口禁用，点击不打开抽屉', async () => {
    const container = await mountDevices();
    expect(batchTagButton(container, 'set')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(batchTagButton(container, 'remove')?.hasAttribute('disabled')).toBe(
      true,
    );

    batchTagButton(container, 'set')?.click();
    await flush();
    expect(batchTagsState.api?.setData).not.toHaveBeenCalled();
    expect(batchTagsState.api?.open).not.toHaveBeenCalled();
  });

  it('★ 勾选后打开对应抽屉：deviceIds 为字符串 id + mode 正确；成功后清空勾选并刷新', async () => {
    const container = await mountDevices();
    await selectRows(container);

    expect(batchTagButton(container, 'set')?.hasAttribute('disabled')).toBe(
      false,
    );
    batchTagButton(container, 'set')?.click();
    await flush();
    expect(batchTagsState.api.setData).toHaveBeenCalledWith({
      deviceIds: ['1001', '1002'],
      mode: 'set',
    });
    expect(batchTagsState.api.open).toHaveBeenCalledTimes(1);

    // 模拟弹层提交成功 → 父页面清空勾选 + 刷新
    (
      container.querySelector(
        '[data-testid="batch-tags-success"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(gridApiMock.grid.clearCheckboxRow).toHaveBeenCalledTimes(1);
    expect(gridApiMock.query).toHaveBeenCalledTimes(1);
    expect(batchTagButton(container, 'set')?.hasAttribute('disabled')).toBe(
      true,
    );

    // 重新勾选后可打开移除模式
    await selectRows(container);
    batchTagButton(container, 'remove')?.click();
    await flush();
    expect(batchTagsState.api.setData).toHaveBeenLastCalledWith({
      deviceIds: ['1001', '1002'],
      mode: 'remove',
    });
    expect(batchTagsState.api.open).toHaveBeenCalledTimes(2);
  });
});

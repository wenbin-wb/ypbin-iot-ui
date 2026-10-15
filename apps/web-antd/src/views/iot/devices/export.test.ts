import { createApp, defineComponent, h, nextTick } from 'vue';

import { registerAccessDirective } from '@vben/access';
import { useAccessStore } from '@vben/stores';

import { message } from 'ant-design-vue';
import dayjs from 'dayjs';
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
 * 设备台账「导出 CSV」用例。
 *
 * 锁四件事：① 按钮按 `iot:device:list` 显示；② 导出参数 = 当前搜索表单值；
 * ③ 成功走 `downloadBlobSafe(blob, 含日期文件名)`；④ 失败原样展示后端 message 且 loading 可防重复。
 *
 * 表格/抽屉用桩（导出逻辑不依赖真实 vxe 渲染），但 i18n、权限指令、antd 是真的。
 */

const { captured, fileMock, gridApiMock, mockApi } = vi.hoisted(() => ({
  captured: { options: null as any },
  fileMock: {
    downloadBlobSafe: vi.fn(),
  },
  gridApiMock: {
    formApi: { form: { values: {} as Record<string, unknown> } },
    grid: {},
    query: vi.fn(),
  },
  mockApi: {
    exportDevicesCsv: vi.fn(),
    getActiveAlertCounts: vi.fn(),
    getDevicePage: vi.fn(),
  },
}));

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: (...args: unknown[]) => fileMock.downloadBlobSafe(...args),
  // series.vue / import.vue 在模块加载期会 import 它；本用例不触发，但 mock 必须提供
  downloadByBlob: vi.fn(),
}));

vi.mock('#/api/iot/device', () => ({
  batchDeleteDevices: vi.fn(),
  batchUpdateDeviceStatus: vi.fn(),
  exportDevicesCsv: (...args: unknown[]) => mockApi.exportDevicesCsv(...args),
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

vi.mock('@vben/common-ui', () => ({
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
      setup:
        (_props: unknown, { slots }: any) =>
        () =>
          h('div', { class: 'grid-stub' }, [slots['toolbar-tools']?.()]),
    });
    return [GridStub, gridApiMock];
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
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-device-export' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  mockApi.exportDevicesCsv.mockReset();
  mockApi.getActiveAlertCounts.mockReset();
  mockApi.getDevicePage.mockReset();
  fileMock.downloadBlobSafe.mockReset();
  gridApiMock.formApi.form.values = {};
  captured.options = null;
  useAccessStore().setAccessCodes(['*:*:*']);
  // 默认：后端返回一个 CSV Blob，安全下载成功
  mockApi.exportDevicesCsv.mockResolvedValue(
    new Blob(['deviceCode,deviceName\nD-1,泵房'], { type: 'text/csv' }),
  );
  fileMock.downloadBlobSafe.mockResolvedValue(true);
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

function exportButton(container: HTMLElement) {
  return container.querySelector(
    '[data-testid="export-csv"]',
  ) as HTMLButtonElement | null;
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

describe('设备台账导出 CSV', () => {
  it('★ 权限门禁：有 iot:device:list 才渲染导出按钮', async () => {
    useAccessStore().setAccessCodes(['iot:device:list']);
    const container = await mountPage();
    expect(exportButton(container), '有列表权限却无导出按钮').toBeTruthy();
  });

  it('★ 权限门禁：无 iot:device:list 时导出按钮不渲染', async () => {
    useAccessStore().setAccessCodes(['iot:device:update']);
    const container = await mountPage();
    expect(exportButton(container), '无列表权限却渲染了导出按钮').toBeNull();
  });

  it('★ 导出参数 = 当前搜索表单值，成功下载文件名带日期', async () => {
    gridApiMock.formApi.form.values = {
      keyword: '泵',
      productId: '9',
      protocol: 'mqtt',
    };
    const container = await mountPage();

    exportButton(container)?.click();
    await flush();

    expect(mockApi.exportDevicesCsv).toHaveBeenCalledTimes(1);
    expect(mockApi.exportDevicesCsv).toHaveBeenCalledWith({
      keyword: '泵',
      productId: '9',
      protocol: 'mqtt',
    });
    // 成功路径必须真的走安全下载，且文件名含当天日期 + .csv
    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    const [blob, fileName, errorMsg] =
      fileMock.downloadBlobSafe.mock.calls[0] ?? [];
    expect(blob).toBeInstanceOf(Blob);
    expect(String(fileName)).toContain(dayjs().format('YYYYMMDD'));
    expect(String(fileName)).toMatch(/\.csv$/);
    expect(typeof errorMsg).toBe('string');
    // loading 已复位
    expect(exportButton(container)?.classList.contains('ant-btn-loading')).toBe(
      false,
    );
  });

  it('★ 请求失败：原样展示后端 message，不触发下载', async () => {
    mockApi.exportDevicesCsv.mockRejectedValueOnce(
      bizFailure(40_303, '导出被拒绝：无对应权限'),
    );
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => ({}) as any);
    const container = await mountPage();

    exportButton(container)?.click();
    await flush();

    expect(errorSpy).toHaveBeenCalledWith('导出被拒绝：无对应权限');
    expect(fileMock.downloadBlobSafe).not.toHaveBeenCalled();
  });

  it('★ loading 防重复：在途期间按钮 loading，重复点击不重复请求', async () => {
    let resolveExport: ((value: Blob) => void) | undefined;
    mockApi.exportDevicesCsv.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          resolveExport = resolve;
        }),
    );
    const container = await mountPage();

    const button = exportButton(container);
    button?.click();
    await nextTick();
    expect(button?.classList.contains('ant-btn-loading')).toBe(true);

    button?.click();
    await flush();
    expect(mockApi.exportDevicesCsv).toHaveBeenCalledTimes(1);

    resolveExport?.(new Blob(['a,b'], { type: 'text/csv' }));
    await flush();
    expect(button?.classList.contains('ant-btn-loading')).toBe(false);
  });
});

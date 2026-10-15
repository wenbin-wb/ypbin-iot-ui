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

import AlertsPage from './index.vue';

/**
 * 告警中心「导出 CSV」用例。
 *
 * 锁四件事：① 按钮按 `iot:alert:list` 显示；② 导出参数 = 当前筛选 + `resolveDeviceFilter`
 * 合并后的 URL 设备过滤（表单显式选择优先）；③ 成功走 `downloadBlobSafe(blob, 含日期文件名)`；
 * ④ 失败原样展示后端 message、loading 防重复。
 *
 * 表格/抽屉用桩；i18n、权限指令、antd Tabs 是真的。
 */

const { captured, fileMock, gridApiMock, mockApi, routeState } = vi.hoisted(
  () => ({
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
      ackAlerts: vi.fn(),
      exportAlertsCsv: vi.fn(),
      getAlertPage: vi.fn(),
      getAlertRulePage: vi.fn(),
      getAlertSummary: vi.fn(),
      getDeviceOptions: vi.fn(),
      getDeviceSeries: vi.fn(),
      getPublishedProductOptions: vi.fn(),
      listProperties: vi.fn(),
      setAlertRulesEnabled: vi.fn(),
      silenceAlerts: vi.fn(),
    },
    routeState: { query: {} as Record<string, unknown> },
  }),
);

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: (...args: unknown[]) => fileMock.downloadBlobSafe(...args),
  downloadByBlob: vi.fn(),
}));

vi.mock('#/api/iot/alert', () => ({
  exportAlertsCsv: (...args: unknown[]) => mockApi.exportAlertsCsv(...args),
}));

vi.mock('#/api/iot', () => ({
  ackAlerts: (...args: unknown[]) => mockApi.ackAlerts(...args),
  getAlertPage: (...args: unknown[]) => mockApi.getAlertPage(...args),
  getAlertRulePage: (...args: unknown[]) => mockApi.getAlertRulePage(...args),
  getAlertSummary: (...args: unknown[]) => mockApi.getAlertSummary(...args),
  getDeviceOptions: (...args: unknown[]) => mockApi.getDeviceOptions(...args),
  getDeviceSeries: (...args: unknown[]) => mockApi.getDeviceSeries(...args),
  getPublishedProductOptions: (...args: unknown[]) =>
    mockApi.getPublishedProductOptions(...args),
  listProperties: (...args: unknown[]) => mockApi.listProperties(...args),
  setAlertRulesEnabled: (...args: unknown[]) =>
    mockApi.setAlertRulesEnabled(...args),
  silenceAlerts: (...args: unknown[]) => mockApi.silenceAlerts(...args),
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
  useRoute: () => ({ path: '/iot/alerts', query: routeState.query }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const { initStores } = await import('@vben/stores');
  await initStores(app, { namespace: 'test-alert-export' });
  useAccessStore().setAccessCodes(['*:*:*']);
});

let mounted: undefined | { app: { unmount: () => void } };

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
  fileMock.downloadBlobSafe.mockReset();
  gridApiMock.formApi.form.values = {};
  captured.options = null;
  routeState.query = {};
  useAccessStore().setAccessCodes(['*:*:*']);
  mockApi.getAlertSummary.mockResolvedValue({
    ackedCount: '0',
    activeCount: '0',
    criticalCount: '0',
    resolvedLast24h: '0',
  });
  mockApi.getDeviceOptions.mockResolvedValue([]);
  mockApi.exportAlertsCsv.mockResolvedValue(
    new Blob(['id,severity\n1,CRITICAL'], { type: 'text/csv' }),
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
  const app = createApp({ render: () => h(AlertsPage as never) });
  registerAccessDirective(app);
  app.mount(container);
  mounted = { app };
  await nextTick();
  await flush();
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

describe('告警中心导出 CSV', () => {
  it('★ 权限门禁：有 iot:alert:list 才渲染导出按钮（不依赖 iot:alert:ack）', async () => {
    useAccessStore().setAccessCodes(['iot:alert:list']);
    const container = await mountPage();
    expect(exportButton(container), '有列表权限却无导出按钮').toBeTruthy();
  });

  it('★ 权限门禁：无 iot:alert:list 时不渲染导出按钮', async () => {
    useAccessStore().setAccessCodes(['iot:alert:ack']);
    const container = await mountPage();
    expect(exportButton(container), '无列表权限却渲染了导出按钮').toBeNull();
  });

  it('★ 导出参数 = 当前筛选 + URL deviceId（无表单设备过滤时）', async () => {
    routeState.query = { deviceId: 'd-9' };
    gridApiMock.formApi.form.values = {
      severity: 'CRITICAL',
      state: 'FIRING',
    };
    const container = await mountPage();

    exportButton(container)?.click();
    await flush();

    expect(mockApi.exportAlertsCsv).toHaveBeenCalledTimes(1);
    expect(mockApi.exportAlertsCsv).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'd-9',
        severity: 'CRITICAL',
        state: 'FIRING',
      }),
    );
    // 成功路径必须真的走安全下载，且文件名含当天日期 + .csv
    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    const [blob, fileName] = fileMock.downloadBlobSafe.mock.calls[0] ?? [];
    expect(blob).toBeInstanceOf(Blob);
    expect(String(fileName)).toContain(dayjs().format('YYYYMMDD'));
    expect(String(fileName)).toMatch(/\.csv$/);
  });

  it('★ 表单显式选择的 deviceId 优先于 URL 带来的 deviceId（与列表查询同一规则）', async () => {
    routeState.query = { deviceId: 'd-9' };
    gridApiMock.formApi.form.values = { deviceId: 'd-1', state: 'ACKED' };
    const container = await mountPage();

    exportButton(container)?.click();
    await flush();

    expect(mockApi.exportAlertsCsv).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'd-1', state: 'ACKED' }),
    );
  });

  it('★ 请求失败：原样展示后端 message，不触发下载', async () => {
    mockApi.exportAlertsCsv.mockRejectedValueOnce(
      bizFailure(40_303, '告警导出被拒绝：无对应权限'),
    );
    const errorSpy = vi
      .spyOn(message, 'error')
      .mockImplementation(() => ({}) as any);
    const container = await mountPage();

    exportButton(container)?.click();
    await flush();

    expect(errorSpy).toHaveBeenCalledWith('告警导出被拒绝：无对应权限');
    expect(fileMock.downloadBlobSafe).not.toHaveBeenCalled();
  });

  it('★ loading 防重复：在途期间按钮 loading，重复点击不重复请求', async () => {
    let resolveExport: ((value: Blob) => void) | undefined;
    mockApi.exportAlertsCsv.mockImplementationOnce(
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
    expect(mockApi.exportAlertsCsv).toHaveBeenCalledTimes(1);

    resolveExport?.(new Blob(['a,b'], { type: 'text/csv' }));
    await flush();
    expect(button?.classList.contains('ant-btn-loading')).toBe(false);
  });
});

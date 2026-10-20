/**
 * `shared/use-csv-export.ts` 的行为用例。
 *
 * 为什么必须单测：这个组合式统一了三处导出的**失败纪律** ——
 * ① 后端把「业务失败」的 JSON 当 HTTP 200 的 blob 返回时，`downloadBlobSafe` 必须拦下、
 *    绝不能下载成 `.csv`（历史事故级问题：用户拿到一个内容是错误提示的表格文件）；
 * ② 在途重复点击只能发一次请求（弱网下连点会重复拉全量导出）；
 * ③ 文件名必须带日期（同一天多次导出否则会互相覆盖，浏览器后面加括号序号）；
 * ④ 失败/异常后 loading 必须复位（否则按钮永久转圈，用户只能刷新页面）。
 * 这些路径页面级用例很难覆盖（要真实下载 + 真实网络），在组合式层用桩断言最稳。
 */
import dayjs from 'dayjs';

import { message } from 'ant-design-vue';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCsvExport } from './use-csv-export';

const { fileMock } = vi.hoisted(() => ({
  fileMock: { downloadBlobSafe: vi.fn() },
}));

vi.mock('#/utils/file', () => fileMock);

vi.mock('ant-design-vue', () => ({
  message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

const SUCCESS = message.success as unknown as ReturnType<typeof vi.fn>;
const ERROR = message.error as unknown as ReturnType<typeof vi.fn>;

const TODAY = dayjs().format('YYYYMMDD');

function createExport(overrides: Record<string, unknown> = {}) {
  return useCsvExport({
    errorText: 'page.iot.device.exportFailed',
    exportFn: vi.fn(async () => new Blob(['a,b\n1,2'], { type: 'text/csv' })),
    fileName: () => 'page.iot.device.exportName',
    ...overrides,
  });
}

beforeEach(() => {
  fileMock.downloadBlobSafe.mockReset();
  fileMock.downloadBlobSafe.mockResolvedValue(true);
  SUCCESS.mockClear();
  ERROR.mockClear();
});

describe('useCsvExport · 成功路径', () => {
  it('下载成功 ⇒ 文件名带日期、提示成功、loading 复位', async () => {
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    const exportFn = vi.fn(async () => blob);
    const { exportLoading, onExportCsv } = createExport({ exportFn });

    expect(exportLoading.value).toBe(false);
    await onExportCsv();

    expect(exportFn).toHaveBeenCalledTimes(1);
    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    const [downloadedBlob, fileName, errorText] =
      fileMock.downloadBlobSafe.mock.calls[0] ?? [];
    expect(downloadedBlob).toBe(blob);
    expect(fileName).toBe(`page.iot.device.exportName_${TODAY}.csv`);
    expect(errorText).toBe('page.iot.device.exportFailed');
    expect(SUCCESS).toHaveBeenCalledTimes(1);
    expect(ERROR).not.toHaveBeenCalled();
    expect(exportLoading.value).toBe(false);
  });

  it('文件名主体由调用方决定（不同页面各自传 i18n 文案），日期/suffix 统一追加', async () => {
    const { onExportCsv } = createExport({ fileName: () => 'alert-export' });
    await onExportCsv();

    expect(fileMock.downloadBlobSafe.mock.calls[0]?.[1]).toMatch(
      new RegExp(`^alert-export_\\d{8}\\.csv$`),
    );
  });
});

describe('useCsvExport · 业务失败（HTTP 200 + 失败 JSON）', () => {
  it('downloadBlobSafe 判定为伪文件 ⇒ 不提示成功（错误由它统一提示）', async () => {
    fileMock.downloadBlobSafe.mockResolvedValue(false);
    const { exportLoading, onExportCsv } = createExport();

    await onExportCsv();

    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    expect(SUCCESS).not.toHaveBeenCalled();
    expect(exportLoading.value).toBe(false);
  });
});

describe('useCsvExport · 在途防连点', () => {
  it('第一次未完成时再次点击 ⇒ 只发一次导出请求', async () => {
    let resolveExport: (value: Blob) => void = () => {};
    const pending = new Promise<Blob>((resolve) => {
      resolveExport = resolve;
    });
    const exportFn = vi.fn(() => pending);
    const { exportLoading, onExportCsv } = createExport({ exportFn });

    const first = onExportCsv();
    // 第二个点击发生在 in-flight 窗口内 ⇒ 直接丢弃（不排队、不重复提示）
    const second = onExportCsv();
    expect(exportLoading.value).toBe(true);
    expect(exportFn).toHaveBeenCalledTimes(1);

    resolveExport(new Blob(['x'], { type: 'text/csv' }));
    await Promise.all([first, second]);

    expect(exportFn).toHaveBeenCalledTimes(1);
    expect(fileMock.downloadBlobSafe).toHaveBeenCalledTimes(1);
    expect(exportLoading.value).toBe(false);
  });
});

describe('useCsvExport · 异常与空数据', () => {
  it('导出请求抛错 ⇒ 原样展示后端 message、不下载、loading 复位', async () => {
    const exportFn = vi.fn(async () => {
      throw Object.assign(new Error('无导出权限'), {
        response: { data: { code: 40_303, message: '无导出权限' } },
      });
    });
    const { exportLoading, onExportCsv } = createExport({ exportFn });

    await onExportCsv();

    expect(fileMock.downloadBlobSafe).not.toHaveBeenCalled();
    expect(ERROR).toHaveBeenCalledWith('无导出权限');
    expect(SUCCESS).not.toHaveBeenCalled();
    expect(exportLoading.value).toBe(false);
  });

  it('exportFn 返回 undefined（当前无可导出数据）⇒ 静默跳过，不下载也不弹提示', async () => {
    const { exportLoading, onExportCsv } = createExport({
      exportFn: vi.fn(async () => undefined),
    });

    await onExportCsv();

    expect(fileMock.downloadBlobSafe).not.toHaveBeenCalled();
    expect(SUCCESS).not.toHaveBeenCalled();
    expect(ERROR).not.toHaveBeenCalled();
    expect(exportLoading.value).toBe(false);
  });
});

import { createApp, h, nextTick } from 'vue';

import { i18n } from '@vben/locales';

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

import {
  BATCH_PAGE_SIZE,
  batchStatusColor,
  batchStatusLabelKey,
  checkImportFile,
  DETAIL_ROWS_PAGE_SIZE,
  formatFileSize,
  hasFailedRows,
  IMPORT_BATCH_STATUS,
  IMPORT_ROW_RESULT,
  resolveBatchPageAfterEmpty,
  resolveDetailPageAfterEmpty,
  resolveImportFileCheckMessage,
  resolveImportListState,
  rowResultLabelKey,
  sortBatchesByRecent,
} from './import-state';
import ImportPanel from './import.vue';

/**
 * 分页接线用例需要替换网络层（`#/api/iot` 用**部分 mock**，保留常量导出）。
 *
 * 为什么必须有组件级用例：P1-10 的两个缺陷（明细 `current` 恒写死 1、批次列表只取第 1 页）
 * 都是**纯接线错误**——纯函数层无从暴露；而 `@row-click` 在 ant-design-vue 4.2.6 里
 * **不是事件**（Table 没有该 emit），行选择此前是死的，同样只有挂真实组件才能发现。
 */
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    downloadDeviceImportFailedCsv: vi.fn(),
    downloadDeviceImportTemplate: vi.fn(),
    getDeviceImportBatchDetail: vi.fn(),
    getDeviceImportBatchPage: vi.fn(),
    importDevicesCsv: vi.fn(),
  },
}));

vi.mock('#/api/iot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    downloadDeviceImportFailedCsv: (...args: unknown[]) =>
      mockApi.downloadDeviceImportFailedCsv(...args),
    downloadDeviceImportTemplate: (...args: unknown[]) =>
      mockApi.downloadDeviceImportTemplate(...args),
    getDeviceImportBatchDetail: (...args: unknown[]) =>
      mockApi.getDeviceImportBatchDetail(...args),
    getDeviceImportBatchPage: (...args: unknown[]) =>
      mockApi.getDeviceImportBatchPage(...args),
    importDevicesCsv: (...args: unknown[]) => mockApi.importDevicesCsv(...args),
  };
});

vi.mock('#/utils/file', () => ({
  downloadBlobSafe: vi.fn(),
}));

/** 真实 i18n：只初始化一次（`$t` 就是 `i18n.global.t`）。 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  // en-US 语言包与生产同源合并；缺键/编译不过会让下面的英文断言直接红
  const mod = (await import('#/locales/langs/en-US/page.json')) as {
    default?: Record<string, unknown>;
  };
  const pageDict = (mod.default ?? mod) as { iot: Record<string, unknown> };
  i18n.global.mergeLocaleMessage('en-US', { page: pageDict });
});

/**
 * 批量导入页的**纯逻辑**用例（前端补测）。
 *
 * 为什么这些判据值得单独锁住：它们决定用户「能不能自助闭环」——
 * 「文件选错了没有」「这批到底进去了几台」「现在到底是失败还是真的没数据」。
 * 页面组件只负责把结论渲染出来，所以**结论本身**必须有用例守着。
 *
 * 三条来自本仓既有事故的防线，逐条对应用例：
 * 1. **失败态优先于空态**（设备台账页踩过的「假空态」）；
 * 2. **状态码 → 文案/颜色**必须一一对齐（不能出现「标签说成功、颜色是红的」）；
 * 3. **不假装进度**：只有后端给的四种状态，未知状态回落到「未知」而不是空白。
 */

/** 造一个「文件」桩（只用到 name 与 size 两个属性）。 */
function fakeFile(name: string, size: number): File {
  return { name, size } as File;
}

describe('resolveImportListState（失败态优先于空态）', () => {
  it('加载中优先于一切', () => {
    // 即使同时带着错误与旧数据，加载中就是加载中
    expect(resolveImportListState(true, 'boom', 5)).toBe('loading');
  });

  it('请求失败时必须判为 error，不得画成空态', () => {
    // 🔴 核心防线：失败且没有任何条目 ⇒ 绝不能返回 empty
    expect(resolveImportListState(false, '网络错误', 0)).toBe('error');
    // 已有旧数据时刷新失败，仍然是 error（页面要提示「这次刷新失败了」）
    expect(resolveImportListState(false, '网络错误', 7)).toBe('error');
  });

  it('确实没有数据时才是空态', () => {
    expect(resolveImportListState(false, '', 0)).toBe('empty');
  });

  it('有数据且无错误时为 ready', () => {
    expect(resolveImportListState(false, '', 3)).toBe('ready');
  });
});

describe('checkImportFile（上传前的前端基本校验）', () => {
  it('接受 .csv 与 .txt', () => {
    expect(checkImportFile(fakeFile('devices.csv', 1024)).ok).toBe(true);
    expect(checkImportFile(fakeFile('devices.txt', 1024)).ok).toBe(true);
  });

  it('扩展名大小写不敏感', () => {
    expect(checkImportFile(fakeFile('DEVICES.CSV', 1024)).ok).toBe(true);
  });

  it('拒绝明显选错的文件类型：结构化 key + 实际文件名/扩展名参数', () => {
    expect(checkImportFile(fakeFile('devices.xlsx', 2048))).toMatchObject({
      messageKey: 'page.iot.device.import.validation.fileType',
      ok: false,
      params: ['.csv / .txt', 'devices.xlsx'],
    });
  });

  it('文件名为空时用独立 key（不把「（无文件名）」硬编码进逻辑）', () => {
    expect(checkImportFile(fakeFile('', 2048))).toMatchObject({
      messageKey: 'page.iot.device.import.validation.fileTypeNoName',
      ok: false,
      params: ['.csv / .txt'],
    });
  });

  it('拒绝 0 字节文件：结构化 key（而非含糊的「格式错误」）', () => {
    expect(checkImportFile(fakeFile('devices.csv', 0))).toMatchObject({
      messageKey: 'page.iot.device.import.validation.fileEmpty',
      ok: false,
    });
  });

  it('超过上限时拒绝：key 带文件大小与上限参数', () => {
    expect(
      checkImportFile(fakeFile('devices.csv', 3 * 1024 * 1024)),
    ).toMatchObject({
      messageKey: 'page.iot.device.import.validation.fileTooLarge',
      ok: false,
      params: ['3.0 MB', '2.0 MB'],
    });
  });

  it('恰好等于上限时放行（边界含等号，与后端 > 判定一致）', () => {
    expect(checkImportFile(fakeFile('devices.csv', 2 * 1024 * 1024)).ok).toBe(
      true,
    );
  });
});

describe('resolveImportFileCheckMessage（真实 vue-i18n，不 mock #/locales）', () => {
  it('zh-CN：四类失败文案可读，通过时为空串', () => {
    expect(
      resolveImportFileCheckMessage(
        checkImportFile(fakeFile('devices.xlsx', 2048)),
      ),
    ).toBe('只支持 CSV/TXT 文件（.csv / .txt），当前文件：devices.xlsx');
    expect(
      resolveImportFileCheckMessage(checkImportFile(fakeFile('', 2048))),
    ).toBe('只支持 CSV/TXT 文件（.csv / .txt），当前文件名不可用');
    expect(
      resolveImportFileCheckMessage(
        checkImportFile(fakeFile('devices.csv', 0)),
      ),
    ).toBe('文件是空的（0 字节），请检查是否选错了文件');
    expect(
      resolveImportFileCheckMessage(
        checkImportFile(fakeFile('devices.csv', 3 * 1024 * 1024)),
      ),
    ).toBe('文件 3.0 MB 超过上限 2.0 MB，请拆分成多个文件分批导入');
    expect(
      resolveImportFileCheckMessage(
        checkImportFile(fakeFile('devices.csv', 1024)),
      ),
    ).toBe('');
  });

  it('en-US：同 key 同参数给出英文文案（不回落中文）', () => {
    const previous = i18n.global.locale.value;
    try {
      i18n.global.locale.value = 'en-US' as never;
      expect(
        resolveImportFileCheckMessage(
          checkImportFile(fakeFile('devices.xlsx', 2048)),
        ),
      ).toBe(
        'Only CSV/TXT files are supported (.csv / .txt). Current file: devices.xlsx',
      );
      expect(
        resolveImportFileCheckMessage(checkImportFile(fakeFile('', 2048))),
      ).toBe(
        'Only CSV/TXT files are supported (.csv / .txt). The current file name is unavailable.',
      );
      expect(
        resolveImportFileCheckMessage(
          checkImportFile(fakeFile('devices.csv', 0)),
        ),
      ).toBe(
        'The file is empty (0 bytes); check whether you selected the wrong file.',
      );
      expect(
        resolveImportFileCheckMessage(
          checkImportFile(fakeFile('devices.csv', 3 * 1024 * 1024)),
        ),
      ).toBe(
        'File 3.0 MB exceeds the 2.0 MB limit; split it into multiple files and import in batches.',
      );
    } finally {
      i18n.global.locale.value = previous as never;
    }
  });
});

describe('formatFileSize', () => {
  it('按量级给出人类可读的大小', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('非法输入不抛异常，回落为 0 B', () => {
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(-1)).toBe('0 B');
  });
});

describe('批次状态 → 文案键 / 颜色（必须一一对齐）', () => {
  it('四种已知状态各自映射到自己的键', () => {
    expect(batchStatusLabelKey(IMPORT_BATCH_STATUS.SUCCESS)).toBe(
      'page.iot.device.import.statusSuccess',
    );
    expect(batchStatusLabelKey(IMPORT_BATCH_STATUS.PARTIAL_FAILED)).toBe(
      'page.iot.device.import.statusPartialFailed',
    );
    expect(batchStatusLabelKey(IMPORT_BATCH_STATUS.FAILED)).toBe(
      'page.iot.device.import.statusFailed',
    );
    expect(batchStatusLabelKey(IMPORT_BATCH_STATUS.RUNNING)).toBe(
      'page.iot.device.import.statusRunning',
    );
  });

  it('未知/缺失状态回落到「未知」键，绝不返回空串', () => {
    // 空标签比「未知」更糟：用户会以为页面坏了
    expect(batchStatusLabelKey('future-status')).toBe(
      'page.iot.device.import.statusUnknown',
    );
    expect(batchStatusLabelKey(undefined)).toBe(
      'page.iot.device.import.statusUnknown',
    );
  });

  it('颜色与语义一致：成功=success、部分失败=warning、失败=error', () => {
    expect(batchStatusColor(IMPORT_BATCH_STATUS.SUCCESS)).toBe('success');
    expect(batchStatusColor(IMPORT_BATCH_STATUS.PARTIAL_FAILED)).toBe(
      'warning',
    );
    expect(batchStatusColor(IMPORT_BATCH_STATUS.FAILED)).toBe('error');
  });

  it('未知状态给 processing（不是 error：未知不等于失败）', () => {
    expect(batchStatusColor('future-status')).toBe('processing');
  });
});

describe('rowResultLabelKey', () => {
  it('成功行与失败行分别映射', () => {
    expect(rowResultLabelKey(IMPORT_ROW_RESULT.SUCCESS)).toBe(
      'page.iot.device.import.rowSuccess',
    );
    expect(rowResultLabelKey(IMPORT_ROW_RESULT.FAILED)).toBe(
      'page.iot.device.import.rowFailed',
    );
  });

  it('未知结果按失败处理（宁可让用户去核对，也不放行一条说不清的行）', () => {
    expect(rowResultLabelKey(undefined)).toBe(
      'page.iot.device.import.rowFailed',
    );
  });
});

describe('hasFailedRows（判据是计数而非状态码）', () => {
  it('失败计数 > 0 才需要给「下载失败行」', () => {
    expect(hasFailedRows(1)).toBe(true);
    expect(hasFailedRows(0)).toBe(false);
  });

  it('数字字符串形态的计数同样识别（后端 long 会序列化成字符串）', () => {
    expect(hasFailedRows('3')).toBe(true);
    expect(hasFailedRows('0')).toBe(false);
  });

  it('脏数据/缺失一律按「没有失败行」处理，不抛异常', () => {
    expect(hasFailedRows(undefined)).toBe(false);
    expect(hasFailedRows('abc')).toBe(false);
  });
});

describe('sortBatchesByRecent（最近在前）', () => {
  it('按 id 倒序（雪花 id 单调）', () => {
    const sorted = sortBatchesByRecent([{ id: '1' }, { id: '3' }, { id: '2' }]);
    expect(sorted.map((item) => item.id)).toStrictEqual(['3', '2', '1']);
  });

  it('不改动入参（返回新数组）', () => {
    const input = [{ id: '1' }, { id: '2' }];
    const sorted = sortBatchesByRecent(input);
    expect(sorted).not.toBe(input);
    expect(input.map((item) => item.id)).toStrictEqual(['1', '2']);
  });

  it('id 非法/缺失时不抛异常（保持相对顺序，不制造无法解释的列表）', () => {
    const sorted = sortBatchesByRecent([{ id: undefined }, { id: '2' }]);
    expect(sorted).toHaveLength(2);
  });

  it('🔴 雪花 ID 相邻两值：不得用 Number() 比较（19 位超出安全整数会精度丢失）', () => {
    // 先自证这条用例有杀伤力：这两个相邻 id 转 number 后**相等**，
    // 旧实现（rightId-leftId）返回 0 ⇒ 顺序取决于入参顺序。
    const smaller = '1830000000000000001';
    const larger = '1830000000000000002';
    expect(Number(smaller) === Number(larger)).toBe(true);

    // 新实现必须把更大的放前面，且与入参顺序无关
    expect(
      sortBatchesByRecent([{ id: smaller }, { id: larger }]).map(
        (item) => item.id,
      ),
    ).toStrictEqual([larger, smaller]);
    expect(
      sortBatchesByRecent([{ id: larger }, { id: smaller }]).map(
        (item) => item.id,
      ),
    ).toStrictEqual([larger, smaller]);
  });
});

// ====================================================================
// 分页纯逻辑（P1-10）
// ====================================================================

describe('分页常量与越界兜底（P1-10）', () => {
  it('分页大小是具名常量（禁止再在组件里写死 20）', () => {
    expect(BATCH_PAGE_SIZE).toBe(20);
    expect(DETAIL_ROWS_PAGE_SIZE).toBe(20);
  });

  it('明细：第 1 页为空 ⇒ 不修正；非第 1 页为空 ⇒ 回第 1 页（空页 ≠ 没明细）', () => {
    expect(resolveDetailPageAfterEmpty(0, 1)).toBe(0);
    expect(resolveDetailPageAfterEmpty(20, 2)).toBe(0);
    expect(resolveDetailPageAfterEmpty(0, 2)).toBe(1);
    expect(resolveDetailPageAfterEmpty(0, 5)).toBe(1);
  });

  it('批次列表：越界页回退到仍有数据的最后一页（只回退、不前进，避免来回震荡）', () => {
    // 45 个批次、每页 20 ⇒ 最后一页是 3
    expect(resolveBatchPageAfterEmpty(0, 45, 5, BATCH_PAGE_SIZE)).toBe(3);
    // 当前页就是最后一页且为空 ⇒ 不来回跳（返回 0）
    expect(resolveBatchPageAfterEmpty(0, 45, 3, BATCH_PAGE_SIZE)).toBe(0);
    // 全部批次都没了 ⇒ 回第 1 页
    expect(resolveBatchPageAfterEmpty(0, 0, 4, BATCH_PAGE_SIZE)).toBe(1);
    // 有数据 / 第 1 页 ⇒ 不修正
    expect(resolveBatchPageAfterEmpty(20, 45, 2, BATCH_PAGE_SIZE)).toBe(0);
    expect(resolveBatchPageAfterEmpty(0, 45, 1, BATCH_PAGE_SIZE)).toBe(0);
  });
});

// ====================================================================
// import.vue 分页接线（挂载用例：真实 antd + 真实 i18n）
// ====================================================================

/** 造一批批次记录（id 递增，createTime 递增）。 */
function makeBatches(page: number, size = BATCH_PAGE_SIZE) {
  return Array.from({ length: size }, (_, index) => {
    const seq = (page - 1) * size + index + 1;
    const padded = String(seq).padStart(3, '0');
    return {
      batchStatus: 'success',
      createTime: `2026-10-20 10:00:${padded.slice(-2)}`,
      failedRows: 0,
      fileName: `devices-${seq}.csv`,
      id: `1830000000000000${padded}`,
      successRows: 10,
      totalRows: 10,
    };
  });
}

/** 造一批明细行。 */
function makeRows(page: number, size = DETAIL_ROWS_PAGE_SIZE) {
  return Array.from({ length: size }, (_, index) => ({
    errorCode: null,
    errorMessage: null,
    id: `row-${page}-${index + 1}`,
    rowNo: (page - 1) * size + index + 1,
    rowResult: 'success',
  }));
}

function stubDefaultPagination() {
  mockApi.getDeviceImportBatchPage.mockImplementation(
    (page: number, pageSize: number) =>
      Promise.resolve({
        items: makeBatches(page, pageSize),
        page,
        pageSize,
        total: '45',
      }),
  );
  mockApi.getDeviceImportBatchDetail.mockImplementation(
    (batchId: string, query: { page?: number; pageSize?: number } = {}) =>
      Promise.resolve({
        batch: { id: batchId, fileName: 'devices.csv' },
        rows: {
          items: makeRows(query.page ?? 1, query.pageSize),
          page: query.page ?? 1,
          pageSize: query.pageSize,
          total: '45',
        },
      }),
  );
}

let mounted: undefined | { app: { unmount: () => void } };

afterEach(() => {
  mounted?.app.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await nextTick();
}

async function mountImport() {
  const container = document.createElement('div');
  document.body.append(container);
  const app = createApp({ render: () => h(ImportPanel as never) });
  app.mount(container);
  mounted = { app };
  await flush();
  return container;
}

/**
 * 表格按 antd 外层容器区分：第 1 个 `.ant-table-wrapper` = 批次列表，第 2 个 = 明细。
 *
 * ⚠️ 不能用 `container.querySelectorAll('table')` 的下标：带 `scroll.y` 的 antd Table 会把
 * 表头与表体拆成**两张 table**（固定表头），下标会错位到只有表头的那张。
 */
function tableWrapperAt(container: HTMLElement, index: number) {
  return container.querySelectorAll('.ant-table-wrapper')[index] as
    | HTMLElement
    | undefined;
}

function tableRows(container: HTMLElement, index: number) {
  return [
    ...(tableWrapperAt(container, index)?.querySelectorAll(
      '.ant-table-tbody tr.ant-table-row',
    ) ?? []),
  ].map((element) => element as HTMLElement);
}

function paginationAt(container: HTMLElement, index: number) {
  return tableWrapperAt(container, index)?.querySelector('.ant-pagination') as
    | HTMLElement
    | undefined;
}

/** 点分页器上的某一页（antd 的 li 自带 click 处理）。 */
async function clickPage(
  container: HTMLElement,
  paginationIndex: number,
  page: number,
) {
  const item = paginationAt(container, paginationIndex)?.querySelector(
    `.ant-pagination-item-${page}`,
  ) as HTMLElement | undefined;
  expect(item, `分页器 ${paginationIndex} 上没有第 ${page} 页`).toBeTruthy();
  item?.click();
  await flush();
}

describe('import.vue 分页接线（P1-10：页码与请求一致、历史批次可达）', () => {
  beforeEach(() => {
    for (const fn of Object.values(mockApi)) {
      fn.mockReset();
    }
    stubDefaultPagination();
  });

  it('初始加载：批次列表按 (page=1, BATCH_PAGE_SIZE) 拉取，并显示总批次数', async () => {
    const container = await mountImport();

    expect(mockApi.getDeviceImportBatchPage).toHaveBeenCalledWith(
      1,
      BATCH_PAGE_SIZE,
    );
    expect(container.textContent).toContain(
      i18n.global.t('page.iot.device.import.batchListTotal', ['45']),
    );
  });

  it('🔴 历史批次可达：点「查看全部批次」→ 翻到第 2 页 ⇒ 请求 page=2', async () => {
    const container = await mountImport();
    const allBatches = container.querySelector(
      '[data-testid="import-all-batches"]',
    ) as HTMLElement | null;
    expect(allBatches, '超过一页时必须给出「查看全部批次」入口').toBeTruthy();
    allBatches?.click();
    await flush();

    await clickPage(container, 0, 2);
    expect(mockApi.getDeviceImportBatchPage).toHaveBeenLastCalledWith(
      2,
      BATCH_PAGE_SIZE,
    );
    // 页码状态跟随请求（否则分页器会显示第 1 页而数据是第 2 页）
    expect(
      paginationAt(container, 0)
        ?.querySelector('.ant-pagination-item-active')
        ?.textContent?.trim(),
    ).toBe('2');
  });

  it('🔴 行选择可用（customRow 而非不存在的 @row-click）：点历史批次即加载其明细', async () => {
    const container = await mountImport();
    const rows = tableRows(container, 0);
    expect(rows.length).toBeGreaterThan(0);
    const secondRowBatchId = '1830000000000000019';
    rows[1]?.click();
    await flush();

    expect(mockApi.getDeviceImportBatchDetail).toHaveBeenCalledTimes(1);
    const [calledId, query] = mockApi.getDeviceImportBatchDetail.mock
      .calls[0] as [string, { page: number; pageSize: number }];
    expect(String(calledId), '点哪一行就加载哪个批次的明细').toBe(
      secondRowBatchId,
    );
    expect(query).toMatchObject({ page: 1, pageSize: DETAIL_ROWS_PAGE_SIZE });
  });

  it('🔴 明细翻页：请求 page 与分页器 current 一致（此前 current 恒写死 1）', async () => {
    const container = await mountImport();
    tableRows(container, 0)[0]?.click();
    await flush();
    expect(mockApi.getDeviceImportBatchDetail).toHaveBeenCalledTimes(1);

    await clickPage(container, 1, 2);

    expect(mockApi.getDeviceImportBatchDetail).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ page: 2, pageSize: DETAIL_ROWS_PAGE_SIZE }),
    );
    expect(
      paginationAt(container, 1)
        ?.querySelector('.ant-pagination-item-active')
        ?.textContent?.trim(),
      '分页器必须跟到第 2 页（current 不能写死 1）',
    ).toBe('2');
  });

  it('🔴 切批次重置页码：从第 2 页切到另一个批次 ⇒ 请求回到 page=1', async () => {
    const container = await mountImport();
    const rows = tableRows(container, 0);
    rows[0]?.click();
    await flush();
    await clickPage(container, 1, 2);
    expect(
      (
        mockApi.getDeviceImportBatchDetail.mock.calls.at(-1)?.[1] as {
          page?: number;
        }
      )?.page,
    ).toBe(2);

    rows[1]?.click();
    await flush();
    expect(
      (
        mockApi.getDeviceImportBatchDetail.mock.calls.at(-1)?.[1] as {
          page?: number;
        }
      )?.page,
      '切批次必须从第 1 页开始看',
    ).toBe(1);
  });

  it('🔴 明细页越界（第 2 页已无数据）：自动回第 1 页并给出可见提示', async () => {
    const infoSpy = vi
      .spyOn(message, 'info')
      .mockImplementation(() => ({}) as any);
    // 第 2 页返回空（数据变少/筛选变化），但总数仍 > 0
    mockApi.getDeviceImportBatchDetail.mockImplementation(
      (batchId: string, query: { page?: number; pageSize?: number } = {}) =>
        Promise.resolve({
          batch: { id: batchId },
          rows: {
            items: (query.page ?? 1) > 1 ? [] : makeRows(1),
            page: query.page ?? 1,
            pageSize: query.pageSize,
            total: '45',
          },
        }),
    );
    const container = await mountImport();
    tableRows(container, 0)[0]?.click();
    await flush();

    await clickPage(container, 1, 2);
    await flush();

    const pages = mockApi.getDeviceImportBatchDetail.mock.calls.map(
      (call) => (call[1] as { page?: number })?.page,
    );
    // 先请求第 2 页（空），随后自动回第 1 页
    expect(pages).toContain(2);
    expect(pages.at(-1), '空页必须自动回第 1 页').toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      i18n.global.t('page.iot.device.import.detailPageReset'),
    );
  });
});

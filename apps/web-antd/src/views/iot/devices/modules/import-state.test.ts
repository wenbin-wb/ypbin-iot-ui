import { createApp } from 'vue';

import { i18n } from '@vben/locales';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  batchStatusColor,
  batchStatusLabelKey,
  checkImportFile,
  formatFileSize,
  hasFailedRows,
  IMPORT_BATCH_STATUS,
  IMPORT_ROW_RESULT,
  resolveImportFileCheckMessage,
  resolveImportListState,
  rowResultLabelKey,
  sortBatchesByRecent,
} from './import-state';

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
});

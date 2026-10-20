/**
 * 批量导入页的**纯逻辑**（前端校验 + 状态/结果映射 + 空态/失败态判定）。
 *
 * 为什么单独抽出来：这些判断是**用户能不能自助闭环**的全部依据——
 * 「文件选错了没有」「这批到底成功了几台」「现在是失败还是真的没数据」。
 * 它们零依赖（不 import vue / antdv / vben），因此可以在 jsdom 之外直接跑用例；
 * 而页面组件只负责把这几个结论渲染出来。
 *
 * 🔴 两条来自本仓既有事故的防线，在这里被**结构化**而不是靠页面自觉：
 * 1. **失败态与空态分离**：`resolveBatchListState` 把「加载失败」与「确实没有批次」
 *    明确分成两个取值，页面就不可能把失败画成「还没有导入过，去上传吧」；
 * 2. **不假装进度**：批次状态只有后端给的四种；前端不自己推演「大概快好了」，
 *    也不把 `running` 之外的状态渲染成进度条。
 */

import type { ListState } from '../../shared/list-state';

import { DEVICE_IMPORT_FRONTEND_LIMITS } from '#/api/iot';
import { $t } from '#/locales';

import { resolveListState } from '../../shared/list-state';

/**
 * 批次状态码（与后端 `DeviceImportStatus` 对齐的**具名常量**）。
 *
 * 页面里不许再出现裸字符串 `'success'`：三处判断（状态标签、颜色、空态）各写一遍字面量，
 * 迟早出现「标签说成功、颜色是红的」这种自相矛盾。
 */
export const IMPORT_BATCH_STATUS = {
  RUNNING: 'running',
  SUCCESS: 'success',
  PARTIAL_FAILED: 'partial-failed',
  FAILED: 'failed',
} as const;

/** 单行结果码（与后端 `DeviceImportRowResult` 对齐）。 */
export const IMPORT_ROW_RESULT = {
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;

/** 批次列表 / 明细表格的加载态（三分：加载中、失败、空）。 */
export type ImportListState = ListState;

/**
 * 判定列表该显示哪种状态。
 *
 * 判据已收口到 `../../shared/list-state`（`resolveListState`）：本函数只保留原导出名与
 * 位置参数签名，行为零漂移。顺序仍是「loading > error > empty/ready」——
 * **失败优先于空**（请求失败时页面绝不能声称「还没有数据」），由公共用例守门。
 */
export function resolveImportListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): ImportListState {
  return resolveListState({ errorMessage, itemCount, loading });
}

/** 前端校验失败结论：只带 i18n key 与参数，文案由 {@link resolveImportFileCheckMessage} 解析。 */
export interface ImportFileCheckFailed {
  ok: false;
  /** i18n 键（`page.iot.device.import.validation.*`）。 */
  messageKey: string;
  /** 插值参数（按 key 定义顺序传入；文件大小已由 {@link formatFileSize} 预格式化）。 */
  params?: Array<number | string>;
}

/** 前端校验结论。 */
export type ImportFileCheckResult = ImportFileCheckFailed | { ok: true };

/**
 * 把文件校验结论解析成面向用户的文案（成功返回空串）。
 *
 * 页面必须经此渲染错误，不得直接展示 `messageKey`（那会把 i18n 键暴露给用户）。
 *
 * @param check 校验结论
 * @returns 本地化错误文案；通过时为空串
 */
export function resolveImportFileCheckMessage(
  check: ImportFileCheckResult,
): string {
  return check.ok ? '' : $t(check.messageKey, check.params ?? []);
}

/**
 * 上传前的**前端**基本校验（类型 / 大小）。
 *
 * 刻意只做「不用读文件就能判」的两项：
 * - 类型：扩展名不是 .csv/.txt ⇒ 用户八成选错了文件（点了 .xlsx）；
 * - 大小：超过 2MB ⇒ 后端必然拒绝，前端先说清楚可以省一次往返。
 *
 * **表头校验不在这里**：那要读文件内容（异步 FileReader），而且判据（必填列/未知列）
 * 的**事实源在后端**——前端再实现一份必然漂移。表头错了由后端返回批次记录里的
 * `errorSummary` 说清，页面照样能显示。
 *
 * @param file 待上传文件
 * @returns 校验结论
 */
export function checkImportFile(file: File): ImportFileCheckResult {
  const name = (file.name || '').toLowerCase();
  const extensionOk = DEVICE_IMPORT_FRONTEND_LIMITS.allowedExtensions.some(
    (extension) => name.endsWith(extension),
  );
  const extensions =
    DEVICE_IMPORT_FRONTEND_LIMITS.allowedExtensions.join(' / ');
  if (!extensionOk) {
    const fileName = file.name || '';
    return fileName
      ? {
          messageKey: 'page.iot.device.import.validation.fileType',
          ok: false,
          params: [extensions, fileName],
        }
      : {
          messageKey: 'page.iot.device.import.validation.fileTypeNoName',
          ok: false,
          params: [extensions],
        };
  }
  if (file.size > DEVICE_IMPORT_FRONTEND_LIMITS.maxBytes) {
    return {
      messageKey: 'page.iot.device.import.validation.fileTooLarge',
      ok: false,
      params: [
        formatFileSize(file.size),
        formatFileSize(DEVICE_IMPORT_FRONTEND_LIMITS.maxBytes),
      ],
    };
  }
  if (file.size === 0) {
    return {
      messageKey: 'page.iot.device.import.validation.fileEmpty',
      ok: false,
    };
  }
  return { ok: true };
}

/**
 * 人类可读的文件大小。
 *
 * @param bytes 字节数
 * @returns 如 `1.2 MB` / `340 KB`
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 批次状态 → i18n 键（页面用它渲染标签；颜色由 {@link batchStatusColor} 单独给）。
 *
 * @param status 状态码
 * @returns i18n 键；未知状态回落到 `unknown`（绝不返回空串：空白的标签比「未知」更糟）
 */
export function batchStatusLabelKey(status?: string): string {
  switch (status) {
    case IMPORT_BATCH_STATUS.FAILED: {
      return 'page.iot.device.import.statusFailed';
    }
    case IMPORT_BATCH_STATUS.PARTIAL_FAILED: {
      return 'page.iot.device.import.statusPartialFailed';
    }
    case IMPORT_BATCH_STATUS.RUNNING: {
      return 'page.iot.device.import.statusRunning';
    }
    case IMPORT_BATCH_STATUS.SUCCESS: {
      return 'page.iot.device.import.statusSuccess';
    }
    default: {
      return 'page.iot.device.import.statusUnknown';
    }
  }
}

/**
 * 批次状态 → antdv Tag 颜色。
 *
 * 与 {@link batchStatusLabelKey} 是**两个函数而不是一个返回对象**：颜色在 antdv 里是
 * 可选的（不传就是默认色），文案必须有；混在一起会让「忘了给颜色」变成编译错误而不是默认行为。
 *
 * @param status 状态码
 * @returns Tag 颜色
 */
export function batchStatusColor(status?: string): string {
  switch (status) {
    case IMPORT_BATCH_STATUS.FAILED: {
      return 'error';
    }
    case IMPORT_BATCH_STATUS.PARTIAL_FAILED: {
      return 'warning';
    }
    case IMPORT_BATCH_STATUS.SUCCESS: {
      return 'success';
    }
    default: {
      return 'processing';
    }
  }
}

/**
 * 单行结果 → i18n 键。
 *
 * @param result 结果码
 * @returns i18n 键
 */
export function rowResultLabelKey(result?: string): string {
  return result === IMPORT_ROW_RESULT.SUCCESS
    ? 'page.iot.device.import.rowSuccess'
    : 'page.iot.device.import.rowFailed';
}

/**
 * 批次是否**需要**提供「下载失败行」。
 *
 * 判据是失败计数而不是状态码：`partial-failed` 与 `failed` 都有失败行，
 * 而 `success` 有 0 行失败。用计数判可以顺带兜住「状态码与计数不一致」的脏数据
 * （此时按计数为准——用户更信「有几行要改」）。
 *
 * @param failedRows 失败行数（可能是字符串形态的脏数据）
 * @returns 需要下载失败行返回 true
 */
export function hasFailedRows(
  failedRows: number | string | undefined,
): boolean {
  const value = Number(failedRows ?? 0);
  return Number.isFinite(value) && value > 0;
}

/**
 * 把批次列表按「最近在前」排序（后端已排序，这里是**二次防线**）。
 *
 * 为什么要二次排序：分页返回的顺序若因后端改动而漂移，用户会看到「刚传的批次夹在中间」
 * 这种无法解释的列表。按 id 倒序（雪花 id 单调）是稳定且与业务无关的判据。
 *
 * 🔴 **不得用 `Number(id)` 比较**：批次 id 是雪花 ID（19 位，远超 `Number.MAX_SAFE_INTEGER`），
 * 相邻两个 id 转 number 后可能相等 ⇒ 比较结果为 0、顺序退化成入参顺序，
 * 历史批次看起来就是乱的（精度丢失）。雪花 ID 是定长单调递增的十进制串，
 * 所以「先比长度、再比字典序」与数值序完全等价，且全程无损。
 *
 * 非纯数字 id（老数据/异常形态）按同一规则退化排序：仍确定性、不抛异常。
 *
 * @param batches 批次列表
 * @returns 新数组（最近在前），不改动入参
 */
export function sortBatchesByRecent<T extends { id?: number | string }>(
  batches: T[],
): T[] {
  return [...batches].toSorted((left, right) => {
    // 统一成字符串：number 形态的老数据也走同一口径（不在这里做精度转换）
    const leftId =
      left.id === undefined || left.id === null ? '' : String(left.id);
    const rightId =
      right.id === undefined || right.id === null ? '' : String(right.id);
    // 降序（最近/更大在前）：长度优先（定长 id 下等价于数值大小），再字典序
    if (leftId.length !== rightId.length) {
      return rightId.length - leftId.length;
    }
    if (leftId === rightId) {
      return 0;
    }
    return leftId < rightId ? 1 : -1;
  });
}

// ---------------------------------------------------------------- 分页

/**
 * 批次列表分页大小（后端 `GET /devices/import` 支持 `page`/`pageSize`）。
 *
 * 与抽屉高度匹配：一屏能看到最近 20 个批次，需要更早的历史批次用「查看全部批次」翻页。
 */
export const BATCH_PAGE_SIZE = 20;

/** 批次明细分页大小（后端 `GET /devices/import/{batchId}` 支持 `page`/`pageSize`）。 */
export const DETAIL_ROWS_PAGE_SIZE = 20;

/**
 * 批次明细「当前页已无数据」时应改查的页码（0 = 不用改）。
 *
 * 🔴 为什么需要：明细页码是页面本地状态（不再恒写死 1），数据会被后续导入/删除改变，
 * 用户停在旧页翻页时就可能落在一张空页上——空页**不等于**「这一批没有明细」，
 * 必须自动回到第 1 页并明确告知（`page.iot.device.import.detailPageReset`），
 * 否则用户会以为失败行被清空了。
 *
 * @param itemsCount 本次返回的明细行数
 * @param page       本次请求的页码（1-based）
 * @returns 需要改查的页码；`0` 表示保持原页
 */
export function resolveDetailPageAfterEmpty(
  itemsCount: number,
  page: number,
): number {
  if (itemsCount > 0 || page <= 1) {
    return 0;
  }
  return 1;
}

/**
 * 批次列表「翻到越界页」时应改查的页码（0 = 不用改）。
 *
 * 批次可能被清理、或总数变少；此时后端对越界页返回空数组。空列表不能画成
 * 「还没有导入过」——自动退到仍有数据的最后一页（全部清空则回第 1 页）。
 *
 * @param itemsCount 本次返回的批次数
 * @param total      后端返回的总批次数
 * @param page       本次请求的页码（1-based）
 * @param pageSize   每页条数
 * @returns 需要改查的页码；`0` 表示保持原页（只在**回退**时返回，避免来回震荡）
 */
export function resolveBatchPageAfterEmpty(
  itemsCount: number,
  total: number,
  page: number,
  pageSize: number,
): number {
  if (itemsCount > 0 || page <= 1) {
    return 0;
  }
  const count = Math.max(Math.trunc(total), 0);
  if (count === 0) {
    return 1;
  }
  const size = Math.max(Math.trunc(pageSize), 1);
  const lastPage = Math.max(Math.ceil(count / size), 1);
  return lastPage < page ? lastPage : 0;
}

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

import { DEVICE_IMPORT_FRONTEND_LIMITS } from '#/api/iot';

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
export type ImportListState = 'empty' | 'error' | 'loading' | 'ready';

/**
 * 判定列表该显示哪种状态。
 *
 * 🔴 顺序是有意的：**失败优先于空**。先判 error 再判空，页面才不会在请求失败时
 * 显示「还没有数据，去创建吧」——那是本仓设备台账页已经踩过的假空态。
 *
 * @param loading 是否正在加载
 * @param errorMessage 加载失败原因（非空即失败）
 * @param itemCount 已拿到的条目数
 * @returns 列表状态
 */
export function resolveImportListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): ImportListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    // 失败**优先于空**：请求失败时页面绝不能声称「没有数据」
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
}

/** 前端校验结论。 */
export interface ImportFileCheckResult {
  /** 是否通过（false 时 `message` 一定非空）。 */
  ok: boolean;
  /** 面向用户的人话原因（直接渲染到 Alert，不需要页面再拼文案）。 */
  message: string;
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
  if (!extensionOk) {
    return {
      ok: false,
      message: `只支持 CSV 文件（${DEVICE_IMPORT_FRONTEND_LIMITS.allowedExtensions.join(' / ')}），当前文件：${file.name || '（无文件名）'}`,
    };
  }
  if (file.size > DEVICE_IMPORT_FRONTEND_LIMITS.maxBytes) {
    return {
      ok: false,
      message: `文件 ${formatFileSize(file.size)} 超过上限 ${formatFileSize(DEVICE_IMPORT_FRONTEND_LIMITS.maxBytes)}，请拆分成多个文件分批导入`,
    };
  }
  if (file.size === 0) {
    return { ok: false, message: '文件是空的（0 字节），请检查是否选错了文件' };
  }
  return { ok: true, message: '' };
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
 * @param batches 批次列表
 * @returns 新数组（最近在前），不改动入参
 */
export function sortBatchesByRecent<T extends { id?: number | string }>(
  batches: T[],
): T[] {
  return [...batches].toSorted((left, right) => {
    const leftId = Number(left.id ?? 0);
    const rightId = Number(right.id ?? 0);
    if (!Number.isFinite(leftId) || !Number.isFinite(rightId)) {
      return 0;
    }
    return rightId - leftId;
  });
}

/**
 * CSV 导出的统一组合式（设备台账 / 告警中心 / 批量下发结果三处共用）。
 *
 * ## 为什么收口
 *
 * 审查 05 §4.1-#2：三处的导出骨架逐字重复 ——「loading 防连点 → 取数据 → `downloadBlobSafe`
 * （防止把 HTTP 200 的业务失败 JSON 当文件下载）→ 成功/失败 message → 文件名拼日期」。
 * 任何一处漏掉 `downloadBlobSafe`，用户就会下载到一个内容是错误 JSON 的 `.csv` 文件；
 * 任何一处漏掉防连点，弱网下连点会重复拉全量导出。收成一份后这类纪律只需守一处。
 *
 * ## 入参设计（刻意保持最小）
 *
 * - `exportFn`：返回 `Blob`（后端下载）或 `undefined`（调用方判定「当前没有可导出的数据」）；
 * - `fileName`：文件名**主体**（`string` 或 `() => string`，不含日期与后缀；通常传 i18n 文案），
 *   默认由本模块统一追加 `_YYYYMMDD.csv`，避免各处自己拼日期导致格式不一致/漏日期覆盖同名文件；
 *   **本地生成且文件名有业务语义**（如历史曲线 `iot-series-<设备>-<点位>-<时间窗口>.csv`）时，
 *   传 `appendDate: false` 并自己给出**完整文件名**（含 `.csv`）——
 *   不用「是否以 .csv 结尾」这类隐式猜测（隐式规则以后加调用方就踩坑）；
 * - `successText`：成功提示（省略用 `common.success`）；本地导出语义不同时可覆盖；
 * - `errorText`：失败兜底文案（后端业务失败体里的 message 优先，见 `downloadBlobSafe`）；
 * - `skipEmpty`：`exportFn` 返回 `undefined` 时的处理。默认**静默跳过**（与收口前一致）；
 *   传 `{ text }` 则先提示再跳过（用于「零行也要告诉用户一声」的场景）。
 *
 * ## 不做的
 *
 * 不做「导出中再次点击排队」：导出是幂等读操作，第二次点击直接丢弃即可（返回同一份文件
 * 没有意义，反而增加服务端压力）。
 */
import type { Ref } from 'vue';

import { ref } from 'vue';

import { message } from 'ant-design-vue';
import dayjs from 'dayjs';

import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

/** 文件名里的日期格式（`YYYYMMDD`：排序友好、不含平台不允许字符）。 */
const FILE_DATE_FORMAT = 'YYYYMMDD';

/** 导出文件扩展名。 */
const CSV_EXTENSION = 'csv';

/**
 * 解析最终下载文件名（**显式口径**，不做「是否以 .csv 结尾」的隐式猜测）。
 *
 * - `appendDate !== false`（默认）：`主体 + _YYYYMMDD.csv`；
 * - `appendDate === false`：`fileName` 返回值原样使用（调用方自备完整名，含 `.csv`）。
 */
function resolveFileName(options: UseCsvExportOptions): string {
  const body =
    typeof options.fileName === 'string' ? options.fileName : options.fileName();
  if (options.appendDate === false) {
    return body;
  }
  return `${body}_${dayjs().format(FILE_DATE_FORMAT)}.${CSV_EXTENSION}`;
}

export interface UseCsvExportOptions {
  /**
   * 生成 CSV 数据。
   *
   * - 后端导出：直接返回下载接口的 `Blob`；
   * - 前端本地生成（如批量下发结果）：在函数内 build 后包成 `Blob`；
   * - 返回 `undefined` ⇒ 视为「当前没有可导出的数据」，静默跳过（不弹成功/失败）。
   */
  exportFn: () => Promise<Blob | undefined>;
  /**
   * 文件名**主体**（不含日期与 `.csv` 后缀；通常是 i18n 文案或业务语义名）。
   *
   * 默认追加 `_YYYYMMDD.csv`；若要给**完整文件名**，同时传 `appendDate: false`。
   */
  fileName: (() => string) | string;
  /**
   * 是否追加 `_YYYYMMDD.csv`（默认 `true`，与收口前的既有行为一致）。
   *
   * `false` ⇒ `fileName` 的返回值**原样使用**，调用方必须自己给出完整文件名（含 `.csv`）。
   */
  appendDate?: boolean;
  /** 成功提示文案（省略用 `common.success`）。 */
  successText?: string;
  /** 失败兜底文案（后端业务失败体优先，未提供 message 时用它）。 */
  errorText: string;
  /**
   * 零行处理：`exportFn` 返回 `undefined` 时默认静默跳过；
   * 传 `{ text }` 则先提示该文案再跳过（文案由调用方给，本模块不造键）。
   */
  skipEmpty?: { text?: string };
}

export interface UseCsvExportReturn {
  /** 导出请求在途：绑定按钮 `:loading`，同时用于防连点。 */
  exportLoading: Ref<boolean>;
  /** 导出当前筛选条件/当前结果集的 CSV。 */
  onExportCsv: () => Promise<void>;
}

/**
 * 创建「导出 CSV」组合式。
 *
 * 行为（顺序不可乱）：
 * 1. 在途则**直接返回**（防连点；不排队、不重复提示）；
 * 2. 置 loading → 取 Blob；
 * 3. `downloadBlobSafe`：业务失败 JSON **不触发下载**，由它统一提示后端 message；
 * 4. 真正下载成功才提示成功（文案可覆盖）；
 * 5. 请求异常原样展示后端 message（`extractErrorMessage`）；
 * 6. finally 复位 loading（失败/超时也不会永久转圈）。
 */
export function useCsvExport(options: UseCsvExportOptions): UseCsvExportReturn {
  const exportLoading = ref(false);

  async function onExportCsv() {
    if (exportLoading.value) {
      return;
    }
    exportLoading.value = true;
    try {
      const blob = await options.exportFn();
      // 调用方判定「没有数据可导出」（undefined 或 0 字节 Blob）：默认静默跳过；
      // 配置了 skipEmpty.text 时先提示一声（零行不是失败，不能弹 error）
      if (!blob || blob.size === 0) {
        const emptyText = options.skipEmpty?.text;
        if (emptyText) {
          message.info(emptyText);
        }
        return;
      }
      const downloaded = await downloadBlobSafe(
        blob,
        resolveFileName(options),
        options.errorText,
      );
      if (downloaded) {
        message.success(options.successText ?? $t('common.success'));
      }
    } catch (error) {
      message.error(extractErrorMessage(error, options.errorText));
    } finally {
      exportLoading.value = false;
    }
  }

  return { exportLoading, onExportCsv };
}

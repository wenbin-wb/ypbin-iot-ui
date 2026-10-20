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
 * - `fileName`：文件名**主体**（不含日期与后缀，通常传 i18n 文案），日期由本模块统一追加，
 *   避免各处自己 `dayjs().format(...)` 导致格式不一致/漏加日期覆盖同名文件；
 * - `errorText`：失败兜底文案（后端业务失败体里的 message 优先，见 `downloadBlobSafe`）。
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

export interface UseCsvExportOptions {
  /**
   * 生成 CSV 数据。
   *
   * - 后端导出：直接返回下载接口的 `Blob`；
   * - 前端本地生成（如批量下发结果）：在函数内 build 后包成 `Blob`；
   * - 返回 `undefined` ⇒ 视为「当前没有可导出的数据」，静默跳过（不弹成功/失败）。
   */
  exportFn: () => Promise<Blob | undefined>;
  /** 文件名主体（不含日期与 `.csv` 后缀；通常是 i18n 文案）。 */
  fileName: () => string;
  /** 失败兜底文案（后端业务失败体优先，未提供 message 时用它）。 */
  errorText: string;
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
 * 4. 真正下载成功才提示成功；
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
      // 调用方判定「没有数据可导出」：静默跳过（与收口前的早退口径一致）
      if (!blob) {
        return;
      }
      const downloaded = await downloadBlobSafe(
        blob,
        `${options.fileName()}_${dayjs().format(FILE_DATE_FORMAT)}.${CSV_EXTENSION}`,
        options.errorText,
      );
      if (downloaded) {
        message.success($t('common.success'));
      }
    } catch (error) {
      message.error(extractErrorMessage(error, options.errorText));
    } finally {
      exportLoading.value = false;
    }
  }

  return { exportLoading, onExportCsv };
}

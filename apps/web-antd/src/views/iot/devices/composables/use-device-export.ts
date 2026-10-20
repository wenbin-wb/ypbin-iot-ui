/**
 * 设备台账「导出 CSV」组合式。
 *
 * 与告警中心导出同一套骨架（loading 防重 + `downloadBlobSafe` 防伪文件 + 原样错误提示），
 * 抽出来是为了让页面只留「导出按钮 + 当前筛选条件」两件事，且便于后续统一收口成
 * `shared/use-csv-export`（05 报告 §4.1-#2 的下一步，本轮不动 shared）。
 */
import type { IotDeviceApi } from '#/api/iot';

import { ref } from 'vue';

import { message } from 'ant-design-vue';
import dayjs from 'dayjs';

import { exportDevicesCsv } from '#/api/iot/device';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

export interface UseDeviceExportOptions {
  /** 当前搜索表单值（与列表 query 同一份字段名，不另做映射）。 */
  readFormValues: () => IotDeviceApi.DeviceQuery;
}

export function useDeviceExport(options: UseDeviceExportOptions) {
  /** 导出请求在途：按钮 loading + 防重复点击。 */
  const exportLoading = ref(false);

  /**
   * 导出当前筛选条件下的设备台账 CSV。
   *
   * - 文件名 `设备台账_YYYYMMDD.csv`（日期由 dayjs 生成，避免同名覆盖）；
   * - `downloadBlobSafe` 处理「HTTP 200 但响应体是业务失败 JSON」的伪文件；
   * - 请求级失败原样展示后端 message（不静默）；loading 防重复点击。
   */
  async function onExportCsv() {
    if (exportLoading.value) {
      return;
    }
    exportLoading.value = true;
    try {
      const blob = await exportDevicesCsv(options.readFormValues());
      const downloaded = await downloadBlobSafe(
        blob,
        `${$t('page.iot.device.exportName')}_${dayjs().format('YYYYMMDD')}.csv`,
        $t('page.iot.device.exportFailed'),
      );
      if (downloaded) {
        message.success($t('common.success'));
      }
    } catch (error) {
      message.error(
        extractErrorMessage(error, $t('page.iot.device.exportFailed')),
      );
    } finally {
      exportLoading.value = false;
    }
  }

  return { exportLoading, onExportCsv };
}

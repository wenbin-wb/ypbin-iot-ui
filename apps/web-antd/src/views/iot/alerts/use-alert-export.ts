import type { IotAlertApi } from '#/api/iot';

import { ref } from 'vue';

import { message } from 'ant-design-vue';
import dayjs from 'dayjs';

import { exportAlertsCsv } from '#/api/iot/alert';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

import { resolveDeviceFilter } from './list-state';

interface AlertExportDeps {
  /** 当前搜索表单值（由页面从 vxe 表单实例读取；导出参数必须与列表查询同源）。 */
  getFormValues: () => IotAlertApi.InstanceQuery;
  /** 从设备台账带过来的 `?deviceId=`（与列表查询同一合并规则）。 */
  getPresetDeviceId: () => string;
}

/**
 * 告警实例 CSV 导出（服务端全量，不是当前页）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：导出的四步骨架（防重 → 取筛选 → 下载 →
 * 成功/失败提示）与其它页面逐字同构（架构审查 §4.1-#2 已登记三处重复），放在页面脚本里
 * 会继续扩散；先在本页收成一个 composable，后续可平移到 `shared/use-csv-export.ts`。
 *
 * 口径（不得改）：
 * - 参数 = 搜索表单当前值 + `resolveDeviceFilter` 合并后的 URL 设备过滤，否则「从设备台账带
 *   ?deviceId= 进来」时导出结果会比屏幕上看到的多；
 * - `downloadBlobSafe` 处理「HTTP 200 但响应体是业务失败 JSON」的伪文件；
 * - 失败原样展示后端 message（不静默）。
 */
export function useAlertExport({
  getFormValues,
  getPresetDeviceId,
}: AlertExportDeps) {
  const exportLoading = ref(false);

  async function onExportCsv() {
    if (exportLoading.value) {
      return;
    }
    exportLoading.value = true;
    try {
      const formValues = getFormValues();
      const blob = await exportAlertsCsv({
        ...formValues,
        deviceId: resolveDeviceFilter(
          formValues.deviceId,
          getPresetDeviceId() || undefined,
        ),
      });
      const downloaded = await downloadBlobSafe(
        blob,
        `${$t('page.iot.alert.exportName')}_${dayjs().format('YYYYMMDD')}.csv`,
        $t('page.iot.alert.exportFailed'),
      );
      if (downloaded) {
        message.success($t('common.success'));
      }
    } catch (error) {
      message.error(
        extractErrorMessage(error, $t('page.iot.alert.exportFailed')),
      );
    } finally {
      exportLoading.value = false;
    }
  }

  return { exportLoading, onExportCsv };
}

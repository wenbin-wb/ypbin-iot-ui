import type { IotDeviceApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { getDeviceOptions } from '#/api/iot/device';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 看板的**设备选项域**：设备下拉数据 + `id → 设备` 映射 + 加载失败原因。
 *
 * 从 `use-board-runtime.ts` 再拆出（批次 7-B）：这一块只服务「组件卡片显示设备名」这一个
 * 展示增强（`deviceById`），失败**不阻塞看板**（只记原因，卡片回落设备 ID 展示）——
 * 与「每个组件的运行期数据」是两个不同的失败等级，混在一起容易把「设备名取不到」误判成
 * 「整板数据加载失败」。
 */
export function useBoardDevices() {
  const deviceOptions = ref<IotDeviceApi.DeviceResp[]>([]);
  const deviceOptionsError = ref('');

  /** 组件卡片按 `deviceId` 反查设备（取不到时卡片回落显示 ID，不伪造名称）。 */
  const deviceById = computed(
    () => new Map(deviceOptions.value.map((item) => [String(item.id), item])),
  );

  /** 拉设备选项（展示增强，失败不阻塞：只把原因记进 `deviceOptionsError`）。 */
  async function loadDevices(): Promise<void> {
    deviceOptionsError.value = '';
    try {
      deviceOptions.value = (await getDeviceOptions()) ?? [];
    } catch (error) {
      deviceOptions.value = [];
      deviceOptionsError.value = extractErrorMessage(
        error,
        $t('page.iot.board.devicesLoadFailed'),
      );
    }
  }

  return { deviceById, deviceOptions, deviceOptionsError, loadDevices };
}

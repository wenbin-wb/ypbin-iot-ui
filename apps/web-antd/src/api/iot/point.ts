import { requestClient } from '#/api/request';

/**
 * IoT 点位映射 API（后端 `GET|POST /iot/devices/{deviceId}/points`）。
 *
 * 点位映射是**设备级**配置（产品侧只有属性定义）：属性来自产品物模型（只读），
 * 地址/周期/缩放是每台设备自己的（`views/iot/devices/modules/detail-points.vue` 的左右并排即此意）。
 */
export namespace IotPointApi {
  export interface PointMappingResp {
    id: string;
    deviceId: string;
    /** 关联属性（或命令）ID —— 与产品物模型的 `IotPropertyResp.id` 对齐。 */
    propertyId: string;
    /** 关联类型：property | command。 */
    refType: string;
    rawAddress: string;
    addressType: string;
    pollIntervalMs?: number;
    scaleFactor?: string;
    offsetValue?: string;
    byteOrder?: string;
    rw: string;
    enabled?: boolean;
    createTime?: string;
  }
}

/** 查询某设备的点位映射列表（无数据为空数组）。 */
export async function getDevicePoints(deviceId: string) {
  return requestClient.get<IotPointApi.PointMappingResp[]>(
    `/iot/devices/${deviceId}/points`,
  );
}

import { requestClient } from '#/api/request';

/**
 * IoT 点位映射 API（后端 /iot/devices/{deviceId}/points，iot:point:list/create/update/delete）。
 *
 * 点位映射是**设备级**配置（产品侧只有属性定义）：属性来自产品物模型（只读），
 * 地址/周期/缩放是每台设备自己的（views/iot/devices/modules/detail-points.vue 的左右并排即此意）。
 */
export namespace IotPointApi {
  export interface PointMappingResp {
    id: string;
    deviceId: string;
    /** 关联属性（或命令）ID —— 与产品物模型的属性/命令 ID 对齐。 */
    propertyId: string;
    /** 关联类型：property | command。 */
    refType: string;
    rawAddress: string;
    /** 地址类型：holding|input|coil|discrete|nodeid|topic。 */
    addressType: string;
    pollIntervalMs?: number;
    /** BigDecimal 全局序列化为字符串。 */
    scaleFactor?: string;
    /** BigDecimal 全局序列化为字符串。 */
    offsetValue?: string;
    /** 字节序：big|little（可空）。 */
    byteOrder?: string;
    /** 读写：R|W|RW（与属性 accessMode 联动校验）。 */
    rw: string;
    enabled?: boolean;
    createTime?: string;
  }

  /**
   * 创建/更新请求（后端 IotPointMappingReq 校验约束）：
   * propertyId @NotNull；refType/addressType/rawAddress/rw @NotBlank；
   * rawAddress @Size(max=128)；pollIntervalMs @Min(0)；scaleFactor/offsetValue/byteOrder/enabled 可空。
   */
  export interface PointMappingSaveReq {
    deviceId?: string;
    propertyId: string;
    refType: string;
    rawAddress: string;
    addressType: string;
    pollIntervalMs?: number;
    scaleFactor?: string;
    offsetValue?: string;
    byteOrder?: string;
    rw: string;
    enabled?: boolean;
  }
}

/** 查询某设备的点位映射列表（无数据为空数组）。 */
export async function getDevicePoints(deviceId: string) {
  return requestClient.get<IotPointApi.PointMappingResp[]>(
    `/iot/devices/${deviceId}/points`,
  );
}

/** 新增点位映射（返回新记录 id）。 */
export async function createDevicePoint(
  deviceId: string,
  data: IotPointApi.PointMappingSaveReq,
) {
  return requestClient.post<number>(`/iot/devices/${deviceId}/points`, data);
}

/** 更新点位映射。 */
export async function updateDevicePoint(
  deviceId: string,
  id: string,
  data: IotPointApi.PointMappingSaveReq,
) {
  return requestClient.put<null>(`/iot/devices/${deviceId}/points/${id}`, data);
}

/** 删除点位映射。 */
export async function deleteDevicePoint(deviceId: string, id: string) {
  return requestClient.delete<null>(`/iot/devices/${deviceId}/points/${id}`);
}

import { requestClient } from '#/api/request';

/**
 * IoT 设备台账 API（网关路由 /iot/**，StripPrefix=1）。
 */
export namespace IotDeviceApi {
  export interface DeviceResp {
    id: string;
    deviceCode: string;
    deviceName: string;
    protocol: string;
    endpoint: string;
    productId?: string;
    productVersion?: string;
    onlineStatus?: string;
    lastSeenAt?: string;
    remark?: string;
    createTime?: string;
  }

  export interface DeviceQuery {
    keyword?: string;
    page?: number;
    pageSize?: number;
    protocol?: string;
  }

  export interface DeviceSaveReq {
    deviceCode: string;
    deviceName: string;
    protocol: string;
    endpoint: string;
    productId?: string;
    productVersion?: string;
    remark?: string;
  }

  export interface PageResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
  }
}

/** 分页查询设备（服务端分页：vxe 需要 `items` + `total`）。 */
export async function getDevicePage(params: IotDeviceApi.DeviceQuery) {
  return requestClient.get<IotDeviceApi.PageResult<IotDeviceApi.DeviceResp>>(
    '/iot/devices',
    { params },
  );
}

/** 查询设备下拉（维护窗口声明用；取前 200 条）。 */
export async function getDeviceOptions(keyword?: string) {
  const result = await getDevicePage({ keyword, page: 1, pageSize: 200 });
  return result.items;
}

export async function createDevice(data: IotDeviceApi.DeviceSaveReq) {
  return requestClient.post<number>('/iot/devices', data);
}

export async function updateDevice(
  id: string,
  data: IotDeviceApi.DeviceSaveReq,
) {
  return requestClient.put(`/iot/devices/${id}`, data);
}

export async function deleteDevice(id: string) {
  return requestClient.delete(`/iot/devices/${id}`);
}

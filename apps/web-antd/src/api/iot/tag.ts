import { requestClient } from '#/api/request';

/**
 * IoT 设备标签 API（看板 #13 前端死能力接线）。
 *
 * 后端契约（ypbin-iot IotDeviceTagController）：
 * GET    /iot/devices/{deviceId}/tags          (iot:tag:list)
 * POST   /iot/devices/{deviceId}/tags          (iot:tag:create)
 * PUT    /iot/devices/{deviceId}/tags/{id}     (iot:tag:update)
 * DELETE /iot/devices/{deviceId}/tags/{id}     (iot:tag:delete)
 *
 * 标签体：tagKey(≤64) + tagValue(≤255)，两者均必填。
 */
export namespace IotDeviceTagApi {
  /** 标签（后端 Long 全局序列化 ⇒ id 是字符串）。 */
  export interface TagResp {
    id: string;
    deviceId: string;
    tagKey: string;
    tagValue: string;
  }

  /** 创建/更新请求（后端 @NotBlank + @Size 边界，前端预校验见 tag-state）。 */
  export interface TagSaveReq {
    tagKey: string;
    tagValue: string;
  }
}

/** 查询某设备全部标签。 */
export async function getDeviceTags(deviceId: string) {
  return requestClient.get<IotDeviceTagApi.TagResp[]>(
    `/iot/devices/${deviceId}/tags`,
  );
}

/** 新增标签。 */
export async function createDeviceTag(
  deviceId: string,
  data: IotDeviceTagApi.TagSaveReq,
) {
  return requestClient.post<number>(`/iot/devices/${deviceId}/tags`, data);
}

/** 更新标签。 */
export async function updateDeviceTag(
  deviceId: string,
  id: string,
  data: IotDeviceTagApi.TagSaveReq,
) {
  return requestClient.put<null>(`/iot/devices/${deviceId}/tags/${id}`, data);
}

/** 删除标签。 */
export async function deleteDeviceTag(deviceId: string, id: string) {
  return requestClient.delete<null>(`/iot/devices/${deviceId}/tags/${id}`);
}

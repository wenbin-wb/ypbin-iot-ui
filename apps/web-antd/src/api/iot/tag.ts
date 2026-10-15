import { requestClient } from '#/api/request';

/**
 * IoT 设备标签 API（前端「死能力接线」：后端能力已存在，此前无页面入口）。
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

  /** 批量打标签请求（同一键值打到多台设备；单次最多 500 台）。 */
  export interface BatchTagSetReq {
    /** 设备主键清单（Long 全局字符串化 ⇒ 前端全程 string，铁律 9）。 */
    deviceIds: string[];
    tagKey: string;
    tagValue: string;
  }

  /** 批量移除标签请求（删除多台设备上的指定标签键）。 */
  export interface BatchTagRemoveReq {
    deviceIds: string[];
    tagKeys: string[];
  }

  /**
   * 批量操作结果（后端 `BatchTagResp`）。
   *
   * 打标签按「该设备该键已有行 / 新增」分别计入 created/updated；移除只填 removed。
   * 三个字段后端恒有值（未涉及场景为 0）。
   */
  export interface BatchTagResp {
    created: number;
    removed: number;
    updated: number;
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

/**
 * 批量给多台设备打同一个键值标签（已存在则更新值，不存在则新增）。
 *
 * 后端 `POST /iot/devices/batch-tags`，权限 create/update 任一即可（SaMode.OR），
 * 单次最多 500 台。字段名与后端 `IotDeviceBatchTagReq` 完全一致，不做映射。
 */
export async function batchSetDeviceTags(
  deviceIds: string[],
  tagKey: string,
  tagValue: string,
) {
  const data: IotDeviceTagApi.BatchTagSetReq = { deviceIds, tagKey, tagValue };
  return requestClient.post<IotDeviceTagApi.BatchTagResp>(
    '/iot/devices/batch-tags',
    data,
  );
}

/**
 * 批量移除多台设备上的指定标签键。
 *
 * 后端 `POST /iot/devices/batch-tags/remove`，权限 `iot:tag:delete`；
 * `tagKeys` 由调用方 trim/去重后传入。
 */
export async function batchRemoveDeviceTags(
  deviceIds: string[],
  tagKeys: string[],
) {
  const data: IotDeviceTagApi.BatchTagRemoveReq = { deviceIds, tagKeys };
  return requestClient.post<IotDeviceTagApi.BatchTagResp>(
    '/iot/devices/batch-tags/remove',
    data,
  );
}

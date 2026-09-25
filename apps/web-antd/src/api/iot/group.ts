import { requestClient } from '#/api/request';

/** IoT 设备分组 API。 */
export namespace IotGroupApi {
  export interface GroupResp {
    id: string;
    groupName: string;
    parentId?: string;
    sort?: number;
    remark?: string;
    createTime?: string;
  }

  export interface GroupSaveReq {
    groupName: string;
    parentId?: string;
    sort?: number;
    remark?: string;
  }

  /**
   * 分组成员（后端 `IotDeviceGroupMemberResp`）。
   *
   * - `id` 是**成员行主键**，移除时用它（`DELETE /groups/{id}/members/{memberId}`），不是 deviceId；
   * - `deviceName`/`deviceCode`/`productName` 都是后端按设备与产品**批量解析**后的快照，
   *   设备或产品已不存在时可能为空（页面回落显示裸 ID / 「未绑定产品」，不编造）。
   */
  export interface GroupMemberResp {
    id: string;
    groupId: string;
    deviceId: string;
    deviceCode?: string;
    deviceName?: string;
    productId?: string;
    productName?: string;
    createTime?: string;
  }

  export interface GroupMemberSaveReq {
    deviceId: string;
  }
}

export async function getGroupList() {
  return requestClient.get<IotGroupApi.GroupResp[]>('/iot/groups');
}

export async function createGroup(data: IotGroupApi.GroupSaveReq) {
  return requestClient.post<number>('/iot/groups', data);
}

export async function updateGroup(id: string, data: IotGroupApi.GroupSaveReq) {
  return requestClient.put(`/iot/groups/${id}`, data);
}

export async function deleteGroup(id: string) {
  return requestClient.delete(`/iot/groups/${id}`);
}

/** 查询分组成员（含设备名与所属产品名，均由后端批量解析）。 */
export async function getGroupMembers(groupId: string) {
  return requestClient.get<IotGroupApi.GroupMemberResp[]>(
    `/iot/groups/${groupId}/members`,
  );
}

/** 把设备加入分组（后端对「已在分组中」会返回业务错误，前端不预判）。 */
export async function addGroupMember(groupId: string, deviceId: string) {
  return requestClient.post<number>(`/iot/groups/${groupId}/members`, {
    deviceId,
  });
}

/**
 * 把设备移出分组。
 *
 * ⚠️ `memberId` 是**成员行主键**（`GroupMemberResp.id`），不是 `deviceId`：
 * 后端按成员行删除，传设备 ID 会删不到任何行（静默无效）。
 */
export async function removeGroupMember(groupId: string, memberId: string) {
  return requestClient.delete(`/iot/groups/${groupId}/members/${memberId}`);
}

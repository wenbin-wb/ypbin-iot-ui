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

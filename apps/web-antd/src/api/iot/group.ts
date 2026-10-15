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

  /** 父分组下拉树的选项（ApiTreeSelect 契约字段：label / value / children）。 */
  export interface GroupTreeOption {
    label: string;
    value: string;
    children?: GroupTreeOption[];
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

/** 根分组判定：`parentId` 为空或 0（Long 全局序列化成字符串时可能是 `"0"`）。 */
export function isRootGroup(parentId?: null | number | string): boolean {
  return (
    parentId === undefined ||
    parentId === null ||
    parentId === '' ||
    parentId === '0' ||
    parentId === 0
  );
}

/** 根分组/0 归一为 undefined，其余 parentId 一律转字符串 id（Long 全局序列化成字符串）。 */
function parentKeyOf(parentId?: null | number | string): string | undefined {
  return isRootGroup(parentId) ? undefined : String(parentId);
}

/**
 * 由分组列表构建父分组下拉树。
 *
 * - `parentId` 为空/0、自引用、或指向列表中不存在的分组时按根分组处理（不隐藏孤儿数据）；
 * - `excludeId` 及其**全部后代**整棵剔除：后代基于完整父子关系先算出来再裁剪，
 *   保证编辑分组时不能把上级选成自己或自己的后代；
 * - 只输出 `label/value/children` 展示契约，不改后端字段名。
 */
export function buildGroupTreeOptions(
  groups: IotGroupApi.GroupResp[],
  excludeId?: string,
): IotGroupApi.GroupTreeOption[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const childrenByParent = new Map<string, IotGroupApi.GroupResp[]>();
  const roots: IotGroupApi.GroupResp[] = [];

  for (const group of groups) {
    const parentId = parentKeyOf(group.parentId);
    let parent: IotGroupApi.GroupResp | undefined;
    if (parentId && parentId !== group.id) {
      parent = groupById.get(parentId);
    }
    if (parent) {
      const siblings = childrenByParent.get(parent.id) ?? [];
      siblings.push(group);
      childrenByParent.set(parent.id, siblings);
    } else {
      roots.push(group);
    }
  }

  const excludedIds = new Set<string>();
  if (excludeId) {
    const stack = [excludeId];
    let current = stack.pop();
    while (current !== undefined) {
      if (!excludedIds.has(current)) {
        excludedIds.add(current);
        for (const child of childrenByParent.get(current) ?? []) {
          stack.push(child.id);
        }
      }
      current = stack.pop();
    }
  }

  const toOption = (
    group: IotGroupApi.GroupResp,
  ): IotGroupApi.GroupTreeOption => {
    const children = (childrenByParent.get(group.id) ?? [])
      .filter((child) => !excludedIds.has(child.id))
      .map((child) => toOption(child));
    return {
      label: group.groupName || group.id,
      value: group.id,
      ...(children.length > 0 ? { children } : {}),
    };
  };

  return roots
    .filter((root) => !excludedIds.has(root.id))
    .map((root) => toOption(root));
}

/** 父分组下拉数据：取全量分组后构树；编辑时传 `excludeId` 排除当前分组及后代。 */
export async function getGroupTreeOptions(excludeId?: string) {
  const groups = await getGroupList();
  return buildGroupTreeOptions(groups, excludeId);
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGroupTreeOptions,
  getGroupTreeOptions,
  isRootGroup,
} from '#/api/iot/group';

/**
 * 设备分组层级（task-15）API 侧用例：树构建、排除自身/后代、根分组判定。
 *
 * `buildGroupTreeOptions` 是纯函数，直接喂数据锁结构与排除逻辑；
 * `getGroupTreeOptions` 用 mock 的 requestClient 锁「一次 getGroupList + 正确排除参数」。
 */

const { requestGet } = vi.hoisted(() => ({ requestGet: vi.fn() }));

vi.mock('#/api/request', () => ({
  requestClient: {
    get: (...args: unknown[]) => requestGet(...args),
  },
}));

const GROUPS = [
  { groupName: '产线 A', id: 'g-1' },
  { groupName: '产线 B', id: 'g-2', parentId: 'g-1' },
  { groupName: '设备组 C', id: 'g-3', parentId: 'g-2' },
  { groupName: '独立组 D', id: 'g-4' },
  { groupName: '旧父组 E', id: 'g-5', parentId: 'g-404' },
  { groupName: '零父组 F', id: 'g-6', parentId: '0' },
];

beforeEach(() => {
  requestGet.mockReset();
});

describe('isRootGroup 根分组判定', () => {
  it('空值、空串、0、"0" 都算根分组；真实 id 不算', () => {
    expect(isRootGroup(undefined)).toBe(true);
    expect(isRootGroup(null)).toBe(true);
    expect(isRootGroup('')).toBe(true);
    expect(isRootGroup(0)).toBe(true);
    expect(isRootGroup('0')).toBe(true);
    expect(isRootGroup('g-1')).toBe(false);
  });
});

describe('buildGroupTreeOptions 树构建与排除', () => {
  it('按 parentId 递归挂 children；parentId 为空/0/指向不存在分组都按根分组保留', () => {
    expect(buildGroupTreeOptions(GROUPS)).toEqual([
      {
        children: [
          {
            children: [{ label: '设备组 C', value: 'g-3' }],
            label: '产线 B',
            value: 'g-2',
          },
        ],
        label: '产线 A',
        value: 'g-1',
      },
      { label: '独立组 D', value: 'g-4' },
      { label: '旧父组 E', value: 'g-5' },
      { label: '零父组 F', value: 'g-6' },
    ]);
  });

  it('★ excludeId 同时剔除自身与全部后代（整棵子树）', () => {
    expect(buildGroupTreeOptions(GROUPS, 'g-2')).toEqual([
      { label: '产线 A', value: 'g-1' },
      { label: '独立组 D', value: 'g-4' },
      { label: '旧父组 E', value: 'g-5' },
      { label: '零父组 F', value: 'g-6' },
    ]);

    // 排除根：根及其所有后代都不在下拉里
    expect(buildGroupTreeOptions(GROUPS, 'g-1')).toEqual([
      { label: '独立组 D', value: 'g-4' },
      { label: '旧父组 E', value: 'g-5' },
      { label: '零父组 F', value: 'g-6' },
    ]);
  });

  it('excludeId 不存在时结构不变；空数组不炸', () => {
    expect(buildGroupTreeOptions(GROUPS, 'g-404')).toEqual(
      buildGroupTreeOptions(GROUPS),
    );
    expect(buildGroupTreeOptions([])).toEqual([]);
  });
});

describe('getGroupTreeOptions 取数与排除参数', () => {
  it('调用 getGroupList 后构树，并把 excludeId 用于剔除自身及后代', async () => {
    requestGet.mockResolvedValue(GROUPS);

    await expect(getGroupTreeOptions('g-1')).resolves.toEqual([
      { label: '独立组 D', value: 'g-4' },
      { label: '旧父组 E', value: 'g-5' },
      { label: '零父组 F', value: 'g-6' },
    ]);
    expect(requestGet).toHaveBeenCalledWith('/iot/groups');
  });

  it('不传 excludeId 返回完整树（新增分组场景）', async () => {
    requestGet.mockResolvedValue(GROUPS);

    const tree = await getGroupTreeOptions();
    expect(tree.map((node) => node.value)).toEqual([
      'g-1',
      'g-4',
      'g-5',
      'g-6',
    ]);
  });

  it('取数失败原样抛出，不静默返回空树', async () => {
    requestGet.mockRejectedValue(new Error('查询被拒绝：无对应权限'));

    await expect(getGroupTreeOptions()).rejects.toThrow(
      '查询被拒绝：无对应权限',
    );
  });
});

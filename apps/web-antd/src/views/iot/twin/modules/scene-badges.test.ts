import { describe, expect, it } from 'vitest';

import { computeSceneBadges } from './scene-badges';

/**
 * 场景树角标（**纯函数**测试）。
 *
 * ## 核心不变量：「没加载 ≠ 0」
 *
 * 场景树里其它场景的告警数前端**没有数据**（只有当前场景拉过运行态）。
 * 若把「没数据」渲染成 0，用户会以为「这层没有告警」，于是不再点进去看 ——
 * 这是比不显示角标更糟的误导。因此 `alerts: undefined` 与 `alerts: 0`
 * 必须在类型与测试上都是两件事。
 */

/** 造场景。 */
function scene(overrides: Partial<{
  childCount: number;
  id: string;
  modelAssetId: null | string;
  pointCount: number;
}>): {
  anchorRx: string;
  anchorRy: string;
  anchorRz: string;
  anchorScale: string;
  anchorX: string;
  anchorY: string;
  anchorZ: string;
  childCount?: number;
  id: string;
  modelAssetId?: null | string;
  parentId: string;
  pointCount?: number;
  sceneCode: string;
  sceneName: string;
  sceneType: 'floor';
} {
  return {
    anchorRx: '0',
    anchorRy: '0',
    anchorRz: '0',
    anchorScale: '1',
    anchorX: '0',
    anchorY: '0',
    anchorZ: '0',
    childCount: overrides.childCount,
    id: overrides.id ?? 's1',
    modelAssetId: overrides.modelAssetId ?? null,
    parentId: '0',
    pointCount: overrides.pointCount,
    sceneCode: 'C',
    sceneName: '场景',
    sceneType: 'floor',
  };
}

describe('computeSceneBadges', () => {
  it('★ 非当前场景的告警数必须是 undefined，而不是 0', () => {
    const badges = computeSceneBadges({
      currentPoints: [],
      currentRuntimePoints: [],
      currentSceneId: 's1',
      scenes: [scene({ id: 's1' }), scene({ id: 's2' })],
    });
    expect(badges.get('s2')?.alerts).toBeUndefined();
    // 当前场景没有告警时是 0（真实数据）
    expect(badges.get('s1')?.alerts).toBe(0);
  });

  it('当前场景告警按设备去重求和', () => {
    const badges = computeSceneBadges({
      currentPoints: [],
      currentRuntimePoints: [
        { alertCount: 2, deviceId: 'd1' },
        { alertCount: 2, deviceId: 'd1' },
        { alertCount: 1, deviceId: 'd2' },
        { alertCount: 0, deviceId: 'd3' },
      ],
      currentSceneId: 's1',
      scenes: [scene({ id: 's1' })],
    });
    expect(badges.get('s1')?.alerts).toBe(3);
  });

  it('当前场景点位数用实际点位（比 pointCount 更实时），其它场景用 pointCount', () => {
    const badges = computeSceneBadges({
      currentPoints: [
        { bindings: [], deviceId: 'd1', id: 'p1', labelVisible: true, localX: '0', localY: '0', localZ: '0', normalX: '0', normalY: '1', normalZ: '0', sceneId: 's1' },
      ],
      currentRuntimePoints: [],
      currentSceneId: 's1',
      scenes: [
        scene({ id: 's1', pointCount: 99 }),
        scene({ id: 's2', pointCount: 4 }),
      ],
    });
    expect(badges.get('s1')?.pointCount).toBe(1);
    expect(badges.get('s2')?.pointCount).toBe(4);
  });

  it('hasModel 反映是否绑定了模型资产', () => {
    const badges = computeSceneBadges({
      currentPoints: [],
      currentRuntimePoints: [],
      currentSceneId: '',
      scenes: [
        scene({ id: 's1', modelAssetId: 'asset-1' }),
        scene({ id: 's2', modelAssetId: null }),
      ],
    });
    expect(badges.get('s1')?.hasModel).toBe(true);
    expect(badges.get('s2')?.hasModel).toBe(false);
  });

  it('childCount 缺省按 0（后端未返回时不渲染角标）', () => {
    const badges = computeSceneBadges({
      currentPoints: [],
      currentRuntimePoints: [],
      currentSceneId: 's1',
      scenes: [scene({ id: 's1' })],
    });
    expect(badges.get('s1')?.childCount).toBe(0);
  });
});

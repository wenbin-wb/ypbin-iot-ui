import { describe, expect, it } from 'vitest';

import { computeTwinKpi, toKpiItems } from './twin-kpi';

/**
 * 顶部 KPI 条（**纯函数**测试）。
 *
 * ## 三个必须钉住的口径
 *
 * 1. **`unknown` 不计入在线率分母**：平台还没拿到过设备连接事件 ≠ 离线。
 *    若把它当离线，新接入的场景在线率会凭空掉到 50%，运维会去查根本不存在的故障。
 * 2. **告警按设备去重取最大值**：一台设备在场景里配了 3 个点位（不同楼层视角）时，
 *    不能把同一条告警算 3 次。
 * 3. **快照截断时不给在线率**（`undefined`）而不是给一个偏高的数字：
 *    分母不完整时给百分比等于说谎，UI 会显示 `--` 并标注「数据不完整」。
 */

/** 造点位。 */
function point(
  id: string,
  deviceId: string,
): {
  bindings: [];
  deviceId: string;
  id: string;
  labelVisible: boolean;
  localX: string;
  localY: string;
  localZ: string;
  normalX: string;
  normalY: string;
  normalZ: string;
  sceneId: string;
} {
  return {
    bindings: [],
    deviceId,
    id,
    labelVisible: true,
    localX: '0',
    localY: '0',
    localZ: '0',
    normalX: '0',
    normalY: '1',
    normalZ: '0',
    sceneId: 's1',
  };
}

/** 造运行态点位。 */
function runtime(deviceId: string, onlineStatus: string, alertCount = 0) {
  return { alertCount, deviceId, onlineStatus };
}

describe('computeTwinKpi', () => {
  it('设备数按 deviceId 去重（同设备多点位只算一台）', () => {
    const kpi = computeTwinKpi({
      assetCount: 2,
      points: [point('p1', 'd1'), point('p2', 'd1'), point('p3', 'd2')],
      runtimePoints: [runtime('d1', 'online'), runtime('d2', 'online')],
      scenes: [{ id: 's1' }, { id: 's2' }],
    });
    expect(kpi.deviceCount).toBe(2);
    expect(kpi.pointCount).toBe(3);
    expect(kpi.modelCount).toBe(2);
    expect(kpi.sceneCount).toBe(2);
  });

  it('★ unknown 不计入在线率分母', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [point('p1', 'd1'), point('p2', 'd2')],
      runtimePoints: [runtime('d1', 'online'), runtime('d2', 'unknown')],
      scenes: [],
    });
    // 1 在线 / 1 已知 = 100%，而不是 1/2 = 50%
    expect(kpi.settledDeviceCount).toBe(1);
    expect(kpi.onlineRate).toBe(100);
  });

  it('★ 全部 unknown ⇒ 在线率 undefined（显示 --，而不是 0% 或 100%）', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [point('p1', 'd1')],
      runtimePoints: [runtime('d1', 'unknown')],
      scenes: [],
    });
    expect(kpi.settledDeviceCount).toBe(0);
    expect(kpi.onlineRate).toBeUndefined();
  });

  it('★ 快照截断 ⇒ 在线率 undefined（分母不完整时不给百分比）', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [point('p1', 'd1'), point('p2', 'd2')],
      runtimePoints: [runtime('d1', 'online'), runtime('d2', 'online')],
      scenes: [],
      truncated: true,
    });
    expect(kpi.truncated).toBe(true);
    expect(kpi.onlineRate).toBeUndefined();
  });

  it('★ 告警按设备去重取最大值（同设备多点位不重复累加）', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [point('p1', 'd1'), point('p2', 'd1'), point('p3', 'd2')],
      runtimePoints: [
        runtime('d1', 'online', 2),
        runtime('d1', 'online', 2),
        runtime('d2', 'online', 1),
      ],
      scenes: [],
    });
    expect(kpi.alertCount).toBe(3);
  });

  it('空场景 ⇒ 全 0、在线率 undefined（不抛错）', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [],
      runtimePoints: [],
      scenes: [],
    });
    expect(kpi).toMatchObject({
      alertCount: 0,
      deviceCount: 0,
      onlineRate: undefined,
      pointCount: 0,
    });
  });

  it('在线率四舍五入为整数（2/3 ⇒ 67）', () => {
    const kpi = computeTwinKpi({
      assetCount: 0,
      points: [],
      runtimePoints: [
        runtime('d1', 'online'),
        runtime('d2', 'online'),
        runtime('d3', 'offline'),
      ],
      scenes: [],
    });
    expect(kpi.onlineRate).toBe(67);
  });
});

describe('toKpiItems', () => {
  it('顺序固定，且有告警时标记 danger', () => {
    const items = toKpiItems(
      computeTwinKpi({
        assetCount: 1,
        points: [point('p1', 'd1')],
        runtimePoints: [runtime('d1', 'online', 2)],
        scenes: [{ id: 's1' }],
      }),
      { devices: '当前场景' },
    );
    expect(items.map((item) => item.key)).toEqual([
      'devices',
      'onlineRate',
      'alerts',
      'points',
      'scenes',
      'models',
    ]);
    expect(items.find((item) => item.key === 'alerts')?.danger).toBe(true);
    expect(items.find((item) => item.key === 'onlineRate')?.value).toBe(100);
    expect(items.find((item) => item.key === 'devices')?.hint).toBe('当前场景');
  });

  it('无告警时不标 danger', () => {
    const items = toKpiItems(
      computeTwinKpi({
        assetCount: 0,
        points: [],
        runtimePoints: [],
        scenes: [],
      }),
    );
    expect(items.find((item) => item.key === 'alerts')?.danger).toBe(false);
  });
});

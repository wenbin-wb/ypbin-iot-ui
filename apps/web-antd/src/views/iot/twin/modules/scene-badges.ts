import type { IotTwinApi } from '#/api/iot';

/**
 * 场景树角标（**纯函数，可单测**）。
 *
 * ## 为什么需要后端之外再算一遍
 *
 * 场景树现在只显示「场景名」，运维看不出「哪个楼层有告警、哪个楼层有设备」，
 * 必须逐个点进去才知道 —— 这正是「像 demo」的一部分。
 * 角标数据**全部来自已有的场景平铺列表与当前场景点位/运行态**：
 *
 * - **子场景数**：`SceneResp.childCount`（后端已给）；
 * - **点位数**：`SceneResp.pointCount`（后端已给）；
 * - **告警数**：只有**当前场景**的运行态是实时拉过的 ⇒ 其它场景的告警数
 *   前端**没有数据**，不能猜、不能显示 0（0 会被误读为「没有告警」）。
 *   因此角标里告警只对当前场景显示，其它场景显示为「未加载」语义（`alerts: undefined`）。
 *
 * ## 为什么不在这里请求每个场景的运行态
 *
 * 4 级 × N 个场景的树在有几十个场景时会产生几十个请求（每个都是 IoTDB 批量读），
 * 打开页面就把后端打满。宁可诚实地「不显示」，也不做 N+1 请求。
 * （若将来需要，应加一个按 parentId 聚合的服务端端点，那是新契约，需单独决策。）
 */

/** 单个场景的角标。 */
export interface SceneBadge {
  /** 子场景数。 */
  childCount: number;
  /** 点位数。 */
  pointCount: number;
  /** 活动告警数；`undefined` = 未加载（**不是 0**）。 */
  alerts?: number;
  /** 是否有模型（未绑模型的场景在树里用空心图标区分）。 */
  hasModel: boolean;
}

/** 角标计算输入。 */
export interface SceneBadgeInput {
  /** 当前场景 ID（只有它有没有告警数的实时数据）。 */
  currentSceneId: string;
  /** 当前场景的点位（用于算设备数，供提示用）。 */
  currentPoints: readonly IotTwinApi.PointResp[];
  /** 当前场景运行态点位。 */
  currentRuntimePoints: readonly Pick<
    IotTwinApi.RuntimePointResp,
    'alertCount' | 'deviceId'
  >[];
  /** 场景（平铺列表）。 */
  scenes: readonly IotTwinApi.SceneResp[];
  /**
   * 共享告警数域（设备 ID → 活动告警数）。
   *
   * 优先于快照里的 `alertCount`（理由见 `twin-kpi.ts` 的 `sharedAlertCounts`）。
   * 只影响**当前场景**的角标：其它场景没有拉过运行态，仍然显示「未加载」。
   */
  sharedAlertCounts?: ReadonlyMap<string, number>;
}

/**
 * 计算角标表。
 *
 * @param input 输入
 * @returns 场景 ID → 角标
 */
export function computeSceneBadges(
  input: SceneBadgeInput,
): Map<string, SceneBadge> {
  const alertByDevice = new Map<string, number>();
  if (input.currentSceneId && input.sharedAlertCounts) {
    const shared = input.sharedAlertCounts;
    for (const deviceId of shared.keys()) {
      const count = Number(shared.get(deviceId) ?? 0);
      if (Number.isFinite(count) && count > 0) {
        alertByDevice.set(deviceId, count);
      }
    }
  } else if (input.currentSceneId) {
    for (const point of input.currentRuntimePoints) {
      const deviceId = String(point.deviceId);
      const count = Number(point.alertCount ?? 0);
      if (!Number.isFinite(count) || count <= 0) {
        continue;
      }
      alertByDevice.set(
        deviceId,
        Math.max(alertByDevice.get(deviceId) ?? 0, count),
      );
    }
  }

  const badges = new Map<string, SceneBadge>();
  for (const scene of input.scenes) {
    const isCurrent = scene.id === input.currentSceneId;
    let alerts: number | undefined;
    if (isCurrent) {
      // 当前场景：按设备去重求和（与 KPI 条同口径）
      let total = 0;
      for (const count of alertByDevice.values()) {
        total += count;
      }
      alerts = total;
    }
    badges.set(scene.id, {
      alerts,
      childCount: Number(scene.childCount ?? 0) || 0,
      hasModel: Boolean(scene.modelAssetId),
      pointCount: isCurrent
        ? input.currentPoints.length
        : Number(scene.pointCount ?? 0) || 0,
    });
  }
  return badges;
}

import type { IotTwinApi } from '#/api/iot';

/**
 * 顶部 KPI 条的数据（**纯函数，可单测**）。
 *
 * ## 为什么 KPI 必须由「已有数据」算出而不是新开接口
 *
 * 孪生页的接口契约是固定的（16 端点），加一个「统计」端点会带来
 * 「两处口径不一致」（画布用运行态、KPI 用统计接口，一个实时一个缓存）的经典问题。
 * 这里所有数字都来自**已经拿到的**：场景平铺列表（`pointCount`）、
 * 当前场景点位与运行态、运行态快照（`truncated`）。
 *
 * ## 口径（写死在这里，避免各处自己算）
 *
 * - **设备总数**：各场景 `pointCount` 去重后的设备数不够准确（点位≠设备），
 *   因此「设备总数」只统计**当前场景**（当前场景的点位所对应的设备），
 *   并在 UI 上标注「当前场景」——不假装是全局数字。
 * - **在线率**：只算**当前场景**内状态已知（online / offline）的设备；
 *   `unknown`（平台还没拿到连接事件）**不计入分母**，否则会把「刚接入的设备」
 *   错误地算成离线，在线率被拉低。
 * - **告警数**：当前场景点位上的活动告警数之和（同一设备多处出现会重复计数，
 *   因此改为**按设备去重后取最大值**，与「该设备有几条活动告警」语义一致）。
 * - **模型数**：模型资产列表长度（全局，不随场景变）。
 */

/** KPI 条的一项。 */
export interface TwinKpiItem {
  /** 稳定的键（用于测试与 DOM `data-kpi`）。 */
  key: 'alerts' | 'devices' | 'models' | 'onlineRate' | 'points' | 'scenes';
  /** 数值（在线率是 0~100 的整数百分比；无分母时为 undefined）。 */
  value: number | undefined;
  /** 补充说明（例如「当前场景」），由调用方本地化后传入。 */
  hint?: string;
  /** 是否以警示色显示（例如有告警）。 */
  danger?: boolean;
}

/** KPI 计算输入。 */
export interface TwinKpiInput {
  /** 模型资产数。 */
  assetCount: number;
  /** 当前场景的点位（用于算设备数与告警数）。 */
  points: readonly IotTwinApi.PointResp[];
  /** 当前场景运行态点位（在线状态 + 告警数）。 */
  runtimePoints: readonly Pick<
    IotTwinApi.RuntimePointResp,
    'alertCount' | 'deviceId' | 'onlineStatus'
  >[];
  /** 场景列表（用于「全部场景数」这一项的展示）。 */
  scenes: readonly Pick<IotTwinApi.SceneResp, 'id'>[];
  /**
   * 共享告警数域（设备 ID → 活动告警数）。
   *
   * **优先于** `runtimePoints[].alertCount`：后者来自场景快照，告警发生/恢复后
   * 要等下一次快照才更新，而共享域在收到 `alert` 事件后立即重拉。
   * 三处（KPI / 树角标 / 卡片）都读它，数字才可能永远一致。
   */
  sharedAlertCounts?: ReadonlyMap<string, number>;
  /**
   * 运行态快照是否被截断（`RuntimeResp.truncated`）。
   *
   * 截断时在线率的分母不完整 ⇒ KPI 必须显式标注，不能让用户以为「全都在线」。
   */
  truncated?: boolean;
}

/** KPI 计算结果。 */
export interface TwinKpiResult {
  /** 当前场景的活动告警数（按设备去重取最大值再求和）。 */
  alertCount: number;
  /** 当前场景的设备数（去重）。 */
  deviceCount: number;
  /** 当前场景的点位数。 */
  pointCount: number;
  /** 模型资产数。 */
  modelCount: number;
  /** 场景数（全部）。 */
  sceneCount: number;
  /** 在线率（0~100 整数百分比）；分母为 0 或快照截断时为 undefined。 */
  onlineRate?: number;
  /** 状态已知（online/offline）的设备数。 */
  settledDeviceCount: number;
  /** 在线设备数。 */
  onlineDeviceCount: number;
  /** 快照是否被截断。 */
  truncated: boolean;
}

/**
 * 计算 KPI。
 *
 * @param input 输入
 * @returns 计算结果
 */
export function computeTwinKpi(input: TwinKpiInput): TwinKpiResult {
  const devices = new Set<string>();
  for (const point of input.points) {
    devices.add(String(point.deviceId));
  }

  // 告警：按设备去重取最大值（同一设备在场景里有多个点位时不能重复累加）
  const alertByDevice = new Map<string, number>();
  const shared = input.sharedAlertCounts;
  if (shared) {
    // 共享域是权威：只统计**本场景**的设备（它可能包含别的场景的设备）
    for (const deviceId of devices) {
      const count = Number(shared.get(deviceId) ?? 0);
      if (Number.isFinite(count) && count > 0) {
        alertByDevice.set(deviceId, count);
      }
    }
  } else {
    for (const point of input.runtimePoints) {
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
  let alertCount = 0;
  for (const count of alertByDevice.values()) {
    alertCount += count;
  }

  let onlineDeviceCount = 0;
  let settledDeviceCount = 0;
  for (const point of input.runtimePoints) {
    const status = point.onlineStatus;
    if (status === 'online') {
      onlineDeviceCount += 1;
      settledDeviceCount += 1;
    } else if (status === 'offline') {
      settledDeviceCount += 1;
    }
    // unknown / 空：**不计入分母**（平台还没拿到连接事件 ≠ 离线）
  }

  const truncated = input.truncated === true;
  const onlineRate =
    truncated || settledDeviceCount === 0
      ? undefined
      : Math.round((onlineDeviceCount / settledDeviceCount) * 100);

  return {
    alertCount,
    deviceCount: devices.size,
    modelCount: input.assetCount,
    onlineDeviceCount,
    onlineRate,
    pointCount: input.points.length,
    sceneCount: input.scenes.length,
    settledDeviceCount,
    truncated,
  };
}

/**
 * 组装 KPI 条的展示项（顺序固定：设备 → 在线率 → 告警 → 点位 → 场景 → 模型）。
 *
 * @param kpi 计算结果
 * @param hints 各键的补充说明（**已本地化**；引擎/纯函数层不做 i18n）
 * @returns 展示项
 */
export function toKpiItems(
  kpi: TwinKpiResult,
  hints: Partial<Record<TwinKpiItem['key'], string>> = {},
): TwinKpiItem[] {
  return [
    {
      hint: hints.devices,
      key: 'devices',
      value: kpi.deviceCount,
    },
    {
      hint: hints.onlineRate,
      key: 'onlineRate',
      value: kpi.onlineRate,
    },
    {
      danger: kpi.alertCount > 0,
      hint: hints.alerts,
      key: 'alerts',
      value: kpi.alertCount,
    },
    { hint: hints.points, key: 'points', value: kpi.pointCount },
    { hint: hints.scenes, key: 'scenes', value: kpi.sceneCount },
    { hint: hints.models, key: 'models', value: kpi.modelCount },
  ];
}

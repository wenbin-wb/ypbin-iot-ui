import type { AnchorRuntimeState } from './types';

import type { IotTwinApi } from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { toRenderMode, toSwitchState } from './display';

/**
 * 运行态值的合并与节流（**实时驱动 3D 的唯一入口**）。
 *
 * ## 为什么必须节流
 *
 * SSE 的 `latest` 是**逐条**推送：一个 500 点位、每点位 1s 上报一次的场景，峰值 500 事件/秒。
 * 若每条事件都触发 Vue 响应式更新 + DOM 文本改写，主线程会被打满（表现为整个页面卡顿、
 * 相机拖不动）。这里做三件事：
 *
 * 1. 事件到达时**只写入一个普通 Map**（不触发任何响应式）；
 * 2. 用 `requestAnimationFrame` 合并，每帧最多提交一次；
 * 3. 提交时只把**本帧真正变化的锚点**交给锚点层。
 *
 * 这与仪表盘的 `useDashboardRealtime`（trailing 去抖 1200ms 后重拉统计接口）不同：
 * 那边是「重拉接口」，这边是「更新已有数据」⇒ 用 rAF 而不是时间窗口去抖，
 * rAF 天然与浏览器刷新对齐，不会出现「数据到了但下一帧还没画」的错位。
 *
 * ## 语义边界（必须体现在 UI 上）
 *
 * - 属性从未上报 ⇒ `values` 里没有该键 ⇒ 标签显示 `--`，**不是 0**；
 * - `onlineStatus=unknown` ⇒ 平台还没拿到过连接事件，**不代表离线**。
 */

/** 运行态存储选项。 */
export interface RuntimeStoreOptions {
  /** 每帧提交回调（已合并、只含变化项）。 */
  onFlush: (states: Map<string, AnchorRuntimeState>) => void;
}

/** 一个点位在存储里的内部状态。 */
interface PointRuntime {
  /** 活动告警数。 */
  alertCount: number;
  /** 点位所属设备（用于匹配 SSE 事件的 deviceId）。 */
  deviceId: string;
  /** 设备名（标签展示用）。 */
  deviceName: string;
  /** 设备在线状态。 */
  onlineStatus?: null | string;
  /** 主展示属性的小数位。 */
  primaryDecimals?: null | number;
  /** 主展示属性标识（由绑定的 `displayRole=primary` 决定；无 primary 时取第一条绑定）。 */
  primaryProperty?: string;
  /** 主展示属性的单位（用于拼接 `26.5 ℃`）。 */
  primaryUnit?: null | string;
  /** 主展示属性的展示形态（决定画布怎么画，见 `display.ts`）。 */
  primaryDisplayType?: null | string;

  /** 启停位。 */
  status?: null | number;
  /** 属性标识 → 最新值。 */
  values: Record<string, IotTwinApi.RuntimeValueResp>;
}

/** 运行态存储：把「快照 + SSE 增量」合成为每帧可渲染的锚点状态。 */
export class TwinRuntimeStore {
  private deviceIdToPointIds = new Map<string, string[]>();

  private dirty = new Set<string>();

  private flushHandle = 0;

  private onFlush: (states: Map<string, AnchorRuntimeState>) => void;

  private points = new Map<string, PointRuntime>();

  private watchedProperties = new Set<string>();

  constructor(options: RuntimeStoreOptions) {
    this.onFlush = options.onFlush;
  }

  /**
   * 合并告警数（`alert` 事件只说明「告警变化了」，具体数量由页面重拉后调用本方法）。
   *
   * @param counts 设备 ID → 活动告警数
   */
  applyAlertCounts(counts: Map<string, number>): void {
    let changed = false;
    for (const [pointId, runtime] of this.points) {
      const next = counts.get(runtime.deviceId) ?? 0;
      if (next !== runtime.alertCount) {
        runtime.alertCount = next;
        this.dirty.add(pointId);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleFlush();
    }
  }

  /**
   * 处理 SSE `device-status` 事件（在线/启停变化）。
   *
   * @param payload 事件负载（`deviceId` 单台 或 `deviceIds` 批量）
   */
  applyDeviceStatusEvent(payload: {
    deviceId?: null | number | string;
    deviceIds?: Array<number | string>;
    status?: null | number | string;
  }): void {
    const rawIds: Array<number | string> = [];
    if (payload.deviceId !== null && payload.deviceId !== undefined) {
      rawIds.push(payload.deviceId);
    }
    for (const id of payload.deviceIds ?? []) {
      rawIds.push(id);
    }
    if (rawIds.length === 0) {
      return;
    }
    let changed = false;
    for (const rawId of rawIds) {
      const pointIds = this.deviceIdToPointIds.get(String(rawId));
      if (!pointIds) {
        continue;
      }
      for (const pointId of pointIds) {
        const runtime = this.points.get(pointId);
        if (!runtime) {
          continue;
        }
        // `status` 是启停位（1/0）；字符串形态则视为在线状态（两种事件共用同一事件名）
        if (typeof payload.status === 'number') {
          runtime.status = payload.status;
        } else if (typeof payload.status === 'string') {
          runtime.onlineStatus = payload.status;
        }
        this.dirty.add(pointId);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleFlush();
    }
  }

  /**
   * 处理 SSE `latest` 事件（**单条读数**）。
   *
   * @param payload 事件负载
   */
  applyLatestEvent(payload: IotRealtimeLatestPayload): void {
    const deviceId =
      payload.deviceId === null || payload.deviceId === undefined
        ? ''
        : String(payload.deviceId);
    const propertyId = payload.propertyId ?? '';
    if (!deviceId || !propertyId) {
      return;
    }
    // 命中索引：同一设备可能出现在多个场景（不同页面实例），但一个 store 只管当前场景
    const pointIds = this.deviceIdToPointIds.get(deviceId);
    if (!pointIds) {
      return;
    }
    const ts =
      payload.ts === null || payload.ts === undefined
        ? null
        : String(payload.ts);
    for (const pointId of pointIds) {
      const runtime = this.points.get(pointId);
      if (!runtime) {
        continue;
      }
      // 只更新本场景真正绑定的属性
      if (!this.watchedProperties.has(`${pointId}\u0000${propertyId}`)) {
        continue;
      }
      const previous = runtime.values[propertyId];
      // 同 ts 不覆盖（SSE 可能乱序；旧值覆盖新值会让数字「跳回去」）
      if (previous?.ts && ts && Number(previous.ts) > Number(ts)) {
        continue;
      }
      runtime.values = {
        ...runtime.values,
        [propertyId]: {
          quality: payload.quality ?? null,
          stale: false,
          ts,
          value: payload.value ?? null,
        },
      };
      this.dirty.add(pointId);
    }
    this.scheduleFlush();
  }

  /** 释放（取消待执行的 rAF）。 */
  dispose(): void {
    if (this.flushHandle) {
      cancelAnimationFrame(this.flushHandle);
      this.flushHandle = 0;
    }
    this.points.clear();
    this.deviceIdToPointIds.clear();
    this.watchedProperties.clear();
    this.dirty.clear();
  }

  /** 立即提交全部状态（例如页面卸载前，或需要同步渲染的场景）。 */
  flushNow(): void {
    if (this.flushHandle) {
      cancelAnimationFrame(this.flushHandle);
      this.flushHandle = 0;
    }
    this.flush();
  }

  /**
   * 用一次快照**整体替换**当前状态（进入场景时调用）。
   *
   * @param snapshot 运行态快照
   * @param bindings 点位 → 绑定（决定主展示属性与单位/精度）
   */
  replaceSnapshot(
    snapshot: IotTwinApi.RuntimeResp,
    bindings: Map<string, IotTwinApi.BindingResp[]>,
  ): void {
    this.points.clear();
    this.deviceIdToPointIds.clear();
    this.watchedProperties.clear();
    this.dirty.clear();

    for (const point of snapshot.points) {
      const pointBindings = bindings.get(point.pointId) ?? [];
      const primary =
        pointBindings.find((binding) => binding.displayRole === 'primary') ??
        pointBindings[0];
      const runtime: PointRuntime = {
        alertCount: point.alertCount ?? 0,
        deviceId: point.deviceId,
        deviceName: point.deviceName ?? point.deviceCode ?? point.deviceId,
        onlineStatus: point.onlineStatus,
        primaryDecimals: primary?.decimals,
        primaryDisplayType: primary?.displayType,
        primaryProperty: primary?.propertyIdentifier,
        primaryUnit: primary?.unit,
        status: point.status,
        // values 的键是属性标识；拷贝一份避免后续 SSE 事件改到快照对象
        values: { ...point.values },
      };
      this.points.set(point.pointId, runtime);

      const existing = this.deviceIdToPointIds.get(point.deviceId);
      if (existing) {
        existing.push(point.pointId);
      } else {
        this.deviceIdToPointIds.set(point.deviceId, [point.pointId]);
      }
      // 记录「本场景关心哪些 (点位, 属性) 组合」：SSE 只推单条读数，
      // 靠这个集合精确判断该事件是否与本场景有关（否则每台设备每次上报都会
      // 触发全场景脏标记，等于没节流）。
      for (const binding of pointBindings) {
        this.watchedProperties.add(
          `${point.pointId}\u0000${binding.propertyIdentifier}`,
        );
      }
      this.dirty.add(point.pointId);
    }
    this.scheduleFlush();
  }

  // ---------- 私有 ----------

  private flush(): void {
    if (this.dirty.size === 0) {
      return;
    }
    const states = new Map<string, AnchorRuntimeState>();
    for (const pointId of this.dirty) {
      const runtime = this.points.get(pointId);
      if (!runtime) {
        continue;
      }
      states.set(pointId, toAnchorState(runtime));
    }
    this.dirty.clear();
    this.onFlush(states);
  }

  private scheduleFlush(): void {
    if (this.flushHandle) {
      return;
    }
    this.flushHandle = requestAnimationFrame(() => {
      this.flushHandle = 0;
      this.flush();
    });
  }
}

/**
 * 把内部状态转成锚点层要的展示状态。
 *
 * @param runtime 点位运行态
 * @returns 锚点展示状态
 */
function toAnchorState(runtime: PointRuntime): AnchorRuntimeState {
  const primaryProperty = runtime.primaryProperty;
  const value = primaryProperty ? runtime.values[primaryProperty] : undefined;
  const hasValue = Boolean(
    value && value.value !== null && value.value !== undefined,
  );
  let primaryText = '';
  if (hasValue && value) {
    primaryText = formatValue(value.value, runtime.primaryDecimals);
    if (runtime.primaryUnit) {
      primaryText = `${primaryText} ${runtime.primaryUnit}`;
    }
  }
  const renderMode = toRenderMode(runtime.primaryDisplayType);
  return {
    alertCount: runtime.alertCount,
    // color 形态：按**数据质量**分档染色（good=0 / 其它=1）。
    // 不用 min/max 线性映射：运行态快照里没有物模型的 min/max（它们在
    // IotTwinDevicePropertyResp，属设备属性配置接口），拿不到就不猜。
    colorRatio: hasValue ? (isGoodQuality(value?.quality) ? 0 : 1) : undefined,
    hasValue,
    onlineStatus: runtime.onlineStatus,
    primaryText,
    renderMode,
    status: runtime.status,
    switchState: hasValue ? toSwitchState(value?.value ?? null) : undefined,
  };
}

/**
 * 数据质量是否为 good。
 *
 * 后端 `quality` 是字符串（如 `good` / `bad` / `uncertain`，具体取值随采集协议）。
 * 判定用「不以 bad/uncertain 开头」而不是白名单 `=== 'good'`：
 * 各协议的质量码不统一，白名单会把合法值误判为异常（进而误染色）。
 *
 * @param quality 质量码
 * @returns 是否视为正常
 */
function isGoodQuality(quality?: null | string): boolean {
  if (quality === null || quality === undefined || quality === '') {
    // 无质量码时按正常处理：不因为「没上报质量」就把点位染成异常色
    return true;
  }
  const normalized = quality.trim().toLowerCase();
  return !normalized.startsWith('bad') && !normalized.startsWith('uncertain');
}

/**
 * 按小数位格式化数值（非数字值原样返回，不显示 NaN）。
 *
 * @param value 原始值字符串
 * @param decimals 小数位（null/undefined ⇒ 原样返回）
 * @returns 展示用文本
 */
function formatValue(
  value: null | string | undefined,
  decimals: null | number | undefined,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (decimals === null || decimals === undefined) {
    return value;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    // 非数字（枚举/字符串属性）不做小数位处理
    return value;
  }
  return numeric.toFixed(decimals);
}

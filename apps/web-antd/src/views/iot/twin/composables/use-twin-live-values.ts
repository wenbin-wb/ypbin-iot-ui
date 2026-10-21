import type { TwinAlertCounts } from './use-twin-alert-counts';

import type { IotTwinApi } from '#/api/iot';

import { computed, onScopeDispose, ref, shallowRef } from 'vue';

import { getTwinRuntime } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../shared/use-iot-realtime';

/** 告警事件去抖窗口（毫秒）：一次告警风暴可能推几十个事件，逐条重拉会打爆接口。 */
const ALERT_RELOAD_DEBOUNCE_MS = 1200;

/**
 * 悬浮卡片的「逐属性实时值」来源（**不新增任何接口**）。
 *
 * ## 为什么不能直接用页面里已有的运行态
 *
 * 页面已有的两路数据**都不够**给卡片用：
 * 1. `runtime-store` 的 `onFlush` 只交出 `Map<pointId, AnchorRuntimeState>`，
 *    且**只含本帧变化的锚点**（节流设计，见 `runtime-store.ts`），
 *    根本没有「全部绑定属性的原值」；把它改成交出原值会破坏节流与既有测试。
 * 2. `useTwinRuntime().snapshot` 是 `ref`，但只在 `loadSnapshot` 时整体替换，
 *    **SSE 增量不会更新它** ⇒ 卡片会显示「快照那一刻」的值，看起来像坏了。
 *
 * 因此这里复用**同一份公开数据源**、但走一条**只读、不节流、不触发 3D 重绘**的旁路：
 * - 快照：`getTwinRuntime(sceneId)`（与 `useTwinRuntime` 同一个端点，只多一次 GET；
 *   进入场景时两次请求几乎同时发出，浏览器 HTTP 缓存与后端都承受得住）；
 * - 增量：`latest` / `device-status` / `alert` 事件直接写入普通 `Map`（**不触发响应式**），
 *   卡片打开/鼠标悬停时再读，避免「每个 SSE 事件都让整个页面重渲染」。
 *
 * ## 为什么 `valuesTick` 是一个自增计数器
 *
 * 卡片的 DOM 需要随实时值滚动更新（悬浮时看到的是「现在」的值）。若把整个值表做成
 * `reactive`，500 点位 × 每秒多条上报 ⇒ Vue 的依赖追踪本身就成为热点。
 * 用一个**节流到 200ms** 的计数器驱动卡片重渲染即可：人眼分辨不出 200ms 的差别，
 * 但主线程开销从「每条事件一次」降到「每秒最多 5 次」。
 */

/** 卡片实时值的节流窗口（毫秒）。 */
export const CARD_TICK_INTERVAL_MS = 200;

/** 一个点位的原始实时值。 */
interface PointValues {
  alertCount: number;
  /** 点位所属设备（SSE `latest` 事件按 deviceId 匹配，必须随值一起存）。 */
  deviceId: string;
  onlineStatus?: null | string;
  status?: null | number;
  values: Record<string, IotTwinApi.RuntimeValueResp>;
}

/** 卡片实时值域选项。 */
export interface TwinLiveValuesOptions {
  /**
   * 共享告警数域（**唯一数据源**）。
   *
   * 传入后卡片的告警数直接读它（与 KPI 条/树角标同一份数字），
   * 本域不再自己维护告警数，也就不会出现「三处三个数」。
   */
  alertCounts?: TwinAlertCounts;
}

/** 卡片实时值域。 */
export function useTwinLiveValues(options: TwinLiveValuesOptions = {}) {
  /** 点位 ID → 原始值（`shallowRef` + 整体替换：Map 内部变更不触发响应式）。 */
  const store = shallowRef(new Map<string, PointValues>());
  /** 节流后的变更计数器（卡片用它做 `:key` 或依赖收集）。 */
  const tick = ref(0);
  const error = ref('');

  const { onEvent } = useIotRealtime();

  let tickTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  /** 把变更标记为「需要通知 UI」，合并到下一次节流窗口。 */
  function markDirty(): void {
    dirty = true;
    if (tickTimer !== undefined) {
      return;
    }
    tickTimer = setTimeout(() => {
      tickTimer = undefined;
      if (dirty) {
        dirty = false;
        tick.value += 1;
      }
    }, CARD_TICK_INTERVAL_MS);
  }

  /**
   * 加载场景快照（进入场景/切场景时调用）。
   *
   * @param sceneId 场景 ID
   */
  async function load(sceneId: string): Promise<void> {
    if (!sceneId) {
      store.value = new Map();
      return;
    }
    try {
      const data = await getTwinRuntime(sceneId);
      const next = new Map<string, PointValues>();
      for (const point of data.points) {
        next.set(point.pointId, {
          alertCount: point.alertCount ?? 0,
          deviceId: String(point.deviceId),
          onlineStatus: point.onlineStatus,
          status: point.status,
          values: { ...point.values },
        });
      }
      store.value = next;
      error.value = '';
      markDirty();
      // 留痕：快照里的属性数 vs 真正有值的属性数（卡片「暂无上报」时据此区分
      // 「运行态没到」与「后端确实没上报」——两者 UI 都显示 --，但排查路径不同）
      if (next.size > 0) {
        let withValue = 0;
        for (const entry of next.values()) {
          for (const value of Object.values(entry.values)) {
            if (value?.value !== null && value?.value !== undefined) {
              withValue += 1;
            }
          }
        }
        // 用 console.warn（本仓 lint 只允许 warn/error）：这条是**排查线索**，
        // 「卡片全显示 --」时凭它区分「运行态没到」与「后端确实没上报」。
        console.warn(
          `[iot/twin] 卡片实时值快照：点位 ${next.size} 个，有值属性 ${withValue} 个`,
        );
      }
    } catch (loadError) {
      // 卡片是"锦上添花"的信息入口：快照失败不能让整页报错（页面另一路已有错误提示），
      // 但必须留痕，且卡片会显示 `--`——不能像"有数据"一样安静。
      error.value = extractErrorMessage(
        loadError,
        $t('page.iot.twin.runtimeLoadFailed'),
      );
      console.warn('[iot/twin] 卡片实时值快照加载失败：', loadError);
    }
  }

  let alertReloadTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAlertReload: (() => void) | undefined;

  // ---- SSE 增量：只改 Map，不发请求 ----
  onEvent('latest', (payload) => {
    const deviceId =
      payload.deviceId === null || payload.deviceId === undefined
        ? ''
        : String(payload.deviceId);
    const propertyId = payload.propertyId ?? '';
    if (!deviceId || !propertyId) {
      return;
    }
    let touched = false;
    for (const entry of store.value.values()) {
      // 点位与设备的对应关系由快照建立；这里只更新已存在的点位
      if (entry.deviceId !== deviceId) {
        continue;
      }
      const previous = entry.values[propertyId];
      const ts =
        payload.ts === null || payload.ts === undefined
          ? null
          : String(payload.ts);
      // 同 ts 不覆盖（SSE 可能乱序；旧值覆盖新值会让数字「跳回去」，与 runtime-store 同口径）
      if (previous?.ts && ts && Number(previous.ts) > Number(ts)) {
        continue;
      }
      entry.values = {
        ...entry.values,
        [propertyId]: {
          quality: payload.quality ?? null,
          stale: false,
          ts,
          value: payload.value ?? null,
        },
      };
      touched = true;
    }
    if (touched) {
      markDirty();
    }
  });

  onEvent('device-status', (payload) => {
    const rawIds: Array<null | number | string> = [];
    if (payload.deviceId !== null && payload.deviceId !== undefined) {
      rawIds.push(payload.deviceId);
    }
    for (const id of payload.deviceIds ?? []) {
      rawIds.push(id);
    }
    if (rawIds.length === 0) {
      return;
    }
    const ids = new Set(rawIds.map((id) => String(id ?? '')));
    let touched = false;
    for (const entry of store.value.values()) {
      if (!ids.has(entry.deviceId)) {
        continue;
      }
      // `status` 是数字时是启停位；字符串时是在线状态（两种事件共用事件名）
      if (typeof payload.status === 'number') {
        entry.status = payload.status;
      } else if (typeof payload.status === 'string') {
        entry.onlineStatus = payload.status;
      }
      touched = true;
    }
    if (touched) {
      markDirty();
    }
  });

  onEvent('alert', () => {
    // 告警事件只说明「告警集合变了」，不带活动数量 ⇒ 与主运行态同口径：
    // 去抖后由页面调用 `applyAlertCounts` 写入重拉结果（不在卡片层自己猜数量）。
    if (alertReloadTimer !== undefined) {
      return;
    }
    alertReloadTimer = setTimeout(() => {
      alertReloadTimer = undefined;
      pendingAlertReload?.();
    }, ALERT_RELOAD_DEBOUNCE_MS);
  });

  /**
   * 注册「告警数变化后重拉」的回调（页面把重拉告警数的逻辑接进来）。
   *
   * @param reload 回调
   */
  function onAlertReload(reload: () => void): void {
    pendingAlertReload = reload;
  }

  /**
   * 合并告警数（页面重拉后调用）。
   *
   * **不传共享域时**才用（单测场景）；页面里一律走 `useTwinAlertCounts`，
   * 这样告警数只有一个来源。
   *
   * @param counts 设备 ID → 活动告警数
   */
  function applyAlertCounts(counts: Map<string, number>): void {
    let touched = false;
    for (const entry of store.value.values()) {
      const next = counts.get(entry.deviceId) ?? 0;
      if (entry.alertCount !== next) {
        entry.alertCount = next;
        touched = true;
      }
    }
    if (touched) {
      markDirty();
    }
  }

  onScopeDispose(() => {
    if (tickTimer !== undefined) {
      clearTimeout(tickTimer);
      tickTimer = undefined;
    }
    if (alertReloadTimer !== undefined) {
      clearTimeout(alertReloadTimer);
      alertReloadTimer = undefined;
    }
  });

  /**
   * 取某点位的原始值（**非响应式读取**：调用方需自己依赖 `tick`）。
   *
   * @param pointId 点位 ID
   * @returns 原始值（没有快照时为 undefined）
   */
  function readPoint(pointId: string): PointValues | undefined {
    const entry = store.value.get(pointId);
    if (!entry) {
      return undefined;
    }
    const shared = options.alertCounts;
    if (!shared) {
      return entry;
    }
    // 共享域的数字是权威：本域快照里的 alertCount 可能比它旧
    return { ...entry, alertCount: shared.count(entry.deviceId) };
  }

  const loaded = computed(() => store.value.size > 0);

  return {
    applyAlertCounts,
    error,
    load,
    loaded,
    onAlertReload,
    readPoint,
    tick,
  };
}

/**
 * 旁路值表的类型（供页面在卡片里组装）。
 *
 * 与 `TwinRuntimeStore` 的区别：这里保留**全部属性原值**、不做节流、不驱动 3D。
 */
export type TwinLiveValues = ReturnType<typeof useTwinLiveValues>;

/**
 * 页面里「同一份运行态喂给两处」的适配说明（防误用）。
 *
 * 3D 锚点 → `TwinRuntimeStore`（节流、只交变化项、驱动重绘）；
 * 悬浮卡片 → {@link useTwinLiveValues}（全量原值、不节流、按需读）。
 * **两者都来自同一组接口**（快照 + SSE），因此显示的值必然一致；
 * 不一致只可能来自「其中一路没接 SSE」——所以两路都必须接。
 */
export const LIVE_VALUES_DOC = {
  anchorStates: 'TwinRuntimeStore.onFlush',
  cardValues: 'useTwinLiveValues.readPoint',
} as const satisfies Record<string, string>;

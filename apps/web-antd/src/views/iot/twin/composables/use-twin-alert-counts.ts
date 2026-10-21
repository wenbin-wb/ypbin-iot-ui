import { onScopeDispose, ref } from 'vue';

import { getActiveAlertCounts } from '#/api/iot';

/**
 * 活动告警数（**单一数据源**：KPI 条 / 场景树角标 / 悬浮卡片共用）。
 *
 * ## 为什么必须是「一份」而不是各算各的
 *
 * 同一个数字在页面上出现三次（KPI「告警 1」、树角标「1 条告警」、卡片「1 条活动告警」）。
 * 若三者各拉各的（或其中一个用快照、另一个用 SSE 推算），会在告警发生/恢复的瞬间
 * 出现「KPI 说 1、卡片说 0」—— 用户第一反应是「这系统坏了」，而不是「数据在更新」。
 *
 * ## 为什么不用 SSE `alert` 事件里的数量
 *
 * 后端 `alert` 事件负载只说明「哪些告警变了」（`IotRealtimeAlertPayload` 不含
 * 单设备活动告警总数），**数量必须重拉** `/iot/alerts/active-counts`。
 * 因此这里采用「事件 → 去抖 → 重拉 → 广播」，与仪表盘 `useDashboardRealtime` 同口径。
 *
 * ## 去抖为什么在域内而不是各调用方
 *
 * 告警风暴时 1 秒内可能推几十条事件。去抖放在域内后，全页**任何**告警事件
 * （主运行态、卡片旁路）都只会产生**一次**请求。
 */

/** 告警事件去抖窗口（毫秒）：一次告警风暴可能推几十个事件，逐条重拉会打爆接口。 */
export const ALERT_REFRESH_DEBOUNCE_MS = 1200;

/** 共享告警数域。 */
export function useTwinAlertCounts() {
  /** 设备 ID → 活动告警数。 */
  const counts = ref<Map<string, number>>(new Map());
  /** 本场景关心的设备（告警事件的设备上下文匹配依据）。 */
  let deviceIds: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;

  /**
   * 设置本场景的设备集合（进入场景/点位变化时调用）。
   *
   * @param ids 设备 ID 列表
   */
  function setDevices(ids: string[]): void {
    deviceIds = [...new Set(ids.map(String))];
  }

  /**
   * 立即重拉（自动去重：正在请求中时只记一个「待重拉」标记，结束后补一次）。
   */
  async function refreshNow(): Promise<void> {
    if (deviceIds.length === 0) {
      return;
    }
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const data = await getActiveAlertCounts(deviceIds);
      const next = new Map<string, number>();
      for (const [deviceId, value] of Object.entries(data)) {
        next.set(String(deviceId), Number(value) || 0);
      }
      counts.value = next;
    } catch (error) {
      // 告警数刷新失败不能让孪生页报错（设备状态仍在正常显示），但必须留痕——
      // 静默失败会让 KPI 长期停在旧数字上而无人察觉。
      console.warn('[iot/twin] 活动告警数刷新失败（设备状态不受影响）：', error);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        void refreshNow();
      }
    }
  }

  /** 去抖后重拉（告警事件到达时调用）。 */
  function refresh(): void {
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void refreshNow();
    }, ALERT_REFRESH_DEBOUNCE_MS);
  }

  /**
   * 取某设备的告警数（未加载过的设备返回 0：调用方通常还有其它「未加载」信号）。
   *
   * @param deviceId 设备 ID
   * @returns 活动告警数
   */
  function countOf(deviceId: string): number {
    return counts.value.get(String(deviceId)) ?? 0;
  }

  onScopeDispose(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  return {
    count: countOf,
    counts,
    refresh,
    refreshNow,
    setDevices,
  };
}

/** 共享告警数域类型（供页面与 composable 之间传参）。 */
export type TwinAlertCounts = ReturnType<typeof useTwinAlertCounts>;

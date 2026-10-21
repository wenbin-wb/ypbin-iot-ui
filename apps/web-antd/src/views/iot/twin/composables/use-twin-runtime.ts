import type { Ref } from 'vue';

import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState } from '#/three/twin/types';

import { onScopeDispose, ref } from 'vue';

import { getActiveAlertCounts, getTwinRuntime } from '#/api/iot';
import { $t } from '#/locales';
import { TwinRuntimeStore } from '#/three/twin/runtime-store';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../shared/use-iot-realtime';

/** 告警事件去抖窗口（毫秒）：一次告警风暴可能推几十个事件，逐条重拉会打爆接口。 */
const ALERT_RELOAD_DEBOUNCE_MS = 1200;

/**
 * 运行态数据域：快照 + SSE 增量合流。
 *
 * ## 三条接线
 *
 * 1. `latest` 事件 ⇒ 直接写入 store（rAF 合并后每帧提交一次给锚点层）；
 * 2. `device-status` 事件 ⇒ 直接写入 store；
 * 3. `alert` 事件 ⇒ **不猜数量**，去抖后重拉告警数（与仪表盘
 *    `useDashboardRealtime` 同口径）：告警事件的负载只说明「哪些告警变了」，
 *    不携带「本设备活动告警总数」。
 *
 * ## 失败语义
 *
 * 快照加载失败 ⇒ `error` 非空，页面渲染错误态 + 重试；**不**伪造空数据。
 * 实时连接失败 ⇒ `realtimeState/error/authError` 原样透出，页面渲染可见提示。
 */
export function useTwinRuntime(options: {
  /** 每帧提交的锚点状态（由页面转给画布）。 */
  onFlush: (states: Map<string, AnchorRuntimeState>) => void;
}) {
  const { authError, error: realtimeError, onEvent, state } = useIotRealtime();
  const snapshot = ref<IotTwinApi.RuntimeResp | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 最近一次快照的本地时刻（用于「数据是几分钟前的」提示）。 */
  const loadedAt = ref<Date | null>(null);

  const store = new TwinRuntimeStore({ onFlush: options.onFlush });
  let alertReloadTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 快照请求世代号（竞态守卫，工单 #132）。
   *
   * 快速连切场景时，先发的「大场景」快照可能后到，把新场景的运行态覆盖掉 ⇒
   * 3D 锚点会用旧场景的值渲染在新模型上。`await` 回来后比对世代，过期即丢弃。
   */
  let snapshotGeneration = 0;

  /**
   * 加载场景快照（进入场景、告警变化、手动刷新时调用）。
   *
   * @param sceneId 场景 ID
   * @param bindings 点位 → 绑定（决定主展示属性与单位/精度）
   */
  async function loadSnapshot(
    sceneId: string,
    bindings: Map<string, IotTwinApi.BindingResp[]>,
  ): Promise<void> {
    const generation = ++snapshotGeneration;
    loading.value = true;
    try {
      const data = await getTwinRuntime(sceneId);
      // 过期响应：期间已切到别的场景 ⇒ 丢弃，否则旧场景的值会渲染到新模型上
      if (generation !== snapshotGeneration) {
        return;
      }
      snapshot.value = data;
      store.replaceSnapshot(data, bindings);
      loadedAt.value = new Date();
      error.value = '';
    } catch (loadError) {
      if (generation !== snapshotGeneration) {
        return;
      }
      error.value = extractErrorMessage(
        loadError,
        $t('page.iot.twin.runtimeLoadFailed'),
      );
      throw loadError;
    } finally {
      if (generation === snapshotGeneration) {
        loading.value = false;
      }
    }
  }

  /** 重拉活动告警数并合并进 store（`alert` 事件的落点）。 */
  async function refreshAlerts(): Promise<void> {
    const deviceIds = [
      ...new Set((snapshot.value?.points ?? []).map((point) => point.deviceId)),
    ];
    if (deviceIds.length === 0) {
      return;
    }
    try {
      const counts = await getActiveAlertCounts(deviceIds);
      const normalized = new Map<string, number>();
      for (const [deviceId, value] of Object.entries(counts)) {
        // 后端 Long 可能是字符串形态；告警数是小整数，Number() 在此安全
        normalized.set(deviceId, Number(value) || 0);
      }
      store.applyAlertCounts(normalized);
    } catch (alertError) {
      // 告警数刷新失败不应让整个孪生页报错（设备状态仍在正常显示）；
      // 但必须留痕并给出可见提示，不能静默。
      console.warn('[iot/twin] 活动告警数刷新失败：', alertError);
      error.value = extractErrorMessage(
        alertError,
        $t('page.iot.twin.alertCountFailed'),
      );
    }
  }

  // ---- SSE 接线 ----
  onEvent('latest', (payload) => {
    store.applyLatestEvent(payload);
  });
  onEvent('device-status', (payload) => {
    store.applyDeviceStatusEvent(
      payload as {
        deviceId?: null | number | string;
        deviceIds?: Array<number | string>;
        status?: null | number | string;
      },
    );
  });
  onEvent('alert', () => {
    if (alertReloadTimer !== undefined) {
      return;
    }
    alertReloadTimer = setTimeout(() => {
      alertReloadTimer = undefined;
      void refreshAlerts();
    }, ALERT_RELOAD_DEBOUNCE_MS);
  });

  onScopeDispose(() => {
    if (alertReloadTimer !== undefined) {
      clearTimeout(alertReloadTimer);
      alertReloadTimer = undefined;
    }
    store.dispose();
  });

  return {
    authError,
    error,
    loadedAt,
    loading,
    loadSnapshot,
    realtimeError,
    realtimeState: state as Ref<string>,
    refreshAlerts,
    snapshot,
  };
}

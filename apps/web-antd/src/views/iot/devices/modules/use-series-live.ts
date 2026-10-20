/**
 * 历史曲线「实时跟随 + 自动刷新」组合式（审查 P2-6 拆分之一）。
 *
 * 从 `series.vue` 抽出的两块**时序型**逻辑（它们最容易泄漏定时器/订阅，也最容易写错）：
 * 1. **实时跟随**：订阅 SSE `latest`，把匹配当前设备/点位的新点追加进内存结果，并计数/提示；
 * 2. **自动刷新**：按上次查询条件周期重放（滑动窗口按当前时刻重算，自定义区间保持固定）。
 *
 * 为什么放一起：两者互斥（开实时跟随会关自动刷新，否则 30s 一次全量重查会把刚跟随的点整批覆盖），
 * 生命周期也一致（关抽屉/卸载都要一起停）。
 *
 * 不依赖 vxe/vue 组件：宿主注入设备 id、结果容器、上次查询条件与「重放一次查询」的函数，
 * 因此可以在 `series-live.test.ts` 里用 mock 的请求层与 SSE 完整驱动。
 */
import type { Ref } from 'vue';

import type {
  SeriesQueryResult,
  SeriesRangeMode,
  SeriesResolvedRange,
} from './series-utils';

import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { $t } from '#/locales';

import { useIotRealtime } from '../../shared/use-iot-realtime';
import {
  appendLiveSeriesPoint,
  IOT_SERIES_AUTO_REFRESH_MS,
  IOT_SERIES_LIVE_MAX_POINTS,
  resolveSeriesRange,
} from './series-utils';

export interface UseSeriesLiveOptions {
  /** 当前设备 id（`latest` 事件按设备匹配）。 */
  getDeviceId: () => string;
  /** 是否有曲线：没出图时不订阅，曲线消失时自动关闭跟随。 */
  hasChart: Ref<boolean>;
  /** 当前查询结果（实时点直接追加到这里，与查询共用同一份数据源）。 */
  results: Ref<SeriesQueryResult[]>;
  /** 自动刷新要重放的上次查询条件（不是「当前编辑中的条件」）。 */
  usedPoints: Ref<string[]>;
  usedMode: Ref<SeriesRangeMode>;
  usedCustom: Ref<{ from?: number; to?: number }>;
  usedLimit: Ref<number>;
  /** 查询是否在途（在途时自动刷新跳过本轮，避免请求叠罗汉）。 */
  isLoading: () => boolean;
  /** 按给定条件重放一次查询（自动刷新用）。 */
  runQuery: (
    targets: string[],
    range: SeriesResolvedRange,
    limit: number,
  ) => Promise<void>;
}

export function useSeriesLive(options: UseSeriesLiveOptions) {
  // ---------------------------------------------------------------- 自动刷新

  /** 自动刷新开关（模板 `v-model:checked`）。 */
  const autoRefresh = ref(false);

  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  /** 停掉周期重查（关抽屉/关开关/卸载时调用；重复调用安全）。 */
  function stopAutoRefresh(): void {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  /** 按当前开关状态重启周期重查（查询成功后调用：让「上次条件」成为最新一次）。 */
  function restartAutoRefresh(): void {
    stopAutoRefresh();
    if (!autoRefresh.value) {
      return;
    }
    refreshTimer = setInterval(() => {
      if (options.isLoading() || options.usedPoints.value.length === 0) {
        return;
      }
      // 重放「上次查询」的条件（而不是当前编辑中的条件）：用户改到一半不该被周期请求打断；
      // 快捷档位按当前时刻重算窗口（滑动），自定义档位保持固定区间
      const range = resolveSeriesRange(
        options.usedMode.value,
        options.usedCustom.value,
        Date.now(),
      );
      void options.runQuery(
        [...options.usedPoints.value],
        range,
        options.usedLimit.value,
      );
    }, IOT_SERIES_AUTO_REFRESH_MS);
  }

  watch(autoRefresh, (enabled) => {
    if (enabled) {
      restartAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  });

  // ---------------------------------------------------------------- 实时跟随

  /**
   * 「实时跟随」：订阅 SSE `latest`，把匹配当前设备/点位的新点**追加进内存 results**。
   *
   * 三条纪律：
   * 1. 只在已出图时可用（没曲线时打开只会订阅一个永远匹配不到的流）；
   * 2. 事件必须设备与点位都匹配才追加；不匹配的静默忽略（不是本曲线的数据）；
   * 3. 关闭开关 / 关抽屉 / 换设备 / 组件卸载都退订；重查时清空计数（内存点已被新结果替换）。
   *
   * 质量口径：非 good 的点**照常追加**（与历史曲线一致：数值照画、质量码在明细表可见），
   * 同时计数并给出可见提示，绝不把它洗成 good；时间戳重复/非法或该点位查询失败的点忽略并计数。
   */
  const liveFollow = ref(false);
  const liveFollowedCount = ref(0);
  const liveDroppedCount = ref(0);
  const liveNonGoodCount = ref(0);

  const {
    error: realtimeError,
    onEvent,
    state: realtimeState,
  } = useIotRealtime();

  /** 当前订阅的退订函数（未订阅时为 undefined）。 */
  let liveUnsubscribe: (() => void) | undefined;

  /** 实时状态 Tag：未开启 = 已关闭；开启后按 SSE 连接状态显示。 */
  const liveState = computed<{ color: string; text: string }>(() => {
    if (!liveFollow.value) {
      return { color: 'default', text: $t('page.iot.series.liveOff') };
    }
    switch (realtimeState.value) {
      case 'connecting': {
        return {
          color: 'processing',
          text: $t('page.iot.series.liveConnecting'),
        };
      }
      case 'live': {
        return { color: 'success', text: $t('page.iot.series.liveActive') };
      }
      case 'reconnecting': {
        return {
          color: 'warning',
          text: $t('page.iot.series.liveReconnecting'),
        };
      }
      default: {
        return { color: 'default', text: $t('page.iot.series.liveOff') };
      }
    }
  });

  /**
   * 清空实时计数。
   *
   * 重查时必须调用：`results` 被整批替换，上一轮内存里跟随的点已不存在，
   * 继续累积计数就是**虚报**（页面上写着「已跟随 12 点」而曲线只有 5 点）。
   */
  function resetLiveCounters(): void {
    liveFollowedCount.value = 0;
    liveDroppedCount.value = 0;
    liveNonGoodCount.value = 0;
  }

  function startLiveFollow(): void {
    if (liveUnsubscribe !== undefined) {
      return;
    }
    liveUnsubscribe = onEvent('latest', onLatestEvent);
  }

  function stopLiveFollow(): void {
    liveUnsubscribe?.();
    liveUnsubscribe = undefined;
  }

  /** 关闭跟随并清空计数（关抽屉 / 换设备 / 卸载时调用）。 */
  function resetLiveFollow(): void {
    stopLiveFollow();
    liveFollow.value = false;
    resetLiveCounters();
  }

  /** `latest` 事件：设备 + 点位双匹配才追加；质量/时间戳规则见 {@link appendLiveSeriesPoint}。 */
  function onLatestEvent(payload: IotRealtimeLatestPayload): void {
    if (!liveFollow.value || !options.hasChart.value) {
      return;
    }
    const eventDeviceId =
      payload.deviceId === null || payload.deviceId === undefined
        ? ''
        : String(payload.deviceId).trim();
    // 其它设备的事件不属于本曲线：静默忽略（不计数，计数只统计「本设备但追加失败」的）
    if (eventDeviceId === '' || eventDeviceId !== options.getDeviceId()) {
      return;
    }
    const propertyId = String(payload.propertyId ?? '').trim();
    if (propertyId === '') {
      return;
    }
    const outcome = appendLiveSeriesPoint(
      options.results.value,
      {
        propertyId,
        quality: payload.quality ?? null,
        ts: payload.ts ?? null,
        value: payload.value ?? null,
      },
      IOT_SERIES_LIVE_MAX_POINTS,
    );
    if (!outcome.matched) {
      // 事件点位不在本次查询内：与本曲线无关，静默忽略
      return;
    }
    if (!outcome.appended) {
      liveDroppedCount.value += 1;
      return;
    }
    options.results.value = outcome.results;
    liveFollowedCount.value += 1;
    if (!outcome.good) {
      liveNonGoodCount.value += 1;
    }
  }

  watch(liveFollow, (enabled) => {
    if (!enabled) {
      stopLiveFollow();
      return;
    }
    // 实时跟随已在内存追加，关掉周期全量重查：避免 30s 一次 IoTDB 查询把刚跟随的点整批覆盖
    autoRefresh.value = false;
    startLiveFollow();
  });

  // 曲线消失（重查为空 / 失败 / 点位全被清掉）就自动关闭跟随，避免「开着却永远追加不进」
  watch(options.hasChart, (value) => {
    if (!value && liveFollow.value) {
      liveFollow.value = false;
    }
  });

  onBeforeUnmount(() => {
    stopAutoRefresh();
    stopLiveFollow();
  });

  return {
    autoRefresh,
    liveDroppedCount,
    liveFollow,
    liveFollowedCount,
    liveNonGoodCount,
    liveState,
    realtimeError,
    realtimeState,
    resetLiveCounters,
    resetLiveFollow,
    restartAutoRefresh,
    stopAutoRefresh,
  };
}

import type { Ref } from 'vue';

import type { BoardConfig, BoardWidget, BoardWidgetRuntime } from './board-utils';

import type { IotDeviceApi } from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onBeforeUnmount, ref } from 'vue';

import { $t } from '#/locales';

import { useIotRealtime } from '../../../iot/shared/use-iot-realtime';
import { niceGaugeMax } from './board-charts';
import {
  appendBoardPoint,
  boardLatestMatchesWidget,
  createBoardWidgetRuntime,
  IOT_BOARD_LINE_MAX_POINTS,
  toBoardNumeric,
} from './board-utils';
import { useBoardDevices } from './use-board-devices';
import {
  appendMultiSeriesPoint,
  mergeLatestValue,
  useBoardSeries,
} from './use-board-series';

/**
 * 看板的**运行时编排**：实时 `latest` 分发、运行期对象生命周期（重置/删除）、整板重载。
 *
 * 数据形状与失败降级在 `use-board-series.ts`（历史序列/最新值合并/折线追加）、
 * 设备选项在 `use-board-devices.ts`；这里只决定「事件落到哪个组件」与「何时重载」。
 *
 * 实时口径：latest 事件设备 + 点位（多点位组件按点位集合）匹配才更新；折线在内存尾部追加
 * （上限 200）；断线只停更新，不把旧值清成空。
 *
 * ⚠️ `useIotRealtime` 必须用**同一个相对路径**引入（`../../../iot/shared/use-iot-realtime`）：
 * `board.test.ts` 按该模块 id `vi.mock`，换 `#/views/...` 别名会让 mock 失效（档案 §2.3）。
 */
export function useBoardRuntime(options: { config: Ref<BoardConfig> }) {
  const { config } = options;

  /** 未创建运行期的占位对象（避免模板里反复 new 触发子组件 watch）。 */
  const EMPTY_RUNTIME = createBoardWidgetRuntime();

  const loading = ref(false);
  const runtime = ref<Record<string, BoardWidgetRuntime>>({});

  /** 设备选项域（展示增强，失败不阻塞看板）。 */
  const devices = useBoardDevices();

  const {
    error: realtimeError,
    onEvent,
    state: realtimeState,
  } = useIotRealtime();

  let unsubscribeLatest: (() => void) | undefined;

  const realtimeTag = computed(() => {
    if (realtimeState.value === 'live') {
      return { color: 'success', text: $t('page.iot.board.realtime') };
    }
    if (realtimeState.value === 'reconnecting') {
      return {
        color: 'warning',
        text: $t('page.iot.board.realtimeReconnecting'),
      };
    }
    return { color: 'default', text: $t('page.iot.board.realtimeOff') };
  });

  function runtimeFor(widget: BoardWidget): BoardWidgetRuntime {
    return runtime.value[widget.id] ?? EMPTY_RUNTIME;
  }

  function patchRuntime(
    id: string,
    updater: (current: BoardWidgetRuntime) => BoardWidgetRuntime,
  ): void {
    const current = runtime.value[id] ?? createBoardWidgetRuntime();
    runtime.value = { ...runtime.value, [id]: updater(current) };
  }

  /** 序列域（历史拉取/最新值合并/多序列追加/失败降级）；写回统一走 `patchRuntime`。 */
  const series = useBoardSeries({ patchRuntime });

  /** 重置某个组件的运行期（配置被替换后先清数据，再由 `loadWidgetRuntime` 拉新值）。 */
  function resetWidgetRuntime(id: string): void {
    patchRuntime(id, () => createBoardWidgetRuntime());
  }

  /** 删除组件的运行期（配置里已经没有它了）。 */
  function dropWidgetRuntime(id: string): void {
    runtime.value = Object.fromEntries(
      Object.entries(runtime.value).filter(([key]) => key !== id),
    );
  }

  function startRealtime(): void {
    if (unsubscribeLatest !== undefined) {
      return;
    }
    unsubscribeLatest = onEvent('latest', onLatestEvent);
  }

  function stopRealtime(): void {
    unsubscribeLatest?.();
    unsubscribeLatest = undefined;
  }

  /** 实时事件：设备 + 点位集合匹配才更新；折线尾部追加（ts 重复/非法忽略，不伪造点）。 */
  function onLatestEvent(payload: IotRealtimeLatestPayload): void {
    const propertyId = String(payload.propertyId ?? '').trim();
    if (propertyId === '') {
      return;
    }
    const ts = Number(payload.ts);
    const value = payload.value ?? null;
    const quality = payload.quality ?? null;
    for (const widget of config.value.widgets) {
      if (!boardLatestMatchesWidget(widget, payload)) {
        continue;
      }
      const current = runtimeFor(widget);
      let next: BoardWidgetRuntime = {
        ...current,
        error: '',
        latest: {
          propertyId,
          quality,
          ts: Number.isFinite(ts) ? ts : undefined,
          value,
        },
        latestList: mergeLatestValue(current.latestList, {
          propertyId,
          quality,
          ts: Number.isFinite(ts) ? ts : undefined,
          value,
        }),
        loaded: true,
        liveCount: current.liveCount + 1,
      };
      if (widget.type === 'line') {
        const outcome = appendBoardPoint(
          current.points,
          { quality, ts: payload.ts ?? null, value },
          IOT_BOARD_LINE_MAX_POINTS,
        );
        if (outcome.appended) {
          next = { ...next, points: outcome.points, seriesLoaded: true };
        }
      }
      if (widget.type === 'multi-line') {
        next = {
          ...next,
          multiSeries: appendMultiSeriesPoint(current.multiSeries, propertyId, {
            quality,
            ts: payload.ts ?? null,
            value,
          }),
          seriesLoaded: true,
        };
      }
      if (widget.type === 'gauge') {
        next = {
          ...next,
          gaugeMax: Math.max(
            current.gaugeMax,
            niceGaugeMax(toBoardNumeric(value)),
          ),
        };
      }
      runtime.value = { ...runtime.value, [widget.id]: next };
    }
  }

  /** 重载看板：设备选项（展示增强，失败不阻塞）+ 每个组件的初始数据。 */
  async function loadAll(): Promise<void> {
    loading.value = true;
    series.resetSeriesWarning();
    const widgets = config.value.widgets;
    const fresh: Record<string, BoardWidgetRuntime> = {};
    for (const widget of widgets) {
      fresh[widget.id] = createBoardWidgetRuntime();
    }
    runtime.value = fresh;
    await devices.loadDevices();
    const latestCache = new Map<
      string,
      Promise<IotDeviceApi.LatestValueResp[]>
    >();
    await Promise.all(
      widgets.map((widget) => series.loadWidgetRuntime(widget, latestCache)),
    );
    loading.value = false;
  }

  onBeforeUnmount(stopRealtime);

  return {
    deviceById: devices.deviceById,
    deviceOptionsError: devices.deviceOptionsError,
    dropWidgetRuntime,
    loadAll,
    loadWidgetRuntime: series.loadWidgetRuntime,
    loading,
    realtimeError,
    realtimeState,
    realtimeTag,
    resetWidgetRuntime,
    runtimeFor,
    seriesWarning: series.seriesWarning,
    startRealtime,
    stopRealtime,
  };
}

export type BoardRuntimeApi = ReturnType<typeof useBoardRuntime>;

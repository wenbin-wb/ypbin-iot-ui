import type { Ref } from 'vue';

import type { BoardConfig, BoardWidget, BoardWidgetRuntime } from './board-utils';

import type { IotDeviceApi, IotSeriesApi } from '#/api/iot';
import type { IotRealtimeLatestPayload } from '#/api/iot/realtime';

import { computed, onBeforeUnmount, ref } from 'vue';

import { getDeviceLatest, getDeviceOptions } from '#/api/iot/device';
import { getDeviceSeries } from '#/api/iot/series';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useIotRealtime } from '../../../iot/shared/use-iot-realtime';
import { niceGaugeMax } from './board-charts';
import {
  appendBoardPoint,
  boardLatestMatchesWidget,
  boardWidgetPropertyIds,
  createBoardWidgetRuntime,
  IOT_BOARD_LINE_MAX_POINTS,
  resolveBoardWindowMs,
  toBoardNumeric,
} from './board-utils';

/**
 * 看板的**运行时数据域**：设备选项、每个组件的初始数据（最新值 + 历史序列）、实时 `latest` 合并、
 * 折线尾部追加、连接状态标签（从 board-drawer.vue 抽出，逻辑逐行搬移，不改语义）。
 *
 * 实时口径：latest 事件设备 + 点位（多点位组件按点位集合）匹配才更新对应组件；折线在内存尾部
 * 追加（上限 200）；断线只停更新，不把旧值清成空。
 *
 * ⚠️ `useIotRealtime` 必须用**同一个相对路径**引入（`../../../iot/shared/use-iot-realtime`）：
 * `board.test.ts` 是按该模块 id 做 `vi.mock` 的，换成 `#/views/...` 别名会让 mock 失效、
 * 用例退化成默认实现（本仓档案 §2.3 记录过这个陷阱）。
 *
 * 为什么单独成 composable：这里是「后端数据 → 渲染模型」的全部映射，且失败必须落到
 * `runtime.error` 由卡片原样展示；独立后卡片数据口径只在这一处定义。
 */
export function useBoardRuntime(options: { config: Ref<BoardConfig> }) {
  const { config } = options;

  /** 未创建运行期的占位对象（避免模板里反复 new 触发子组件 watch）。 */
  const EMPTY_RUNTIME = createBoardWidgetRuntime();

  const deviceOptions = ref<IotDeviceApi.DeviceResp[]>([]);
  const deviceOptionsError = ref('');
  const loading = ref(false);
  const runtime = ref<Record<string, BoardWidgetRuntime>>({});
  const seriesWarning = ref('');

  const deviceById = computed(
    () => new Map(deviceOptions.value.map((item) => [String(item.id), item])),
  );

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

  /** 整设备最新值快照里替换/追加某点位（表格卡与开关卡共用）。 */
  function mergeLatestValue(
    list: IotDeviceApi.LatestValueResp[],
    item: IotDeviceApi.LatestValueResp,
  ): IotDeviceApi.LatestValueResp[] {
    const index = list.findIndex((row) => row.propertyId === item.propertyId);
    if (index === -1) {
      return [...list, item];
    }
    return list.map((row, current) => (current === index ? item : row));
  }

  /** 多序列折线的实时追加：按点位找到对应序列，找不到时忽略（配置与点位对不上）。 */
  function appendMultiSeriesPoint(
    series: BoardWidgetRuntime['multiSeries'],
    propertyId: string,
    point: {
      quality: null | string;
      ts: null | number | string;
      value: null | string;
    },
  ) {
    let matched = false;
    const next = series.map((item) => {
      if (item.propertyId !== propertyId) {
        return item;
      }
      const outcome = appendBoardPoint(
        item.points,
        point,
        IOT_BOARD_LINE_MAX_POINTS,
      );
      if (!outcome.appended) {
        return item;
      }
      matched = true;
      return { ...item, points: outcome.points };
    });
    return matched ? next : series;
  }

  /** 单个组件的初始数据（最新值 + 历史序列）；失败原因进 runtime.error，卡片原样展示。 */
  async function loadWidgetRuntime(
    widget: BoardWidget,
    latestCache: Map<string, Promise<IotDeviceApi.LatestValueResp[]>>,
  ): Promise<void> {
    try {
      let latestPromise = latestCache.get(widget.deviceId);
      if (!latestPromise) {
        latestPromise = getDeviceLatest(widget.deviceId);
        latestCache.set(widget.deviceId, latestPromise);
      }
      const latestList = (await latestPromise) ?? [];
      const properties = boardWidgetPropertyIds(widget);
      const found =
        latestList.find((item) => item.propertyId === widget.propertyId) ??
        null;
      patchRuntime(widget.id, (current) => ({
        ...current,
        error: '',
        gaugeMax: Math.max(
          current.gaugeMax,
          niceGaugeMax(toBoardNumeric(found?.value ?? null)),
        ),
        latest: found,
        latestList,
        loaded: true,
      }));
      if (widget.type !== 'line' && widget.type !== 'multi-line') {
        patchRuntime(widget.id, (current) => ({
          ...current,
          seriesLoaded: true,
        }));
        return;
      }
      const points = await loadSeries(
        widget.deviceId,
        properties,
        resolveBoardWindowMs(widget),
      );
      if (widget.type === 'line') {
        patchRuntime(widget.id, (current) => ({
          ...current,
          points: points.get(properties[0] ?? '') ?? [],
          seriesLoaded: true,
        }));
        return;
      }
      patchRuntime(widget.id, (current) => ({
        ...current,
        multiSeries: properties.map((propertyId) => ({
          points: points.get(propertyId) ?? [],
          propertyId,
        })),
        seriesLoaded: true,
      }));
    } catch (error) {
      patchRuntime(widget.id, (current) => ({
        ...current,
        error: extractErrorMessage(error, $t('page.iot.board.dataLoadFailed')),
        loaded: true,
        seriesLoaded: true,
      }));
    }
  }

  /** 拉多个点位的历史：单个点位失败**不连坐**，该序列留空并带上原因到 runtime.error。 */
  async function loadSeries(
    deviceId: string,
    properties: string[],
    windowMs: number,
  ): Promise<Map<string, IotSeriesApi.TimeSeriesPointResp[]>> {
    const now = Date.now();
    const result = new Map<string, IotSeriesApi.TimeSeriesPointResp[]>();
    const settled = await Promise.allSettled(
      properties.map(async (propertyId) => {
        const points = await getDeviceSeries(deviceId, {
          from: now - windowMs,
          limit: IOT_BOARD_LINE_MAX_POINTS,
          propertyId,
          to: now,
        });
        return { points: points ?? [], propertyId };
      }),
    );
    let firstError = '';
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        result.set(item.value.propertyId, item.value.points);
      } else if (firstError === '') {
        firstError = extractErrorMessage(
          item.reason,
          $t('page.iot.board.dataLoadFailed'),
        );
      }
    }
    if (firstError !== '' && result.size === 0) {
      throw new Error(firstError);
    }
    if (firstError !== '') {
      // 部分序列失败：不静默——在抽屉顶部给出原因（成功序列照常画）
      seriesWarning.value = $t('page.iot.board.seriesPartialFailed', [
        firstError,
      ]);
    }
    return result;
  }

  /** 重载看板：设备选项（展示增强，失败不阻塞）+ 每个组件的初始数据。 */
  async function loadAll(): Promise<void> {
    loading.value = true;
    deviceOptionsError.value = '';
    seriesWarning.value = '';
    const widgets = config.value.widgets;
    const fresh: Record<string, BoardWidgetRuntime> = {};
    for (const widget of widgets) {
      fresh[widget.id] = createBoardWidgetRuntime();
    }
    runtime.value = fresh;
    try {
      deviceOptions.value = (await getDeviceOptions()) ?? [];
    } catch (error) {
      deviceOptions.value = [];
      deviceOptionsError.value = extractErrorMessage(
        error,
        $t('page.iot.board.devicesLoadFailed'),
      );
    }
    const latestCache = new Map<
      string,
      Promise<IotDeviceApi.LatestValueResp[]>
    >();
    await Promise.all(
      widgets.map((widget) => loadWidgetRuntime(widget, latestCache)),
    );
    loading.value = false;
  }

  onBeforeUnmount(stopRealtime);

  return {
    deviceById,
    deviceOptionsError,
    dropWidgetRuntime,
    loadAll,
    loadWidgetRuntime,
    loading,
    realtimeError,
    realtimeState,
    realtimeTag,
    resetWidgetRuntime,
    runtimeFor,
    seriesWarning,
    startRealtime,
    stopRealtime,
  };
}

export type BoardRuntimeApi = ReturnType<typeof useBoardRuntime>;

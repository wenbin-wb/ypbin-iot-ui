import type { IotDeviceApi, IotSeriesApi } from '#/api/iot';

import type { BoardWidget, BoardWidgetRuntime } from './board-utils';

import { ref } from 'vue';

import { getDeviceLatest } from '#/api/iot/device';
import { getDeviceSeries } from '#/api/iot/series';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { niceGaugeMax } from './board-charts';
import {
  appendBoardPoint,
  boardWidgetPropertyIds,
  IOT_BOARD_LINE_MAX_POINTS,
  resolveBoardWindowMs,
  toBoardNumeric,
} from './board-utils';

/**
 * 看板的**序列数据域**：历史序列拉取、最新值合并、折线尾部追加、多序列合并与失败降级。
 *
 * 从 `use-board-runtime.ts` 再拆出（批次 7-B，2026-10-20 架构审查 §2.11 剩余项）：
 * 运行时文件此前同时承担「实时事件分发 / 设备选项 / 每个组件的数据加载」，其中序列这一块
 * 是**数据形状与失败语义**最集中的部分 —— 单点位失败不连坐、成功序列照常画、失败原因
 * 汇总到抽屉顶部提示。拆开后运行时只保留「事件 → 哪个组件」的分发与生命周期。
 *
 * 🔴 行为零漂移（逐行搬移，未改语义）：
 * 1. **折线尾部追加**：`ts` 必须可解析且**严格大于**最后一点（重复/乱序/非法一律丢弃，
 *    **不排序** —— 排序会把「设备时钟回拨」掩盖成正常时序）；超上限保留最近 N 点；
 * 2. **最新值合并**：同 `propertyId` **覆盖**（不追加重复），新 `propertyId` 追加到尾部；
 * 3. **多序列合并**：按 `propertyId` 命中序列追加，未命中时**原样返回入参引用**
 *    （调用方据此跳过重渲染）；
 * 4. **失败降级**：全部序列失败才抛出（卡片展示 error）；部分失败把原因写进
 *    `seriesWarning`（成功序列照常画，不静默、也不整块清空）。
 */

/** 单个组件的运行期补丁函数（由 `useBoardRuntime` 注入，保持 runtime 单一写入口）。 */
export type PatchBoardRuntime = (
  id: string,
  updater: (current: BoardWidgetRuntime) => BoardWidgetRuntime,
) => void;

/**
 * 整设备最新值快照里替换/追加某点位（表格卡与开关卡共用）。
 *
 * 同 `propertyId` **原位替换**（保留位置，避免表格行序抖动）；新点位追加到尾部。
 * 返回新数组，不改写入参（调用方可能持有上一次快照做 diff）。
 */
export function mergeLatestValue(
  list: IotDeviceApi.LatestValueResp[],
  item: IotDeviceApi.LatestValueResp,
): IotDeviceApi.LatestValueResp[] {
  const index = list.findIndex((row) => row.propertyId === item.propertyId);
  if (index === -1) {
    return [...list, item];
  }
  return list.map((row, current) => (current === index ? item : row));
}

/**
 * 多序列折线的实时追加：按点位找到对应序列，找不到时忽略（配置与点位对不上）。
 *
 * @returns 命中并追加成功时返回新数组；未命中/未追加时**返回原引用**（零重渲染）
 */
export function appendMultiSeriesPoint(
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

interface BoardSeriesDeps {
  /** 运行期写入口（由运行时注入，保证「runtime 只在一处被整体替换」）。 */
  patchRuntime: PatchBoardRuntime;
}

export function useBoardSeries({ patchRuntime }: BoardSeriesDeps) {
  /** 部分序列失败的原因（抽屉顶部提示；空串 = 无降级）。 */
  const seriesWarning = ref('');

  /** 整板重载前清空降级提示（与旧值一起清，避免上一次的警告残留）。 */
  function resetSeriesWarning(): void {
    seriesWarning.value = '';
  }

  /**
   * 单个组件的初始数据（最新值 + 历史序列）；失败原因进 `runtime.error`，卡片原样展示。
   *
   * 与旧实现逐行一致：
   * - 最新值按**设备**缓存 Promise（多组件同设备只请求一次）；
   * - 非折线/多序列组件把 `seriesLoaded` 置真就返回（不拉历史）；
   * - 折线取 `properties[0]`，多序列按 `propertyId` 各一条序列。
   */
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

  /** 拉多个点位的历史：单个点位失败**不连坐**，该序列留空并带上原因到 `seriesWarning`。 */
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

  return {
    loadSeries,
    loadWidgetRuntime,
    resetSeriesWarning,
    seriesWarning,
  };
}

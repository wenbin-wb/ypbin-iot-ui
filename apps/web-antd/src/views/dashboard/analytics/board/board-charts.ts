import type { useEcharts } from '@vben/plugins/echarts';

import type { BoardSeriesPoints } from './board-utils';

import type { IotSeriesApi } from '#/api/iot';

import { toBoardNumeric } from './board-utils';

/** 图表配置类型取自 renderEcharts 的入参（echarts 不是本应用的直接依赖，不能直接 import 它的类型）。 */
type BoardChartOption = Parameters<
  ReturnType<typeof useEcharts>['renderEcharts']
>[0];

/**
 * 看板图表的 **ECharts option 纯构建**（不含 vue/网络，便于单测规则）。
 *
 * 三条取舍：
 * 1. 仪表盘量程：组件配了 min/max 就**以用户配置为准**（现场仪表的量程是业务口径，不能被
 *    「自适应」改掉）；没配才用 niceGaugeMax 按数量级自适应，且调用方只增不减地维护量程，
 *    避免指针随数值抖动；
 * 2. 折线用时间轴 + [ts, value] 对，非数值点为 null（断点），与历史曲线同一口径；
 * 3. 多序列折线一序列一点位，颜色固定调色板取模（同一份配置每次渲染颜色稳定，不用随机色）。
 */
const LINE_COLOR = '#0066f5';

/** 多序列折线调色板（12 色，与 IOT_BOARD_MAX_SERIES 对齐；同一序列每次渲染颜色一致）。 */
export const BOARD_SERIES_COLORS = [
  '#0066f5',
  '#00a870',
  '#ed7b2f',
  '#e34d59',
  '#5c5cff',
  '#0fb5ae',
  '#b25e09',
  '#d54941',
  '#7d5bff',
  '#0594fa',
  '#c9353f',
  '#8b5cf6',
];

/** 取第 index 条序列的颜色（越界按调色板长度取模，绝不返回 undefined）。 */
export function seriesColorAt(index: number): string {
  const safe = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return BOARD_SERIES_COLORS[safe % BOARD_SERIES_COLORS.length] as string;
}

/**
 * 仪表盘量程：0 / 负数 → 100；其余按数量级向上取整到 1/2/2.5/5 × 10^n，
 * 并留 20% 余量（21 → 50，5 → 10，0.3 → 0.5）。
 */
export function niceGaugeMax(value?: null | number): number {
  const number =
    value === null || value === undefined || !Number.isFinite(value)
      ? 0
      : Math.abs(value);
  if (number <= 0) {
    return 100;
  }
  const target = number * 1.2;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= target) {
      return Number(candidate.toFixed(6));
    }
  }
  return Number((10 * magnitude).toFixed(6));
}

export interface BoardGaugeBounds {
  max: number;
  min: number;
}

/**
 * 仪表盘量程决策（纯函数）：
 * - 用户显式配了下限：**尊重配置**，缺上限时用 niceGaugeMax(value) 兜底；
 * - 只配了上限：下限默认 0；
 * - 都没配：下限 0、上限取「自适应值」与调用方维护值（fallbackMax）的较大者，
 *   保证实时数值变大时不出现指针顶格的假象。
 */
export function resolveGaugeBounds(
  min: null | number | undefined,
  max: null | number | undefined,
  value: null | number,
  fallbackMax = 100,
): BoardGaugeBounds {
  const hasMin = typeof min === 'number' && Number.isFinite(min);
  const hasMax = typeof max === 'number' && Number.isFinite(max);
  if (hasMin && hasMax && max > min) {
    return { max, min };
  }
  if (hasMin) {
    const auto = niceGaugeMax(value);
    return { max: hasMax && max > min ? max : auto, min };
  }
  const autoMax = Math.max(
    niceGaugeMax(value),
    Number.isFinite(fallbackMax) ? fallbackMax : 0,
  );
  return { max: hasMax && max > 0 ? max : autoMax, min: 0 };
}

/** 仪表盘 option：无值时显示 -（不假装 0，0 是有效读数）。 */
export function buildGaugeOption(
  value: null | number,
  max: number,
  min = 0,
): BoardChartOption {
  const hasValue = value !== null && Number.isFinite(value);
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : safeMin + 100;
  return {
    series: [
      {
        axisLabel: { distance: 16, fontSize: 10 },
        axisLine: { lineStyle: { width: 12 } },
        axisTick: { show: false },
        data: [{ value: hasValue ? value : 0 }],
        detail: {
          fontSize: 18,
          formatter: () => (hasValue ? String(value) : '-'),
          offsetCenter: [0, '68%'],
        },
        endAngle: -30,
        max: safeMax,
        min: safeMin,
        pointer: { width: 4 },
        progress: { show: true, width: 12 },
        splitLine: { distance: -12, length: 10 },
        startAngle: 210,
        type: 'gauge',
      },
    ],
  };
}

/** 折线/time 轴的公共片段（单序列与多序列共用，避免两份口径漂移）。 */
function timeAxis(): BoardChartOption['xAxis'] {
  // ⚠️ 必须断言：echarts 6 的 EChartsOption 把 xAxis.type 收窄成了 'category'
  // （类型合成的已知缺陷，运行时完全支持 'time'；与 series.vue 同一处理）。
  return {
    axisLabel: { fontSize: 10, hideOverlap: true },
    axisLine: { show: false },
    axisTick: { show: false },
    boundaryGap: false,
    splitLine: { show: false },
    type: 'time',
  } as unknown as BoardChartOption['xAxis'];
}

function valueAxis(): BoardChartOption['yAxis'] {
  return {
    axisLine: { show: false },
    scale: true,
    splitLine: { lineStyle: { type: 'dashed' } },
    type: 'value',
  };
}

/** 折线 option：时间轴 + null 断点；点少时显示数据点，点多时隐藏避免糊成一团。 */
export function buildBoardLineOption(
  points: IotSeriesApi.TimeSeriesPointResp[],
  name: string,
): BoardChartOption {
  return {
    grid: {
      bottom: 4,
      containLabel: true,
      left: 4,
      right: 10,
      top: 10,
    },
    series: [
      {
        connectNulls: false,
        data: points.map((point): [number, null | number] => [
          Number(point.ts),
          toBoardNumeric(point.value),
        ]),
        itemStyle: { color: LINE_COLOR },
        lineStyle: { color: LINE_COLOR, width: 2 },
        name,
        showSymbol: points.length <= 60,
        smooth: false,
        type: 'line',
      },
    ],
    tooltip: { trigger: 'axis' },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
  };
}

/**
 * 多序列折线 option：每条序列一个点位（同一台设备）。
 *
 * 图例取 names（调用方已把点位名/单位拼好）；序列为空时仍返回带空 series 的合法 option，
 * 由卡片的空态兜住，不在这里编造占位曲线。
 */
export function buildMultiLineOption(
  series: BoardSeriesPoints[],
  names?: string[],
): BoardChartOption {
  const hasMultiple = series.length > 1;
  return {
    grid: {
      bottom: 4,
      containLabel: true,
      left: 4,
      right: 10,
      top: hasMultiple ? 28 : 10,
    },
    legend: {
      show: hasMultiple,
      top: 0,
      type: 'scroll',
    },
    series: series.map((item, index) => {
      const color = seriesColorAt(index);
      return {
        connectNulls: false,
        data: item.points.map((point): [number, null | number] => [
          Number(point.ts),
          toBoardNumeric(point.value),
        ]),
        itemStyle: { color },
        lineStyle: { color, width: 2 },
        name: names?.[index] ?? item.propertyId,
        showSymbol: item.points.length <= 60,
        smooth: false,
        type: 'line',
      };
    }),
    tooltip: { trigger: 'axis' },
    xAxis: timeAxis(),
    yAxis: valueAxis(),
  };
}

import type { useEcharts } from '@vben/plugins/echarts';

import type { IotSeriesApi } from '#/api/iot';

import { toBoardNumeric } from './board-utils';

/** 图表配置类型取自 `renderEcharts` 的入参（echarts 不是本应用的直接依赖，不能直接 import 它的类型）。 */
type BoardChartOption = Parameters<
  ReturnType<typeof useEcharts>['renderEcharts']
>[0];

/**
 * 看板图表的 **ECharts option 纯构建**（不含 vue/网络，便于单测规则）。
 *
 * 两条取舍：
 * 1. 仪表盘量程自动：组件配置只有 deviceId/propertyId/标题，没有 min/max ⇒ 用
 *    {@link niceGaugeMax} 取「当前值的 1.2 倍向上取整到 1/2/2.5/5/10 × 10^n」，
 *    调用方只增不减地维护该量程，避免指针随数值抖动；
 * 2. 折线用时间轴 + [ts, value] 对，非数值点为 null（断点），与历史曲线同一口径。
 */
const LINE_COLOR = '#0066f5';

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

/** 仪表盘 option：无值时显示 `-`（不假装 0，0 是有效读数）。 */
export function buildGaugeOption(
  value: null | number,
  max: number,
): BoardChartOption {
  const hasValue = value !== null && Number.isFinite(value);
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
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
        min: 0,
        pointer: { width: 4 },
        progress: { show: true, width: 12 },
        splitLine: { distance: -12, length: 10 },
        startAngle: 210,
        type: 'gauge',
      },
    ],
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
    // ⚠️ 必须断言：echarts 6 的 `EChartsOption` 把 `xAxis.type` 收窄成了 `'category'`
    // （类型合成的已知缺陷，运行时完全支持 `'time'`；与 series.vue 同一处理）。
    xAxis: {
      axisLabel: { fontSize: 10, hideOverlap: true },
      axisLine: { show: false },
      axisTick: { show: false },
      boundaryGap: false,
      splitLine: { show: false },
      type: 'time',
    } as unknown as BoardChartOption['xAxis'],
    yAxis: {
      axisLine: { show: false },
      scale: true,
      splitLine: { lineStyle: { type: 'dashed' } },
      type: 'value',
    },
  };
}

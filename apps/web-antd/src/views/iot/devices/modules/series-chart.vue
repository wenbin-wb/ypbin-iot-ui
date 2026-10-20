<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { ChartSeriesModel } from './series-utils';

import { nextTick, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { chartSeriesColorAt } from '#/utils/chart-tokens';

import { formatAxisTs } from './series-utils';

/**
 * 历史曲线图表（审查 P2-6 拆分之一）。
 *
 * 抽出的理由：图表配置（多 Y 轴/图例/时间轴断言/语义 token 取色）与抽屉的查询/表单逻辑
 * 完全不耦合，且它是**纯展示**——只要 `model`/`units` 变了就重绘，宿主不需要再记得调 `renderChart()`。
 *
 * 颜色在**渲染时**按语义 token 解析（跟随主题/暗色）：`buildChartModel` 是纯函数、跑在 node 里
 * 读不到 `:root` 变量，所以颜色在这里定，而不是在 `series-utils.ts` 里写死 hex
 * （canvas 也不解析 CSS 变量，见 `chart-tokens.ts`）。
 */
const props = defineProps<{
  /** 每条曲线的绘图模型（`data[i]` 与 `timestamps[i]` 一一对应）。 */
  model: ChartSeriesModel[];
  /** 各 Y 轴单位（来自查询结果，决定轴数量与左右布局）。 */
  units: string[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 图表配置类型取自 `renderEcharts` 的入参：echarts 不是本应用的直接依赖，不能直接 import 它的类型。 */
type SeriesChartOption = Parameters<typeof renderEcharts>[0];

/** 每个单位一条 Y 轴（不同量纲共轴会把两条曲线都压扁），左右交替摆放。 */
function buildYAxes(unitList: string[]) {
  return unitList.map((unit, index) => ({
    axisTick: { show: false },
    name: unit,
    offset: Math.floor(index / 2) * 56,
    position: (index % 2 === 0 ? 'left' : 'right') as 'left' | 'right',
    // 传感器量程通常远离 0：强制从 0 起会把曲线压成一条直线，故按数据范围缩放
    scale: true,
    splitNumber: 4,
    type: 'value' as const,
  }));
}

/** 历史曲线配置：时间轴 + 十字线 + 图例；单位进 Y 轴名与图例（量纲不再只能靠猜）。 */
async function renderChart(): Promise<void> {
  if (props.model.length === 0) {
    return;
  }
  const model = props.model;
  const unitList = props.units;
  await nextTick();
  const option: SeriesChartOption = {
    grid: {
      bottom: 8,
      containLabel: true,
      left: 8,
      right: unitList.length > 1 ? 56 : 16,
      top: model.length > 1 ? 40 : 24,
    },
    legend: { show: model.length > 1, top: 0, type: 'scroll' },
    series: model.map((item, index) => ({
      connectNulls: false,
      // 时间轴 + [时刻, 值]：多个点位的采样时刻不同，用等距类别轴会把它们按索引对齐（假的时间关系）
      data: item.timestamps.map((ts, index): [number, null | number] => [
        ts,
        item.data[index] ?? null,
      ]),
      itemStyle: { color: chartSeriesColorAt(index) },
      lineStyle: { color: chartSeriesColorAt(index), width: 2 },
      name: item.name,
      showSymbol: item.showSymbol,
      smooth: false,
      type: 'line',
      yAxisIndex: item.yAxisIndex,
    })),
    tooltip: { axisPointer: { type: 'cross' }, trigger: 'axis' },
    // ⚠️ 必须断言：echarts 6 的 `EChartsOption` 把 `xAxis.type` 收窄成了 `'category'`
    // （类型合成的已知缺陷，运行时完全支持 `'time'`）。用等距类别轴代替时间轴会把多个点位的
    // 采样点按**索引**对齐 —— 那是假的峰谷对齐关系，宁可断言也不能这么画。
    xAxis: {
      axisLabel: {
        formatter: (value: number | string) => formatAxisTs(value),
        hideOverlap: true,
      },
      axisTick: { show: false },
      boundaryGap: false,
      splitLine: { show: false },
      type: 'time',
    } as unknown as SeriesChartOption['xAxis'],
    yAxis: buildYAxes(unitList),
  };
  await renderEcharts(option);
}

// 模型/单位任何变化（新查询、实时追加、切换点位）都重绘：宿主不再需要手工调渲染
watch(
  () => [props.model, props.units] as const,
  () => {
    void renderChart();
  },
  { immediate: true },
);
</script>

<template>
  <EchartsUI v-if="model.length > 0" ref="chartRef" height="320px" />
</template>

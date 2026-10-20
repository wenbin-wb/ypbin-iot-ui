<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';
import { chartColor } from '#/utils/chart-tokens';

defineOptions({ name: 'AnalyticsOnlineTrend' });

const props = defineProps<{
  /** 近 14 日在线/离线设备趋势 */
  points: IotDashboardApi.OnlineTrendPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.points.length > 0);

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(points: IotDashboardApi.OnlineTrendPoint[]) {
  if (points.length === 0) {
    return;
  }
  // 颜色在**渲染时**从语义 token 解析（canvas 不认 CSS 变量，见 chart-tokens.ts 头注释）；
  // 解析不到时是 undefined，交给 ECharts 默认色板，不塞黑色。
  const onlineColor = chartColor('primary');
  const offlineColor = chartColor('destructive');
  renderEcharts({
    grid: {
      bottom: 0,
      containLabel: true,
      left: '1%',
      right: '2%',
      top: '14%',
    },
    legend: {
      left: 'center',
      top: 0,
      data: [$t('page.dashboard.online'), $t('page.dashboard.offline')],
    },
    tooltip: {
      axisPointer: { lineStyle: { color: onlineColor, width: 1 } },
      trigger: 'axis',
    },
    xAxis: {
      axisLabel: { formatter: (val: string) => val.slice(5) },
      axisLine: { show: false },
      axisTick: { show: false },
      data: points.map((p) => p.date),
      type: 'category',
    },
    yAxis: [
      {
        axisLine: { show: false },
        min: 0,
        name: $t('page.dashboard.online'),
        splitLine: { lineStyle: { type: 'dashed' } },
        type: 'value',
      },
      {
        axisLine: { show: false },
        min: 0,
        name: $t('page.dashboard.offline'),
        splitLine: { show: false },
        type: 'value',
      },
    ],
    series: [
      {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            x2: 0,
            y: 0,
            y2: 1,
            colorStops: [
              { color: chartColor('primary', 0.35), offset: 0 },
              { color: chartColor('primary', 0.02), offset: 1 },
            ],
          },
        },
        data: points.map((p) => p.online),
        itemStyle: { color: onlineColor },
        lineStyle: { color: onlineColor, width: 2.5 },
        name: $t('page.dashboard.online'),
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        type: 'line',
      },
      {
        barMaxWidth: 18,
        data: points.map((p) => p.offline),
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: offlineColor,
        },
        name: $t('page.dashboard.offline'),
        type: 'bar',
        yAxisIndex: 1,
      },
    ],
  });
}

onMounted(() => {
  renderChart(props.points);
});

watch(() => props.points, renderChart, { deep: true, flush: 'post' });
</script>

<template>
  <!--
    图表是纯 canvas，读屏拿不到任何信息；ECharts 的 aria 组件未在本项目注册
    （`packages/effects/plugins/src/echarts/echarts.ts` 未 `echarts.use([AriaComponent])`），
    所以在容器上给 `role="img"` + `aria-label`，让读屏至少能播报「这是一张什么图」。
  -->
  <EchartsUI
    v-if="hasData"
    ref="chartRef"
    :aria-label="$t('page.dashboard.onlineTrend')"
    role="img"
  />
  <div
    v-else
    class="flex h-[300px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
  >
    <Inbox class="size-8 opacity-50" />
    <span>{{ $t('page.dashboard.chartEmptyTrend') }}</span>
  </div>
</template>

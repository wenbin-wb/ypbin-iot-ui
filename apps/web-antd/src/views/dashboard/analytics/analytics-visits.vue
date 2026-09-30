<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsOnlineTrend' });

const props = defineProps<{
  /** 近 14 日在线/离线设备趋势 */
  points: IotDashboardApi.OnlineTrendPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const ONLINE_COLOR = '#0066f5';
const OFFLINE_COLOR = '#f2547b';

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(points: IotDashboardApi.OnlineTrendPoint[]) {
  if (points.length === 0) {
    return;
  }
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
      axisPointer: { lineStyle: { color: ONLINE_COLOR, width: 1 } },
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
              { offset: 0, color: 'rgba(0,102,245,0.35)' },
              { offset: 1, color: 'rgba(0,102,245,0.02)' },
            ],
          },
        },
        data: points.map((p) => p.online),
        itemStyle: { color: ONLINE_COLOR },
        lineStyle: { color: ONLINE_COLOR, width: 2.5 },
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
          color: OFFLINE_COLOR,
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

watch(() => props.points, renderChart, { deep: true });
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>

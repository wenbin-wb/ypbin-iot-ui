<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsMessageTrend' });

const props = defineProps<{
  /** 近 30 日消息量趋势（上行/下行） */
  points: IotDashboardApi.MessageTrendPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const UPLINK_COLOR = '#0066f5';
const DOWNLINK_COLOR = '#7c7cf0';

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(points: IotDashboardApi.MessageTrendPoint[]) {
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
      data: [$t('page.dashboard.uplink'), $t('page.dashboard.downlink')],
      left: 'center',
      top: 0,
    },
    tooltip: {
      axisPointer: { lineStyle: { color: UPLINK_COLOR, width: 1 } },
      trigger: 'axis',
    },
    xAxis: {
      axisLabel: { formatter: (val: string) => val.slice(5) },
      axisLine: { show: false },
      axisTick: { show: false },
      boundaryGap: false,
      data: points.map((p) => p.date),
      type: 'category',
    },
    yAxis: {
      axisLine: { show: false },
      splitLine: { lineStyle: { type: 'dashed' } },
      type: 'value',
    },
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
              { offset: 0, color: 'rgba(0,102,245,0.42)' },
              { offset: 1, color: 'rgba(0,102,245,0.02)' },
            ],
          },
        },
        data: points.map((p) => p.uplink),
        itemStyle: { color: UPLINK_COLOR },
        lineStyle: { color: UPLINK_COLOR, width: 2.5 },
        name: $t('page.dashboard.uplink'),
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        type: 'line',
      },
      {
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            x2: 0,
            y: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(124,124,240,0.38)' },
              { offset: 1, color: 'rgba(124,124,240,0.02)' },
            ],
          },
        },
        data: points.map((p) => p.downlink),
        itemStyle: { color: DOWNLINK_COLOR },
        lineStyle: { color: DOWNLINK_COLOR, width: 2 },
        name: $t('page.dashboard.downlink'),
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        type: 'line',
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

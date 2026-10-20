<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsMessageTrend' });

const props = defineProps<{
  /** 近 30 日消息量趋势（上行/下行） */
  points: IotDashboardApi.MessageTrendPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.points.length > 0);

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
    :aria-label="$t('page.dashboard.messageTrend')"
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

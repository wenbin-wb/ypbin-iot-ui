<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsDeviceGrowth' });

const props = defineProps<{
  /** 近 14 日设备增长（每日新增设备数） */
  points: IotDashboardApi.DeviceGrowthPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const BAR_COLOR = '#0066f5';

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.points.length > 0);

function renderChart(points: IotDashboardApi.DeviceGrowthPoint[]) {
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
    tooltip: {
      axisPointer: { type: 'shadow' },
      trigger: 'axis',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString()} ${$t('page.dashboard.deviceUnit')}`,
    },
    xAxis: {
      axisLabel: { formatter: (val: string) => val.slice(5) },
      axisLine: { show: false },
      axisTick: { show: false },
      data: points.map((point) => point.date),
      type: 'category',
    },
    yAxis: {
      axisLine: { show: false },
      minInterval: 1,
      splitLine: { lineStyle: { type: 'dashed' } },
      type: 'value',
    },
    series: [
      {
        barMaxWidth: 18,
        data: points.map((point) => point.added),
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: {
            colorStops: [
              { color: 'rgba(0,102,245,0.45)', offset: 0 },
              { color: BAR_COLOR, offset: 1 },
            ],
            type: 'linear',
            x: 0,
            x2: 0,
            y: 0,
            y2: 1,
          },
        },
        label: {
          color: 'inherit',
          fontSize: 11,
          formatter: '{c}',
          position: 'top',
          show: true,
        },
        name: $t('page.dashboard.deviceGrowth'),
        type: 'bar',
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
    :aria-label="$t('page.dashboard.deviceGrowth')"
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

<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsProductTop' });

const props = defineProps<{
  /** 设备数 TOP 产品（按产品聚合的设备台账数量） */
  items: IotDashboardApi.NameValue[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 横向条形图 y 轴自下而上绘制，取 TOP6 并反序让最大值在顶部 */
const topItems = computed(() =>
  [...props.items]
    .toSorted((a, b) => b.value - a.value)
    .slice(0, 6)
    .toReversed(),
);

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(items: IotDashboardApi.NameValue[]) {
  if (items.length === 0) {
    return;
  }
  renderEcharts({
    grid: {
      bottom: 0,
      containLabel: true,
      left: '2%',
      right: '10%',
      top: '2%',
    },
    series: [
      {
        barMaxWidth: 16,
        data: items.map((item) => item.value),
        itemStyle: {
          borderRadius: [0, 8, 8, 0],
          color: {
            type: 'linear',
            x: 0,
            x2: 1,
            y: 0,
            y2: 0,
            colorStops: [
              { offset: 0, color: 'rgba(0,102,245,0.45)' },
              { offset: 1, color: '#0066f5' },
            ],
          },
        },
        label: {
          color: 'inherit',
          fontSize: 11,
          formatter: '{c}',
          position: 'right',
          show: true,
        },
        name: $t('page.dashboard.deviceUnit'),
        type: 'bar',
      },
    ],
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString()} ${$t('page.dashboard.deviceUnit')}`,
    },
    xAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { type: 'dashed' } },
      type: 'value',
    },
    yAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      data: items.map((item) => item.name),
      type: 'category',
    },
  });
}

onMounted(() => {
  renderChart(topItems.value);
});

watch(topItems, renderChart, { deep: true });
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>

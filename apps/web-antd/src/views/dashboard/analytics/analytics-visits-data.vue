<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsProtocolDistribution' });

const props = defineProps<{
  /** 接入协议分布（按设备数） */
  items: IotDashboardApi.NameValue[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const PALETTE = [
  '#0066f5',
  '#7c7cf0',
  '#0ec9a3',
  '#f0b429',
  '#f2547b',
  '#5a6cf0',
];

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(items: IotDashboardApi.NameValue[]) {
  if (items.length === 0) {
    return;
  }
  renderEcharts({
    color: PALETTE,
    legend: {
      bottom: '2%',
      left: 'center',
    },
    series: [
      {
        animationDelay(idx: number) {
          return idx * 20;
        },
        animationEasing: 'exponentialInOut',
        animationType: 'scale',
        avoidLabelOverlap: false,
        data: items.map((item) => ({ ...item })),
        emphasis: {
          label: { fontSize: '12', fontWeight: 'bold', show: true },
          scaleSize: 8,
        },
        itemStyle: {
          borderColor: 'transparent',
          borderRadius: 6,
          borderWidth: 2,
        },
        label: { position: 'center', show: false },
        labelLine: { show: false },
        name: $t('page.dashboard.protocolTitle'),
        radius: ['42%', '66%'],
        type: 'pie',
      },
    ],
    tooltip: {
      trigger: 'item',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString()} ${$t('page.dashboard.deviceUnit')}`,
    },
  });
}

onMounted(() => {
  renderChart(props.items);
});

watch(() => props.items, renderChart, { deep: true });
</script>

<template>
  <EchartsUI ref="chartRef" />
</template>

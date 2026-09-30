<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';

defineOptions({ name: 'AnalyticsSeverityDistribution' });

const props = defineProps<{
  /**
   * 待处理告警级别分布。`name` 为告警级别码（critical/warning/info…，
   * 与告警中心同一口径），展示文案走 `page.iot.alert.severity.*`。
   */
  items: IotDashboardApi.NameValue[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 级别 → 配色（与告警中心的语义一致：严重红 / 警告黄 / 提示蓝） */
const SEVERITY_COLORS: Record<string, string> = {
  critical: '#f2547b',
  info: '#0066f5',
  unknown: '#8a94a6',
  warning: '#f0b429',
};
const FALLBACK_PALETTE = ['#0066f5', '#7c7cf0', '#0ec9a3'];

function severityLabel(code: string) {
  return SEVERITY_COLORS[code] === undefined
    ? code
    : $t(`page.iot.alert.severity.${code}`);
}

/** 级别配色（未知级别按序号轮替兜底色，保证每项都有颜色） */
function severityColor(code: string, index: number) {
  const known = SEVERITY_COLORS[code];
  if (known !== undefined) {
    return known;
  }
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#0066f5';
}

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(items: IotDashboardApi.NameValue[]) {
  if (items.length === 0) {
    return;
  }
  renderEcharts({
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
        color: items.map((item, idx) => severityColor(item.name, idx)),
        data: items.map((item) => ({
          name: severityLabel(item.name),
          value: item.value,
        })),
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
        name: $t('page.dashboard.severityTitle'),
        radius: ['42%', '66%'],
        type: 'pie',
      },
    ],
    tooltip: {
      trigger: 'item',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString()} ${$t('page.dashboard.alertUnit')}`,
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

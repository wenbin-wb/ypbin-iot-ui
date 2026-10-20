<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';
import { chartColor } from '#/utils/chart-tokens';

defineOptions({ name: 'AnalyticsAlertTrend' });

const props = defineProps<{
  /** 近 30 日告警趋势（按天、按严重级别） */
  points: IotDashboardApi.AlertTrendPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/**
 * 与告警中心的级别语义同色：严重=destructive / 警告=warning / 提示=primary
 * （图例文案也复用告警 i18n）。
 *
 * 只保留「字段 + 文案键」，**颜色在渲染时按 token 解析**（canvas 不认 CSS 变量，
 * 见 `shared/chart-tokens.ts` 头注释）：这样切主题/暗色时柱色自动跟随，不再写死 hex。
 */
const SERIES = [
  {
    field: 'critical',
    labelKey: 'page.iot.alert.severity.critical',
    token: 'destructive',
  },
  {
    field: 'warning',
    labelKey: 'page.iot.alert.severity.warning',
    token: 'warning',
  },
  { field: 'info', labelKey: 'page.iot.alert.severity.info', token: 'primary' },
] as const;

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.points.length > 0);

/**
 * 按级别堆叠柱：同一天的严重/警告/提示叠在一根柱子上，
 * 既能看总量（柱高）又能看结构（分段），比三条独立折线更省纵向空间。
 */
function renderChart(points: IotDashboardApi.AlertTrendPoint[]) {
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
      data: SERIES.map((item) => $t(item.labelKey)),
      left: 'center',
      top: 0,
    },
    tooltip: {
      axisPointer: { type: 'shadow' },
      trigger: 'axis',
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
    series: SERIES.map((item) => ({
      barMaxWidth: 18,
      data: points.map((point) => point[item.field]),
      itemStyle: { color: chartColor(item.token) },
      name: $t(item.labelKey),
      stack: 'alert',
      type: 'bar',
    })),
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
    :aria-label="$t('page.dashboard.alertTrend')"
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

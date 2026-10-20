<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';
import { chartColor } from '#/utils/chart-tokens';
import { useChartThemeRefresh } from '#/utils/use-chart-theme';

defineOptions({ name: 'AnalyticsDeviceGrowth' });

const props = defineProps<{
  /** 近 14 日设备增长（每日新增设备数） */
  points: IotDashboardApi.DeviceGrowthPoint[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

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
              { color: chartColor('primary', 0.45), offset: 0 },
              { color: chartColor('primary'), offset: 1 },
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

/**
 * 用**当前**数据渲染。数据变化与主题变化共用这一条路径：
 * 主题切换后必须重建 option（颜色在渲染时从 CSS 变量解析），否则 canvas 会保留旧色。
 */
function renderCurrent(): void {
  renderChart(props.points);
}

onMounted(renderCurrent);

watch(() => props.points, renderCurrent, { deep: true, flush: 'post' });

// 暗色/主题色变化后重绘（canvas 不会自己重算颜色）
useChartThemeRefresh(renderCurrent);
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

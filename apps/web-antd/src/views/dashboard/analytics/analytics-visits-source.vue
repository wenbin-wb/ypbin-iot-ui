<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';
import { chartColor, chartSeriesPalette } from '#/utils/chart-tokens';
import { useChartThemeRefresh } from '#/utils/use-chart-theme';

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

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.items.length > 0);

/**
 * 级别 → 语义 token（与告警中心一致：严重 destructive / 警告 warning / 提示 primary / 未知 muted）。
 * 只存 token 名，颜色在渲染时解析（canvas 不认 CSS 变量，见 `shared/chart-tokens.ts`）。
 */
const SEVERITY_TOKENS: Record<
  string,
  'destructive' | 'muted-foreground' | 'primary' | 'warning'
> = {
  critical: 'destructive',
  info: 'primary',
  unknown: 'muted-foreground',
  warning: 'warning',
};

/** 级别是否已知（未知级别不翻译，原样露出码值）。 */
function isKnownSeverity(code: string) {
  return SEVERITY_TOKENS[code] !== undefined;
}

function severityLabel(code: string) {
  return isKnownSeverity(code) ? $t(`page.iot.alert.severity.${code}`) : code;
}

/** 级别配色（未知级别按序号轮替兜底色，保证每项都有颜色） */
function severityColor(code: string, index: number) {
  const token = SEVERITY_TOKENS[code];
  if (token !== undefined) {
    return chartColor(token);
  }
  // chartSeriesPalette 保证非空（读不到 token 时由降级色板补齐）
  const palette = chartSeriesPalette();
  return palette[index % palette.length] ?? palette[0] ?? 'rgb(84, 112, 198)';
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

/**
 * 用**当前**数据渲染。数据变化与主题变化共用这一条路径：
 * 主题切换后必须重建 option（颜色在渲染时从 CSS 变量解析），否则 canvas 会保留旧色。
 */
function renderCurrent(): void {
  renderChart(props.items);
}

onMounted(renderCurrent);

watch(() => props.items, renderCurrent, { deep: true, flush: 'post' });

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
    :aria-label="$t('page.dashboard.severityTitle')"
    role="img"
  />
  <div
    v-else
    class="flex h-[300px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
  >
    <Inbox class="size-8 opacity-50" />
    <span>{{ $t('page.dashboard.chartEmptyDistribution') }}</span>
  </div>
</template>

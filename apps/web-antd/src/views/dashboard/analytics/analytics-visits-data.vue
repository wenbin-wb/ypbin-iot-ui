<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotDashboardApi } from '#/api/dashboard/iot-overview';

import { computed, onMounted, ref, watch } from 'vue';

import { Inbox } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { $t } from '#/locales';
import { chartSeriesPalette } from '#/utils/chart-tokens';

import { protocolLabel } from '../../iot/shared/display';

defineOptions({ name: 'AnalyticsProtocolDistribution' });

const props = defineProps<{
  /** 接入协议分布（按设备数） */
  items: IotDashboardApi.NameValue[];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/** 空数据时不渲染画布，改为友好空态：空数组会让图表区看起来像坏掉的白块。 */
const hasData = computed(() => props.items.length > 0);

/**
 * 必须在挂载后渲染：useEcharts 内部 isActiveRef 要 onMounted 才为 true，
 * setup 期（watch immediate）调用 renderEcharts 会被静默丢弃且不重试。
 */
function renderChart(items: IotDashboardApi.NameValue[]) {
  if (items.length === 0) {
    return;
  }
  // 分类色板在渲染时按语义 token 解析（全取不到时传空数组，让 ECharts 用自带色板）
  const palette = chartSeriesPalette();
  renderEcharts({
    color: palette,
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
        // 后端 `protocolDistribution.name` 是协议码（modbus/tcp/mqtt/opcua）⇒ 必须映射成
        // 中文名，否则饼图/图例直接露出英文码；未知码由 shared/display 按「未知（原码）」露出。
        data: items.map((item) => ({
          name: protocolLabel(item.name),
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

watch(() => props.items, renderChart, { deep: true, flush: 'post' });
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
    :aria-label="$t('page.dashboard.protocolTitle')"
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

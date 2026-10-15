<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { BoardWidget, BoardWidgetRuntime } from './board-utils';

import type { IotDeviceApi } from '#/api/iot';

import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { Settings, X } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import {
  Alert,
  Button,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Tag,
} from 'ant-design-vue';

import { $t } from '#/locales';

import {
  displayOrFallback,
  formatDateTime,
  onlineStatusColor,
  onlineStatusLabel,
  qualityLabel,
} from '../../../iot/shared/display';
import { buildBoardLineOption, buildGaugeOption } from './board-charts';
import { toBoardNumeric } from './board-utils';

/**
 * 看板里的单个组件卡片（数值卡 / 仪表盘 / 折线图 / 状态卡）。
 *
 * 字段诚实性：
 * - 加载失败 ⇒ Alert 原样展示后端 message，绝不画成「暂无数据」；
 * - 有值才画图：仪表盘无值时显示空态而不是把 0 当读数；折线无点显示空态。
 */
defineOptions({ name: 'BoardWidgetCard' });

const props = defineProps<{
  device?: IotDeviceApi.DeviceResp;
  runtime: BoardWidgetRuntime;
  widget: BoardWidget;
}>();

const emit = defineEmits<{
  edit: [];
  remove: [];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const isGauge = computed(() => props.widget.type === 'gauge');
const isLine = computed(() => props.widget.type === 'line');

/** 数值是否可画：文本点位/空值不画仪表盘（用空态表达，不伪造 0）。 */
const numericValue = computed(() =>
  toBoardNumeric(props.runtime.latest?.value),
);

const gaugeReady = computed(
  () =>
    isGauge.value &&
    props.runtime.error === '' &&
    props.runtime.loaded &&
    numericValue.value !== null,
);

const lineReady = computed(
  () =>
    isLine.value &&
    props.runtime.error === '' &&
    props.runtime.seriesLoaded &&
    props.runtime.points.length > 0,
);

const chartReady = computed(() => gaugeReady.value || lineReady.value);

const loading = computed(
  () =>
    props.runtime.error === '' &&
    (!props.runtime.loaded ||
      (isLine.value &&
        !props.runtime.seriesLoaded &&
        props.runtime.error === '')),
);

const deviceLabel = computed(
  () =>
    props.device?.deviceName ||
    props.device?.deviceCode ||
    props.widget.deviceId ||
    $t('page.iot.board.unknownDevice'),
);

/** 质量码 → Tag 颜色（与告警/曲线同一语义；未知码不猜好色）。 */
function qualityColor(quality?: null | string): string {
  switch ((quality ?? '').trim().toUpperCase()) {
    case 'BAD': {
      return 'error';
    }
    case 'CONFIG_ERROR': {
      return 'error';
    }
    case 'GOOD': {
      return 'success';
    }
    case 'STALE': {
      return 'warning';
    }
    case 'UNCERTAIN': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
}

function renderChart(): void {
  if (!chartReady.value) {
    return;
  }
  if (isGauge.value) {
    renderEcharts(buildGaugeOption(numericValue.value, props.runtime.gaugeMax));
    return;
  }
  renderEcharts(buildBoardLineOption(props.runtime.points, props.widget.title));
}

onMounted(() => {
  void nextTick(renderChart);
});

watch(
  () => [props.runtime, props.widget.title],
  () => {
    void nextTick(renderChart);
  },
  { deep: true, flush: 'post' },
);
</script>

<template>
  <div
    class="flex flex-col rounded-xl border border-border/80 bg-card p-4"
    :data-widget-id="widget.id"
    :data-widget-type="widget.type"
  >
    <div class="mb-2 flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h4 class="truncate text-sm font-semibold" :title="widget.title">
          {{ widget.title }}
        </h4>
        <p class="mt-0.5 truncate text-xs text-muted-foreground">
          {{ deviceLabel }} · {{ widget.propertyId }}
        </p>
      </div>
      <Space :size="0" class="shrink-0">
        <Button
          size="small"
          type="text"
          :title="$t('page.iot.board.editWidget')"
          @click="emit('edit')"
        >
          <Settings class="size-4" />
        </Button>
        <Popconfirm
          :cancel-text="$t('common.cancel')"
          :ok-text="$t('common.delete')"
          :title="$t('page.iot.board.removeConfirm', [widget.title])"
          @confirm="emit('remove')"
        >
          <Button
            danger
            size="small"
            type="text"
            :title="$t('page.iot.board.removeWidget')"
          >
            <X class="size-4" />
          </Button>
        </Popconfirm>
      </Space>
    </div>

    <!-- 失败原样展示后端 message，不画成「暂无数据」 -->
    <Alert
      v-if="runtime.error"
      :message="runtime.error"
      show-icon
      type="error"
    />

    <Spin v-else :spinning="loading">
      <!-- 数值卡 -->
      <template v-if="widget.type === 'value'">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="text-3xl font-bold tabular-nums">
            {{ displayOrFallback(runtime.latest?.value) }}
          </span>
          <Tag :color="qualityColor(runtime.latest?.quality)">
            {{ qualityLabel(runtime.latest?.quality) }}
          </Tag>
          <Tag v-if="runtime.liveCount > 0" color="success">
            {{ $t('page.iot.board.realtime') }}
          </Tag>
        </div>
        <div class="mt-2 text-xs text-muted-foreground">
          {{ $t('page.iot.board.updatedAt') }}:
          {{ formatDateTime(runtime.latest?.ts) }}
        </div>
      </template>

      <!-- 状态卡：设备在线状态（快照）+ 点位质量（实时） -->
      <template v-else-if="widget.type === 'status'">
        <div class="flex flex-wrap items-center gap-2">
          <Tag :color="onlineStatusColor(device?.onlineStatus)">
            {{ onlineStatusLabel(device?.onlineStatus) }}
          </Tag>
          <Tag :color="qualityColor(runtime.latest?.quality)">
            {{ qualityLabel(runtime.latest?.quality) }}
          </Tag>
          <Tag v-if="runtime.liveCount > 0" color="success">
            {{ $t('page.iot.board.realtime') }}
          </Tag>
        </div>
        <div class="mt-2 text-xs text-muted-foreground">
          {{ $t('page.iot.board.updatedAt') }}:
          {{ formatDateTime(runtime.latest?.ts) }}
        </div>
      </template>

      <!-- 仪表盘 -->
      <template v-else-if="isGauge">
        <Empty
          v-if="runtime.loaded && numericValue === null"
          :description="$t('page.iot.board.latestEmpty')"
        />
        <EchartsUI v-else ref="chartRef" height="180px" />
      </template>

      <!-- 折线图 -->
      <template v-else-if="isLine">
        <Empty
          v-if="runtime.seriesLoaded && runtime.points.length === 0"
          :description="$t('page.iot.board.seriesEmpty')"
        />
        <EchartsUI v-else ref="chartRef" height="180px" />
      </template>
    </Spin>
  </div>
</template>

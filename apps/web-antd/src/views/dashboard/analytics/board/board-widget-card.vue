<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type {
  BoardBooleanState,
  BoardWidget,
  BoardWidgetRuntime,
} from './board-utils';

import type { IotDeviceApi } from '#/api/iot';

import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { ArrowDown, ArrowUp, GripVertical, Settings, X } from '@vben/icons';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import {
  Alert,
  Button,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { $t } from '#/locales';

import {
  displayOrFallback,
  formatDateTime,
  onlineStatusColor,
  onlineStatusLabel,
  qualityLabel,
} from '../../../iot/shared/display';
import {
  buildBoardLineOption,
  buildGaugeOption,
  buildMultiLineOption,
  resolveGaugeBounds,
} from './board-charts';
import {
  formatBoardValue,
  resolveBoardBoolean,
  toBoardNumeric,
} from './board-utils';

/**
 * 看板里的单个组件卡片（数值卡 / 仪表盘 / 折线图 / 状态卡 / 开关卡 / 多序列折线 / 表格卡）。
 *
 * 字段诚实性：
 * - 加载失败 ⇒ Alert 原样展示后端 message，绝不画成「暂无数据」；
 * - 有值才画图：仪表盘无值时显示空态而不是把 0 当读数；折线无点显示空态；
 * - 布尔卡：不在真值表里的值显示「未知」而不是猜成「关」；
 * - 表格卡：缺失点位给 '-'，不编造读数。
 *
 * 无障碍 / 触屏：卡片本身是 HTML5 draggable（鼠标拖拽），并始终提供「上移/下移」按钮
 * （键盘 Tab + Enter / 触屏点按都能完成排序），两条路径共用 moveWidget 同一规则。
 */
defineOptions({ name: 'BoardWidgetCard' });

const props = withDefaults(
  defineProps<{
    device?: IotDeviceApi.DeviceResp;
    /** 在列表中的下标（上移/下移按钮的禁用判定与拖拽文案）。 */
    index?: number;
    runtime: BoardWidgetRuntime;
    /** 列表总数（上移/下移按钮的禁用判定）。 */
    total?: number;
    widget: BoardWidget;
  }>(),
  { device: undefined, index: 0, total: 1 },
);

const emit = defineEmits<{
  dragstart: [index: number];
  drop: [index: number];
  edit: [];
  moveDown: [];
  moveUp: [];
  remove: [];
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

const isBoolean = computed(() => props.widget.type === 'boolean');
const isGauge = computed(() => props.widget.type === 'gauge');
const isLine = computed(() => props.widget.type === 'line');
const isMultiLine = computed(() => props.widget.type === 'multi-line');
const isTable = computed(() => props.widget.type === 'table');

const canMoveUp = computed(() => props.index > 0);
const canMoveDown = computed(() => props.index < props.total - 1);

/** 数值是否可画：文本点位/空值不画仪表盘（用空态表达，不伪造 0）。 */
const numericValue = computed(() =>
  toBoardNumeric(props.runtime.latest?.value),
);

/** 展示值：按 decimals 定点格式化；空值给 '-'（不把缺失画成 0）。 */
function widgetDisplayValue(value: null | number | string | undefined): string {
  const text = formatBoardValue(value, props.widget.decimals);
  return displayOrFallback(text);
}

/** 拼接单位：只做展示，不做换算。 */
const valueText = computed(() => {
  const text = widgetDisplayValue(props.runtime.latest?.value);
  return props.widget.unit ? `${text} ${props.widget.unit}` : text;
});

const booleanState = computed<BoardBooleanState>(() =>
  resolveBoardBoolean(props.runtime.latest?.value),
);

const booleanTag = computed(() => {
  switch (booleanState.value) {
    case 'off': {
      return { color: 'default', text: $t('page.iot.board.booleanOff') };
    }
    case 'on': {
      return { color: 'success', text: $t('page.iot.board.booleanOn') };
    }
    default: {
      return { color: 'warning', text: $t('page.iot.board.booleanUnknown') };
    }
  }
});

const gaugeBounds = computed(() =>
  resolveGaugeBounds(
    props.widget.min,
    props.widget.max,
    numericValue.value,
    props.runtime.gaugeMax,
  ),
);

const gaugeReady = computed(
  () =>
    isGauge.value &&
    props.runtime.error === '' &&
    props.runtime.loaded &&
    numericValue.value !== null,
);

const linePoints = computed(() => props.runtime.points);

const lineReady = computed(
  () =>
    isLine.value &&
    props.runtime.error === '' &&
    props.runtime.seriesLoaded &&
    linePoints.value.length > 0,
);

const multiSeries = computed(() => props.runtime.multiSeries);

/** 多序列图例名：点位 + 单位（单位只看组件配置，不猜物模型）。 */
const multiSeriesNames = computed(() =>
  multiSeries.value.map((item) =>
    props.widget.unit
      ? `${item.propertyId} (${props.widget.unit})`
      : item.propertyId,
  ),
);

const multiLineReady = computed(
  () =>
    isMultiLine.value &&
    props.runtime.error === '' &&
    props.runtime.seriesLoaded &&
    multiSeries.value.some((item) => item.points.length > 0),
);

const chartReady = computed(
  () => gaugeReady.value || lineReady.value || multiLineReady.value,
);

/** 表格卡行：按组件配置的点位顺序，取整设备最新值快照；缺点位给空值行（不编造）。 */
const tableRows = computed(() => {
  const wanted =
    props.widget.propertyIds && props.widget.propertyIds.length > 0
      ? props.widget.propertyIds
      : [props.widget.propertyId];
  const byProperty = new Map(
    props.runtime.latestList.map((item) => [item.propertyId, item]),
  );
  return wanted.map((propertyId) => {
    const found = byProperty.get(propertyId);
    return {
      propertyId,
      quality: found?.quality ?? null,
      ts: found?.ts,
      value: found?.value ?? null,
    };
  });
});

const loading = computed(
  () =>
    props.runtime.error === '' &&
    (!props.runtime.loaded ||
      ((isLine.value || isMultiLine.value) && !props.runtime.seriesLoaded)),
);

const deviceLabel = computed(
  () =>
    props.device?.deviceName ||
    props.device?.deviceCode ||
    props.widget.deviceId ||
    $t('page.iot.board.unknownDevice'),
);

/** 卡片副标题：多点位类型列出点位集合，其余给单点位。 */
const pointLabel = computed(() => {
  const ids = props.widget.propertyIds;
  if ((isMultiLine.value || isTable.value) && ids && ids.length > 0) {
    return ids.join(' / ');
  }
  return props.widget.propertyId;
});

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
    renderEcharts(
      buildGaugeOption(
        numericValue.value,
        gaugeBounds.value.max,
        gaugeBounds.value.min,
      ),
    );
    return;
  }
  if (isMultiLine.value) {
    renderEcharts(
      buildMultiLineOption(multiSeries.value, multiSeriesNames.value),
    );
    return;
  }
  renderEcharts(buildBoardLineOption(linePoints.value, props.widget.title));
}

onMounted(() => {
  void nextTick(renderChart);
});

watch(
  () => [props.runtime, props.widget.title, props.widget.decimals],
  () => {
    void nextTick(renderChart);
  },
  { deep: true, flush: 'post' },
);

function onDragStart(event: DragEvent): void {
  emit('dragstart', props.index);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // 部分浏览器不设置 data 就不触发 drop；值本身不用，位置由 dragstart 记录
    event.dataTransfer.setData('text/plain', props.widget.id);
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  emit('drop', props.index);
}
</script>

<template>
  <div
    class="flex min-w-0 flex-col rounded-xl border border-border/80 bg-card p-4"
    :data-widget-id="widget.id"
    :data-widget-type="widget.type"
    draggable="true"
    @dragstart="onDragStart"
    @dragover.prevent
    @drop="onDrop"
  >
    <div class="mb-2 flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-start gap-1">
        <Tooltip :title="$t('page.iot.board.dragHandle')">
          <span
            class="mt-0.5 inline-flex shrink-0 cursor-grab items-center text-muted-foreground"
            :aria-label="$t('page.iot.board.dragHandle')"
            data-board-drag-handle="true"
          >
            <GripVertical class="size-4" />
          </span>
        </Tooltip>
        <div class="min-w-0">
          <h4 class="truncate text-sm font-semibold" :title="widget.title">
            {{ widget.title }}
          </h4>
          <p
            class="mt-0.5 truncate text-xs text-muted-foreground"
            :title="`${deviceLabel} · ${pointLabel}`"
          >
            {{ deviceLabel }} · {{ pointLabel }}
          </p>
        </div>
      </div>
      <Space :size="0" class="shrink-0">
        <Button
          :aria-label="$t('page.iot.board.moveUp')"
          :disabled="!canMoveUp"
          size="small"
          type="text"
          :title="$t('page.iot.board.moveUp')"
          @click="emit('moveUp')"
        >
          <ArrowUp class="size-4" />
        </Button>
        <Button
          :aria-label="$t('page.iot.board.moveDown')"
          :disabled="!canMoveDown"
          size="small"
          type="text"
          :title="$t('page.iot.board.moveDown')"
          @click="emit('moveDown')"
        >
          <ArrowDown class="size-4" />
        </Button>
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
            {{ valueText }}
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

      <!-- 开关 / 布尔状态卡 -->
      <template v-else-if="isBoolean">
        <div class="flex flex-wrap items-center gap-2">
          <Tag :color="booleanTag.color" class="!px-3 !py-1 !text-base">
            {{ booleanTag.text }}
          </Tag>
          <span class="tabular-nums text-sm text-muted-foreground">
            {{ widgetDisplayValue(runtime.latest?.value) }}
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

      <!-- 表格卡：点位最新值（键/值/质量/时间）；窄屏卡片化，不做横向滚动 -->
      <template v-else-if="isTable">
        <Empty
          v-if="tableRows.length === 0"
          :description="$t('page.iot.board.tableEmpty')"
        />
        <template v-else>
          <table class="hidden w-full table-fixed text-xs sm:table">
            <thead>
              <tr
                class="border-b border-border/70 text-left text-muted-foreground"
              >
                <th class="w-1/3 py-1.5 pr-2 font-medium">
                  {{ $t('page.iot.board.tableProperty') }}
                </th>
                <th class="w-1/4 py-1.5 pr-2 font-medium">
                  {{ $t('page.iot.board.tableValue') }}
                </th>
                <th class="w-1/5 py-1.5 pr-2 font-medium">
                  {{ $t('page.iot.board.tableQuality') }}
                </th>
                <th class="w-1/4 py-1.5 font-medium">
                  {{ $t('page.iot.board.tableTime') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in tableRows"
                :key="row.propertyId"
                class="border-b border-border/50 last:border-b-0"
              >
                <td
                  class="truncate py-1.5 pr-2 font-medium"
                  :title="row.propertyId"
                >
                  {{ row.propertyId }}
                </td>
                <td class="truncate py-1.5 pr-2 tabular-nums">
                  {{ widgetDisplayValue(row.value) }}
                </td>
                <td class="py-1.5 pr-2">
                  <Tag :color="qualityColor(row.quality)" class="!mr-0">
                    {{ qualityLabel(row.quality) }}
                  </Tag>
                </td>
                <td class="truncate py-1.5 tabular-nums text-muted-foreground">
                  {{ formatDateTime(row.ts) }}
                </td>
              </tr>
            </tbody>
          </table>
          <!-- 390px 小屏：每行一张小卡，避免 4 列被压到不可读 -->
          <ul class="flex flex-col gap-2 sm:hidden">
            <li
              v-for="row in tableRows"
              :key="row.propertyId"
              class="rounded-lg border border-border/60 p-2 text-xs"
            >
              <p class="truncate font-medium" :title="row.propertyId">
                {{ row.propertyId }}
              </p>
              <div class="mt-1 flex flex-wrap items-center gap-2">
                <span class="tabular-nums">{{
                  widgetDisplayValue(row.value)
                }}</span>
                <Tag :color="qualityColor(row.quality)" class="!mr-0">
                  {{ qualityLabel(row.quality) }}
                </Tag>
              </div>
              <p class="mt-1 truncate tabular-nums text-muted-foreground">
                {{ formatDateTime(row.ts) }}
              </p>
            </li>
          </ul>
        </template>
      </template>

      <!-- 仪表盘 -->
      <template v-else-if="isGauge">
        <Empty
          v-if="runtime.loaded && numericValue === null"
          :description="$t('page.iot.board.latestEmpty')"
        />
        <EchartsUI v-else ref="chartRef" height="180px" />
      </template>

      <!-- 多序列对比折线 -->
      <template v-else-if="isMultiLine">
        <Empty
          v-if="runtime.seriesLoaded && !multiLineReady"
          :description="$t('page.iot.board.seriesEmpty')"
        />
        <EchartsUI v-else ref="chartRef" height="200px" />
      </template>

      <!-- 折线图 -->
      <template v-else-if="isLine">
        <Empty
          v-if="runtime.seriesLoaded && linePoints.length === 0"
          :description="$t('page.iot.board.seriesEmpty')"
        />
        <EchartsUI v-else ref="chartRef" height="180px" />
      </template>
    </Spin>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { Alert, Empty, Spin } from 'ant-design-vue';

import { getDeviceSeries } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { buildSparkline, parseThresholdSnapshot } from '../sparkline';

/**
 * 告警展开行里的「该点位近期曲线**缩略**」。
 *
 * 数据源与「历史曲线」页签**完全一致**（`GET /iot/devices/{id}/series`），只是取最近 2 小时的少量点画成
 * 一条 inline SVG 折线——不新造查询、不新造口径。要看完整曲线（缩放/CSV 导出/多点位对比）点「查看完整曲线」。
 *
 * 三态与页面其它区块同口径：加载中（Spin）/ 失败（Alert 原样展示后端 message）/ 数据不足（Empty）。
 * **失败绝不画成「没有数据」**：时序库未启用时后端返回的是业务错误，这是两条完全不同的事实。
 */
const props = defineProps<{
  deviceId: string;
  /** 点位标识（断档类告警没有点位 ⇒ 不画曲线）。 */
  propertyId?: string;
  /** 触发时的阈值快照（形如 `> 80`），用于在缩略图上画阈值线。 */
  thresholdSnapshot?: string;
}>();

const loading = ref(false);
const error = ref('');
const points = ref<Awaited<ReturnType<typeof getDeviceSeries>>>([]);

/** 窗口：最近 2 小时（缩略图只看近期，不拉全量）。 */
const WINDOW_MS = 2 * 60 * 60 * 1000;

const sparkline = computed(() =>
  buildSparkline({
    points: points.value,
    threshold: parseThresholdSnapshot(props.thresholdSnapshot) ?? undefined,
  }),
);

async function load() {
  if (!props.deviceId || !props.propertyId) {
    points.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const to = Date.now();
    points.value = await getDeviceSeries(props.deviceId, {
      propertyId: props.propertyId,
      from: to - WINDOW_MS,
      to,
      limit: 300,
    });
  } catch (caught) {
    // 原样展示后端 message（时序库未启用等），绝不当成「没有数据」
    points.value = [];
    error.value = extractErrorMessage(
      caught,
      $t('page.iot.alert.curve.loadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-if="!propertyId" class="text-xs text-muted-foreground">
    {{ $t('page.iot.alert.curve.noPoint') }}
  </div>
  <div v-else class="max-w-[280px]">
    <Spin :spinning="loading" size="small">
      <Alert
        v-if="error"
        :message="error"
        show-icon
        type="error"
      />
      <Empty
        v-else-if="sparkline.plotted < 2"
        :description="$t('page.iot.alert.curve.empty')"
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />
      <svg
        v-else
        :height="48"
        :viewBox="`0 0 220 48`"
        :width="220"
        class="rounded border border-solid border-gray-200"
      >
        <line
          v-if="sparkline.thresholdY !== null"
          :y1="sparkline.thresholdY"
          :y2="sparkline.thresholdY"
          stroke="#ff4d4f"
          stroke-dasharray="4 3"
          stroke-width="1"
          x1="0"
          x2="220"
        />
        <path
          :d="sparkline.path"
          fill="none"
          stroke="#1677ff"
          stroke-width="1.5"
        />
      </svg>
      <div
        v-if="sparkline.plotted >= 2"
        class="mt-1 text-xs text-muted-foreground"
      >
        {{ $t('page.iot.alert.curve.range', [sparkline.min, sparkline.max]) }}
        <span v-if="sparkline.skipped > 0">
          · {{ $t('page.iot.alert.curve.skipped', [sparkline.skipped]) }}
        </span>
      </div>
    </Spin>
  </div>
</template>

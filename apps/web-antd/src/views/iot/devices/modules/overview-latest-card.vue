<script lang="ts" setup>
import type { IotAvailabilityApi, IotDeviceApi } from '#/api/iot';

import { computed } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
} from 'ant-design-vue';

import { $t } from '#/locales';

import { EMPTY_TEXT, formatDateTime, qualityLabel } from '../../shared/display';

/**
 * 概览 · 最新值 + 可用率卡（两卡响应式并排）。
 *
 * 为什么两块放同一张卡：它们在模板里本就是**同一个 `md:grid-cols-2` 网格的两个子项**，
 * 拆成两个独立卡片会让网格的直系子项数量/顺序变化 ⇒ 改变既有并排布局（视觉契约必须不变）。
 * 卡片自身无状态：数据、加载中与失败原因全部由父组件透传，仅通过事件请求父组件开抽屉。
 *
 * 失败语义：失败绝不画成空态——错误态优先；空态只说「当前没有可展示记录」。
 */
const props = defineProps<{
  /** 可用率响应（断档次数/时长/进行中断档都取自同一个响应，避免两处数字对不上）。 */
  availability?: IotAvailabilityApi.AvailabilityResp;
  /** 可用率查询失败原因（非空即错误态）。 */
  availabilityError: string;
  /**
   * 秒 → 可读时长（与事件页签断档表同一实现）。
   *
   * 为什么由父组件传入：同一换算在「事件与断档」页签的断档表也要用，卡片里再写一份会漂移成两套口径。
   */
  human: (seconds?: number | string) => string;
  /** 最新值列表。 */
  latest: IotDeviceApi.LatestValueResp[];
  /** 最新值查询失败原因（非空即错误态）。 */
  latestError: string;
  /** 父组件加载中（用于区分「还没加载」与「确实为空」）。 */
  loading: boolean;
}>();

const emit = defineEmits<{ openAvailability: []; openSeries: [] }>();

/** 加载完成且没有错误，空列表才代表「真的没有最新值」。 */
const latestLoaded = computed(() => props.latestError === '' && !props.loading);

/** 可用率小数按 4 位展示（后端返回字符串，可能是小数或百分数字符串）。 */
const availabilityText = computed(() => {
  const raw = props.availability?.availability;
  if (raw === null || raw === undefined || raw === '') {
    return '-';
  }
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? String(raw) : parsed.toFixed(4);
});

/** 进行中的断档数（`endTs` 为空 = 还没恢复）。 */
const ongoingOutageCount = computed(
  () => props.availability?.outages.filter((item) => !item.endTs).length ?? 0,
);
</script>

<template>
  <div class="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
    <section
      class="rounded-xl border border-border/80 bg-card p-4"
      data-section="overview-latest"
    >
      <div class="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h3 class="text-sm font-semibold">
          {{ $t('page.iot.device.latestValues') }}
        </h3>
        <span class="text-xs text-muted-foreground">
          {{ $t('page.iot.device.latestHint') }}
        </span>
      </div>
      <Alert v-if="latestError" :message="latestError" show-icon type="error" />
      <Empty
        v-else-if="latestLoaded && latest.length === 0"
        :description="$t('page.iot.device.latestEmpty')"
      />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[480px] text-sm">
          <thead>
            <tr
              class="border-b border-border/60 text-left text-xs text-muted-foreground"
            >
              <th class="py-1.5 pr-3 font-medium">
                {{ $t('page.iot.device.propertyId') }}
              </th>
              <th class="py-1.5 pr-3 font-medium">
                {{ $t('page.iot.series.value') }}
              </th>
              <th class="py-1.5 pr-3 font-medium">
                {{ $t('page.iot.series.quality') }}
              </th>
              <th class="py-1.5 font-medium">
                {{ $t('page.iot.series.ts') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in latest"
              :key="item.propertyId"
              class="border-b border-border/60 last:border-b-0"
            >
              <td class="py-1.5 pr-3 break-all">
                {{ item.propertyId || EMPTY_TEXT }}
              </td>
              <td class="py-1.5 pr-3">{{ item.value || EMPTY_TEXT }}</td>
              <td class="py-1.5 pr-3">
                {{ qualityLabel(item.quality) }}
              </td>
              <td class="py-1.5 whitespace-nowrap">
                {{ formatDateTime(item.ts) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section
      class="rounded-xl border border-border/80 bg-card p-4"
      data-section="overview-availability"
    >
      <h3 class="mb-3 text-sm font-semibold">
        {{ $t('page.iot.availability.title', ['']) }}
      </h3>
      <Alert
        v-if="availabilityError"
        :message="availabilityError"
        show-icon
        type="error"
      />
      <Descriptions v-else :column="1" bordered size="small">
        <DescriptionsItem :label="$t('page.iot.availability.availability')">
          <span class="text-lg font-semibold">
            {{ availabilityText }}
          </span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('page.iot.availability.outageSeconds')">
          {{ human(availability?.outageSeconds) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('page.iot.availability.outageCount')">
          {{ availability?.outageCount ?? EMPTY_TEXT }}
          <span
            v-if="ongoingOutageCount > 0"
            class="ml-2 text-destructive-text"
          >
            （{{ $t('page.iot.availability.ongoing') }}
            {{ ongoingOutageCount }}）
          </span>
        </DescriptionsItem>
      </Descriptions>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button size="small" @click="emit('openAvailability')">
          {{ $t('page.iot.device.openAvailability') }}
        </Button>
        <Button size="small" @click="emit('openSeries')">
          {{ $t('page.iot.series.title') }}
        </Button>
      </div>
    </section>
  </div>
</template>

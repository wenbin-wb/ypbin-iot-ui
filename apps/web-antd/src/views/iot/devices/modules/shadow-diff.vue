<script lang="ts" setup>
import type { ShadowDiffStatus } from './shadow-state';

import { computed } from 'vue';

import { Empty, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import ShadowEdit from './shadow-edit.vue';
import { shadowDiffRows } from './shadow-state';

/**
 * 设备影子「差异对比」区块（reported vs desired，逐键四态）。
 *
 * 为什么单列一块：reported / desired 两张卡各看一列，用户要「来回对照才能发现的差异」正是最容易漏的
 * —— 期望已下发但设备没对齐、设备上报了期望里没有的键，这两类问题在两张表里都看不出来。
 * 这里把两侧按键对齐成一张表，并给出**与后端同一口径**的判等（见 shadow-state.shadowValueEquals）。
 *
 * 权限：diff 是**只读**能力，无 `iot:shadow:update` 时仍然完整展示差异，只是不渲染写操作入口
 * （手工编辑与一键应用都由 {@link ShadowEdit} 统一把关，写入口只有一处）。
 */
const props = defineProps<{
  /** 平台期望值（desired）。 */
  desired?: null | Record<string, unknown>;
  deviceId: number | string;
  /** 设备上报值（reported）。 */
  reported?: null | Record<string, unknown>;
}>();

const emit = defineEmits<{ saved: [] }>();

/** 四态 → 颜色（success/error/warning/processing，与 antd Tag 语义一致）。 */
const STATUS_COLOR: Record<ShadowDiffStatus, string> = {
  'extra-report': 'processing',
  'missing-report': 'warning',
  'value-differs': 'error',
  match: 'success',
};

/** 四态 → 本地化标签。 */
function statusLabel(status: ShadowDiffStatus): string {
  switch (status) {
    case 'extra-report': {
      return $t('page.iot.shadow.diffStatusExtraReport');
    }
    case 'match': {
      return $t('page.iot.shadow.diffStatusMatch');
    }
    case 'missing-report': {
      return $t('page.iot.shadow.diffStatusMissingReport');
    }
    case 'value-differs': {
      return $t('page.iot.shadow.diffStatusValueDiffers');
    }
    default: {
      return '';
    }
  }
}

const rows = computed(() => shadowDiffRows(props.reported, props.desired));

/** 图例顺序固定（一致 → 值不一致 → 仅期望 → 仅上报），便于对照。 */
const LEGEND: ShadowDiffStatus[] = [
  'match',
  'value-differs',
  'missing-report',
  'extra-report',
];
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold">
        {{ $t('page.iot.shadow.diffTitle') }}
      </h3>
      <ShadowEdit
        :device-id="deviceId"
        :initial-desired="desired"
        :reported="reported"
        @saved="emit('saved')"
      />
    </div>

    <div class="mb-2 text-xs text-muted-foreground">
      {{ $t('page.iot.shadow.diffHint') }}
    </div>

    <!-- 图例：四态与颜色一一对应，避免用户只看颜色猜语义 -->
    <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span class="text-muted-foreground">
        {{ $t('page.iot.shadow.diffLegend') }}:
      </span>
      <span
        v-for="status in LEGEND"
        :key="status"
        class="flex items-center gap-1"
      >
        <Tag :color="STATUS_COLOR[status]">{{ statusLabel(status) }}</Tag>
      </span>
    </div>

    <Empty
      v-if="rows.length === 0"
      :description="$t('page.iot.shadow.diffEmpty')"
    />
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[560px] text-sm">
        <thead>
          <tr
            class="border-b border-border/60 text-left text-xs text-muted-foreground"
          >
            <th class="py-1.5 pr-3 font-medium">
              {{ $t('page.iot.shadow.diffKey') }}
            </th>
            <th class="py-1.5 pr-3 font-medium">
              {{ $t('page.iot.shadow.reported') }}
            </th>
            <th class="py-1.5 pr-3 font-medium">
              {{ $t('page.iot.shadow.desired') }}
            </th>
            <th class="py-1.5 font-medium">
              {{ $t('page.iot.shadow.diffStatus') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.key"
            :data-diff-status="row.status"
            class="border-b border-border/60 last:border-b-0"
          >
            <td class="py-1.5 pr-3 break-all">{{ row.key }}</td>
            <td class="py-1.5 pr-3 break-all whitespace-pre-wrap">
              {{ row.reportedText || '-' }}
            </td>
            <td class="py-1.5 pr-3 break-all whitespace-pre-wrap">
              {{ row.desiredText || '-' }}
            </td>
            <td class="py-1.5 whitespace-nowrap">
              <Tag :color="STATUS_COLOR[row.status]">
                {{ statusLabel(row.status) }}
              </Tag>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

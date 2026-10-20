<script lang="ts" setup>
import { Download } from '@vben/icons';

import { Button, Space, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 告警列表页签的工具栏工具区（导出 + 批量确认 + 批量静默）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：三个按钮的「禁用原因 Tooltip + 可聚焦包裹层 +
 * sr-only 文案」是同一套可访问性骨架，占约 60 行模板；把它收成一个展示组件后，
 * 页面模板只留一个标签，禁用口径仍由页面的 `resolveBatchDisabledReason` 单点决定。
 *
 * 纪律：
 * - `:disabled` 必须说明原因（P1-6）：Tooltip 给鼠标/触屏，包裹 `span` 的 `tabindex=0` +
 *   `sr-only` 文案给键盘/读屏（禁用按钮本身不可聚焦）；
 * - 导出权限沿用列表读权限（`iot:alert:list`），不额外造权限码；
 * - 所有 `data-testid` 与文案保持原样（批量处置用例按 testid 定位）。
 */
withDefaults(
  defineProps<{
    /** 批量确认的禁用原因（空串 = 可用）。 */
    batchAckDisabledReason?: string;
    /** 批量确认是否在途。 */
    batchAckPending?: boolean;
    /** 批量静默的禁用原因（空串 = 可用）。 */
    batchSilenceDisabledReason?: string;
    /** 批量静默是否在途。 */
    batchSilencePending?: boolean;
    /** 当前用户有 `iot:alert:ack`（无权限则不渲染两个批量按钮）。 */
    canAck?: boolean;
    /** 导出是否在途（按钮 loading + 防重复点击）。 */
    exportLoading?: boolean;
    /** 当前已勾选条数（只用于禁用判定，原因文案由页面算好传入）。 */
    selectedCount?: number;
  }>(),
  {
    canAck: false,
    batchAckDisabledReason: '',
    batchAckPending: false,
    batchSilenceDisabledReason: '',
    batchSilencePending: false,
    exportLoading: false,
    selectedCount: 0,
  },
);

const emit = defineEmits<{
  batchAck: [];
  batchSilence: [];
  export: [];
}>();
</script>

<template>
  <Space wrap>
    <!-- 导出当前筛选结果（服务端全量，不是当前页）；权限沿用列表读权限 -->
    <Button
      v-access:code="['iot:alert:list']"
      data-testid="export-csv"
      :loading="exportLoading"
      @click="emit('export')"
    >
      <template #icon><Download /></template>
      {{ $t('page.iot.alert.exportCsv') }}
    </Button>
    <Tooltip :title="batchAckDisabledReason">
      <span class="inline-block" :tabindex="batchAckDisabledReason ? 0 : -1">
        <Button
          v-if="canAck"
          data-testid="batch-ack"
          :disabled="selectedCount === 0 || batchAckPending"
          :loading="batchAckPending"
          @click="emit('batchAck')"
        >
          {{ $t('page.iot.alert.batchAck') }}
        </Button>
        <span v-if="batchAckDisabledReason" class="sr-only">
          {{ batchAckDisabledReason }}
        </span>
      </span>
    </Tooltip>
    <Tooltip :title="batchSilenceDisabledReason">
      <span
        class="inline-block"
        :tabindex="batchSilenceDisabledReason ? 0 : -1"
      >
        <Button
          v-if="canAck"
          data-testid="batch-silence"
          :disabled="selectedCount === 0 || batchSilencePending"
          :loading="batchSilencePending"
          @click="emit('batchSilence')"
        >
          {{ $t('page.iot.alert.batchSilence') }}
        </Button>
        <span v-if="batchSilenceDisabledReason" class="sr-only">
          {{ batchSilenceDisabledReason }}
        </span>
      </span>
    </Tooltip>
  </Space>
</template>

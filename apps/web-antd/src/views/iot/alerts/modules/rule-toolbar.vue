<script lang="ts" setup>
import { Button, Popconfirm, Space, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 告警规则页签的工具栏工具区（批量启用 / 批量停用 / 新建规则）。
 *
 * 从 `index.vue` 拆出的原因（拆分批次 5-D）：两个批量按钮各自带着「Popconfirm 二次确认 +
 * 禁用原因 Tooltip + 可聚焦包裹层 + sr-only 文案」四层结构，约 77 行模板；抽成展示组件后
 * 页面只留一个标签，确认文案与禁用口径仍由页面单点决定。
 *
 * 纪律（不得改）：
 * - 启停都要二次确认（P1-9）：批量停用会让 N 类故障同时失去告警，条数取**当前已选数**，
 *   ok 文案复用全局 `common.confirm`；
 * - `:disabled` 必须说明原因；禁用按钮本身不可聚焦，故用 `tabindex=0` 包裹层 + `sr-only` 文案；
 * - `data-testid` 与文案保持原样（批量启停用例按 testid 定位）。
 */
withDefaults(
  defineProps<{
    /** 当前用户有 `iot:alert:rule-save`。 */
    canSaveRule?: boolean;
    /** 批量启停的禁用原因（空串 = 可用）。 */
    disabledReason?: string;
    /** 当前已选规则条数（用于 Popconfirm 文案与禁用判定）。 */
    selectedCount?: number;
    /** 批量启停在途（两个按钮共用：同一时刻只允许一批，防连点造成两批交集）。 */
    togglePending?: boolean;
  }>(),
  {
    canSaveRule: false,
    disabledReason: '',
    selectedCount: 0,
    togglePending: false,
  },
);

const emit = defineEmits<{
  create: [];
  toggle: [enabled: boolean];
}>();
</script>

<template>
  <Space wrap>
    <Tooltip :title="disabledReason">
      <span class="inline-block" :tabindex="disabledReason ? 0 : -1">
        <Popconfirm
          v-if="canSaveRule"
          :cancel-text="$t('common.cancel')"
          :ok-text="$t('common.confirm')"
          :title="$t('page.iot.alert.rule.batchEnableConfirm', [selectedCount])"
          @confirm="emit('toggle', true)"
        >
          <Button
            data-testid="batch-rule-enable"
            :disabled="selectedCount === 0 || togglePending"
            :loading="togglePending"
          >
            {{ $t('page.iot.alert.rule.batchEnable') }}
          </Button>
        </Popconfirm>
        <span v-if="disabledReason" class="sr-only">
          {{ disabledReason }}
        </span>
      </span>
    </Tooltip>
    <Tooltip :title="disabledReason">
      <span class="inline-block" :tabindex="disabledReason ? 0 : -1">
        <Popconfirm
          v-if="canSaveRule"
          :cancel-text="$t('common.cancel')"
          :ok-text="$t('common.confirm')"
          :title="
            $t('page.iot.alert.rule.batchDisableConfirm', [selectedCount])
          "
          @confirm="emit('toggle', false)"
        >
          <Button
            data-testid="batch-rule-disable"
            :disabled="selectedCount === 0 || togglePending"
            :loading="togglePending"
          >
            {{ $t('page.iot.alert.rule.batchDisable') }}
          </Button>
        </Popconfirm>
        <span v-if="disabledReason" class="sr-only">
          {{ disabledReason }}
        </span>
      </span>
    </Tooltip>
    <Button v-if="canSaveRule" type="primary" @click="emit('create')">
      {{ $t('page.iot.alert.rule.createTitle') }}
    </Button>
  </Space>
</template>

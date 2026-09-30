<script lang="ts" setup>
import type { IotPlatformAlertApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Alert, Empty, Select, Tag } from 'ant-design-vue';

import { getPlatformAlerts } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  platformAlertSeverityColor,
  platformAlertSeverityLabelKey,
  platformAlertStateColor,
  platformAlertStateLabelKey,
  resolvePlatformAlertListState,
  snapshotLabel,
  tsLabel,
} from './platform-alert-state';

/**
 * 平台自告警列表（看板 #10 二批；菜单 /iot/platform-alerts，权限 iot:alert:list）。
 *
 * 平台健康问题（评估器停摆/通知投递失败/入站丢弃）的**只读视图**；
 * 数据来自后端判定器落库结果，本页不产告警。
 *
 * 约束（与设备告警页同口径）：
 *   ① 失败态与空态严格分离（加载失败不画成"没有告警"）；
 *   ② 状态/级别标签与后端枚举对齐（未知值回落"未知"）；
 *   ③ 分页计数/页码为字符串 ⇒ 交给 vxe 前显式转数。
 */
const { hasAccessByCodes } = useAccess();
const canView = computed(() => hasAccessByCodes(['iot:alert:list']));

const loading = ref(false);
const errorMessage = ref('');
const rows = ref<IotPlatformAlertApi.PlatformAlertResp[]>([]);
const total = ref(0);

const stateFilter = ref<string | undefined>();
const severityFilter = ref<string | undefined>();

const listState = computed(() =>
  resolvePlatformAlertListState(
    loading.value,
    errorMessage.value,
    rows.value.length,
  ),
);

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const result = await getPlatformAlerts({
      page: 1,
      pageSize: 50,
      state: stateFilter.value || undefined,
      severity: severityFilter.value || undefined,
    });
    rows.value = result.items ?? [];
    total.value = toBackendNumber(result.total);
  } catch (error) {
    rows.value = [];
    errorMessage.value = extractErrorMessage(
      error,
      $t('page.iot.platformAlert.loadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

function reloadOnFilter() {
  void load();
}

onMounted(() => {
  if (canView.value) {
    void load();
  }
});
</script>

<template>
  <div v-if="canView" class="p-3">
    <div class="mb-3 flex items-center gap-3">
      <div class="font-semibold">
        {{ $t('page.iot.platformAlert.title') }}
      </div>
      <Select
        v-model:value="stateFilter"
        allow-clear
        :placeholder="$t('page.iot.platformAlert.allStates')"
        class="w-40"
        @change="reloadOnFilter"
      >
        <Select.Option value="PENDING">
          {{ $t('page.iot.platformAlert.state.pending') }}
        </Select.Option>
        <Select.Option value="FIRING">
          {{ $t('page.iot.platformAlert.state.firing') }}
        </Select.Option>
        <Select.Option value="RESOLVED">
          {{ $t('page.iot.platformAlert.state.resolved') }}
        </Select.Option>
      </Select>
      <Select
        v-model:value="severityFilter"
        allow-clear
        :placeholder="$t('page.iot.platformAlert.allSeverities')"
        class="w-40"
        @change="reloadOnFilter"
      >
        <Select.Option value="CRITICAL">
          {{ $t('page.iot.platformAlert.severity.critical') }}
        </Select.Option>
        <Select.Option value="WARNING">
          {{ $t('page.iot.platformAlert.severity.warning') }}
        </Select.Option>
      </Select>
      <span class="text-xs text-muted-foreground">{{ total }}</span>
    </div>

    <Alert
      v-if="listState === 'error'"
      type="error"
      show-icon
      :message="$t('page.iot.platformAlert.loadFailed')"
      :description="errorMessage"
    />

    <Empty
      v-if="listState === 'empty'"
      :description="$t('page.iot.platformAlert.empty')"
    />

    <table v-if="listState === 'ready'" class="w-full text-sm">
      <thead>
        <tr class="text-left text-gray-500">
          <th class="py-1">{{ $t('page.iot.platformAlert.rule') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.severityField') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.stateField') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.summary') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.snapshot') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.startTs') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.resolvedTs') }}</th>
          <th class="py-1">{{ $t('page.iot.platformAlert.rounds') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" class="border-t">
          <td class="py-1">
            <span class="font-mono text-xs">{{ row.ruleCode }}</span>
          </td>
          <td class="py-1">
            <Tag :color="platformAlertSeverityColor(row.severity)">
              {{ $t(platformAlertSeverityLabelKey(row.severity)) }}
            </Tag>
          </td>
          <td class="py-1">
            <Tag :color="platformAlertStateColor(row.state)">
              {{ $t(platformAlertStateLabelKey(row.state)) }}
            </Tag>
          </td>
          <td class="py-1">{{ row.summary }}</td>
          <td class="max-w-56 truncate py-1 font-mono text-xs">
            {{ snapshotLabel(row.metricSnapshot) }}
          </td>
          <td class="py-1">{{ tsLabel(row.startTs) }}</td>
          <td class="py-1">{{ tsLabel(row.resolvedTs) }}</td>
          <td class="py-1">{{ row.observedRounds ?? '-' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="!canView" class="p-4 text-sm text-muted-foreground">
      {{ $t('page.iot.platformAlert.noPermission') }}
    </div>
  </div>
</template>

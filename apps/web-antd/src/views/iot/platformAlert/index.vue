<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotPlatformAlertApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Select, Tag } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getPlatformAlerts } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  platformAlertSeverityColor,
  platformAlertSeverityLabelKey,
  platformAlertStateColor,
  platformAlertStateLabelKey,
  snapshotLabel,
  tsLabel,
} from './platform-alert-state';

/**
 * 平台自告警列表（看板 #10 二批；菜单 /iot/platform-alerts，权限 iot:alert:list）。
 *
 * 平台健康问题（评估器停摆/通知投递失败/入站丢弃）的**只读视图**；
 * 数据来自后端判定器落库结果，本页不产告警。
 *
 * 表现层约束（架构统一，硬性要求）：
 *   ① 列表用架构自带 `useVbenVxeGrid`（vxe-table），不用原生 `<table>`；
 *   ② 失败态与空态严格分离（加载失败不画成"没有告警"，失败原因记 `listError` 并继续抛出走 vxe 失败分支）；
 *   ③ 状态/级别标签与后端枚举对齐（未知值回落"未知"）；
 *   ④ 分页计数/页码为字符串 ⇒ 交给 vxe 前显式转数。
 */
const { hasAccessByCodes } = useAccess();
const canView = computed(() => hasAccessByCodes(['iot:alert:list']));

const listError = ref('');

const stateFilter = ref<string | undefined>();
const severityFilter = ref<string | undefined>();

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: [
      {
        field: 'ruleCode',
        title: $t('page.iot.platformAlert.rule'),
        minWidth: 180,
      },
      {
        field: 'severity',
        title: $t('page.iot.platformAlert.severityField'),
        width: 110,
        slots: { default: 'severity' },
      },
      {
        field: 'state',
        title: $t('page.iot.platformAlert.stateField'),
        width: 110,
        slots: { default: 'state' },
      },
      {
        field: 'summary',
        title: $t('page.iot.platformAlert.summary'),
        minWidth: 200,
      },
      {
        field: 'metricSnapshot',
        title: $t('page.iot.platformAlert.snapshot'),
        minWidth: 160,
        slots: { default: 'snapshot' },
      },
      {
        field: 'startTs',
        title: $t('page.iot.platformAlert.startTs'),
        width: 170,
        slots: { default: 'startTs' },
      },
      {
        field: 'resolvedTs',
        title: $t('page.iot.platformAlert.resolvedTs'),
        width: 170,
        slots: { default: 'resolvedTs' },
      },
      {
        field: 'observedRounds',
        title: $t('page.iot.platformAlert.rounds'),
        width: 90,
      },
    ],
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) => {
          try {
            const result = await getPlatformAlerts({
              page: page.currentPage,
              pageSize: page.pageSize,
              state: stateFilter.value || undefined,
              severity: severityFilter.value || undefined,
            });
            listError.value = '';
            // 后端计数是字符串（long 全局序列化），进 vxe 前转数
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.platformAlert.loadFailed'),
            );
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotPlatformAlertApi.PlatformAlertResp>,
});

function reloadOnFilter() {
  gridApi.query();
}
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
    </div>

    <Grid>
      <template #severity="{ row }">
        <Tag :color="platformAlertSeverityColor(row.severity)">
          {{ $t(platformAlertSeverityLabelKey(row.severity)) }}
        </Tag>
      </template>
      <template #state="{ row }">
        <Tag :color="platformAlertStateColor(row.state)">
          {{ $t(platformAlertStateLabelKey(row.state)) }}
        </Tag>
      </template>
      <template #snapshot="{ row }">
        <span class="font-mono text-xs">
          {{ snapshotLabel(row.metricSnapshot) }}
        </span>
      </template>
      <template #startTs="{ row }">
        {{ tsLabel(row.startTs) }}
      </template>
      <template #resolvedTs="{ row }">
        {{ tsLabel(row.resolvedTs) }}
      </template>
    </Grid>

    <div v-if="!canView" class="p-4 text-sm text-muted-foreground">
      {{ $t('page.iot.platformAlert.noPermission') }}
    </div>
  </div>
</template>

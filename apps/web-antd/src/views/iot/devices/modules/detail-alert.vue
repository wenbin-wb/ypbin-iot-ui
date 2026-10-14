<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Empty,
  message,
  Skeleton,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  ackAlerts,
  getDeviceAlertPage,
  getDeviceAlertSummary,
  silenceAlerts,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  humanSeconds,
  reasonLabelKey,
  severityColor,
  severityLabelKey,
  stateColor,
  stateLabelKey,
} from '../../alerts/data';
import InstanceCurve from '../../alerts/modules/instance-curve.vue';
import { displayOrFallback, formatDateTime } from '../../shared/display';

/**
 * 设备详情抽屉的**第 6 个「告警」页签**。
 *
 * 两块内容：**活动告警区**（FIRING/ACKED，可一键确认/静默）与**历史告警区**（RESOLVED，分页）。
 * 三态与其它页签同口径：失败（Alert 原样展示后端 message）→ 空（Empty）→ 内容；
 * **失败绝不画成「没有告警」**（那是本仓已收口过的事故形态）。
 *
 * 展开行直接展示触发值/阈值/时间线/投递记录，以及**该点位近期曲线缩略**（数据源与「历史曲线」页签同源）。
 */
const props = defineProps<{
  deviceId: string;
  productId?: string;
}>();

const { hasAccessByCodes } = useAccess();

const canAck = computed(() => hasAccessByCodes(['iot:alert:ack']));

const ACTIVE_PAGE_SIZE = 20;

const HISTORY_PAGE_SIZE = 10;

const activeRows = ref<any[]>([]);

const activeError = ref('');

const historyRows = ref<any[]>([]);

const historyTotal = ref(0);

const historyPage = ref(1);

const historyError = ref('');

const historyLoading = ref(false);

const summaryText = ref('');

const loading = ref(false);

const expandedKeys = ref<string[]>([]);

/** 持续时长：空值给 `-`；`0` 是合法时长，不能被当成空。 */
function durationText(value?: null | number | string): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  return humanSeconds(value);
}

async function loadSummary() {
  if (!props.deviceId) {
    return;
  }
  try {
    const summary = await getDeviceAlertSummary(props.deviceId);
    summaryText.value = $t('page.iot.alert.deviceSummary', [
      toBackendNumber(summary.activeCount),
      toBackendNumber(summary.firingCount),
      toBackendNumber(summary.ackedCount),
    ]);
  } catch {
    // 摘要失败不阻塞两块列表（列表各自的失败态才是用户要看的）
    summaryText.value = '';
  }
}

async function loadActive() {
  if (!props.deviceId) {
    activeRows.value = [];
    return;
  }
  loading.value = true;
  try {
    const result = await getDeviceAlertPage(props.deviceId, {
      page: 1,
      pageSize: ACTIVE_PAGE_SIZE,
      activeOnly: true,
    });
    activeRows.value = result.items ?? [];
    activeError.value = '';
  } catch (error) {
    activeRows.value = [];
    activeError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.loadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

async function loadHistory() {
  if (!props.deviceId) {
    historyRows.value = [];
    historyTotal.value = 0;
    return;
  }
  historyLoading.value = true;
  try {
    const result = await getDeviceAlertPage(props.deviceId, {
      page: historyPage.value,
      pageSize: HISTORY_PAGE_SIZE,
      state: 'RESOLVED',
    });
    historyRows.value = result.items ?? [];
    historyTotal.value = toBackendNumber(result.total);
    historyError.value = '';
  } catch (error) {
    historyRows.value = [];
    historyTotal.value = 0;
    historyError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.loadFailed'),
    );
  } finally {
    historyLoading.value = false;
  }
}

async function reload() {
  await Promise.all([loadSummary(), loadActive(), loadHistory()]);
}

async function onAck(id: string) {
  try {
    const count = await ackAlerts([id]);
    message.success($t('page.iot.alert.ackDone', [count]));
    await reload();
  } catch {
    // 全局拦截器已提示
  }
}

async function onSilence(id: string, minutes = 60) {
  try {
    const count = await silenceAlerts([id], minutes);
    message.success($t('page.iot.alert.silenceDone', [count, minutes]));
    await reload();
  } catch {
    // 全局拦截器已提示
  }
}

watch(
  () => props.deviceId,
  () => {
    historyPage.value = 1;
    void reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="space-y-3">
    <div class="text-sm text-muted-foreground">
      {{ summaryText || $t('page.iot.alert.deviceHint') }}
    </div>

    <!-- 活动告警区 -->
    <div class="font-semibold">{{ $t('page.iot.alert.activeSection') }}</div>
    <!--
      🔴 三态顺序必须是「加载中 → 失败 → 空 → 内容」：早期版本把 `:loading` 挂在那张**要等有行才渲染**
      的 Table 上，于是首屏请求未回来时用户看到的是「该设备暂无活动告警」——**把加载中画成了没有告警**
      （与本仓已收口过的假空态同类）。独立复核 2026-10-03 判为必须整改。
    -->
    <Skeleton v-if="loading" active :paragraph="{ rows: 3 }" />
    <Alert
      v-else-if="activeError"
      :message="activeError"
      show-icon
      type="error"
    />
    <Empty
      v-else-if="activeRows.length === 0"
      :description="$t('page.iot.alert.noActive')"
    />
    <Table
      v-else
      :data-source="activeRows"
      :loading="loading"
      :pagination="false"
      :row-key="(row: any) => row.id"
      size="small"
      :expanded-row-keys="expandedKeys"
      @expanded-rows-change="
        (keys: any) => {
          expandedKeys = keys as string[];
        }
      "
    >
      <Table.Column
        :title="$t('page.iot.alert.severityField')"
        data-index="severity"
      >
        <template #default="{ record }">
          <Tag :color="severityColor(record.severity)">
            {{ $t(severityLabelKey(record.severity)) }}
          </Tag>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.property')"
        data-index="propertyId"
      >
        <template #default="{ record }">
          <span v-if="record.outage">{{
            $t('page.iot.alert.kind.offline')
          }}</span>
          <span v-else>{{ displayOrFallback(record.propertyId) }}</span>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.triggerValue')"
        data-index="triggerValue"
      >
        <template #default="{ record }">
          {{ displayOrFallback(record.triggerValue) }}
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.threshold')"
        data-index="thresholdSnapshot"
      >
        <template #default="{ record }">
          {{ displayOrFallback(record.thresholdSnapshot) }}
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.alert.stateField')" data-index="state">
        <template #default="{ record }">
          <Tag :color="stateColor(record.state)">
            {{ $t(stateLabelKey(record.state)) }}
          </Tag>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.duration')"
        data-index="durationSeconds"
      >
        <template #default="{ record }">
          {{ durationText(record.durationSeconds) }}
        </template>
      </Table.Column>
      <Table.Column :title="$t('common.action')">
        <template #default="{ record }">
          <Space>
            <Button
              v-if="canAck"
              :disabled="record.state !== 'FIRING'"
              size="small"
              type="link"
              @click="onAck(record.id)"
            >
              {{ $t('page.iot.alert.ack') }}
            </Button>
            <Button
              v-if="canAck"
              size="small"
              type="link"
              @click="onSilence(record.id, 60)"
            >
              {{ $t('page.iot.alert.silenceOneHour') }}
            </Button>
          </Space>
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.alert.expandHint')" key="expandIcon" />
      <template #expandedRowRender="{ record }">
        <div class="grid grid-cols-2 gap-4">
          <div class="text-xs">
            <div>
              {{ $t('page.iot.alert.startTs') }}:
              {{ formatDateTime(record.startTs) }}
            </div>
            <div>
              {{ $t('page.iot.alert.firingTs') }}:
              {{ formatDateTime(record.firingTs) }}
            </div>
            <div v-if="record.silenceUntil">
              {{ $t('page.iot.alert.silenceUntil') }}:
              {{ formatDateTime(record.silenceUntil) }}
            </div>
            <div v-if="record.reason">
              {{ $t('page.iot.alert.reasonField') }}:
              {{ $t(reasonLabelKey(record.reason)) }}
            </div>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">
              {{ $t('page.iot.alert.curve.title') }}
            </div>
            <InstanceCurve
              :device-id="record.deviceId"
              :property-id="record.propertyId"
              :threshold-snapshot="record.thresholdSnapshot"
            />
          </div>
        </div>
      </template>
    </Table>

    <!-- 历史告警区 -->
    <div class="font-semibold">{{ $t('page.iot.alert.historySection') }}</div>
    <Skeleton v-if="historyLoading" active :paragraph="{ rows: 3 }" />
    <Alert
      v-else-if="historyError"
      :message="historyError"
      show-icon
      type="error"
    />
    <Empty
      v-else-if="historyRows.length === 0"
      :description="$t('page.iot.alert.noHistory')"
    />
    <Table
      v-else
      :data-source="historyRows"
      :pagination="{
        current: historyPage,
        pageSize: HISTORY_PAGE_SIZE,
        total: historyTotal,
        showSizeChanger: false,
      }"
      :row-key="(row: any) => row.id"
      size="small"
      @change="
        (pagination: any) => {
          historyPage = pagination.current;
          void loadHistory();
        }
      "
    >
      <Table.Column
        :title="$t('page.iot.alert.severityField')"
        data-index="severity"
      >
        <template #default="{ record }">
          <Tag :color="severityColor(record.severity)">
            {{ $t(severityLabelKey(record.severity)) }}
          </Tag>
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.property')"
        data-index="propertyId"
      >
        <template #default="{ record }">
          {{ displayOrFallback(record.propertyId) }}
        </template>
      </Table.Column>
      <Table.Column :title="$t('page.iot.alert.startTs')" data-index="startTs">
        <template #default="{ record }">
          {{ formatDateTime(record.startTs) }}
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.resolvedTs')"
        data-index="resolvedTs"
      >
        <template #default="{ record }">
          {{ formatDateTime(record.resolvedTs) }}
        </template>
      </Table.Column>
      <Table.Column
        :title="$t('page.iot.alert.reasonField')"
        data-index="reason"
      >
        <template #default="{ record }">
          {{ record.reason ? $t(reasonLabelKey(record.reason)) : '-' }}
        </template>
      </Table.Column>
    </Table>
  </div>
</template>

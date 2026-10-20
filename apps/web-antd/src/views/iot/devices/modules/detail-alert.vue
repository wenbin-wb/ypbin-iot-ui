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
import {
  displayOrFallback,
  EMPTY_TEXT,
  formatDateTime,
} from '../../shared/display';

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

/** 活动告警总数（后端 long → 全局字符串；展示/比较前显式 toBackendNumber）。 */
const activeTotal = ref(0);

/** 当前**已加载到**第几页（加载更多成功后 +1；刷新/切设备回到 1）。 */
const activePage = ref(1);

/** 加载更多在途（与首次加载的 `loading` 分开：翻页期间表格继续可读）。 */
const activeLoadingMore = ref(false);

/** 加载更多失败原因（失败**不得清空已加载行**，提示挂在这条独立错误上）。 */
const activeMoreError = ref('');

/** 是否还有未加载的活动告警（按 total 与已加载行数判断，不猜后端页数）。 */
const hasMoreActive = computed(
  () => activeRows.value.length < activeTotal.value,
);

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

/**
 * 加载活动告警。
 *
 * @param reset `true`=回到第 1 页并**整体替换**（首次加载/刷新/切换设备/处置后）；
 *              `false`=加载下一页并**追加**（「加载更多」）。
 *
 * 失败语义（两条不同路径，刻意分开）：
 * - 首屏失败 ⇒ 清空并展示 `activeError`（没有可保留的数据）；
 * - 加载更多失败 ⇒ **保留已加载行**，只把后端 message 挂到 `activeMoreError`
 *   （把已看到的活动告警清掉，等于在故障时让用户失去处置依据）。
 */
async function loadActive(reset = true) {
  if (!props.deviceId) {
    activeRows.value = [];
    activeTotal.value = 0;
    activePage.value = 1;
    activeError.value = '';
    activeMoreError.value = '';
    return;
  }
  const page = reset ? 1 : activePage.value + 1;
  if (reset) {
    loading.value = true;
  } else {
    activeLoadingMore.value = true;
  }
  try {
    const result = await getDeviceAlertPage(props.deviceId, {
      activeOnly: true,
      page,
      pageSize: ACTIVE_PAGE_SIZE,
    });
    const items = result.items ?? [];
    activeRows.value = reset ? items : [...activeRows.value, ...items];
    activeTotal.value = toBackendNumber(result.total);
    activePage.value = page;
    activeError.value = '';
    activeMoreError.value = '';
  } catch (error) {
    const reason = extractErrorMessage(
      error,
      $t('page.iot.alert.loadFailed'),
    );
    if (reset) {
      activeRows.value = [];
      activeTotal.value = 0;
      activePage.value = 1;
      activeError.value = reason;
    } else {
      // 保留已加载行：失败只是「更多没拿到」，不是「已有数据作废」
      activeMoreError.value = reason;
    }
  } finally {
    if (reset) {
      loading.value = false;
    } else {
      activeLoadingMore.value = false;
    }
  }
}

/** 「加载更多」：在途/已到末页时短路，避免重复请求与末页空翻。 */
function loadMoreActive() {
  if (activeLoadingMore.value || !hasMoreActive.value) {
    return;
  }
  void loadActive(false);
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
  // 刷新（含处置后的重拉）必须回到活动告警第 1 页：否则会停在旧页码上，
  // 用户会看到「已确认的告警消失但总数没变」这类错位。
  activePage.value = 1;
  activeMoreError.value = '';
  await Promise.all([loadSummary(), loadActive(true), loadHistory()]);
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
    <template v-else>
      <!--
        分页口径必须**显式可见**：旧实现固定取第 1 页 20 条且分页器关闭 ⇒ 用户不知道还有多少条、
        也看不到更多（审查 03 P2-5）。这里给出「共 N 条（当前第 x 页）」+「加载更多」，
        total 是后端 long（全局字符串），展示前已用 `toBackendNumber` 归一。
      -->
      <div
        class="flex items-center justify-between text-xs text-muted-foreground"
        data-testid="active-page-info"
      >
        <span>
          {{ $t('page.iot.alert.activeTotal', [activeTotal, activePage]) }}
        </span>
      </div>
      <!-- 加载更多失败：保留已加载行，只提示「更多没拿到」（不得清空已有活动告警） -->
      <Alert
        v-if="activeMoreError"
        :message="activeMoreError"
        data-testid="active-more-error"
        show-icon
        type="error"
      />
      <Table
        data-testid="active-alert-table"
        :data-source="activeRows"
        :loading="loading"
        :pagination="false"
        :row-key="(row: any) => row.id"
        :scroll="{ x: 1000 }"
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
      <div v-if="hasMoreActive" class="mt-2">
        <Button
          data-testid="active-load-more"
          :loading="activeLoadingMore"
          size="small"
          @click="loadMoreActive"
        >
          {{ $t('page.iot.alert.loadMore') }}
        </Button>
      </div>
    </template>

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
      :scroll="{ x: 760 }"
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
          {{ record.reason ? $t(reasonLabelKey(record.reason)) : EMPTY_TEXT }}
        </template>
      </Table.Column>
    </Table>
  </div>
</template>

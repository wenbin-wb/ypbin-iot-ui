<script lang="ts" setup>
/**
 * 接入侧只读运维概览（**内容组件**：不含 Page，规则同 ledger.vue 的文件头）。
 *
 * 数据源只有一个：`GET /iot/access-overview`（平台级 `iot:ledger:list`）。
 * 字段诚实性（硬要求）：
 * - access 未上报前 `metrics.reported=false`，指标区显示「暂无上报」，**不许渲染 0**（0 = 已上报且为零）；
 * - 计数字段按 `null | number | string` 处理（Long 序列化），本文件统一用 `toText()` 转文本。
 */
import { onMounted, ref } from 'vue';

import { Alert, Button, Card, Descriptions, Table, Tag } from 'ant-design-vue';

import { getAccessOverview } from '#/api/iot/accessOverview';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

interface Row {
  key: string;
  accessNode: string;
  maxTenants: string;
  holding: string;
  earliestExpire: string;
  lastRegistered: string;
  leaseAlive: string;
  leaseRemaining: string;
}

interface Metric {
  label: string;
  value: string;
}

const rows = ref<Row[]>([]);
const metrics = ref<Metric[]>([]);
const reported = ref(false);
const loading = ref(false);
const error = ref('');

/** null/undefined ⇒ 统一显示「暂无数据」（不显示 0）。 */
function toText(value: null | number | string | undefined): string {
  if (value === null || value === undefined || value === '') {
    return $t('page.iot.overview.noData');
  }
  return String(value);
}

/** 租约存活文案：null/undefined ⇒ 无租约；true ⇒ 续约中；false ⇒ 已过期（**不用嵌套三元**，可读性优先）。 */
function leaseAliveText(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return $t('page.iot.overview.noLease');
  }
  return value
    ? $t('page.iot.overview.leaseAliveYes')
    : $t('page.iot.overview.leaseExpired');
}

/** 心跳阈值 45s（与后端 PlatformHealthRule.REPORT_STALLED_THRESHOLD_MS 一致）。 */
const REPORT_LAG_THRESHOLD_MS = 45_000;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await getAccessOverview();
    reported.value = data.metrics.reported;
    rows.value = (data.nodes ?? []).map((node) => ({
      key: node.accessNode,
      accessNode: node.accessNode,
      maxTenants:
        node.maxTenants === null || node.maxTenants === undefined
          ? $t('page.iot.overview.unlimited')
          : String(node.maxTenants),
      holding: toText(node.holdingCount),
      earliestExpire: toText(node.leaseExpireMin),
      lastRegistered: toText(node.lastRegisteredAt),
      leaseAlive: leaseAliveText(node.leaseAlive),
      leaseRemaining: toText(node.leaseRemainingSec),
    }));
    const m = data.metrics;
    metrics.value = [
      {
        label: $t('page.iot.overview.reportLag'),
        value: toText(m.reportLagMs),
      },
      {
        label: $t('page.iot.overview.reconcileDeferred'),
        value: reported.value ? toText(m.reconcileDeferredCount) : '-',
      },
      {
        label: $t('page.iot.overview.tickMax'),
        value: reported.value ? toText(m.tickDurationMaxMs) : '-',
      },
      {
        label: $t('page.iot.overview.specLoadMax'),
        value: reported.value ? toText(m.specLoadDurationMaxMs) : '-',
      },
      {
        label: $t('page.iot.overview.selfFenced'),
        value: reported.value ? toText(m.selfFencedCount) : '-',
      },
      {
        label: $t('page.iot.overview.nodeFenced'),
        value: reported.value ? toText(m.nodeFencedCount) : '-',
      },
      {
        label: $t('page.iot.overview.renewFailure'),
        value: reported.value ? toText(m.renewFailureCount) : '-',
      },
      {
        label: $t('page.iot.overview.egressPending'),
        value: reported.value ? toText(m.egressPendingCount) : '-',
      },
    ];
  } catch (error_) {
    error.value = extractErrorMessage(
      error_,
      $t('page.iot.overview.listLoadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

function reportState(): string {
  if (!reported.value) {
    return $t('page.iot.overview.noReport');
  }
  return Number(metrics.value[0]?.value ?? 0) >= REPORT_LAG_THRESHOLD_MS
    ? $t('page.iot.overview.interrupted')
    : $t('page.iot.overview.normal');
}

onMounted(load);
</script>

<template>
  <div class="flex h-full flex-col gap-4 p-4">
    <Alert v-if="error" :message="error" type="error" show-icon closable />
    <Card>
      <template #title>
        <span>{{ $t('page.iot.overview.reported') }}</span>
        <Tag
          class="ml-2"
          :color="
            reported
              ? Number(metrics[0]?.value ?? 0) >= 45000
                ? 'error'
                : 'success'
              : 'default'
          "
        >
          {{ reportState() }}
        </Tag>
      </template>
      <template #extra>
        <Button :loading="loading" size="small" @click="load">
          {{ $t('page.iot.overview.refresh') }}
        </Button>
      </template>
      <Descriptions :column="4" size="small" bordered>
        <Descriptions.Item
          v-for="item in metrics"
          :key="item.label"
          :label="item.label"
        >
          {{ item.value }}
        </Descriptions.Item>
      </Descriptions>
    </Card>
    <Card :title="$t('page.iot.overview.overview')">
      <Table
        :columns="[
          {
            title: $t('page.iot.overview.node'),
            dataIndex: 'accessNode',
            key: 'accessNode',
          },
          {
            title: $t('page.iot.overview.maxTenants'),
            dataIndex: 'maxTenants',
            key: 'maxTenants',
          },
          {
            title: $t('page.iot.overview.holding'),
            dataIndex: 'holding',
            key: 'holding',
          },
          {
            title: $t('page.iot.overview.earliestExpire'),
            dataIndex: 'earliestExpire',
            key: 'earliestExpire',
          },
          {
            title: $t('page.iot.overview.lastRegistered'),
            dataIndex: 'lastRegistered',
            key: 'lastRegistered',
          },
          {
            title: $t('page.iot.overview.leaseAlive'),
            dataIndex: 'leaseAlive',
            key: 'leaseAlive',
          },
          {
            title: $t('page.iot.overview.leaseRemaining'),
            dataIndex: 'leaseRemaining',
            key: 'leaseRemaining',
          },
        ]"
        :data-source="rows"
        :loading="loading"
        :pagination="false"
        row-key="key"
        size="small"
      >
        <template #emptyText>
          <span>{{ $t('page.iot.overview.noData') }}</span>
        </template>
      </Table>
    </Card>
  </div>
</template>

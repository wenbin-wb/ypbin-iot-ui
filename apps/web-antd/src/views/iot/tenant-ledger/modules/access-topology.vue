<script lang="ts" setup>
import type { EchartsUIType } from '@vben/plugins/echarts';

import type { IotLedgerApi } from '#/api/iot';
import type {
  AccessNodeOverview,
  AccessOverview,
} from '#/api/iot/accessOverview';

import { computed, onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

import { Button, Card, Empty, Spin, Tag } from 'ant-design-vue';

import { getTenantLedgerList } from '#/api/iot';
import { getAccessOverview } from '#/api/iot/accessOverview';
import { getTenantList } from '#/api/system/tenant';
import { $t } from '#/locales';
import { useChartThemeRefresh } from '#/utils/use-chart-theme';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime } from '../../shared/display';
import ListErrorAlert from '../../shared/list-error-alert.vue';
import { buildTenantNameMap } from '../ledger-display';
import {
  TOPOLOGY_COLOR_BAD,
  TOPOLOGY_COLOR_EDGE,
  TOPOLOGY_COLOR_OK,
  TOPOLOGY_COLOR_TENANT,
  TOPOLOGY_COLOR_UNKNOWN,
} from './access-topology-colors';

/**
 * 接入拓扑（**内容组件**：不含 Page；宿主见同目录 index.vue 的第三个页签）。
 *
 * 数据源三个（都只读）：
 * - `GET /iot/access-overview`：接入节点 + access 侧健康指标；
 * - `GET /iot/tenant-ledger`：租户接入台账（deviceCount / assignable / lastReportAt）；
 * - `GET /system/tenant/list`：租户名解析（**展示增强**，失败回落 tenantId，不阻塞拓扑）。
 *
 * 图里只画两类星形边：平台 → 接入节点、平台 → 租户。
 * **不画 accessNode → tenant 的归属边**：后端契约里没有这层映射（见卡片底部提示文案），
 * 画出来就是编造。节点大小按 holdingCount / deviceCount；接入节点颜色按 leaseAlive，
 * 平台颜色按 reportLag 阈值（45s，与后端 `PlatformHealthRule.REPORT_STALLED_THRESHOLD_MS` 一致），
 * 租户节点按 assignable（不可接入 = 灰）——所有颜色规则都在图例与提示里可解释。
 */
const REPORT_LAG_THRESHOLD_MS = 45_000;

const PLATFORM_NODE_ID = 'platform';
const ACCESS_NODE_PREFIX = 'access:';
const TENANT_NODE_PREFIX = 'tenant:';

// 图表色值从 `access-topology-colors.ts` 引入：ECharts 用 Canvas 渲染，无法解析
// `hsl(var(--token))`，故只能在常量模块里保留具体色值（原因见该文件头注释）。
const COLOR_OK = TOPOLOGY_COLOR_OK;
const COLOR_BAD = TOPOLOGY_COLOR_BAD;
const COLOR_UNKNOWN = TOPOLOGY_COLOR_UNKNOWN;
const COLOR_TENANT = TOPOLOGY_COLOR_TENANT;

interface MetricCard {
  key: string;
  label: string;
  tone: 'danger' | 'muted' | 'normal';
  value: string;
}

interface TopologyNode {
  category: number;
  id: string;
  itemStyle: { color: string };
  label: Record<string, number | string>;
  name: string;
  symbolSize: number;
  tooltip: string[];
  x: number;
  y: number;
}

interface TopologyEdge {
  source: string;
  target: string;
}

const loading = ref(false);
const accessError = ref('');
const ledgerError = ref('');
const tenantNameError = ref('');
const accessNodes = ref<AccessNodeOverview[]>([]);
const metrics = ref<AccessOverview['metrics']>();
const ledgerRows = ref<IotLedgerApi.LedgerResp[]>([]);
const tenantNameById = ref<Record<string, string>>({});

const chartRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(chartRef);

/**
 * 图表配置类型取自 `renderEcharts` 的入参（echarts 不是本应用的直接依赖，不能直接 import 它的类型）。
 * 显式标注返回值，否则 `type: 'graph'` / `layout: 'none'` 这类字面量会被放宽成 string，
 * 与 `GraphSeriesOption` 的联合类型不兼容（vue-tsc 会红）。
 */
type TopologyChartOption = Parameters<typeof renderEcharts>[0];

const reported = computed(() => metrics.value?.reported === true);
const reportLag = computed(() => numOrNull(metrics.value?.reportLagMs));

const hasTopologyData = computed(
  () => accessNodes.value.length > 0 || ledgerRows.value.length > 0,
);

/** 两个关键数据源都成功且有内容才画图；任一失败只显示可见错误，不画半张图伪装完整。 */
const graphReady = computed(
  () => !accessError.value && !ledgerError.value && hasTopologyData.value,
);

const reportTagColor = computed(() => {
  if (!reported.value) {
    return 'default';
  }
  const lag = reportLag.value;
  return lag !== null && lag >= REPORT_LAG_THRESHOLD_MS ? 'error' : 'success';
});

const platformColor = computed(() => {
  if (!reported.value) {
    return COLOR_UNKNOWN;
  }
  const lag = reportLag.value;
  if (lag === null) {
    return COLOR_UNKNOWN;
  }
  return lag >= REPORT_LAG_THRESHOLD_MS ? COLOR_BAD : COLOR_OK;
});

const metricCards = computed<MetricCard[]>(() => {
  const data = metrics.value;
  if (!data || !data.reported) {
    // access 未上报：四张卡统一说明「尚未上报」，绝不把缺省当 0 渲染。
    return [
      unreported('reportLag', 'page.iot.overview.reportLag'),
      unreported('reconcileDeferred', 'page.iot.overview.reconcileDeferred'),
      unreported('tickMax', 'page.iot.overview.tickMax'),
      unreported('selfFenced', 'page.iot.overview.selfFenced'),
    ];
  }
  const lag = numOrNull(data.reportLagMs);
  return [
    {
      key: 'reportLag',
      label: $t('page.iot.overview.reportLag'),
      tone:
        lag !== null && lag >= REPORT_LAG_THRESHOLD_MS ? 'danger' : 'normal',
      value: msText(data.reportLagMs),
    },
    {
      key: 'reconcileDeferred',
      label: $t('page.iot.overview.reconcileDeferred'),
      tone: isPositive(data.reconcileDeferredCount) ? 'danger' : 'normal',
      value: countText(data.reconcileDeferredCount),
    },
    {
      key: 'tickMax',
      label: $t('page.iot.overview.tickMax'),
      tone: 'normal',
      value: msText(data.tickDurationMaxMs),
    },
    {
      key: 'selfFenced',
      label: $t('page.iot.overview.selfFenced'),
      tone: isPositive(data.selfFencedCount) ? 'danger' : 'normal',
      value: countText(data.selfFencedCount),
    },
  ];
});

/** 图数据是**纯派生**：节点/边只来自接口字段，不引入前端猜测的归属关系。 */
const graphOption = computed((): TopologyChartOption => {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const access = accessNodes.value;
  const tenants = ledgerRows.value;
  const step = 76;

  nodes.push({
    category: 0,
    id: PLATFORM_NODE_ID,
    itemStyle: { color: platformColor.value },
    label: { fontSize: 12, fontWeight: 'bold', position: 'bottom' },
    name: $t('page.iot.topology.platform'),
    symbolSize: 58,
    tooltip: [
      `${$t('page.iot.overview.reported')}：${reportStateText()}`,
      `${$t('page.iot.overview.reportLag')}：${reported.value ? msText(metrics.value?.reportLagMs) : $t('page.iot.overview.noData')}`,
    ],
    x: 0,
    y: 0,
  });

  access.forEach((node, index) => {
    const id = `${ACCESS_NODE_PREFIX}${node.accessNode}`;
    nodes.push({
      category: 1,
      id,
      itemStyle: { color: leaseAliveColor(node.leaseAlive) },
      label: {
        overflow: 'break',
        position: 'left',
        width: 150,
      },
      name: accessNodeLabel(node),
      symbolSize: nodeSize(node.holdingCount, 18, 5, 48),
      tooltip: [
        `${$t('page.iot.overview.leaseAlive')}：${leaseAliveText(node.leaseAlive)}`,
        `${$t('page.iot.overview.holding')}：${countText(node.holdingCount)}`,
        `${$t('page.iot.overview.leaseRemaining')}：${countText(node.leaseRemainingSec)}`,
        `${$t('page.iot.overview.maxTenants')}：${
          node.maxTenants === null || node.maxTenants === undefined
            ? $t('page.iot.overview.unlimited')
            : String(node.maxTenants)
        }`,
        `${$t('page.iot.overview.lastRegistered')}：${formatDateTime(
          node.lastRegisteredAt,
          $t('page.iot.overview.noData'),
        )}`,
      ],
      x: -320,
      y: (index - (access.length - 1) / 2) * step,
    });
    edges.push({ source: PLATFORM_NODE_ID, target: id });
  });

  tenants.forEach((row, index) => {
    const id = `${TENANT_NODE_PREFIX}${row.tenantId}`;
    nodes.push({
      category: 2,
      id,
      itemStyle: { color: tenantColor(row) },
      label: {
        overflow: 'break',
        position: 'right',
        width: 150,
      },
      name: tenantLabel(row),
      symbolSize: nodeSize(row.deviceCount, 18, 3.5, 48),
      tooltip: [
        `${$t('page.iot.ledger.deviceCount')}：${tenantDeviceText(row)}`,
        `${$t('page.iot.ledger.assignable')}：${tenantAssignableText(row)}`,
        `${$t('page.iot.ledger.lastReportAt')}：${formatDateTime(
          row.lastReportAt,
          $t('page.iot.overview.noData'),
        )}`,
      ],
      x: 320,
      y: (index - (tenants.length - 1) / 2) * step,
    });
    edges.push({ source: PLATFORM_NODE_ID, target: id });
  });

  return {
    legend: {
      data: [
        $t('page.iot.topology.platform'),
        $t('page.iot.topology.accessNodes'),
        $t('page.iot.topology.tenants'),
      ],
      top: 0,
    },
    series: [
      {
        categories: [
          { name: $t('page.iot.topology.platform') },
          { name: $t('page.iot.topology.accessNodes') },
          { name: $t('page.iot.topology.tenants') },
        ],
        data: nodes,
        draggable: true,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 8,
        edges,
        emphasis: { focus: 'adjacency', lineStyle: { width: 2 } },
        label: { fontSize: 11, show: true },
        layout: 'none',
        lineStyle: { color: TOPOLOGY_COLOR_EDGE, curveness: 0.08, width: 1 },
        roam: true,
        scaleLimit: { max: 3, min: 0.5 },
        symbol: 'circle',
        type: 'graph',
      },
    ],
    tooltip: {
      // ECharts 的 formatter 参数是联合类型（data 可能是数组/null）⇒ 入口按 unknown 收窄，
      // 不给回调参数写窄类型（否则与 TooltipFormatterCallback 不兼容，vue-tsc 会红）。
      formatter: (params: unknown) => {
        const data = (params as null | { data?: TopologyNode })?.data;
        if (!data) {
          return '';
        }
        return [data.name, ...(data.tooltip ?? [])].join('<br/>');
      },
      // as const：computed 推断会把字面量放宽成 string，而 EChartsOption.trigger 只认 'item'
      trigger: 'item' as const,
    },
  };
});

function numOrNull(value?: null | number | string): null | number {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPositive(value?: null | number | string): boolean {
  const parsed = numOrNull(value);
  return parsed !== null && parsed > 0;
}

function countText(value?: null | number | string): string {
  const parsed = numOrNull(value);
  return parsed === null ? $t('page.iot.overview.noData') : String(parsed);
}

function msText(value?: null | number | string): string {
  const parsed = numOrNull(value);
  return parsed === null
    ? $t('page.iot.overview.noData')
    : `${parsed.toLocaleString()} ms`;
}

function unreported(key: string, labelKey: string): MetricCard {
  return {
    key,
    label: $t(labelKey),
    tone: 'muted',
    value: $t('page.iot.overview.noReport'),
  };
}

function leaseAliveText(value?: boolean | null): string {
  if (value === null || value === undefined) {
    return $t('page.iot.overview.noLease');
  }
  return value
    ? $t('page.iot.overview.leaseAliveYes')
    : $t('page.iot.overview.leaseExpired');
}

function leaseAliveColor(value?: boolean | null): string {
  if (value === null || value === undefined) {
    return COLOR_UNKNOWN;
  }
  return value ? COLOR_OK : COLOR_BAD;
}

/** 节点大小按数量平方根增长并封顶：小节点不被吞没，大节点不遮住邻居。 */
function nodeSize(
  value: null | number | string | undefined,
  base: number,
  scale: number,
  max: number,
): number {
  const parsed = Math.max(numOrNull(value) ?? 0, 0);
  return Math.min(max, base + Math.sqrt(parsed) * scale);
}

function reportStateText(): string {
  if (!reported.value) {
    return $t('page.iot.overview.noReport');
  }
  const lag = reportLag.value;
  return lag !== null && lag >= REPORT_LAG_THRESHOLD_MS
    ? $t('page.iot.overview.interrupted')
    : $t('page.iot.overview.normal');
}

function accessNodeLabel(node: AccessNodeOverview): string {
  const count = numOrNull(node.holdingCount);
  const holding =
    count === null
      ? $t('page.iot.overview.noData')
      : $t('page.iot.topology.holdingShort', [String(count)]);
  return `${node.accessNode}\n${holding}`;
}

function tenantLabel(row: IotLedgerApi.LedgerResp): string {
  const name = (tenantNameById.value[row.tenantId] ?? '').trim();
  return name === '' ? row.tenantId : name;
}

function tenantDeviceText(row: IotLedgerApi.LedgerResp): string {
  const count = numOrNull(row.deviceCount);
  return count === null
    ? $t('page.iot.ledger.pending')
    : $t('page.iot.topology.deviceShort', [String(count)]);
}

function tenantAssignableText(row: IotLedgerApi.LedgerResp): string {
  if (row.assignable === true) {
    return $t('page.iot.ledger.assignableOn');
  }
  if (row.assignable === false) {
    return $t('page.iot.ledger.assignableOff');
  }
  return $t('page.iot.display.unknown');
}

/** 租户节点颜色：明确「不可接入」置灰；其余保持品牌色（不猜未提供的状态）。 */
function tenantColor(row: IotLedgerApi.LedgerResp): string {
  return row.assignable === false ? COLOR_UNKNOWN : COLOR_TENANT;
}

/**
 * 批量解析 tenantId → 租户名称；失败不阻塞拓扑：节点名回落 tenantId，
 * 同时把失败原因放进可见 warning 提示（不静默吞，也不伪造名称）。
 */
async function resolveTenantNames(rows: IotLedgerApi.LedgerResp[]) {
  const ids = [...new Set(rows.map((row) => row.tenantId).filter(Boolean))];
  if (ids.length === 0) {
    tenantNameById.value = {};
    tenantNameError.value = '';
    return;
  }
  try {
    tenantNameById.value = buildTenantNameMap(await getTenantList());
    tenantNameError.value = '';
  } catch (error) {
    tenantNameById.value = {};
    tenantNameError.value = extractErrorMessage(
      error,
      $t('page.iot.ledger.tenantNameLoadFailed'),
    );
    console.warn(
      '[iot/tenant-ledger/topology] 租户名称解析失败，节点回落 tenantId（不伪造名称）',
      error,
    );
  }
}

async function load() {
  loading.value = true;
  accessError.value = '';
  ledgerError.value = '';
  tenantNameError.value = '';

  // 两个关键数据源互不依赖：并发拉取、各自独立报错（名称解析不参与 critical 判定）
  const [accessResult, ledgerResult] = await Promise.allSettled([
    getAccessOverview(),
    getTenantLedgerList(),
  ]);

  if (accessResult.status === 'fulfilled') {
    accessNodes.value = accessResult.value.nodes ?? [];
    metrics.value = accessResult.value.metrics;
  } else {
    accessNodes.value = [];
    metrics.value = undefined;
    accessError.value = extractErrorMessage(
      accessResult.reason,
      $t('page.iot.overview.listLoadFailed'),
    );
  }

  if (ledgerResult.status === 'fulfilled') {
    ledgerRows.value = ledgerResult.value ?? [];
    await resolveTenantNames(ledgerRows.value);
  } else {
    ledgerRows.value = [];
    tenantNameById.value = {};
    ledgerError.value = extractErrorMessage(
      ledgerResult.reason,
      $t('page.iot.ledger.listLoadFailed'),
    );
  }

  loading.value = false;
}

function renderChart() {
  if (!graphReady.value) {
    return;
  }
  renderEcharts(graphOption.value);
}

onMounted(load);

watch(
  graphOption,
  () => {
    renderChart();
  },
  { deep: true, flush: 'post' },
);

// 暗色/主题色变化后重绘：节点/边色在 `graphOption` 里解析为具体 rgb，
// 重建 option 才能拿到新主题的色值（canvas 不会自己重算）。
useChartThemeRefresh(renderChart);
</script>

<template>
  <div class="flex h-full flex-col gap-4 overflow-auto p-4">
    <ListErrorAlert
      v-if="accessError"
      :error="accessError"
      :title="$t('page.iot.overview.listLoadFailed')"
    />
    <ListErrorAlert
      v-if="ledgerError"
      :error="ledgerError"
      :title="$t('page.iot.ledger.listLoadFailed')"
    />
    <ListErrorAlert
      v-if="tenantNameError"
      :error="tenantNameError"
      :title="$t('page.iot.ledger.tenantNameLoadFailed')"
      type="warning"
    />

    <!-- 顶部健康指标卡：access 未上报时统一显示「尚未上报」，不把缺省当 0 -->
    <div
      v-if="!accessError"
      class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <div
        v-for="item in metricCards"
        :key="item.key"
        class="rounded-xl border border-border/80 bg-card p-4"
      >
        <p class="text-xs text-muted-foreground">{{ item.label }}</p>
        <p
          class="mt-1 text-xl font-semibold tabular-nums"
          :class="{
            'text-muted-foreground': item.tone === 'muted',
            // 语义 token：danger 色改用 text-destructive-text（跟随主题明/暗两档），
            // 不再硬编码 Tailwind 红色调色板类——后者在暗色下对比度不可控。
            'text-destructive-text': item.tone === 'danger',
          }"
        >
          {{ item.value }}
        </p>
      </div>
    </div>

    <Card :title="$t('page.iot.topology.title')">
      <template #extra>
        <div class="flex items-center gap-2">
          <Tag :color="reportTagColor">{{ reportStateText() }}</Tag>
          <Button :loading="loading" size="small" @click="load">
            {{ $t('page.iot.overview.refresh') }}
          </Button>
        </div>
      </template>

      <p class="mb-3 text-xs text-muted-foreground">
        {{ $t('page.iot.topology.desc') }}
      </p>

      <Spin :spinning="loading">
        <EchartsUI v-if="graphReady" ref="chartRef" height="520px" />
        <div
          v-else
          class="flex h-[520px] flex-col items-center justify-center gap-2"
        >
          <Empty
            v-if="!loading && !accessError && !ledgerError"
            :description="$t('page.iot.topology.empty')"
          />
          <span v-else-if="!loading" class="text-sm text-muted-foreground">
            {{ $t('page.iot.overview.noData') }}
          </span>
        </div>
      </Spin>

      <p class="mt-3 text-xs text-muted-foreground">
        {{ $t('page.iot.topology.noOwnershipHint') }}
      </p>
    </Card>
  </div>
</template>

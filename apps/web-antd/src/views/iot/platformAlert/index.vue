<script lang="ts" setup>
import type { RefreshGuard } from '../shared/refresh-guard';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotPlatformAlertApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { Page } from '@vben/common-ui';

import { Select, Tag, Tooltip } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getPlatformAlerts } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  EMPTY_TEXT,
  formatDateTime,
  platformHealthRuleLabelKey,
  prettyJson,
} from '../shared/display';
import ListErrorAlert from '../shared/list-error-alert.vue';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../shared/refresh-guard';
import {
  platformAlertSeverityColor,
  platformAlertSeverityLabelKey,
  platformAlertStateColor,
  platformAlertStateLabelKey,
} from './platform-alert-state';

/**
 * 平台自告警列表（菜单 /iot/platform-alerts，权限 iot:alert:list）。
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

/**
 * 列表的「静默丢弃」守卫（见 shared/refresh-guard.ts）。
 *
 * 为什么需要：vxe 在查询在途时会直接吞掉后续 `query`/`reload`（不报错、不转圈），
 * 用户在这个窗口点刷新/翻页/改筛选就是「点了没反应」；慢请求也没有客户端超时。
 * 这里登记每个查询意图，被吞掉的那次在本周期结束后用**最新筛选**补发一次。
 */
let listGuard: RefreshGuard;

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: [
      {
        field: 'ruleCode',
        title: $t('page.iot.platformAlert.rule'),
        minWidth: 180,
        slots: { default: 'ruleCode' },
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
          // 查询真的启动了 ⇒ 登记过的刷新意图已被执行，消费掉（没被 vxe 丢弃）
          listGuard.consumeIntent();
          try {
            const result = await withQueryTimeout(
              getPlatformAlerts({
                page: page.currentPage,
                pageSize: page.pageSize,
                state: stateFilter.value || undefined,
                severity: severityFilter.value || undefined,
              }),
            ).catch((error: unknown) => {
              // 客户端超时 ⇒ 换成用户能看懂的话（而不是永远转圈/静默）
              if (error instanceof QueryTimeoutError) {
                throw new TypeError($t('page.iot.common.queryTimeout'));
              }
              throw error;
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
          } finally {
            // 一个查询周期结束（成功/失败都算）⇒ 若期间有被丢弃的意图，守卫会补发
            listGuard.notifyCycleEnd();
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotPlatformAlertApi.PlatformAlertResp>,
  gridEvents: {
    // 翻页与工具栏刷新由 vxe 自己发起 commitProxy，页面只能靠事件知道「这次意图可能被丢弃」
    pageChange: () => listGuard.markIntent(),
    toolbarButtonClick: ({ code }: { code?: string }) => {
      if (code === 'reload' || code === 'query') {
        listGuard.markIntent();
      }
    },
  },
});

listGuard = createRefreshGuard({
  isBusy: () => Boolean(gridApi.grid?.reactData?.tableLoading),
  issue: () => {
    void gridApi.query();
  },
  onTrailing: (active) => gridApi.setLoading(active),
});

/**
 * 筛选变化后刷新。
 *
 * 必须先回第 1 页：`query()` 不会重置 `tablePage.currentPage`（vxe 只有 `reload`/`initial` 重置），
 * 原实现在第 3 页改筛选仍请求 page=3 ⇒ 结果只有 1 页时表格空白，
 * 上方筛选条却显示「已筛选」，用户会误判「没有严重告警」。
 */
async function reloadOnFilter() {
  await gridApi.grid?.setCurrentPage(1);
  listGuard.request();
}
</script>

<template>
  <!-- 架构对齐：补上 auto-content-height（此前高度链与其它页不一致） -->
  <Page auto-content-height>
    <!-- 页面主标题：视觉上隐藏，供读屏/文档大纲使用（全站 0 个 h1 是审查 P3-5 指出的可访问性缺陷） -->
    <h1 class="sr-only">{{ $t('page.iot.platformAlert.title') }}</h1>
    <template v-if="canView">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <div class="font-semibold">
          {{ $t('page.iot.platformAlert.title') }}
        </div>
        <Select
          v-model:value="stateFilter"
          allow-clear
          :placeholder="$t('page.iot.platformAlert.allStates')"
          class="w-40 max-w-full"
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
          class="w-40 max-w-full"
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

      <!-- 失败态挂在表格之外：vxe 的 #empty 分不清「加载失败」与「真的没有告警」。 -->
      <ListErrorAlert
        :error="listError"
        :title="$t('page.iot.platformAlert.loadFailed')"
      />

      <Grid>
        <template #empty>
          <!-- 失败时由上方 ListErrorAlert 承担，不得再声称「暂无告警」。 -->
          <span v-if="!listError" class="text-muted-foreground">
            {{ $t('page.iot.platformAlert.empty') }}
          </span>
        </template>

        <template #ruleCode="{ row }">
          <!-- 规则名走码表，原码放 tooltip 便于排障（未知码由 helper 给「未知规则」）。 -->
          <Tooltip :title="row.ruleCode || undefined">
            <span class="cursor-help">
              {{ $t(platformHealthRuleLabelKey(row.ruleCode)) }}
            </span>
          </Tooltip>
        </template>

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
          <!-- 快照原样存 JSON：单元格只给可滚动的限高窗口，完整美化 JSON 放 tooltip。 -->
          <Tooltip v-if="row.metricSnapshot" placement="topLeft">
            <template #title>
              <pre
                class="m-0 max-h-80 max-w-[480px] overflow-auto whitespace-pre-wrap text-xs"
                >{{ prettyJson(row.metricSnapshot) }}</pre>
            </template>
            <pre
              class="m-0 max-h-16 max-w-[240px] cursor-help overflow-auto whitespace-pre-wrap break-all text-xs"
              >{{ prettyJson(row.metricSnapshot) }}</pre>
          </Tooltip>
          <span v-else class="text-muted-foreground">{{ EMPTY_TEXT }}</span>
        </template>
        <template #startTs="{ row }">
          {{ formatDateTime(row.startTs) }}
        </template>
        <template #resolvedTs="{ row }">
          {{ formatDateTime(row.resolvedTs) }}
        </template>
      </Grid>
    </template>
    <div v-else class="p-4 text-sm text-muted-foreground">
      {{ $t('page.iot.platformAlert.noPermission') }}
    </div>
  </Page>
</template>

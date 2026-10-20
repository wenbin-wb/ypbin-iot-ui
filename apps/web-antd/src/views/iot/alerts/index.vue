<script lang="ts" setup>
import type { RefreshGuard } from '../shared/refresh-guard';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotAlertApi } from '#/api/iot';

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';

import { Alert, Button, Empty, Tabs, Tag } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { getAlertPage, getAlertRulePage, getDeviceOptions } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime } from '../shared/display';
import {
  ALERT_INSTANCE_FILTER_DEFAULTS,
  ALERT_INSTANCE_FILTER_PAGE,
  ALERT_INSTANCE_FILTER_SHAPE,
  ALERT_INSTANCE_FILTER_VERSION,
  loadFilter,
  pickFilterFields,
  saveFilterIfChanged,
} from '../shared/list-filter';
import PanelErrorBoundary from '../shared/panel-error-boundary.vue';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../shared/refresh-guard';
import { watchGridForRunawayHeight } from './alerts-layout';
import { resolveBatchDisabledReason } from './batch-reasons';
import {
  conditionText,
  humanSeconds,
  scopeLabelKey,
  scopeTargetText,
  severityColor,
  severityLabelKey,
  stateColor,
  stateLabelKey,
  useInstanceColumns,
  useInstanceFormSchema,
  useRuleColumns,
} from './data';
import { listSlotState, resolveDeviceFilter } from './list-state';
import InstanceExpand from './modules/instance-expand.vue';
import InstanceStatus from './modules/instance-status.vue';
import InstanceToolbar from './modules/instance-toolbar.vue';
import NotifyRiskTag from './modules/notify-risk-tag.vue';
import RuleForm from './modules/rule-form.vue';
import RuleToolbar from './modules/rule-toolbar.vue';
import { useAlertExport } from './use-alert-export';
import { useAlertInstanceActions } from './use-alert-instance-actions';
import { useAlertRealtime } from './use-alert-realtime';
import { useAlertRuleActions } from './use-alert-rule-actions';
import { useAlertSummary } from './use-alert-summary';

/**
 * 全局告警中心（用户口径 ⑥⑦：三处可达 + 空态引导 + 失败态原样展示后端 message）。
 *
 * 两个页签：**告警列表**（活动与历史同一张表，靠筛选区分）与**告警规则**（一键模板创建/编辑/启停）。
 * 权限：`iot:alert:list`（查）、`iot:alert:ack`（确认/静默）、`iot:alert:rule-list`/`iot:alert:rule-save`（规则）。
 * 页签级权限用 `computed + v-if`（`v-access` 摘不掉 Tabs 的表头，会留下点得动但空白的页签）。
 */
const { hasAccessByCodes } = useAccess();

const canViewAlert = computed(() => hasAccessByCodes(['iot:alert:list']));

const canAck = computed(() => hasAccessByCodes(['iot:alert:ack']));

const canViewRule = computed(() => hasAccessByCodes(['iot:alert:rule-list']));

const canSaveRule = computed(() => hasAccessByCodes(['iot:alert:rule-save']));

/**
 * 实时流接线（断线提示 / 鉴权失败常驻提示 / alert 事件去抖刷新）收在 composable 里：
 * 页面只提供「刷新走哪条链路」，连接健康与文案留在 `use-alert-realtime`（拆分批次 5-D）。
 */
const {
  realtimeAuthError,
  realtimeDisconnected,
  realtimeError,
  realtimeUnavailable,
  reLogin: onReLogin,
} = useAlertRealtime(() => {
  // 刷新只有一条路径：列表走守卫 request、摘要走串行化，避免实时事件另开一条刷新分支
  void reloadAll();
});

const [RuleDrawer, RuleDrawerApi] = useVbenDrawer({
  connectedComponent: RuleForm,
});

const activeTab = ref('list');

const route = useRoute();

const router = useRouter();

/**
 * 从设备台账行「告警」入口带过来的设备 ID（`/iot/alerts?deviceId=xxx`）。
 *
 * 取舍：直接并入查询条件而**不去改写筛选控件**（vben 的 vxe 适配层没有稳定的「设置筛选初值」入口），
 * 因此筛选框里显示「全部设备」而结果已按该设备过滤 —— 这一点在页面上以提示文案说明，
 * 避免用户误以为筛选失效（宁可有解释，也不要静默的空列表）。
 */
const presetDeviceId = ref(
  typeof route.query.deviceId === 'string' ? route.query.deviceId : '',
);

/** 入口提示里展示的设备名（解析失败回落为空串，模板再回落 deviceId）。 */
const presetDeviceName = ref('');

/** 设备名可用则用名，否则回落裸 ID —— 两种形态都是页面已知的事实。 */
const presetDeviceLabel = computed(
  () => presetDeviceName.value || presetDeviceId.value,
);

/**
 * 设备入口的 deviceId → 设备名（展示增强，失败回落显示 deviceId）。
 *
 * 用 `getDeviceOptions` 一次拉 200 条建映射，绝不按行发请求；设备名只影响入口提示，
 * 解析失败不影响列表与筛选，但必须 `console.warn` 留痕，不能静默吞掉。
 */
async function resolvePresetDeviceName() {
  const id = presetDeviceId.value;
  if (!id) {
    return;
  }
  try {
    const options = await getDeviceOptions();
    const hit = (options ?? []).find((device) => device.id === id);
    presetDeviceName.value = hit?.deviceName || hit?.deviceCode || '';
  } catch (error) {
    console.warn(
      '[iot/alerts] 设备名称解析失败，入口提示回落显示 deviceId',
      error,
    );
  }
}

/** 顶部计数（**一次聚合查询**给出，不拿列表长度当计数）；串行化与失败文案见 composable。 */
const { reload: reloadSummary, summary, summaryError } = useAlertSummary();

// ---------------------------------------------------------------- 告警列表

const listError = ref('');

const selectedIds = ref<string[]>([]);

/**
 * 实例表的「静默丢弃」守卫（见 shared/refresh-guard.ts）。
 *
 * 生命周期：`useVbenVxeGrid` 返回的 api 先就位，再创建守卫；网格组件真正
 * 挂载/查询发生在 setup 之后，闭包拿到的引用必然已赋值。
 */
let instanceGuard: RefreshGuard;

// 筛选持久化：首次进入回填上次筛选（loadFilter 已净化，不信任存储）
const savedInstanceFilter = loadFilter(
  ALERT_INSTANCE_FILTER_PAGE,
  ALERT_INSTANCE_FILTER_VERSION,
  ALERT_INSTANCE_FILTER_SHAPE,
  ALERT_INSTANCE_FILTER_DEFAULTS,
);
const [InstanceGrid, instanceGridApi] = useVbenVxeGrid({
  formOptions: {
    schema: useInstanceFormSchema(savedInstanceFilter),
    submitOnChange: true,
  },

  gridOptions: {
    columns: useInstanceColumns(),
    expandConfig: { padding: true },
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    checkboxConfig: { checkMethod: () => canAck.value },
    proxyConfig: {
      ajax: {
        query: async ({ page }, formValues: IotAlertApi.InstanceQuery) => {
          // 查询真正启动 ⇒ 任何刷新意图都被执行了（没被 vxe 丢弃），消费掉
          instanceGuard.consumeIntent();
          // 筛选持久化：查询启动即持久化当前筛选（幂等：值无变化不写）
          saveFilterIfChanged(
            ALERT_INSTANCE_FILTER_PAGE,
            ALERT_INSTANCE_FILTER_VERSION,
            Object.assign(
              {},
              ALERT_INSTANCE_FILTER_DEFAULTS,
              pickFilterFields(formValues ?? {}),
            ),
          );
          try {
            const result = await withQueryTimeout(
              getAlertPage({
                page: page.currentPage,
                pageSize: page.pageSize,
                ...formValues,
                // 合并规则见 `resolveDeviceFilter`（表单显式选择优先，其次才是 URL 带来的设备）
                deviceId: resolveDeviceFilter(
                  (formValues as IotAlertApi.InstanceQuery | undefined)
                    ?.deviceId,
                  presetDeviceId.value || undefined,
                ),
              }),
            ).catch((error: unknown) => {
              // 客户端超时 ⇒ 给用户能看懂的话（而不是永远转圈）
              if (error instanceof QueryTimeoutError) {
                throw new TypeError($t('page.iot.alert.queryTimeout'));
              }
              throw error;
            });
            listError.value = '';
            // 后端 `total` 是 long ⇒ 全局序列化成**字符串**；vxe 分页要做算术 ⇒ 进表格前显式转数。
            // 只返回**本页**结果：vxe 收到后走 `loadData` **整体替换**表体（不是 append/merge），
            // 这一条由 `list-refresh.test.ts` 用真实 vxe 守门。
            // 并发由 vxe 自己在 `commitProxy` 里守（`tableLoading` 期间再来的 query 直接 return），
            // 所以这里不会出现「两个 ajax.query 同时在途、旧响应写回 listError」的乱序。
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            // 记下失败原因（原样展示后端 message），再把异常继续抛出（不改动既有失败语义）
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.alert.listLoadFailed'),
            );
            throw error;
          } finally {
            // 一个查询周期结束（成功或失败）⇒ 若这段时间里有被丢弃的刷新意图，守卫会补发
            instanceGuard.notifyCycleEnd();
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: {
      custom: true,
      export: false,
      refresh: true,
      search: true,
      zoom: true,
    },
  } as VxeTableGridOptions<IotAlertApi.InstanceResp>,
  gridEvents: {
    // 🔴 勾选事件**必须**走 gridEvents：`useVbenVxeGrid` 返回的 Grid 包装组件没有
    // `defineEmits`，模板上的 checkbox-change 模板监听会作为 fallthrough attr 落到根 div，
    // 而 vxe 的 `checkbox-change` 只绑在内层 `<VxeGrid v-on="events">`（自定义事件不冒泡）
    // ⇒ 模板监听永远收不到、`selectedIds` 恒空、批量按钮恒禁用（P0-1）。
    checkboxChange: onCheckboxChange,
    // 真实事件信号：页签刷新按钮、分页翻页都由 vxe 自己发起 commitProxy，
    // 页面要能知道「这次意图可能被丢弃」只能靠这些事件登记。
    // （vben 表单的提交/重置走适配层 `api.reload`，不会触发 vxe 的 form-* 事件；
    //   该入口在途丢弃暂由同一竞态窗口外的其它入口补发场景兜住——残余缺口见 PR 说明。）
    pageChange: () => instanceGuard.markIntent(),
    toolbarButtonClick: ({ code }: { code?: string }) => {
      if (code === 'reload' || code === 'query') {
        instanceGuard.markIntent();
      }
    },
  },
});

instanceGuard = createRefreshGuard({
  isBusy: () => Boolean(instanceGridApi.grid?.reactData?.tableLoading),
  issue: () => {
    void instanceGridApi.query();
  },
  onTrailing: (active) => instanceGridApi.setLoading(active),
});

function onCheckboxChange({
  records,
}: {
  records: IotAlertApi.InstanceResp[];
}) {
  selectedIds.value = records.map((item) => item.id);
}

async function reloadAll() {
  instanceGuard.request();
  await reloadSummary();
}

/**
 * 告警实例处置动作（单条/批量确认与静默）：调 API → 播报生效条数 → 清勾选 → 整页刷新，
 * 整条链路由 `use-alert-instance-actions` 单点维护。
 */
const {
  ack: onAck,
  batchAck: onBatchAck,
  batchAckPending,
  batchSilence: onBatchSilence,
  batchSilencePending,
  silence: onSilence,
} = useAlertInstanceActions({ reloadAll, selectedIds });

/** 批量按钮禁用原因：同一条优先级规则（在途 > 未勾选）收在 `./batch-reasons`，三处按钮共用。 */
const batchAckDisabledReason = computed(() =>
  resolveBatchDisabledReason(batchAckPending.value, selectedIds.value.length),
);

const batchSilenceDisabledReason = computed(() =>
  resolveBatchDisabledReason(
    batchSilencePending.value,
    selectedIds.value.length,
  ),
);

/**
 * 导出当前筛选条件下的告警实例 CSV（防重 + 伪文件识别 + 失败原样提示，见 `use-alert-export`）。
 *
 * 表单值与 URL 设备过滤都以 getter 注入：导出参数必须与列表查询同源（页面持有这两处事实）。
 */
const { exportLoading, onExportCsv } = useAlertExport({
  getFormValues: () =>
    (instanceGridApi.formApi?.form?.values ?? {}) as IotAlertApi.InstanceQuery,
  getPresetDeviceId: () => presetDeviceId.value,
});

// ---------------------------------------------------------------- 告警规则

const ruleError = ref('');

/** 规则表的「静默丢弃」守卫（与实例表同构，见 shared/refresh-guard.ts）。 */
let ruleGuard: RefreshGuard;

const [RuleGrid, ruleGridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useRuleColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) => {
          ruleGuard.consumeIntent();
          try {
            const result = await withQueryTimeout(
              getAlertRulePage({
                page: page.currentPage,
                pageSize: page.pageSize,
              }),
            ).catch((error: unknown) => {
              if (error instanceof QueryTimeoutError) {
                throw new TypeError($t('page.iot.alert.queryTimeout'));
              }
              throw error;
            });
            ruleError.value = '';
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            ruleError.value = extractErrorMessage(
              error,
              $t('page.iot.alert.rule.listLoadFailed'),
            );
            throw error;
          } finally {
            ruleGuard.notifyCycleEnd();
          }
        },
      },
    },
    checkboxConfig: { checkMethod: () => canSaveRule.value },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotAlertApi.RuleResp>,
  gridEvents: {
    // 与实例表同理：模板上直接写的 checkbox-change 监听收不到，规则批量启停会恒禁用（P0-1 第二处）
    checkboxChange: onRuleCheckboxChange,
    pageChange: () => ruleGuard.markIntent(),
    toolbarButtonClick: ({ code }: { code?: string }) => {
      if (code === 'reload' || code === 'query') {
        ruleGuard.markIntent();
      }
    },
  },
});

ruleGuard = createRefreshGuard({
  isBusy: () => Boolean(ruleGridApi.grid?.reactData?.tableLoading),
  issue: () => {
    void ruleGridApi.query();
  },
  onTrailing: (active) => ruleGridApi.setLoading(active),
});

/** 规则勾选（批量启用/停用）；与告警列表的勾选互不影响。 */
const selectedRuleIds = ref<string[]>([]);

function onRuleCheckboxChange({
  records,
}: {
  records: IotAlertApi.RuleResp[];
}) {
  selectedRuleIds.value = records.map((item) => item.id);
}

/**
 * 规则启停动作（单条/批量启用、停用）：与实例处置同构的「调 API → 播报生效条数 → 清勾选 →
 * 刷新」链路，由 `use-alert-rule-actions` 单点维护；二次确认仍由模板 Popconfirm 负责。
 */
const {
  batchToggleRule: onBatchToggleRule,
  ruleTogglePending,
  toggleRule: onToggleRule,
} = useAlertRuleActions({
  requestReload: () => ruleGuard.request(),
  selectedRuleIds,
});

/** 批量按钮禁用原因（与实例表同口径：在途 > 未勾选；规则收在 `./batch-reasons`）。 */
const ruleBatchDisabledReason = computed(() =>
  resolveBatchDisabledReason(
    ruleTogglePending.value,
    selectedRuleIds.value.length,
  ),
);

/** 关闭「按设备过滤」提示：清本地过滤 + **把 URL 上的 deviceId 也去掉**（否则刷新后过滤会回来）。 */
function onClearDeviceFilter() {
  presetDeviceId.value = '';
  if (typeof route.query.deviceId === 'string') {
    void router.replace({
      path: route.path,
      query: { ...route.query, deviceId: undefined },
    });
  }
  instanceGuard.request();
}

/** 高度看门狗（纯 DOM 采样，实现在 `./alerts-layout`，与判据/常量同文件）见 {@link watchGridForRunawayHeight}。 */

let stopHeightWatch: (() => void) | undefined;

onMounted(() => {
  void reloadSummary();
  // 设备台账跳转带 ?deviceId=xxx：提示里显示设备名，找不到/解析失败回落裸 ID
  void resolvePresetDeviceName();
  // 规则页签与实例页签共用同一条确定高度链，只盯实例表即可覆盖两条链的自反馈风险
  stopHeightWatch = watchGridForRunawayHeight(
    instanceGridApi as never,
    '告警实例表',
  );
});

onUnmounted(() => {
  // 实时事件去抖的取消在 `useAlertRealtime` 内部（onUnmounted），这里只剩表格相关清理
  stopHeightWatch?.();
  instanceGuard?.dispose();
  ruleGuard?.dispose();
});
</script>

<template>
  <!--
    🔴 高度修复（2026-10 生产实测）：本页在 `Page auto-content-height` 与两个表格之间
    隔了一层 antd `Tabs`。`.ant-tabs-tabpane` 默认 `flex:none; width:100%`（高度=内容），
    会把「确定高度链」打断成「内容高度反推」链：vxe `height:'auto'` 的量父回写
    （ResizeObserver）与父高度=内容形成自反馈 ⇒ 行数恒为 2 表体却无限增高（见
    `alerts-layout.ts` 的机制注释与用例）。
    修复：Tabs 根 `h-full` 占满 Page 内容区，tabpane 定高为列 flex，两个表格壳
    `flex-1 min-h-0` 吃剩余高度 ⇒ 链条与设备台账同构（父容器确定高度）。
    `ALERTS_LAYOUT.requiredDeepRules` 与 `alerts-layout.test.ts` 看守这些标记。
  -->
  <Page auto-content-height>
    <!--
      页面主标题：视觉上标题由页头/菜单承担，这里给读屏用的唯一 <h1>
      （全站此前 0 个 h1 ⇒ 读屏「按 H 跳标题」在长表格页完全失效）。
    -->
    <h1 class="sr-only">{{ $t('page.iot.alert.title') }}</h1>
    <!--
      实时流鉴权失败必须常驻可见（P1-1）：
      `unauthorized`（401，会话可能过期）给「重新登录」入口；`forbidden`（403）只说明无权限
      —— 两者都不由客户端自动登出，避免「登出 → 重订阅 → 再 401」的循环。
    -->
    <Alert
      v-if="realtimeUnavailable"
      class="mb-2"
      show-icon
      type="warning"
      :message="
        realtimeAuthError === 'forbidden'
          ? $t('page.iot.realtime.forbidden')
          : $t('page.iot.realtime.authFailed')
      "
    >
      <template v-if="realtimeAuthError === 'unauthorized'" #action>
        <Button size="small" type="primary" @click="onReLogin">
          {{ $t('authentication.loginAgainTitle') }}
        </Button>
      </template>
    </Alert>
    <PanelErrorBoundary title-key="page.iot.alert.renderFailed">
      <Tabs v-model:active-key="activeTab" :animated="false" class="h-full">
        <!-- ===== 告警列表 ===== -->
        <Tabs.TabPane
          v-if="canViewAlert"
          key="list"
          :tab="$t('page.iot.alert.tabList')"
        >
          <!-- 状态区（入口提示/摘要/断线/失败/租户引导）是只读展示 + 一个关闭动作，见子组件 -->
          <InstanceStatus
            :list-error="listError"
            :preset-device-id="presetDeviceId"
            :preset-device-label="presetDeviceLabel"
            :realtime-disconnected="realtimeDisconnected"
            :realtime-error="realtimeError"
            :summary="summary"
            :summary-error="summaryError"
            @clear-device-filter="onClearDeviceFilter"
          />
          <!--
            勾选事件必须走 `gridEvents.checkboxChange`（见 script 里的接线注释）：
            模板上直接写的 checkbox-change 监听在本包装组件上收不到（P0-1）。
          -->
          <InstanceGrid class="flex-1 min-h-0">
            <template #toolbar-tools>
              <InstanceToolbar
                :batch-ack-disabled-reason="batchAckDisabledReason"
                :batch-ack-pending="batchAckPending"
                :batch-silence-disabled-reason="batchSilenceDisabledReason"
                :batch-silence-pending="batchSilencePending"
                :can-ack="canAck"
                :export-loading="exportLoading"
                :selected-count="selectedIds.length"
                @batch-ack="onBatchAck"
                @batch-silence="onBatchSilence"
                @export="onExportCsv"
              />
            </template>

            <!-- 空态引导：说明「为什么是空的 + 下一步点哪里」，而不是一张空白表格 -->
            <template #empty>
              <!-- 判据抽成纯函数 listSlotState：失败**绝不**画成空态（有可运行用例守门） -->
              <Empty
                v-if="listSlotState(listError, 0) === 'empty'"
                :description="$t('page.iot.alert.emptyReason')"
              />
            </template>

            <template #severity="{ row }">
              <Tag :color="severityColor(row.severity)">
                {{ $t(severityLabelKey(row.severity)) }}
              </Tag>
            </template>
            <template #state="{ row }">
              <Tag :color="stateColor(row.state)">
                {{ $t(stateLabelKey(row.state)) }}
              </Tag>
            </template>
            <template #startTs="{ row }">
              {{ formatDateTime(row.startTs) }}
            </template>

            <template #duration="{ row }">
              {{ humanSeconds(row.durationSeconds) }}
            </template>

            <template #rule="{ row }">
              <span v-if="row.outage">{{
                $t('page.iot.alert.kind.offline')
              }}</span>
              <span v-else>{{ row.ruleName ?? '-' }}</span>
            </template>

            <!-- 展开行：触发值 / 阈值 / 时间线 / 投递记录 / 该点位近期曲线缩略（见子组件） -->
            <template #expand="{ row }">
              <InstanceExpand :row="row" />
            </template>

            <template #action="{ row }">
              <VbenTableAction
                :actions="[
                  {
                    text: $t('page.iot.alert.ack'),
                    icon: 'lucide:check',
                    auth: 'iot:alert:ack',
                    disabled: row.state !== 'FIRING',
                    onClick: () => onAck([row.id]),
                  },
                  {
                    text: $t('page.iot.alert.silenceOneHour'),
                    icon: 'lucide:bell-off',
                    auth: 'iot:alert:ack',
                    disabled: row.state === 'RESOLVED',
                    popConfirm: {
                      title: $t('page.iot.alert.silenceConfirm'),
                      confirm: () => onSilence([row.id], 60),
                    },
                  },
                ]"
                align="center"
              />
            </template>
          </InstanceGrid>
        </Tabs.TabPane>

        <!-- ===== 告警规则 ===== -->
        <Tabs.TabPane
          v-if="canViewRule"
          key="rules"
          :tab="$t('page.iot.alert.tabRules')"
        >
          <Alert
            v-if="ruleError"
            class="mb-2"
            :description="ruleError"
            :message="$t('page.iot.alert.rule.listLoadFailed')"
            show-icon
            type="error"
          />
          <RuleGrid class="flex-1 min-h-0">
            <template #toolbar-tools>
              <RuleToolbar
                :can-save-rule="canSaveRule"
                :disabled-reason="ruleBatchDisabledReason"
                :selected-count="selectedRuleIds.length"
                :toggle-pending="ruleTogglePending"
                @create="RuleDrawerApi.setData({}).open()"
                @toggle="onBatchToggleRule"
              />
            </template>

            <template #empty>
              <Empty
                v-if="listSlotState(ruleError, 0) === 'empty'"
                :description="$t('page.iot.alert.rule.emptyReason')"
              />
            </template>

            <template #scope="{ row }">
              <!-- 用映射函数而不是动态拼键：未知 scopeType 会渲染出 `page.iot.alert.scope.xxx` 原始键 -->
              {{ $t(scopeLabelKey(row.scopeType)) }}
            </template>
            <template #scopeTarget="{ row }">
              {{ scopeTargetText(row) }}
            </template>
            <template #severity="{ row }">
              <Tag :color="severityColor(row.severity)">
                {{ $t(severityLabelKey(row.severity)) }}
              </Tag>
            </template>
            <template #condition="{ row }">
              <!-- 与规则列表单元格共用同一份人话（不在模板里重复实现一遍，避免两处口径漂移） -->
              {{ conditionText(row) }}
            </template>
            <template #notifyRisk="{ row }">
              <NotifyRiskTag
                :channels="row.notifyChannels"
                :targets="row.notifyTargets"
              />
            </template>
            <template #enabled="{ row }">
              <Tag :color="row.enabled ? 'success' : 'default'">
                {{ row.enabled ? $t('common.enabled') : $t('common.disabled') }}
              </Tag>
            </template>

            <template #updateTime="{ row }">
              {{ formatDateTime(row.updateTime) }}
            </template>

            <template #action="{ row }">
              <VbenTableAction
                :actions="[
                  {
                    text: $t('common.edit'),
                    icon: 'lucide:pencil',
                    auth: 'iot:alert:rule-save',
                    onClick: () => RuleDrawerApi.setData({ rule: row }).open(),
                  },
                  {
                    text: row.enabled
                      ? $t('common.disabled')
                      : $t('common.enabled'),
                    icon: 'lucide:power',
                    auth: 'iot:alert:rule-save',
                    onClick: () => onToggleRule([row.id], !row.enabled),
                  },
                ]"
                align="center"
              />
            </template>
          </RuleGrid>
        </Tabs.TabPane>
      </Tabs>
    </PanelErrorBoundary>

    <RuleDrawer @saved="ruleGuard.request()" />
  </Page>
</template>

<style scoped>
/*
 * 告警页的确定高度链（与 `ALERTS_LAYOUT.requiredDeepRules` 一一对应，
 * `alerts-layout.test.ts` 会读本文件断言；删改任一规则都会让用例咬人）。
 *
 * antd `Tabs` 的 tabpane 默认「高度 = 内容」（`flex:none; width:100%`），
 * 必须显式定高并把内容区改成列 flex，表格壳（`flex-1 min-h-0`）才能拿到确定高度；
 * 否则 vxe `height:'auto'` 的量父回写会与内容高度形成自反馈（表体无限增高）。
 */

:deep(.ant-tabs-content) {
  height: 100%;
}

:deep(.ant-tabs-tabpane) {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
</style>

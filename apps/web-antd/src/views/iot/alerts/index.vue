<script lang="ts" setup>
import type { RefreshGuard } from './refresh-guard';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotAlertApi } from '#/api/iot';

import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';

import {
  Alert,
  Button,
  Empty,
  message,
  Space,
  Tabs,
  Tag,
} from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  ackAlerts,
  getAlertPage,
  getAlertRulePage,
  getAlertSummary,
  setAlertRulesEnabled,
  silenceAlerts,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  ALERT_INSTANCE_FILTER_DEFAULTS,
  ALERT_INSTANCE_FILTER_PAGE,
  ALERT_INSTANCE_FILTER_SHAPE,
  ALERT_INSTANCE_FILTER_VERSION,
  loadFilter,
  pickFilterFields,
  saveFilterIfChanged,
} from '../shared/list-filter';
import { detectRunawayGrowth, RUNAWAY_HEIGHT } from './alerts-layout';
import {
  conditionText,
  eventLabelKey,
  humanSeconds,
  notifyStatusLabelKey,
  reasonLabelKey,
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
import {
  createSerialRunner,
  isTenantContextError,
  listSlotState,
  resolveDeviceFilter,
} from './list-state';
import InstanceCurve from './modules/instance-curve.vue';
import RuleForm from './modules/rule-form.vue';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from './refresh-guard';

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

/** 顶部计数（**一次聚合查询**给出，不拿列表长度当计数）。 */
const summary = ref<IotAlertApi.SummaryResp>();

const summaryError = ref('');

/**
 * 摘要请求串行化（后发覆盖前发）。
 *
 * 🔴 为什么只有它需要：`reloadSummary()` 不走 vxe，没有 vxe 那层在途守卫，
 * 而它会被「进页面」和「确认/静默后的 `reloadAll()`」两处触发 ⇒ 两次请求可以同时在途，
 * 最终值取决于谁最后**返回**（旧请求后到会把刚确认后的计数回退）。
 * 两张表格不用守：vxe 在 `tableLoading` 期间会直接丢弃再来的 query，天然至多一个在途。
 */
const runSummaryQuery = createSerialRunner();

async function reloadSummary() {
  return runSummaryQuery(async () => {
    try {
      summary.value = await getAlertSummary();
      summaryError.value = '';
    } catch (error) {
      summary.value = undefined;
      summaryError.value = extractErrorMessage(
        error,
        $t('page.iot.alert.summaryLoadFailed'),
      );
    }
  });
}

// ---------------------------------------------------------------- 告警列表

const listError = ref('');

const selectedIds = ref<string[]>([]);

/**
 * 实例表的「静默丢弃」守卫（见 refresh-guard.ts）。
 *
 * 生命周期：`useVbenVxeGrid` 返回的 api 先就位，再创建守卫；网格组件真正
 * 挂载/查询发生在 setup 之后，闭包拿到的引用必然已赋值。
 */
let instanceGuard: RefreshGuard;

// 看板 #12「筛选持久化」：首次进入回填上次筛选（loadFilter 已净化，不信任存储）
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
          // 看板 #12：查询启动即持久化当前筛选（幂等：值无变化不写）
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

async function onAck(ids: string[]) {
  try {
    const count = await ackAlerts(ids);
    message.success($t('page.iot.alert.ackDone', [count]));
    selectedIds.value = [];
    await reloadAll();
    return true;
  } catch {
    // 失败提示由全局请求拦截器统一展示；这里只兜底避免未处理拒绝
    return false;
  }
}

async function onSilence(ids: string[], minutes = 60) {
  try {
    const count = await silenceAlerts(ids, minutes);
    message.success($t('page.iot.alert.silenceDone', [count, minutes]));
    selectedIds.value = [];
    await reloadAll();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 告警规则

const ruleError = ref('');

/** 规则表的「静默丢弃」守卫（与实例表同构，见 refresh-guard.ts）。 */
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

async function onToggleRule(ids: string[], enabled: boolean) {
  try {
    const count = await setAlertRulesEnabled(ids, enabled);
    message.success(
      enabled
        ? $t('page.iot.alert.rule.enableDone', [count])
        : $t('page.iot.alert.rule.disableDone', [count]),
    );
    selectedRuleIds.value = [];
    ruleGuard.request();
    return true;
  } catch {
    return false;
  }
}

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

/**
 * 表格高度看门狗（防「自增长」兜底，见 alerts-layout.ts）：
 * 若 vxe 的 ResizeObserver 自反馈在某个浏览器/未来改动下复燃，这里会在
 * 连续 N 次「异常高 + 严格递增」采样后把表格回退到固定上限（具名常量可配），
 * 而不是让页面无限长高。正常（确定高度链）情况下只做廉价高度采样，稳定即收工。
 */
function watchGridForRunawayHeight(
  api: {
    grid: { $el?: HTMLElement };
    setGridOptions: (options: { maxHeight?: number }) => void;
  },
  label: string,
) {
  const samples: number[] = [];
  let stopped = false;
  let stableStreak = 0;
  const stop = () => {
    stopped = true;
    window.clearInterval(timer);
  };
  const timer = window.setInterval(() => {
    const el = api.grid?.$el as HTMLElement | undefined;
    if (!el) {
      return;
    }
    const heightPx = el.offsetHeight;
    const thresholdPx = window.innerHeight + RUNAWAY_HEIGHT.excessPx;
    samples.push(heightPx);
    if (samples.length > RUNAWAY_HEIGHT.requiredConsecutive + 2) {
      samples.shift();
    }
    if (
      detectRunawayGrowth(samples, {
        thresholdPx,
        requiredConsecutive: RUNAWAY_HEIGHT.requiredConsecutive,
      })
    ) {
      stop();
      const capPx = Math.max(
        0,
        window.innerHeight - RUNAWAY_HEIGHT.excessPx * 2,
      );
      api.setGridOptions({ maxHeight: capPx });
      console.warn(
        `[iot/alerts] ${label} 表格高度出现持续自增长，已回退到固定上限 ${capPx}px（请把复现步骤反馈给开发）`,
      );
      return;
    }
    const prev = samples[samples.length - 2];
    if (
      prev !== undefined &&
      Math.abs(heightPx - prev) <= RUNAWAY_HEIGHT.stableDeltaPx
    ) {
      stableStreak += 1;
      if (stableStreak >= 4) {
        stop();
      }
    } else {
      stableStreak = 0;
    }
  }, RUNAWAY_HEIGHT.intervalMs);
  return () => {
    if (!stopped) {
      stop();
    }
  };
}

let stopHeightWatch: (() => void) | undefined;

onMounted(() => {
  void reloadSummary();
  // 规则页签与实例页签共用同一条确定高度链，只盯实例表即可覆盖两条链的自反馈风险
  stopHeightWatch = watchGridForRunawayHeight(
    instanceGridApi as never,
    '告警实例表',
  );
});

onUnmounted(() => {
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
    <Tabs v-model:active-key="activeTab" :animated="false" class="h-full">
      <!-- ===== 告警列表 ===== -->
      <Tabs.TabPane
        v-if="canViewAlert"
        key="list"
        :tab="$t('page.iot.alert.tabList')"
      >
        <!-- 可关闭：否则用户无法在界面上解除「从设备台账带过来的设备过滤」（只能离开页面重进） -->
        <Alert
          v-if="presetDeviceId"
          class="mb-2"
          closable
          :message="$t('page.iot.alert.fromDeviceEntry', [presetDeviceId])"
          show-icon
          type="info"
          @close="onClearDeviceFilter"
        />
        <Alert
          v-if="summaryError"
          class="mb-2"
          :description="summaryError"
          :message="$t('page.iot.alert.summaryLoadFailed')"
          show-icon
          type="error"
        />
        <div v-else-if="summary" class="mb-2 text-sm">
          <Space>
            <Tag color="error">
              {{
                $t('page.iot.alert.summaryActive', [
                  toBackendNumber(summary.activeCount),
                ])
              }}
            </Tag>
            <Tag color="warning">
              {{
                $t('page.iot.alert.summaryCritical', [
                  toBackendNumber(summary.criticalCount),
                ])
              }}
            </Tag>
            <Tag color="processing">
              {{
                $t('page.iot.alert.summaryAcked', [
                  toBackendNumber(summary.ackedCount),
                ])
              }}
            </Tag>
            <Tag color="success">
              {{
                $t('page.iot.alert.summaryResolved24h', [
                  toBackendNumber(summary.resolvedLast24h),
                ])
              }}
            </Tag>
          </Space>
        </div>

        <!--
          🔴 失败态**必须挂在表格之外**（不能只放 `#empty` 槽里）：真实 vxe 只在表体无行时才渲染该槽
          ⇒ 「已有数据后刷新失败」时槽不渲染、失败提示会消失、页面继续展示过期数据。
        -->
        <Alert
          v-if="listError"
          class="mb-2"
          :description="listError"
          :message="$t('page.iot.alert.listLoadFailed')"
          show-icon
          type="error"
        />
        <!-- 失败若是「没有租户上下文」⇒ 给一条能照着做的引导（不弹原始码、不只是报错） -->
        <Alert
          v-if="isTenantContextError(listError)"
          class="mb-2"
          :message="$t('page.iot.alert.noTenantHint')"
          show-icon
          type="warning"
        />
        <InstanceGrid
          class="flex-1 min-h-0"
          @checkbox-change="onCheckboxChange"
        >
          <template #toolbar-tools>
            <Space>
              <Button
                v-if="canAck"
                :disabled="selectedIds.length === 0"
                @click="onAck(selectedIds)"
              >
                {{ $t('page.iot.alert.batchAck') }}
              </Button>
              <Button
                v-if="canAck"
                :disabled="selectedIds.length === 0"
                @click="onSilence(selectedIds, 60)"
              >
                {{ $t('page.iot.alert.batchSilence') }}
              </Button>
            </Space>
          </template>

          <!-- 空态引导：说明「为什么是空的 + 下一步点哪里」，而不是一张空白表格 -->
          <template #empty>
            <!-- 判据抽成纯函数 listSlotState：失败**绝不**画成空态（有可运行用例守门） -->
            <Empty
              v-if="listSlotState(listError, 0) === 'empty'"
              :description="$t('page.iot.alert.emptyReason')"
            />
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

          <!-- 展开行：触发值 / 阈值 / 时间线 / 投递记录 / 该点位近期曲线缩略 -->
          <template #expand="{ row }">
            <div class="grid grid-cols-3 gap-4 p-2 text-sm">
              <div class="space-y-1">
                <div>
                  <span class="text-muted-foreground">
                    {{ $t('page.iot.alert.triggerValue') }}:
                  </span>
                  <span class="font-medium">{{ row.triggerValue ?? '-' }}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">
                    {{ $t('page.iot.alert.threshold') }}:
                  </span>
                  <span class="font-medium">{{
                    row.thresholdSnapshot ?? '-'
                  }}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">
                    {{ $t('page.iot.alert.stateField') }}:
                  </span>
                  <Tag :color="stateColor(row.state)">
                    {{ $t(stateLabelKey(row.state)) }}
                  </Tag>
                </div>
              </div>
              <div class="space-y-1">
                <div>
                  {{ $t('page.iot.alert.startTs') }}: {{ row.startTs ?? '-' }}
                </div>
                <div>
                  {{ $t('page.iot.alert.firingTs') }}: {{ row.firingTs ?? '-' }}
                </div>
                <div>
                  {{ $t('page.iot.alert.resolvedTs') }}:
                  {{ row.resolvedTs ?? '-' }}
                </div>
                <div v-if="row.reason">
                  {{ $t('page.iot.alert.reasonField') }}:
                  {{ $t(reasonLabelKey(row.reason)) }}
                </div>
                <div v-if="row.silenceUntil">
                  {{ $t('page.iot.alert.silenceUntil') }}:
                  {{ row.silenceUntil }}
                </div>
              </div>
              <div>
                <div class="mb-1 text-muted-foreground">
                  {{ $t('page.iot.alert.curve.title') }}
                </div>
                <InstanceCurve
                  :device-id="row.deviceId"
                  :property-id="row.propertyId"
                  :threshold-snapshot="row.thresholdSnapshot"
                />
              </div>
            </div>
            <div class="p-2 text-sm">
              <div class="mb-1 text-muted-foreground">
                {{ $t('page.iot.alert.notify.title') }}
                ({{ row.notifyCount ?? 0 }})
              </div>
              <div
                v-if="(row.notifications?.length ?? 0) === 0"
                class="text-xs text-muted-foreground"
              >
                {{ $t('page.iot.alert.notify.none') }}
              </div>
              <table v-else class="w-full text-xs">
                <thead>
                  <tr class="text-left text-muted-foreground">
                    <th>{{ $t('page.iot.alert.notify.channel') }}</th>
                    <th>{{ $t('page.iot.alert.notify.target') }}</th>
                    <th>{{ $t('page.iot.alert.notify.event') }}</th>
                    <th>{{ $t('page.iot.alert.notify.status') }}</th>
                    <th>{{ $t('page.iot.alert.notify.attempt') }}</th>
                    <th>{{ $t('page.iot.alert.notify.error') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row2 in row.notifications" :key="row2.id">
                    <td>{{ row2.channel }}</td>
                    <td>{{ row2.target || '-' }}</td>
                    <td>{{ $t(eventLabelKey(row2.event)) }}</td>
                    <td>{{ $t(notifyStatusLabelKey(row2.notifyStatus)) }}</td>
                    <td>{{ row2.attempt ?? 0 }}</td>
                    <td class="break-all text-red-600">
                      {{ row2.lastError || '-' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
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
        <RuleGrid
          class="flex-1 min-h-0"
          @checkbox-change="onRuleCheckboxChange"
        >
          <template #toolbar-tools>
            <Space>
              <Button
                v-if="canSaveRule"
                :disabled="selectedRuleIds.length === 0"
                @click="onToggleRule(selectedRuleIds, true)"
              >
                {{ $t('page.iot.alert.rule.batchEnable') }}
              </Button>
              <Button
                v-if="canSaveRule"
                :disabled="selectedRuleIds.length === 0"
                @click="onToggleRule(selectedRuleIds, false)"
              >
                {{ $t('page.iot.alert.rule.batchDisable') }}
              </Button>
              <Button
                v-if="canSaveRule"
                type="primary"
                @click="RuleDrawerApi.setData({}).open()"
              >
                {{ $t('page.iot.alert.rule.createTitle') }}
              </Button>
            </Space>
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
          <template #enabled="{ row }">
            <Tag :color="row.enabled ? 'success' : 'default'">
              {{ row.enabled ? $t('common.enabled') : $t('common.disabled') }}
            </Tag>
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

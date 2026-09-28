<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotAlertApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useRoute } from 'vue-router';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';

import { Alert, Button, Empty, message, Space, Tabs, Tag } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  ackAlerts,
  getAlertPage,
  getAlertSummary,
  getAlertRulePage,
  setAlertRulesEnabled,
  silenceAlerts,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  conditionText,
  eventLabelKey,
  humanSeconds,
  notifyStatusLabelKey,
  reasonLabelKey,
  severityColor,
  scopeLabelKey,
  scopeTargetText,
  severityLabelKey,
  stateColor,
  stateLabelKey,
  useInstanceColumns,
  useInstanceFormSchema,
  useRuleColumns,
} from './data';
import InstanceCurve from './modules/instance-curve.vue';
import RuleForm from './modules/rule-form.vue';

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

const [RuleDrawer, RuleDrawerApi] = useVbenDrawer({ connectedComponent: RuleForm });

const activeTab = ref('list');

const route = useRoute();

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

async function reloadSummary() {
  try {
    summary.value = await getAlertSummary();
    summaryError.value = '';
  } catch (caught) {
    summary.value = undefined;
    summaryError.value = extractErrorMessage(
      caught,
      $t('page.iot.alert.summaryLoadFailed'),
    );
  }
}

// ---------------------------------------------------------------- 告警列表

const listError = ref('');

const selectedIds = ref<string[]>([]);

const [InstanceGrid, instanceGridApi] = useVbenVxeGrid({
  formOptions: {
    schema: useInstanceFormSchema(),
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
          try {
            const result = await getAlertPage({
              page: page.currentPage,
              pageSize: page.pageSize,
              ...formValues,
              deviceId:
                (formValues as IotAlertApi.InstanceQuery | undefined)?.deviceId ||
                presetDeviceId.value ||
                undefined,
            });
            listError.value = '';
            // 后端 `total` 是 long ⇒ 全局序列化成**字符串**；vxe 分页要做算术 ⇒ 进表格前显式转数
            return { ...result, total: toBackendNumber(result.total) };
          } catch (caught) {
            // 记下失败原因（原样展示后端 message），再把异常继续抛出（不改动既有失败语义）
            listError.value = extractErrorMessage(
              caught,
              $t('page.iot.alert.listLoadFailed'),
            );
            throw caught;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, search: true, zoom: true },
  } as VxeTableGridOptions<IotAlertApi.InstanceResp>,
});

function onCheckboxChange({ records }: { records: IotAlertApi.InstanceResp[] }) {
  selectedIds.value = records.map((item) => item.id);
}

async function reloadAll() {
  await Promise.all([instanceGridApi.query(), reloadSummary()]);
}

async function onAck(ids: string[]) {
  try {
    const count = await ackAlerts(ids);
    message.success($t('page.iot.alert.ackDone', [count]));
    await reloadAll();
    return true;
  } catch (caught) {
    // 失败提示由全局请求拦截器统一展示；这里只兜底避免未处理拒绝
    return false;
  }
}

async function onSilence(ids: string[], minutes = 60) {
  try {
    const count = await silenceAlerts(ids, minutes);
    message.success($t('page.iot.alert.silenceDone', [count, minutes]));
    await reloadAll();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 告警规则

const ruleError = ref('');

const [RuleGrid, ruleGridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useRuleColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) => {
          try {
            const result = await getAlertRulePage({
              page: page.currentPage,
              pageSize: page.pageSize,
            });
            ruleError.value = '';
            return { ...result, total: toBackendNumber(result.total) };
          } catch (caught) {
            ruleError.value = extractErrorMessage(
              caught,
              $t('page.iot.alert.rule.listLoadFailed'),
            );
            throw caught;
          }
        },
      },
    },
    checkboxConfig: { checkMethod: () => canSaveRule.value },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotAlertApi.RuleResp>,
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
    await ruleGridApi.query();
    return true;
  } catch {
    return false;
  }
}

onMounted(reloadSummary);
</script>

<template>
  <Page auto-content-height>
    <Tabs v-model:activeKey="activeTab" :animated="false">
      <!-- ===== 告警列表 ===== -->
      <Tabs.TabPane v-if="canViewAlert" key="list" :tab="$t('page.iot.alert.tabList')">
        <!-- 可关闭：否则用户无法在界面上解除「从设备台账带过来的设备过滤」（只能离开页面重进） -->
        <Alert
          v-if="presetDeviceId"
          class="mb-2"
          closable
          :message="$t('page.iot.alert.fromDeviceEntry', [presetDeviceId])"
          show-icon
          type="info"
          @close="
            () => {
              presetDeviceId = '';
              instanceGridApi.query();
            }
          "
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
              {{ $t('page.iot.alert.summaryActive', [toBackendNumber(summary.activeCount)]) }}
            </Tag>
            <Tag color="warning">
              {{ $t('page.iot.alert.summaryCritical', [toBackendNumber(summary.criticalCount)]) }}
            </Tag>
            <Tag color="processing">
              {{ $t('page.iot.alert.summaryAcked', [toBackendNumber(summary.ackedCount)]) }}
            </Tag>
            <Tag color="success">
              {{ $t('page.iot.alert.summaryResolved24h', [toBackendNumber(summary.resolvedLast24h)]) }}
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
        <InstanceGrid @checkbox-change="onCheckboxChange">
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
            <Empty
              v-if="!listError"
              :description="$t('page.iot.alert.emptyReason')"
            />
          </template>

          <template #duration="{ row }">
            {{ humanSeconds(row.durationSeconds) }}
          </template>

          <template #rule="{ row }">
            <span v-if="row.outage">{{ $t('page.iot.alert.kind.offline') }}</span>
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
                  <span class="font-medium">{{ row.thresholdSnapshot ?? '-' }}</span>
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
                  {{ $t('page.iot.alert.resolvedTs') }}: {{ row.resolvedTs ?? '-' }}
                </div>
                <div v-if="row.reason">
                  {{ $t('page.iot.alert.reasonField') }}:
                  {{ $t(reasonLabelKey(row.reason)) }}
                </div>
                <div v-if="row.silenceUntil">
                  {{ $t('page.iot.alert.silenceUntil') }}: {{ row.silenceUntil }}
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
      <Tabs.TabPane v-if="canViewRule" key="rules" :tab="$t('page.iot.alert.tabRules')">
        <Alert
          v-if="ruleError"
          class="mb-2"
          :description="ruleError"
          :message="$t('page.iot.alert.rule.listLoadFailed')"
          show-icon
          type="error"
        />
        <RuleGrid @checkbox-change="onRuleCheckboxChange">
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
              v-if="!ruleError"
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
                  text: row.enabled ? $t('common.disabled') : $t('common.enabled'),
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

    <RuleDrawer @saved="ruleGridApi.query()" />
  </Page>
</template>

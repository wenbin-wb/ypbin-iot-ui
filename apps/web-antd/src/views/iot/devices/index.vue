<script lang="ts" setup>
import { useRoute } from 'vue-router';

import { Page } from '@vben/common-ui';
import { Download, Plus } from '@vben/icons';

import {
  Alert,
  Button,
  Popconfirm,
  Switch,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { VbenTableAction } from '#/adapter/vxe-table';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';
import ListErrorAlert from '../shared/list-error-alert.vue';
import TenantLedger from '../tenant-ledger/modules/ledger.vue';
import {
  DEVICE_DISABLED,
  DEVICE_ENABLED,
} from './composables/device-status-codes';
import { useDeviceBatch } from './composables/use-device-batch';
import { useDeviceDrawers } from './composables/use-device-drawers';
import { useDeviceExport } from './composables/use-device-export';
import { useDeviceList } from './composables/use-device-list';
import { useDeviceStatus } from './composables/use-device-status';

/**
 * 设备台账页（宿主）。
 *
 * 本文件只做**装配 + 模板**，四块逻辑各自在 `composables/` 里（审查 P2-7）：
 * - `useDeviceList`：vxe Grid + 静默丢弃守卫 + 失败态/活动告警数 + 分页取值；
 * - `useDeviceBatch`：勾选 + 批量启停/删除 + 批量标签/命令（含结果播报与删除后页码回落）；
 * - `useDeviceStatus`：启停开关 + 实时状态/鉴权提示；
 * - `useDeviceExport`：导出当前筛选条件下的 CSV；
 * - `useDeviceDrawers`：9 个抽屉中的 7 个 + 行内跳转 + `?action=create` 的一次性消费。
 *
 * 装配顺序有讲究：批量组合式依赖列表组合式的表格能力（清勾选/取可见行/分页快照），
 * 而列表查询开始时又要清空旧页勾选 ⇒ 用 `setQueryStartHandler`/`setCheckboxChangeHandler`
 * 在两者都创建后接线，避免循环依赖。
 */
const route = useRoute();

/**
 * `?productId=` 带来的**初始筛选值**（产品详情「添加设备」与按产品浏览共用这个参数）。
 *
 * 只在组件初始化时读取：搜索表单的 `defaultValue` 会随首次查询一起提交，
 * 因此「带 productId 打开台账」天然是筛选后的结果；用户之后可在表单里改/清空。
 */
const initialProductId =
  typeof route.query.productId === 'string' && route.query.productId !== ''
    ? route.query.productId
    : undefined;

const list = useDeviceList({ initialProductId });

const {
  Grid,
  alertCountError,
  alertCounts,
  guard: deviceGuard,
  listError,
} = list;

const batch = useDeviceBatch({
  clearGridCheckbox: list.clearGridCheckbox,
  getGuard: () => list.guard,
  readPagerSnapshot: list.readPagerSnapshot,
  readSelectedRows: list.readSelectedRows,
  readVisibleRows: list.readVisibleRows,
  setGridCurrentPage: list.setGridCurrentPage,
});

// 双向接线（两者都已创建）：查询开始清空旧页勾选；vxe 勾选事件同步到批量目标
list.setQueryStartHandler(batch.resetSelectedIds);
list.setCheckboxChangeHandler(batch.onCheckboxChange);

const {
  BatchCommandDrawer,
  BatchTagsDrawer,
  batchActionDisabled,
  batchDisabledTooltip,
  onBatchCommandSuccess,
  onBatchDelete,
  onBatchStatus,
  onBatchTagsSuccess,
  onDelete,
  openBatchCommand,
  openBatchTags,
  selectedIds,
  tagDisabledTooltip,
} = batch;

const {
  handleRealtimeReLogin,
  isDeviceEnabled,
  onToggleStatus,
  realtimeAuthError,
  realtimeDisconnected,
  realtimeError,
  realtimeTag,
  realtimeUnauthorized,
  statusPending,
} = useDeviceStatus({
  getVisibleDeviceIds: list.currentVisibleDeviceIds,
  refresh: () => list.guard.request(),
});

const {
  AvailabilityDrawer,
  DetailDrawer,
  FormDrawer,
  FormDrawerApi,
  GuideDrawer,
  ImportDrawer,
  ImportPanel,
  LedgerDrawer,
  SeriesDrawer,
  onAlerts,
  onAvailability,
  onDetail,
  onEdit,
  onGuideAddDevice,
  onSeries,
  openGuide,
  openImport,
  openLedger,
} = useDeviceDrawers({ getGuard: () => list.guard });

const { exportLoading, onExportCsv } = useDeviceExport({
  readFormValues: list.readFormValues,
});
</script>
<template>
  <Page auto-content-height>
    <!--
      页面主标题：视觉标题由页头/菜单承担，这里给读屏用的唯一 <h1>
      （与告警中心/仪表盘同口径；全站此前 0 个 h1）。
    -->
    <h1 class="sr-only">{{ $t('page.iot.device.title') }}</h1>
    <FormDrawer @reload="deviceGuard.request()" />
    <DetailDrawer />
    <AvailabilityDrawer />
    <SeriesDrawer />
    <GuideDrawer
      :title="$t('page.iot.onboarding.title')"
      class="w-full max-w-[900px]"
    >
      <OnboardingGuide
        @add-device="onGuideAddDevice"
        @done="deviceGuard.request()"
      />
    </GuideDrawer>
    <LedgerDrawer
      :title="$t('page.iot.ledger.pageTitle')"
      class="w-full max-w-[1000px]"
    >
      <TenantLedger />
    </LedgerDrawer>
    <ImportDrawer
      :title="$t('page.iot.device.import.title')"
      class="w-full max-w-[1000px]"
    >
      <DeviceImport :ref="ImportPanel" />
    </ImportDrawer>
    <BatchTagsDrawer @success="onBatchTagsSuccess" />
    <BatchCommandDrawer @success="onBatchCommandSuccess" />
    <!--
      🔴 失败态**必须挂在表格之外**（不能只放 `#empty` 槽里）：
      真实 vxe 只在**表体没有行**时才渲染 `#empty` 槽 ⇒ 若把失败提示只放槽里，
      「已有数据后刷新失败」时旧行仍在、槽不渲染 ⇒ 失败提示**看不见**（只剩一次转瞬即逝的 toast），
      页面会继续展示**过期数据**而用户毫不知情。放在表格上方则任何一次失败都可见。
    -->
    <!--
      活动告警数查询失败：**辅助信息失败不能把设备列表画成失败态**，但也不能静默无声
      （列上只会显示 `-`，用户会以为「这台设备没有告警」）。因此单独一条可关闭的提示。
    -->
    <ListErrorAlert
      v-if="alertCountError"
      :error="alertCountError"
      :title="$t('page.iot.alert.activeCountLoadFailed')"
      closable
      type="warning"
      @close="alertCountError = ''"
    />
    <!-- 实时连接中断：可见提示但不阻塞页面（列表仍可手动刷新） -->
    <ListErrorAlert
      v-if="realtimeDisconnected"
      :error="$t('page.iot.realtime.disconnectedHint', [realtimeError || '-'])"
      :title="$t('page.iot.realtime.disconnected')"
      type="warning"
    />
    <!--
      实时鉴权失败（401/403）：实时层**不自动重连**，页面若只提示 reconnecting 就完全不提示，
      用户会拿过期数据做处置。因此这里常驻一条 Alert：
      - unauthorized（会话可能过期）⇒ 给「重新登录」按钮（复用全局会话过期入口）；
      - forbidden（角色无实时端点权限）⇒ 重新登录也没用，只说明原因、不给按钮。
    -->
    <Alert
      v-if="realtimeUnauthorized"
      show-icon
      type="warning"
      :message="
        $t(
          realtimeAuthError === 'unauthorized'
            ? 'page.iot.realtime.authFailed'
            : 'page.iot.realtime.forbidden',
        )
      "
    >
      <template v-if="realtimeAuthError === 'unauthorized'" #action>
        <Button
          data-testid="realtime-relogin"
          size="small"
          @click="handleRealtimeReLogin"
        >
          {{ $t('authentication.loginAgainTitle') }}
        </Button>
      </template>
    </Alert>
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.device.listLoadFailed')"
    />
    <!--
      勾选事件不写在这里：vben 的 Grid 会把未声明的 attrs 透传到自身根 div，而 vxe 的
      checkbox-change 只绑定在内层 VxeGrid 上（自定义事件不冒泡）⇒ 模板监听收不到，
      selectedIds 恒为空、所有批量按钮恒禁用。正确接线是 gridOptions 同级的
      gridEvents.checkboxChange（见脚本内注释）。
    -->
    <Grid>
      <template #toolbar-tools>
        <div class="flex flex-wrap items-center gap-2">
          <!-- 实时连接状态：live/connecting/reconnecting；closed（无 token）不渲染 -->
          <Tag v-if="realtimeTag" :color="realtimeTag.color">
            {{ realtimeTag.text }}
          </Tag>
          <!-- 接入向导入口：不带权限码（所有角色可见，先知道下一步做什么）； -->
          <!-- 向导里的写动作各自沿用 iot:product:create / iot:product:publish / iot:device:create。 -->
          <Button @click="openGuide">
            {{ $t('page.iot.onboarding.openGuide') }}
          </Button>
          <!-- 租户接入台账：平台级权限（platform_only=1），非平台管理员看不到这个按钮 -->
          <Button v-access:code="['iot:ledger:list']" @click="openLedger">
            {{ $t('page.iot.ledger.pageTitle') }}
          </Button>
          <!--
          批量运维：按钮按权限码显示（iot:device:update / iot:device:delete），
          未勾选或批量请求在途时禁用。启用无破坏性后果直接执行；停用/删除必须 Popconfirm 讲清后果。
        -->
          <Tooltip :title="batchDisabledTooltip">
            <span class="inline-block" :tabindex="batchActionDisabled ? 0 : -1">
              <Button
                v-access:code="['iot:device:update']"
                data-testid="batch-enable"
                :disabled="batchActionDisabled"
                @click="onBatchStatus(DEVICE_ENABLED)"
              >
                {{ $t('page.iot.device.batchEnable') }}
              </Button>
            </span>
          </Tooltip>
          <Popconfirm
            :cancel-text="$t('common.cancel')"
            :ok-text="$t('page.iot.device.disabled')"
            :title="
              $t('page.iot.device.batchDisableConfirm', [
                String(selectedIds.length),
              ])
            "
            @confirm="onBatchStatus(DEVICE_DISABLED)"
          >
            <Tooltip :title="batchDisabledTooltip">
              <span
                class="inline-block"
                :tabindex="batchActionDisabled ? 0 : -1"
              >
                <Button
                  v-access:code="['iot:device:update']"
                  data-testid="batch-disable"
                  :disabled="batchActionDisabled"
                >
                  {{ $t('page.iot.device.batchDisable') }}
                </Button>
              </span>
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            :cancel-text="$t('common.cancel')"
            :ok-text="$t('common.delete')"
            :title="
              $t('page.iot.device.batchDeleteConfirm', [
                String(selectedIds.length),
              ])
            "
            @confirm="onBatchDelete"
          >
            <Tooltip :title="batchDisabledTooltip">
              <span
                class="inline-block"
                :tabindex="batchActionDisabled ? 0 : -1"
              >
                <Button
                  v-access:code="['iot:device:delete']"
                  danger
                  data-testid="batch-delete"
                  :disabled="batchActionDisabled"
                >
                  {{ $t('page.iot.device.batchDelete') }}
                </Button>
              </span>
            </Tooltip>
          </Popconfirm>
          <!--
            批量下发命令：权限沿用 iot:debug:send（后端 @SaCheckPermission 同码）；
            未勾选或批量请求在途时禁用。批量会**明确拒绝停用设备**（单台端点不拒），
            该结果由弹窗逐台如实展示。
          -->
          <Tooltip :title="batchDisabledTooltip">
            <span class="inline-block" :tabindex="batchActionDisabled ? 0 : -1">
              <Button
                v-access:code="['iot:debug:send']"
                data-testid="batch-command"
                :disabled="batchActionDisabled"
                @click="openBatchCommand"
              >
                {{ $t('page.iot.device.batchCommand.entry') }}
              </Button>
            </span>
          </Tooltip>
          <!-- 批量打标签：后端权限为 iot:tag:create/update 任一（SaMode.OR），故两码都放行 -->
          <Tooltip :title="tagDisabledTooltip">
            <span class="inline-block" :tabindex="tagDisabledTooltip ? 0 : -1">
              <Button
                v-access:code="['iot:tag:create', 'iot:tag:update']"
                data-testid="batch-tag-set"
                :disabled="selectedIds.length === 0"
                @click="openBatchTags('set')"
              >
                {{ $t('page.iot.device.batchTagSet') }}
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="tagDisabledTooltip">
            <span class="inline-block" :tabindex="tagDisabledTooltip ? 0 : -1">
              <Button
                v-access:code="['iot:tag:delete']"
                data-testid="batch-tag-remove"
                :disabled="selectedIds.length === 0"
                @click="openBatchTags('remove')"
              >
                {{ $t('page.iot.device.batchTagRemove') }}
              </Button>
            </span>
          </Tooltip>
          <!-- 导出当前筛选结果（服务端全量，不是当前页）；权限沿用列表读权限 -->
          <Button
            v-access:code="['iot:device:list']"
            data-testid="export-csv"
            :loading="exportLoading"
            @click="onExportCsv"
          >
            <template #icon><Download /></template>
            {{ $t('page.iot.device.exportCsv') }}
          </Button>
          <!-- 批量导入（CSV）：一次能建上万台设备 ⇒ 独立权限码 iot:device:import -->
          <Button v-access:code="['iot:device:import']" @click="openImport">
            {{ $t('page.iot.device.import.title') }}
          </Button>
          <Button
            v-access:code="['iot:device:create']"
            type="primary"
            @click="FormDrawerApi.setData(null).open()"
          >
            <template #icon><Plus /></template>
            {{ $t('ui.actionTitle.create', [$t('page.iot.device.name')]) }}
          </Button>
        </div>
      </template>

      <!-- 空态引导：说明「为什么是空的 + 下一步点哪里」，而不是一张空白表格 -->
      <!-- 🔴 但**失败不能画成空态**：加载失败时由上方 Alert 承担失败态，这里不得再声称「没有数据」 -->
      <template #empty>
        <EmptyGuide
          v-if="!listError"
          :reason="$t('page.iot.device.emptyReason')"
          @open-guide="openGuide"
        />
      </template>

      <template #alertActive="{ row }">
        <Tag v-if="toBackendNumber(alertCounts[row.id] ?? 0) > 0" color="error">
          {{ toBackendNumber(alertCounts[row.id] ?? 0) }}
        </Tag>
        <span v-else class="text-muted-foreground">-</span>
      </template>

      <!--
        启停开关。
        🔴 这里用 `Popconfirm` **包住** `Switch`，而不是给 Switch 传 `popconfirm` 属性：
        ant-design-vue 4.2.6 的 Switch **没有** `popconfirm` 这个 prop（只有 React antd 有），
        传进去会被静默忽略 ⇒ 「停用会停止采集」这道确认**根本不会弹**。
        `Popconfirm` 只在**要停用时**才渲染（`v-if="isDeviceEnabled(row)"`）：启用没有意外后果，
        若也弹确认，用户会习惯性点确定 ⇒ 真正危险的那次确认就失去拦截力。
        开关是**受控**的（`:checked` + `@change` 后重查），不做乐观翻转——
        慢请求期间先翻再回滚等于界面先撒一次谎。
      -->
      <template #status="{ row }">
        <Popconfirm
          v-if="isDeviceEnabled(row)"
          :cancel-text="$t('common.cancel')"
          :ok-text="$t('page.iot.device.disabled')"
          :title="$t('page.iot.device.statusConfirmDisable')"
          @confirm="onToggleStatus(row, false)"
        >
          <Switch
            v-access:code="['iot:device:update']"
            :aria-label="$t('page.iot.device.status')"
            :checked="true"
            :loading="!!statusPending[row.id]"
            size="small"
          />
        </Popconfirm>
        <Switch
          v-else
          v-access:code="['iot:device:update']"
          :aria-label="$t('page.iot.device.status')"
          :checked="false"
          :loading="!!statusPending[row.id]"
          size="small"
          @change="() => onToggleStatus(row, true)"
        />
        <Tag v-if="!isDeviceEnabled(row)" class="ml-1" color="default">
          {{ $t('page.iot.device.statusDisabledTag') }}
        </Tag>
      </template>

      <!--
        操作列：详情/编辑留在行内，告警/可用率/历史曲线/删除收进「更多」下拉。
        6 个 icon+文字按钮横排会被固定列宽挤成省略号；权限码与各动作入口保持不变。
      -->
      <template #action="{ row }">
        <VbenTableAction
          :actions="[
            {
              text: $t('page.iot.device.detail'),
              icon: 'lucide:info',
              auth: 'iot:device:list',
              onClick: () => onDetail(row),
            },
            {
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:device:update',
              onClick: () => onEdit(row),
            },
          ]"
          :dropdown-actions="[
            {
              text: $t('page.iot.alert.title'),
              icon: 'lucide:bell-ring',
              auth: 'iot:alert:list',
              onClick: () => onAlerts(row),
            },
            {
              text: $t('page.iot.availability.title', ['']),
              icon: 'lucide:activity',
              auth: 'iot:availability:get',
              onClick: () => onAvailability(row),
            },
            {
              text: $t('page.iot.series.title'),
              icon: 'lucide:chart-line',
              auth: 'iot:series:get',
              onClick: () => onSeries(row),
            },
            {
              text: $t('common.delete'),
              icon: 'lucide:trash-2',
              auth: 'iot:device:delete',
              danger: true,
              popConfirm: {
                title: $t('ui.actionMessage.deleteConfirm', [
                  row.deviceName || row.deviceCode || '',
                ]),
                confirm: () => onDelete(row),
              },
            },
          ]"
          align="center"
        />
      </template>
    </Grid>
  </Page>
</template>

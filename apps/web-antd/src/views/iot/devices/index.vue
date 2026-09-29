<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import {
  Alert,
  Button,
  message,
  Popconfirm,
  Switch,
  Tag,
} from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  deleteDevice,
  getActiveAlertCounts,
  getDevicePage,
  updateDeviceStatus,
} from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';
import TenantLedger from '../tenant-ledger/modules/ledger.vue';
import { useColumns } from './data';
import Availability from './modules/availability.vue';
import Detail from './modules/detail.vue';
import Form from './modules/form.vue';
import Series from './modules/series.vue';

const route = useRoute();
const router = useRouter();

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
const [DetailDrawer, DetailDrawerApi] = useVbenDrawer({
  connectedComponent: Detail,
});
const [AvailabilityDrawer, AvailabilityDrawerApi] = useVbenDrawer({
  connectedComponent: Availability,
});
const [SeriesDrawer, SeriesDrawerApi] = useVbenDrawer({
  connectedComponent: Series,
});
/**
 * 接入向导（F6）抽屉。
 *
 * 用**默认插槽**而不是 `connectedComponent`：向导内容组件（`onboarding/modules/guide.vue`）
 * 同时要被独立页面复用，因此它不自带抽屉容器；`connectedComponent` 形态要求子组件自己渲染
 * `<Drawer>`（vben 只 provide 上下文、父侧不渲染容器），两者不能兼得。
 */
const [GuideDrawer, GuideDrawerApi] = useVbenDrawer();
/**
 * 租户接入台账（F5）抽屉。
 *
 * **为什么挂在设备台账页**：平台级权限码 `iot:ledger:list/update` 本来就挂在设备菜单（`sys_menu`
 * 320014/320015，`platform_only=1`，见 `deploy/sql/007-iot-data.sql`）。
 * **菜单已由迁移补齐**（2026-09-29 更正，此前写的是「台账页暂时没有页面级菜单」）：
 * `deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 补了 3206
 * （`type='menu'`、`platform_only=1`、标题键 `page.iot.ledger.pageTitle`）。
 * 此处保留抽屉入口仍有价值：平台管理员在设备台账页可**就地**查看/修改本租户归属，
 * 不必跳到独立页面。
 */
const [LedgerDrawer, LedgerDrawerApi] = useVbenDrawer();

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 为什么必须有它：vxe 的 `#empty` 插槽在「**加载失败**」与「**确实没有数据**」两种情况下
 * 长得一模一样 ⇒ 只挂一个 `EmptyGuide` 就是把失败画成「还没有设备，去创建吧」。
 * 失败虽然会由全局请求拦截器弹一次 toast，但 toast 是**转瞬即逝**的：用户错过它之后，
 * 页面上永久留着「没有数据」这个**错误结论**（这正是「假空态」）。
 * 有了这个 ref，空态插槽才有依据区分二者：失败态原样展示后端 `message`。
 */
const listError = ref('');

/**
 * 当前页设备的**活动告警数**（一次批量查询；`id → 数量`）。
 *
 * 它是**辅助信息**，因此它自己的失败不能把设备列表画成失败态（那是两件事）；
 * 但也不能完全无声：失败时把原因记到 `alertCountError` 并只清空计数，
 * 列表照常展示（页面上会少一列数字，而不是给出错误结论）。
 */
const alertCounts = ref<Record<string, number | string>>({});

const alertCountError = ref('');

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) => {
          try {
            const result = await getDevicePage({
              page: page.currentPage,
              pageSize: page.pageSize,
            });
            listError.value = '';
            await loadAlertCounts(result.items ?? []);
            // 后端 `PageResult.total` 是 `long` ⇒ 全局序列化成**字符串**（`"17"`），
            // 而 vxe 的 pager 拿到 total 后要做算术语义（页数 = ceil(total/pageSize)）⇒
            // 在**进入表格前**转成 number，别把契约违例一路喂到分页组件里。
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            // 记下失败原因（原样展示后端 message），再把异常**继续抛出**：
            // 不改动原有失败语义（全局拦截器照旧弹提示、vxe 照旧走失败分支）。
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.device.listLoadFailed'),
            );
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotDeviceApi.DeviceResp>,
});

/**
 * 批量取本页设备的活动告警数（一次请求；空页直接短路，不发请求）。
 *
 * 失败**不影响列表**：清空计数并把原因记到 `alertCountError`（控制台留痕），
 * 列上显示 `-`。把「计数查询失败」渲染成「设备列表加载失败」会让用户以为整页不可用。
 */
async function loadAlertCounts(items: IotDeviceApi.DeviceResp[]) {
  const ids = items.map((item) => item.id).filter((id) => !!id);
  if (ids.length === 0) {
    alertCounts.value = {};
    alertCountError.value = '';
    return;
  }
  try {
    alertCounts.value = await getActiveAlertCounts(ids);
    alertCountError.value = '';
  } catch (error) {
    alertCounts.value = {};
    alertCountError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.activeCountLoadFailed'),
    );
    console.warn('[iot] 活动告警数查询失败（列表照常展示）', error);
  }
}

/**
 * 「从产品一键添加设备」（F2 的入口）落地处：产品详情点「添加设备」时带
 * `?productId=xxx&action=create` 跳到这里，设备表单打开并预选该产品。
 *
 * 用 `?action=create` 显式表达意图（只在带它时自动开表单）：单纯带 `productId` 浏览台账
 * 不应该弹出表单。参数消费后清掉，避免刷新/后退又弹一次。
 */
function consumeCreateQuery() {
  const productId = route.query.productId;
  if (route.query.action !== 'create' || typeof productId !== 'string') {
    return;
  }
  FormDrawerApi.setData({ productId }).open();
  gridApi.query();
  // 参数只消费一次：不清理的话刷新/切回标签页会再弹一次表单
  void router.replace({ query: {} });
}

onMounted(consumeCreateQuery);
watch(() => route.query.action, consumeCreateQuery);

function onEdit(row: IotDeviceApi.DeviceResp) {
  FormDrawerApi.setData(row).open();
}

function onDetail(row: IotDeviceApi.DeviceResp) {
  DetailDrawerApi.setData(row).open();
}

function onAvailability(row: IotDeviceApi.DeviceResp) {
  AvailabilityDrawerApi.setData(row).open();
}

function onSeries(row: IotDeviceApi.DeviceResp) {
  SeriesDrawerApi.setData(row).open();
}

/** 跳到全局告警中心并带上该设备（设备台账 → 告警的**第二个入口**，第一个在设备详情页签）。 */
function onAlerts(row: IotDeviceApi.DeviceResp) {
  router.push({ path: '/iot/alerts', query: { deviceId: row.id } });
}

function onDelete(row: IotDeviceApi.DeviceResp) {
  deleteDevice(row.id)
    .then(() => {
      message.success($t('common.success'));
      gridApi.query();
    })
    // 失败提示由全局请求拦截器统一处理，这里仅兜底避免未处理拒绝
    .catch(() => {});
}

/** 打开接入向导抽屉（空态引导与工具栏按钮共用同一个入口）。 */
function openGuide() {
  GuideDrawerApi.open();
}

/**
 * 启停位与后端 `EntityStatus` 的码值对齐（1 启用 / 0 停用）。
 *
 * 用具名常量而不是散落的字面量：这两个数字同时出现在「开关取值」与「行是否停用」两处判断里，
 * 写错一处就会出现「行显示已停用、开关却是开的」这种自相矛盾的界面。
 */
const DEVICE_ENABLED = 1;

const DEVICE_DISABLED = 0;

/**
 * 正在切换启停的设备 id 集合（开关的 `loading` 与防重复提交）。
 *
 * 按行记而不是一个全局布尔：并发切换两台设备时，全局布尔会让**所有**开关一起转，
 * 也会把第二台设备的点击误判成「已在提交中」而静默丢弃（点了没反应）。
 */
const statusPending = ref<Record<string, boolean>>({});

/** 后端启停位按「启用」处理当且仅当它显式等于 1（`null/undefined` 视为启用，与 DB 默认值一致）。 */
function isDeviceEnabled(row: IotDeviceApi.DeviceResp) {
  return toBackendNumber(row.status ?? DEVICE_ENABLED) === DEVICE_ENABLED;
}

/**
 * 切换设备启停（G7′）。
 *
 * 🔴 为什么要二次确认：停用是**破坏性**动作——接入侧会解绑该设备并撤销其全部点位订阅，
 * 采集立刻停止。确认文案必须把这个后果说清楚，而不是干巴巴一句「确定吗」。
 *
 * 失败时**不保留乐观状态**：`.finally` 里无条件重查列表，让开关回到后端的真实值；
 * 成功时也重查（不能只翻本地位，否则「停用是否真的生效」在界面上无从体现）。
 */
function onToggleStatus(row: IotDeviceApi.DeviceResp, checked: boolean) {
  const target = checked ? DEVICE_ENABLED : DEVICE_DISABLED;
  statusPending.value = { ...statusPending.value, [row.id]: true };
  updateDeviceStatus(row.id, target)
    .then(() => {
      message.success(
        $t(
          target === DEVICE_ENABLED
            ? 'page.iot.device.statusEnableDone'
            : 'page.iot.device.statusDisableDone',
        ),
      );
    })
    .catch((error: unknown) => {
      // 原样展示后端 message：全局拦截器也会弹一次，但这里给出的是「这次切换没生效」的明确结论
      message.error(
        extractErrorMessage(error, $t('page.iot.device.statusUpdateFailed')),
      );
    })
    .finally(() => {
      // 用「删键后重新赋值」而不是 `delete`：oxlint 的 `no-dynamic-delete` 禁止对动态键做
      // delete（频繁删除会把对象推进字典模式、伤内联缓存）。这里用解构剔除该 id，
      // 语义与原写法一致（未在途的行不再有 loading 标记）。
      const { [row.id]: _removed, ...rest } = statusPending.value;
      void _removed;
      statusPending.value = rest;
      gridApi.query();
    });
}

/**
 * 向导第 3 步点了「添加设备」：先关向导，否则它会盖在设备表单抽屉上；
 * 表单本身由 `consumeCreateQuery()` 消费 `?productId=&action=create` 后打开（同一条既有链路）。
 */
function onGuideAddDevice() {
  GuideDrawerApi.close();
}

/** 打开租户接入台账抽屉（仅平台管理员可见：按钮由 `iot:ledger:list` 权限码门禁）。 */
function openLedger() {
  LedgerDrawerApi.open();
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="gridApi.query()" />
    <DetailDrawer />
    <AvailabilityDrawer />
    <SeriesDrawer />
    <GuideDrawer :title="$t('page.iot.onboarding.title')" class="w-[900px]">
      <OnboardingGuide @add-device="onGuideAddDevice" @done="gridApi.query()" />
    </GuideDrawer>
    <LedgerDrawer :title="$t('page.iot.ledger.pageTitle')" class="w-[1000px]">
      <TenantLedger />
    </LedgerDrawer>
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
    <Alert
      v-if="alertCountError"
      class="mb-2"
      closable
      :description="alertCountError"
      :message="$t('page.iot.alert.activeCountLoadFailed')"
      show-icon
      type="warning"
      @close="alertCountError = ''"
    />
    <Alert
      v-if="listError"
      class="mb-2"
      :description="listError"
      :message="$t('page.iot.device.listLoadFailed')"
      show-icon
      type="error"
    />
    <Grid>
      <template #toolbar-tools>
        <!-- 接入向导入口：不带权限码（方案 §6.1：所有角色可见，先知道下一步做什么）； -->
        <!-- 向导里的写动作各自沿用 iot:product:create / iot:product:publish / iot:device:create。 -->
        <Button class="mr-2" @click="openGuide">
          {{ $t('page.iot.onboarding.openGuide') }}
        </Button>
        <!-- 租户接入台账：平台级权限（platform_only=1），非平台管理员看不到这个按钮 -->
        <Button
          v-access:code="['iot:ledger:list']"
          class="mr-2"
          @click="openLedger"
        >
          {{ $t('page.iot.ledger.pageTitle') }}
        </Button>
        <Button
          v-access:code="['iot:device:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('ui.actionTitle.create', [$t('page.iot.device.name')]) }}
        </Button>
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
        启停开关（G7′）。
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
            :checked="true"
            :loading="!!statusPending[row.id]"
            size="small"
          />
        </Popconfirm>
        <Switch
          v-else
          v-access:code="['iot:device:update']"
          :checked="false"
          :loading="!!statusPending[row.id]"
          size="small"
          @change="() => onToggleStatus(row, true)"
        />
        <Tag v-if="!isDeviceEnabled(row)" class="ml-1" color="default">
          {{ $t('page.iot.device.statusDisabledTag') }}
        </Tag>
      </template>

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
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:device:update',
              onClick: () => onEdit(row),
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

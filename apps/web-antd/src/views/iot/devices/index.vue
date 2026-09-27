<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { onMounted, ref, watch } from 'vue';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Alert, Button, message } from 'ant-design-vue';
import { useRoute, useRouter } from 'vue-router';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteDevice, getDevicePage } from '#/api/iot';
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
 * 320014/320015，`platform_only=1`，见 `deploy/sql/007-iot-data.sql`），而**台账页暂时没有页面级菜单**
 * （本轮不新建 `sys_menu` 记录，避开与其它改动的冲突）。挂在设备页的工具栏里，平台管理员今天就能用，
 * 且不影响任何非平台角色（按钮由 `v-access:code` 按权限码隐藏）。
 * 页面级落点 `views/iot/tenant-ledger/index.vue` 已备好，接上菜单即生效。
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
      <OnboardingGuide
        @add-device="onGuideAddDevice"
        @done="gridApi.query()"
      />
    </GuideDrawer>
    <LedgerDrawer
      :title="$t('page.iot.ledger.pageTitle')"
      class="w-[1000px]"
    >
      <TenantLedger />
    </LedgerDrawer>
    <!--
      🔴 失败态**必须挂在表格之外**（不能只放 `#empty` 槽里）：
      真实 vxe 只在**表体没有行**时才渲染 `#empty` 槽 ⇒ 若把失败提示只放槽里，
      「已有数据后刷新失败」时旧行仍在、槽不渲染 ⇒ 失败提示**看不见**（只剩一次转瞬即逝的 toast），
      页面会继续展示**过期数据**而用户毫不知情。放在表格上方则任何一次失败都可见。
    -->
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

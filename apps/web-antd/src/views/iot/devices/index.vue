<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { onMounted, watch } from 'vue';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';
import { useRoute, useRouter } from 'vue-router';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteDevice, getDevicePage } from '#/api/iot';
import { $t } from '#/locales';

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

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) =>
          await getDevicePage({
            page: page.currentPage,
            pageSize: page.pageSize,
          }),
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
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="gridApi.query()" />
    <DetailDrawer />
    <AvailabilityDrawer />
    <SeriesDrawer />
    <Grid>
      <template #toolbar-tools>
        <Button
          v-access:code="['iot:device:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('ui.actionTitle.create', [$t('page.iot.device.name')]) }}
        </Button>
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

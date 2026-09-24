<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteDevice, getDevicePage } from '#/api/iot';
import { $t } from '#/locales';

import { useColumns } from './data';
import Availability from './modules/availability.vue';
import Form from './modules/form.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
const [AvailabilityDrawer, AvailabilityDrawerApi] = useVbenDrawer({
  connectedComponent: Availability,
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

function onEdit(row: IotDeviceApi.DeviceResp) {
  FormDrawerApi.setData(row).open();
}

function onAvailability(row: IotDeviceApi.DeviceResp) {
  AvailabilityDrawerApi.setData(row).open();
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
    <AvailabilityDrawer />
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
              text: $t('page.iot.availability.title', ['']),
              icon: 'lucide:activity',
              auth: 'iot:availability:get',
              onClick: () => onAvailability(row),
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

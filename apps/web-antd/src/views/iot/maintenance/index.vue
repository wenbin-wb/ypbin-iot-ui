<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotMaintenanceApi } from '#/api/iot';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { closeMaintenanceWindow, getMaintenanceWindowList } from '#/api/iot';
import { $t } from '#/locales';

import { useColumns } from './data';
import Form from './modules/form.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: { query: async () => await getMaintenanceWindowList({}) },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotMaintenanceApi.MaintenanceWindowDto>,
});

function onClose(row: IotMaintenanceApi.MaintenanceWindowDto) {
  closeMaintenanceWindow(row.id)
    .then(() => {
      message.success($t('common.success'));
      gridApi.query();
    })
    .catch(() => {});
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="gridApi.query()" />
    <Grid>
      <template #toolbar-tools>
        <Button
          v-access:code="['iot:maintenance:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('page.iot.maintenance.create') }}
        </Button>
      </template>

      <template #action="{ row }">
        <VbenTableAction
          v-if="!row.endTs"
          :actions="[
            {
              text: $t('page.iot.maintenance.close'),
              icon: 'lucide:circle-check',
              auth: 'iot:maintenance:close',
              popConfirm: {
                title: $t('page.iot.maintenance.closeConfirm'),
                confirm: () => onClose(row),
              },
            },
          ]"
          align="center"
        />
      </template>
    </Grid>
  </Page>
</template>

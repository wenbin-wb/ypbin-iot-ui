<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotMaintenanceApi } from '#/api/iot';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  closeMaintenanceWindow,
  getDeviceNameMap,
  getMaintenanceWindowList,
} from '#/api/iot';
import { $t } from '#/locales';

import { useColumns } from './data';
import Form from './modules/form.vue';

/**
 * 列表行 = 后端窗口 DTO + 前端补上的 `deviceName`。
 * 名称是**展示层**的加工结果（后端契约不变），故不进 `api/iot/maintenance.ts` 的 DTO。
 */
type MaintenanceWindowRow = IotMaintenanceApi.MaintenanceWindowDto & {
  deviceName: string;
};

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });

/**
 * 拉取窗口列表并把 `deviceId` 换成设备名（F3：解决「看不出关联」最直观的一处）。
 *
 * N+1 规避：先收齐本页所有 deviceId，**一次批量**解析（内部按页拉取、命中即停），
 * 绝不按行发请求；没有 deviceId 的窗口直接短路成「租户全部设备」，也不发多余请求。
 */
async function loadWindowRows(): Promise<MaintenanceWindowRow[]> {
  const rows = await getMaintenanceWindowList({});
  const deviceIds = rows
    .map((row) => row.deviceId)
    .filter((id): id is string => !!id);
  let names: Record<string, string> = {};
  try {
    names = await getDeviceNameMap(deviceIds);
  } catch (error) {
    // 设备名是**展示增强**，不是这条列表的前提：该角色可能只有维护窗口权限、没有设备列表权限
    // ⇒ 解析失败时回落显示裸 deviceId，绝不让整页窗口列表跟着失败（F3 不引入新的权限依赖）
    console.warn('[iot] 设备名解析失败，维护窗口列表回落显示设备 ID', error);
  }
  return rows.map((row) => ({
    ...row,
    deviceName: row.deviceId
      ? (names[row.deviceId] ?? row.deviceId)
      : $t('page.iot.maintenance.tenantWide'),
  }));
}

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: { query: async () => await loadWindowRows() },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<MaintenanceWindowRow>,
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

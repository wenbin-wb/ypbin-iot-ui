<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotGroupApi } from '#/api/iot';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteGroup, getGroupList } from '#/api/iot';
import { $t } from '#/locales';

import { useColumns } from './data';
import Form from './modules/form.vue';
import Members from './modules/members.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
/** 成员管理（F4）：抽屉而不是新路由页——路由由后端 sys_menu.component 决定，不另立菜单。 */
const [MembersDrawer, MembersDrawerApi] = useVbenDrawer({
  connectedComponent: Members,
});

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: { ajax: { query: async () => await getGroupList() } },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotGroupApi.GroupResp>,
});

function onEdit(row: IotGroupApi.GroupResp) {
  FormDrawerApi.setData(row).open();
}

function onMembers(row: IotGroupApi.GroupResp) {
  MembersDrawerApi.setData(row).open();
}

function onDelete(row: IotGroupApi.GroupResp) {
  deleteGroup(row.id)
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
    <MembersDrawer />
    <Grid>
      <template #toolbar-tools>
        <Button
          v-access:code="['iot:group:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('ui.actionTitle.create', [$t('page.iot.group.name')]) }}
        </Button>
      </template>

      <template #action="{ row }">
        <VbenTableAction
          :actions="[
            {
              text: $t('page.iot.group.members'),
              icon: 'lucide:users',
              auth: 'iot:group:list',
              onClick: () => onMembers(row),
            },
            {
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:group:update',
              onClick: () => onEdit(row),
            },
            {
              text: $t('common.delete'),
              icon: 'lucide:trash-2',
              auth: 'iot:group:delete',
              danger: true,
              popConfirm: {
                title: $t('ui.actionMessage.deleteConfirm', [row.groupName || '']),
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

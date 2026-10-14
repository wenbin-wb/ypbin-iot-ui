<script lang="ts" setup>
import type { GroupRow } from './data';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotGroupApi } from '#/api/iot';

import { ref } from 'vue';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteGroup, getGroupList } from '#/api/iot';
import { isRootGroup } from '#/api/iot/group';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import ListErrorAlert from '../shared/list-error-alert.vue';
import { useColumns } from './data';
import Form from './modules/form.vue';
import Members from './modules/members.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
/** 成员管理：抽屉而不是新路由页——路由由后端 sys_menu.component 决定，不另立菜单。 */
const [MembersDrawer, MembersDrawerApi] = useVbenDrawer({
  connectedComponent: Members,
});

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 本页原先**连 `#empty` 槽都没有** ⇒ 加载失败时直接落到 vxe 的默认「暂无数据」，
 * 那是彻底的**假空态**（用户会以为分组真的没了）。失败必须单独、持续可见。
 */
const listError = ref('');

/**
 * 给列表行补展示用的 `parentIdName`：parentId → groupName 的映射来自**同一次**列表结果
 * （一次批量，绝不逐行查）；根分组、父分组已不存在时保持空，由列 formatter 决定显示什么。
 */
function withParentIdName(rows: IotGroupApi.GroupResp[]): GroupRow[] {
  const nameById = new Map(rows.map((row) => [row.id, row.groupName]));
  return rows.map((row) => {
    const parentId = isRootGroup(row.parentId)
      ? undefined
      : String(row.parentId);
    const parentIdName = parentId ? nameById.get(parentId) : undefined;
    return parentIdName ? { ...row, parentIdName } : { ...row };
  });
}

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async () => {
          try {
            const rows = await getGroupList();
            listError.value = '';
            return withParentIdName(rows);
          } catch (error) {
            // 记下失败原因（原样展示后端 message），异常继续抛出 ⇒ 不改原有失败语义
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.group.listLoadFailed'),
            );
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<GroupRow>,
});

function onEdit(row: GroupRow) {
  FormDrawerApi.setData(row).open();
}

function onMembers(row: GroupRow) {
  MembersDrawerApi.setData(row).open();
}

function onDelete(row: GroupRow) {
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
    <!-- 失败态必须挂在表格之外：真实 vxe 只在表体无行时渲染 `#empty` 槽，
         「已有数据后刷新失败」时槽不渲染 ⇒ 放槽里的失败提示会看不见。
         统一走 shared/list-error-alert.vue。 -->
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.group.listLoadFailed')"
    />
    <Grid>
      <!-- 空态：本页原先没有 `#empty` 槽 ⇒ 失败时会落到 vxe 默认的「暂无数据」（假空态）。
           这里只声明**真的没有数据**这一种情况；失败态由上方 ListErrorAlert 单独承担。 -->
      <template #empty>
        <span v-if="!listError" class="text-muted-foreground">
          {{ $t('page.iot.group.emptyHint') }}
        </span>
      </template>

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
                title: $t('ui.actionMessage.deleteConfirm', [
                  row.groupName || '',
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

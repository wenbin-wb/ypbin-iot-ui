<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotMaintenanceApi } from '#/api/iot';

import { ref } from 'vue';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Alert, Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  closeMaintenanceWindow,
  getDeviceNameMap,
  getMaintenanceWindowList,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';

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
/** 接入向导（F6）抽屉：空态引导的「下一步」入口（保持与设备/产品页同一处）。 */
const [GuideDrawer, GuideDrawerApi] = useVbenDrawer();

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

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 vxe 的 `#empty` 槽分不清「加载失败」与「确实没有窗口」⇒ 原来只挂 `EmptyGuide`
 * 会把失败画成「还没有维护窗口」，而维护窗口为空的**真实含义**是「计划停机不会被排除、
 * 可用率会偏低」——把一个查询失败说成这件事是会误导运维的。失败必须单独、持续可见。
 */
const listError = ref('');

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
            const rows = await loadWindowRows();
            listError.value = '';
            return rows;
          } catch (error) {
            // 记下失败原因（原样展示后端 message），异常继续抛出 ⇒ 不改原有失败语义
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.maintenance.listLoadFailed'),
            );
            throw error;
          }
        },
      },
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

/** 打开接入向导抽屉（空态引导的「下一步」）。 */
function openGuide() {
  GuideDrawerApi.open();
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="gridApi.query()" />
    <GuideDrawer :title="$t('page.iot.onboarding.title')" class="w-[900px]">
      <OnboardingGuide @done="gridApi.query()" />
    </GuideDrawer>
    <!-- 失败态必须挂在表格之外：真实 vxe 只在表体无行时渲染 `#empty` 槽，
         「已有数据后刷新失败」时槽不渲染 ⇒ 放槽里的失败提示会看不见。 -->
    <Alert
      v-if="listError"
      class="mb-2"
      :description="listError"
      :message="$t('page.iot.maintenance.listLoadFailed')"
      show-icon
      type="error"
    />
    <Grid>
      <template #toolbar-tools>
        <Button class="mr-2" @click="openGuide">
          {{ $t('page.iot.onboarding.openGuide') }}
        </Button>
        <Button
          v-access:code="['iot:maintenance:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('page.iot.maintenance.create') }}
        </Button>
      </template>

      <!-- 空态引导：维护窗口为空时说明「为什么是空的 + 下一步点哪里」 -->
      <template #empty>
        <!-- 失败时由上方 Alert 承担失败态，这里不得再声称「没有数据」 -->
        <EmptyGuide
          v-if="!listError"
          :reason="$t('page.iot.maintenance.emptyReason')"
          @open-guide="openGuide"
        />
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

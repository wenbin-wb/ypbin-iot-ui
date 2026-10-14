<script lang="ts" setup>
import type { MaintenanceWindowRow } from './data';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotMaintenanceApi } from '#/api/iot';

import { ref } from 'vue';

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
import { extractErrorMessage } from '#/utils/error';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';
import { maintenanceState } from '../shared/display';
import ListErrorAlert from '../shared/list-error-alert.vue';
import { useColumns, useGridFormSchema } from './data';
import Form from './modules/form.vue';

/** 列表查询参数（字段与后端 `getMaintenanceWindowList` 契约同名）。 */
type MaintenanceWindowQuery = {
  deviceId?: string;
  from?: string;
  to?: string;
};

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
/** 接入向导抽屉：空态引导的「下一步」入口（保持与设备/产品页同一处）。 */
const [GuideDrawer, GuideDrawerApi] = useVbenDrawer();

/** 设备名优先级：后端注解名 → 批量解析映射 → 裸 deviceId → 租户级文案（空串按缺失处理）。 */
function resolveDeviceName(
  row: IotMaintenanceApi.MaintenanceWindowDto,
  names: Record<string, string>,
): string {
  if (row.deviceIdName) {
    return row.deviceIdName;
  }
  if (!row.deviceId) {
    return $t('page.iot.maintenance.tenantWide');
  }
  return names[row.deviceId] ?? row.deviceId;
}

/**
 * 拉取窗口列表并把 `deviceId` 换成设备名（解决「看不出关联」最直观的一处）。
 *
 * 名称优先级：后端 `@RefText("device")` 注解名 `deviceIdName` → 批量解析映射 → 裸 `deviceId`
 * → 租户级文案。**仅对注解名缺失的行**做批量解析，且先按 id 去重后**一次批量**（内部按页拉取、
 * 命中即停）：全部行都有注解名时不发该请求；没有 deviceId 的租户级窗口不参与解析。
 */
async function loadWindowRows(
  params: MaintenanceWindowQuery,
): Promise<MaintenanceWindowRow[]> {
  const rows = await getMaintenanceWindowList(params);
  const missingIds = [
    ...new Set(
      rows
        .filter((row) => !row.deviceIdName)
        .map((row) => row.deviceId)
        .filter((id): id is string => !!id),
    ),
  ];
  let names: Record<string, string> = {};
  if (missingIds.length > 0) {
    try {
      names = await getDeviceNameMap(missingIds);
    } catch (error) {
      // 设备名是**展示增强**，不是这条列表的前提：该角色可能只有维护窗口权限、没有设备列表权限
      // ⇒ 解析失败时回落显示裸 deviceId，绝不让整页窗口列表跟着失败（设备名解析不引入新的权限依赖）
      console.warn('[iot] 设备名解析失败，维护窗口列表回落显示设备 ID', error);
    }
  }
  return rows.map((row) => ({
    ...row,
    deviceName: resolveDeviceName(row, names),
    maintenanceState: maintenanceState(row.startTs, row.endTs),
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
  formOptions: {
    schema: useGridFormSchema(),
    submitOnChange: true,
  },
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async (_params, formValues: MaintenanceWindowQuery) => {
          try {
            const rows = await loadWindowRows(formValues ?? {});
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
    toolbarConfig: {
      custom: true,
      export: false,
      refresh: true,
      search: true,
      zoom: true,
    },
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
         「已有数据后刷新失败」时槽不渲染 ⇒ 放槽里的失败提示会看不见。
         统一走 shared/list-error-alert.vue。 -->
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.maintenance.listLoadFailed')"
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
        <!-- 失败时由上方 ListErrorAlert 承担失败态，这里不得再声称「没有数据」 -->
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

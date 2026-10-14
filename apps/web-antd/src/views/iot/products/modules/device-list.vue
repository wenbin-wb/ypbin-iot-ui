<script lang="ts" setup>
import type {
  VxeTableGridColumns,
  VxeTableGridOptions,
} from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { ref, watch } from 'vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getDevicePage } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  formatDateTime,
  onlineStatusColor,
  onlineStatusOptions,
  protocolLabel,
} from '../../shared/display';
import ListErrorAlert from '../../shared/list-error-alert.vue';

/**
 * 产品详情「设备」页签：按 `productId` 服务端分页列出该产品的设备。
 *
 * 纯内嵌列表（不是独立路由页），因此列定义与查询都收在本文件内：
 * 它只服务这一个宿主，抽到 products/data.ts 反而会让「产品列表页的列」与
 * 「产品详情的设备列」共用文件、彼此牵连。
 *
 * 约定：
 * - 查询参数名与后端 `IotDeviceQuery.productId` 同名，透传不映射（铁律 7）；
 * - 失败走共享 `ListErrorAlert`，且 `#empty` 槽在失败时不得声称「还没有设备」（失败 ≠ 空态）；
 * - 展示列统一走 shared/display（协议中文名、在线状态 Tag、时间格式化）。
 */
const props = defineProps<{ productId: string }>();

/** 列表加载失败原因（空 = 本次成功）。 */
const listError = ref('');

function useColumns(): VxeTableGridColumns {
  return [
    { field: 'deviceCode', title: $t('page.iot.device.code'), minWidth: 140 },
    { field: 'deviceName', title: $t('page.iot.device.name'), minWidth: 160 },
    {
      field: 'protocol',
      title: $t('page.iot.device.protocol'),
      width: 110,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        protocolLabel(cellValue),
    },
    {
      field: 'onlineStatus',
      title: $t('page.iot.device.onlineStatus'),
      width: 110,
      cellRender: {
        name: 'CellTag',
        options: onlineStatusOptions().map((item) => ({
          color: onlineStatusColor(item.value),
          label: item.label,
          value: item.value,
        })),
      },
    },
    {
      field: 'lastSeenAt',
      title: $t('page.iot.device.lastSeenAt'),
      width: 170,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        formatDateTime(cellValue),
    },
    {
      field: 'status',
      title: $t('page.iot.device.status'),
      width: 100,
      cellRender: {
        name: 'CellTag',
        options: [
          {
            color: 'success',
            label: $t('page.iot.device.enabled'),
            value: 1,
          },
          {
            color: 'default',
            label: $t('page.iot.device.disabled'),
            value: 0,
          },
        ],
      },
    },
  ];
}

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    // 内嵌在详情页签里没有 auto-content-height 高度链 ⇒ 给一个确定高度，
    // 否则 vxe 拿 0 高不渲染行（同 tenant-ledger 页头注释里的教训）。
    height: 420,
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }) => {
          try {
            const result = await getDevicePage({
              page: page.currentPage,
              pageSize: page.pageSize,
              productId: props.productId,
            });
            listError.value = '';
            // 后端 total 是 Long → 字符串；vxe 分页要算页数 ⇒ 进表格前显式转数。
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            // 原样展示后端 message，异常继续抛出（全局拦截器与 vxe 失败分支都保持不变）
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

/** 宿主切换产品（同一组件复用）时按新产品重查。 */
watch(
  () => props.productId,
  () => {
    if (props.productId) {
      gridApi.query();
    }
  },
);

/** 供宿主（产品详情）在需要时主动刷新设备页签。 */
function reload() {
  gridApi.query();
}

defineExpose({ reload });
</script>

<template>
  <div class="flex h-full flex-col">
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.device.listLoadFailed')"
    />
    <Grid>
      <!-- 空态：失败由上方 ListErrorAlert 承担，这里不得再声称「还没有设备」 -->
      <template #empty>
        <div v-if="!listError" class="text-muted-foreground py-8 text-center">
          {{ $t('page.iot.product.devicesEmptyReason') }}
        </div>
      </template>
    </Grid>
  </div>
</template>

<script lang="ts" setup>
import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotProductApi } from '#/api/iot';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteProduct, getProductPage, publishProduct } from '#/api/iot';
import { $t } from '#/locales';

import { useColumns } from './data';
import Detail from './modules/detail.vue';
import Form from './modules/form.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
const [DetailDrawer, DetailDrawerApi] = useVbenDrawer({
  connectedComponent: Detail,
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
          await getProductPage({
            page: page.currentPage,
            pageSize: page.pageSize,
          }),
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotProductApi.ProductResp>,
});

function onEdit(row: IotProductApi.ProductResp) {
  FormDrawerApi.setData(row).open();
}

/** 产品详情（F2）：5 页签 + 物模型编辑器 + 添加设备入口，全部走已存在的物模型接口。 */
function onDetail(row: IotProductApi.ProductResp) {
  DetailDrawerApi.setData(row).open();
}

function onDelete(row: IotProductApi.ProductResp) {
  deleteProduct(row.id)
    .then(() => {
      message.success($t('common.success'));
      gridApi.query();
    })
    .catch(() => {});
}

function onPublish(row: IotProductApi.ProductResp) {
  publishProduct(row.id)
    .then((version) => {
      message.success(`${$t('common.success')} ${version}`);
      gridApi.query();
    })
    .catch(() => {});
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="gridApi.query()" />
    <DetailDrawer @reload="gridApi.query()" />
    <Grid>
      <template #toolbar-tools>
        <Button
          v-access:code="['iot:product:create']"
          type="primary"
          @click="FormDrawerApi.setData(null).open()"
        >
          <template #icon><Plus /></template>
          {{ $t('ui.actionTitle.create', [$t('page.iot.product.name')]) }}
        </Button>
      </template>

      <template #action="{ row }">
        <VbenTableAction
          :actions="[
            {
              text: $t('page.iot.product.detail'),
              icon: 'lucide:info',
              auth: 'iot:product:list',
              onClick: () => onDetail(row),
            },
            {
              text: $t('page.iot.product.publish'),
              icon: 'lucide:upload',
              auth: 'iot:product:publish',
              popConfirm: {
                title: $t('page.iot.product.publishConfirm'),
                confirm: () => onPublish(row),
              },
            },
            {
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:product:update',
              onClick: () => onEdit(row),
            },
            {
              text: $t('common.delete'),
              icon: 'lucide:trash-2',
              auth: 'iot:product:delete',
              danger: true,
              popConfirm: {
                title: $t('ui.actionMessage.deleteConfirm', [
                  row.productName || row.productCode || '',
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

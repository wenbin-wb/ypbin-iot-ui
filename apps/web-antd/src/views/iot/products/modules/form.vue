<script lang="ts" setup>
import type { IotProductApi } from '#/api/iot';

import { nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import { createProduct, updateProduct } from '#/api/iot';
import { $t } from '#/locales';

import { useFormSchema } from '../data';

const emit = defineEmits(['reload']);
const isUpdate = ref(false);
const rowId = ref('');

const [Form, formApi] = useVbenForm({
  schema: useFormSchema(),
  showDefaultActions: false,
});

const [Drawer, drawerApi] = useVbenDrawer<null | IotProductApi.ProductResp>({
  onCancel() {
    drawerApi.close();
  },
  async onConfirm() {
    try {
      drawerApi.setState({ confirmLoading: true });
      const { valid } = await formApi.validate();
      if (!valid) {
        return;
      }
      const values = await formApi.getValues<IotProductApi.ProductSaveReq>();
      if (isUpdate.value) {
        await updateProduct(rowId.value, values);
      } else {
        await createProduct(values);
      }
      message.success($t('common.success'));
      drawerApi.close();
      emit('reload');
    } finally {
      drawerApi.setState({ confirmLoading: false });
    }
  },
  async onOpenChange(isOpen: boolean) {
    if (isOpen) {
      const data = drawerApi.getData();
      isUpdate.value = !!data?.id;
      rowId.value = data?.id ?? '';
      formApi.reset();
      drawerApi.setState({
        title: isUpdate.value
          ? $t('ui.actionTitle.edit', [$t('iot.product.name')])
          : $t('ui.actionTitle.create', [$t('iot.product.name')]),
      });
      await nextTick();
      if (data) {
        formApi.setValues(data);
      }
    }
  },
});

defineExpose({ drawerApi });
</script>
<template>
  <Drawer>
    <Form />
  </Drawer>
</template>

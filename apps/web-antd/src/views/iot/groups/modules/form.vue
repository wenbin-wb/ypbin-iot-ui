<script lang="ts" setup>
import type { IotGroupApi } from '#/api/iot';

import { nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import { createGroup, updateGroup } from '#/api/iot';
import { $t } from '#/locales';

import { useFormSchema } from '../data';

const emit = defineEmits(['reload']);
const isUpdate = ref(false);
const rowId = ref('');

const [Form, formApi] = useVbenForm({
  schema: useFormSchema(),
  showDefaultActions: false,
});

const [Drawer, drawerApi] = useVbenDrawer<null | IotGroupApi.GroupResp>({
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
      const values = await formApi.getValues<IotGroupApi.GroupSaveReq>();
      if (isUpdate.value) {
        await updateGroup(rowId.value, values);
      } else {
        await createGroup(values);
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
          ? $t('ui.actionTitle.edit', [$t('page.iot.group.name')])
          : $t('ui.actionTitle.create', [$t('page.iot.group.name')]),
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

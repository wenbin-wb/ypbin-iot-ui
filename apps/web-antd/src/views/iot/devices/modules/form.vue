<script lang="ts" setup>
import type { IotDeviceApi } from '#/api/iot';

import { nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import {
  createDevice,
  getDeviceSpaces,
  syncDeviceSpaces,
  updateDevice,
} from '#/api/iot';
import { $t } from '#/locales';

import { buildCreateDeviceValues } from '../create-defaults';
import { useFormSchema } from '../data';

const emit = defineEmits(['reload']);
const isUpdate = ref(false);
const rowId = ref('');

/**
 * 打开时回显的空间集合（用于「只在变更时才调 sync」）。
 *
 * **为什么必须记录**：sync 端点要求 `iot:device:update` 之外的关联写权限路径，
 * 若每次保存都无条件调 sync，就会出现「设备已保存成功 → sync 失败 → 抽屉停在打开态」。
 * 只在集合真的变了才同步，既省一次请求，也避免无权限用户连改备注都被卡住。
 */
const originalSpaceIds = ref<string[]>([]);

const [Form, formApi] = useVbenForm({
  schema: useFormSchema(),
  showDefaultActions: false,
});

const [Drawer, drawerApi] =
  useVbenDrawer<null | Partial<IotDeviceApi.DeviceResp>>({
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
        const values = await formApi.getValues<
          IotDeviceApi.DeviceSaveReq & { spaceIds?: string[] }
        >();
        // 空间集合单独处理：不进 DeviceSaveReq（否则改备注也要空间绑定权限）
        const desiredSpaces = values.spaceIds ?? [];
        const { spaceIds: _ignored, ...saveValues } = values;

        let deviceId: string;
        if (isUpdate.value) {
          deviceId = rowId.value;
          await updateDevice(
            deviceId,
            saveValues as IotDeviceApi.DeviceSaveReq,
          );
        } else {
          // 新建返回 ID ⇒ 新建时也能立即绑定空间（否则用户选的空间被静默丢弃）
          const created = await createDevice(
            buildCreateDeviceValues(saveValues as IotDeviceApi.DeviceSaveReq),
          );
          deviceId = String(created);
        }

        // 只在空间集合**变更**时才同步（见 originalSpaceIds 的注释）
        const changed =
          !isUpdate.value ||
          desiredSpaces.length !== originalSpaceIds.value.length ||
          desiredSpaces.some((id) => !originalSpaceIds.value.includes(id));
        if (deviceId && changed) {
          try {
            await syncDeviceSpaces(deviceId, desiredSpaces);
          } catch (error: any) {
            // 设备已保存成功，但空间关联失败：必须说清「哪一步失败」，
            // 不能笼统报「保存失败」（用户会以为设备没存而重复提交）
            message.error(
              `${$t('page.iot.device.spaceSyncFailed')}${error?.message ?? ''}`,
            );
            drawerApi.setState({ confirmLoading: false });
            return;
          }
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
            ? $t('ui.actionTitle.edit', [$t('page.iot.device.name')])
            : $t('ui.actionTitle.create', [$t('page.iot.device.name')]),
        });
        originalSpaceIds.value = [];
        await nextTick();
        if (data) {
          formApi.setValues(data);
          // 回显已有空间（设备可对应多个空间点）
          if (data.id) {
            try {
              const ids = await getDeviceSpaces(data.id);
              originalSpaceIds.value = ids;
              formApi.setValues({ spaceIds: ids });
            } catch {
              // 回显失败不阻断编辑，但必须提示：否则用户保存时会把关联清空却不知道
              message.warning($t('page.iot.device.spaceLoadFailed'));
            }
          }
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

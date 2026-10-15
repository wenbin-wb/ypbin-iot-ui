<script lang="ts" setup>
import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { IotDeviceTagApi } from '#/api/iot';

import { nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import { batchRemoveDeviceTags, batchSetDeviceTags } from '#/api/iot/tag';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  checkTagForm,
  normalizeTagForm,
  resolveTagFormCheckMessage,
  TAG_KEY_MAX,
  TAG_VALUE_MAX,
} from './tag-state';

/**
 * 设备台账「批量打标签 / 批量移除标签」抽屉。
 *
 * 同一个组件按 `mode` 切换：
 * - `set`：tagKey + tagValue 两个输入（已存在则更新值，不存在则新增）；
 * - `remove`：tagKeys 标签输入（可多个，回车分隔）。
 *
 * 契约（后端 `IotDeviceBatchTagController`）：
 * - `POST /iot/devices/batch-tags`        权限 iot:tag:create/update 任一；
 * - `POST /iot/devices/batch-tags/remove` 权限 iot:tag:delete；
 * - 返回 `{created, updated, removed}`，成功提示必须给出真实数量。
 *
 * 三条纪律：表单走 vben schema；提交中 lock 防重复；失败原样展示后端 message 且不关闭抽屉。
 */
type BatchTagsMode = 'remove' | 'set';

interface BatchTagsData {
  deviceIds: string[];
  mode: BatchTagsMode;
}

const emit = defineEmits<{
  (e: 'success', result: IotDeviceTagApi.BatchTagResp): void;
}>();

const mode = ref<BatchTagsMode>('set');

const deviceIds = ref<string[]>([]);

/** 程序性防重复：drawer lock 之外再挡一层（测试/慢网络下按钮状态可能滞后）。 */
let submitting = false;

/** 标签键输入归一化：trim → 去空 → 去重（保持用户输入顺序）。 */
function normalizeTagKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const keys = value.map((item) => String(item ?? '').trim()).filter(Boolean);
  return [...new Set(keys)];
}

/** 按当前模式生成表单 schema（open 时用 `setState` 整体替换）。 */
function useFormSchema(currentMode: BatchTagsMode): FormSchema[] {
  if (currentMode === 'remove') {
    return [
      {
        component: 'Select',
        componentProps: {
          allowClear: true,
          class: 'w-full',
          mode: 'tags',
          placeholder: $t('page.iot.tag.keysPlaceholder'),
          tokenSeparators: [',', '，'],
        },
        fieldName: 'tagKeys',
        label: $t('page.iot.tag.keys'),
        rules: 'required',
      },
    ];
  }
  return [
    {
      component: 'Input',
      componentProps: {
        maxlength: TAG_KEY_MAX,
        placeholder: $t('page.iot.tag.keyPlaceholder'),
      },
      fieldName: 'tagKey',
      label: $t('page.iot.tag.key'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: TAG_VALUE_MAX,
        placeholder: $t('page.iot.tag.valuePlaceholder'),
      },
      fieldName: 'tagValue',
      label: $t('page.iot.tag.value'),
      rules: 'required',
    },
  ];
}

const [Form, formApi] = useVbenForm({
  schema: useFormSchema('set'),
  showDefaultActions: false,
});

const [Drawer, drawerApi] = useVbenDrawer<BatchTagsData>({
  onCancel() {
    drawerApi.close();
  },
  async onConfirm() {
    if (submitting) {
      return;
    }
    submitting = true;
    try {
      const { valid } = await formApi.validate();
      if (!valid) {
        return;
      }
      const values = await formApi.getValues();

      // 校验先于 lock：校验失败不该把抽屉锁住，用户可当场改
      if (mode.value === 'remove') {
        const tagKeys = normalizeTagKeys(values.tagKeys);
        if (tagKeys.length === 0) {
          message.error($t('page.iot.tag.validation.keysRequired'));
          return;
        }
        const tooLong = tagKeys.find((key) => key.length > TAG_KEY_MAX);
        if (tooLong) {
          message.error(
            $t('page.iot.tag.validation.keyTooLong', [TAG_KEY_MAX]),
          );
          return;
        }

        drawerApi.lock();
        try {
          const result = await batchRemoveDeviceTags(deviceIds.value, tagKeys);
          message.success(
            $t('page.iot.device.batchTagRemoveDone', [
              String(result.removed ?? 0),
            ]),
          );
          emit('success', result);
          drawerApi.close();
        } catch (error) {
          // 原样展示后端 message；不关闭抽屉，用户可修正后重试
          message.error(
            extractErrorMessage(error, $t('page.iot.tag.deleteFailed')),
          );
          drawerApi.unlock();
        }
        return;
      }

      const check = checkTagForm(
        String(values.tagKey ?? ''),
        String(values.tagValue ?? ''),
      );
      if (!check.ok) {
        message.error(resolveTagFormCheckMessage(check));
        return;
      }
      const payload = normalizeTagForm(
        String(values.tagKey ?? ''),
        String(values.tagValue ?? ''),
      );

      drawerApi.lock();
      try {
        const result = await batchSetDeviceTags(
          deviceIds.value,
          payload.tagKey,
          payload.tagValue,
        );
        message.success(
          $t('page.iot.device.batchTagSetDone', [
            String(result.created ?? 0),
            String(result.updated ?? 0),
          ]),
        );
        emit('success', result);
        drawerApi.close();
      } catch (error) {
        message.error(
          extractErrorMessage(error, $t('page.iot.tag.saveFailed')),
        );
        drawerApi.unlock();
      }
    } finally {
      submitting = false;
    }
  },
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    mode.value = data?.mode === 'remove' ? 'remove' : 'set';
    deviceIds.value = data?.deviceIds ?? [];
    drawerApi.setState({
      title:
        mode.value === 'remove'
          ? $t('page.iot.device.batchTagRemoveTitle', [
              String(deviceIds.value.length),
            ])
          : $t('page.iot.device.batchTagSetTitle', [
              String(deviceIds.value.length),
            ]),
    });
    formApi.reset();
    // 两种模式的字段不同：整体替换 schema，避免上一模式字段残留
    formApi.setState({ schema: useFormSchema(mode.value) });
    await nextTick();
  },
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer>
    <Form />
  </Drawer>
</template>

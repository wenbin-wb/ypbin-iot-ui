<script lang="ts" setup>
import type { BoardWidget, BoardWidgetType } from './board-utils';

import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { IotDeviceApi } from '#/api/iot';

import { nextTick } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { useVbenForm } from '#/adapter/form';
import { getDeviceLatest, getDeviceOptions } from '#/api/iot/device';
import { getDevicePoints } from '#/api/iot/point';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { buildPropertyOptions, isBoardWidgetType } from './board-utils';

/**
 * 看板组件的新增/编辑弹层（useVbenForm schema + useVbenModal）。
 *
 * 点位候选：设备变化时由 ApiSelect 的 `params` 触发重新拉取（`getDevicePoints` +
 * `getDeviceLatest` 合并）。候选加载失败/为空时**不静默**：在下拉里放一条禁用项，
 * 把后端 message（或「暂无点位」的原因）直接显示给用户。
 */
interface BoardWidgetFormData {
  widget?: BoardWidget;
}

interface BoardWidgetFormValues {
  deviceId?: string;
  propertyId?: string;
  title?: string;
  type?: string;
}

const emit = defineEmits<{
  success: [BoardWidget];
}>();

const TYPE_OPTIONS: { label: string; value: BoardWidgetType }[] = [
  { label: $t('page.iot.board.typeValue'), value: 'value' },
  { label: $t('page.iot.board.typeGauge'), value: 'gauge' },
  { label: $t('page.iot.board.typeLine'), value: 'line' },
  { label: $t('page.iot.board.typeStatus'), value: 'status' },
];

/** ApiSelect 的 `api`：按参数里的 deviceId 拉候选；失败/为空用禁用项把原因显示出来。 */
async function loadPropertyOptions(params?: { deviceId?: string }) {
  const deviceId = String(params?.deviceId ?? '').trim();
  if (deviceId === '') {
    return [];
  }
  const [pointsResult, latestResult] = await Promise.allSettled([
    getDevicePoints(deviceId),
    getDeviceLatest(deviceId),
  ]);
  if (
    pointsResult.status === 'rejected' &&
    latestResult.status === 'rejected'
  ) {
    const message = extractErrorMessage(
      pointsResult.reason,
      $t('page.iot.board.propertyLoadFailed'),
    );
    return [
      {
        disabled: true,
        label: `${$t('page.iot.board.propertyLoadFailed')}：${message}`,
        value: '__board_point_error__',
      },
    ];
  }
  const options = buildPropertyOptions(
    pointsResult.status === 'fulfilled' ? pointsResult.value : [],
    latestResult.status === 'fulfilled' ? latestResult.value : [],
  );
  if (options.length === 0) {
    return [
      {
        disabled: true,
        label: $t('page.iot.board.propertyEmpty'),
        value: '__board_point_empty__',
      },
    ];
  }
  return options;
}

function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Select',
      componentProps: {
        options: TYPE_OPTIONS,
      },
      defaultValue: 'value',
      fieldName: 'type',
      label: $t('page.iot.board.type'),
      rules: 'selectRequired',
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: 60,
        placeholder: $t('page.iot.board.widgetTitlePlaceholder'),
      },
      fieldName: 'title',
      label: $t('page.iot.board.widgetTitle'),
      rules: 'required',
    },
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: () => getDeviceOptions(),
        class: 'w-full',
        labelField: 'deviceName',
        labelFn: (item: IotDeviceApi.DeviceResp) =>
          item.deviceName || item.deviceCode || item.id,
        placeholder: $t('page.iot.board.devicePlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      label: $t('page.iot.board.device'),
      rules: 'selectRequired',
    },
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: loadPropertyOptions,
        class: 'w-full',
        labelField: 'label',
        placeholder: $t('page.iot.board.propertyPlaceholder'),
        showSearch: true,
        valueField: 'value',
      },
      dependencies: {
        resolve: ({ values }) => ({
          componentProps: {
            params: { deviceId: values.deviceId ?? '' },
            // 未选设备时点位下拉是禁用的：placeholder 直接说明原因，而不是留一个空框
            placeholder: values.deviceId
              ? $t('page.iot.board.propertyPlaceholder')
              : $t('page.iot.board.noDevice'),
          },
          disabled: !values.deviceId,
        }),
        triggerFields: ['deviceId'],
      },
      fieldName: 'propertyId',
      label: $t('page.iot.board.property'),
      rules: 'selectRequired',
    },
  ];
}

const [Form, formApi] = useVbenForm({
  schema: useFormSchema(),
  showDefaultActions: false,
});

const [Modal, modalApi] = useVbenModal<BoardWidgetFormData>({
  async onCancel() {
    modalApi.close();
  },
  async onConfirm() {
    const { valid } = await formApi.validate();
    if (!valid) {
      return;
    }
    const values = await formApi.getValues<BoardWidgetFormValues>();
    const widget: BoardWidget = {
      deviceId: String(values.deviceId ?? '').trim(),
      id: modalApi.getData()?.widget?.id ?? '',
      propertyId: String(values.propertyId ?? '').trim(),
      title: String(values.title ?? '').trim(),
      type: isBoardWidgetType(values.type) ? values.type : 'value',
    };
    modalApi.lock();
    try {
      emit('success', widget);
      modalApi.close();
    } finally {
      modalApi.unlock();
    }
  },
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = modalApi.getData();
    formApi.reset();
    modalApi.setState({
      title: data?.widget
        ? $t('ui.actionTitle.edit', [$t('page.iot.board.widget')])
        : $t('ui.actionTitle.create', [$t('page.iot.board.widget')]),
    });
    await nextTick();
    formApi.setValues({
      deviceId: data?.widget?.deviceId ?? undefined,
      propertyId: data?.widget?.propertyId ?? undefined,
      title: data?.widget?.title ?? '',
      type: data?.widget?.type ?? 'value',
    });
  },
});

defineExpose({ modalApi });
</script>

<template>
  <Modal>
    <Form />
  </Modal>
</template>

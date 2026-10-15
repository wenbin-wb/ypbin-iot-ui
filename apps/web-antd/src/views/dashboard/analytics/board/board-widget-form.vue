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

import {
  buildPropertyOptions,
  IOT_BOARD_MAX_DECIMALS,
  isBoardWidgetFieldVisible,
  isBoardWidgetType,
  isMultiPointWidgetType,
  sanitizeBoardPropertyIds,
} from './board-utils';

/**
 * 看板组件的新增/编辑弹层（useVbenForm schema + useVbenModal）。
 *
 * 两条约束：
 * 1. **按类型条件显示字段**：点位/量程/单位/窗口/小数位只在相关组件类型下出现
 *    （见 board-utils 的 BOARD_WIDGET_FIELD_TYPES），用 dependencies.resolve 驱动，
 *    避免「选了仪表盘还要求填折线窗口」这种噪声；
 * 2. **点位候选不静默失败**：设备变化时由 ApiSelect 的 params 触发重新拉取
 *    （getDevicePoints + getDeviceLatest 合并）；失败/为空时在下拉里放一条禁用项，
 *    把后端 message（或「暂无点位」的原因）直接显示给用户。
 */
interface BoardWidgetFormData {
  widget?: BoardWidget;
}

interface BoardWidgetFormValues {
  decimals?: number;
  deviceId?: string;
  max?: number;
  min?: number;
  propertyId?: string;
  propertyIds?: string[];
  title?: string;
  type?: string;
  unit?: string;
  windowMinutes?: number;
}

const emit = defineEmits<{
  success: [BoardWidget];
}>();

const TYPE_OPTIONS: { label: string; value: BoardWidgetType }[] = [
  { label: $t('page.iot.board.typeValue'), value: 'value' },
  { label: $t('page.iot.board.typeGauge'), value: 'gauge' },
  { label: $t('page.iot.board.typeLine'), value: 'line' },
  { label: $t('page.iot.board.typeStatus'), value: 'status' },
  { label: $t('page.iot.board.typeBoolean'), value: 'boolean' },
  { label: $t('page.iot.board.typeMultiLine'), value: 'multi-line' },
  { label: $t('page.iot.board.typeTable'), value: 'table' },
];

/** 窗口档位（分钟）：按现场常用粒度给选项，避免用户填出「3 天」这种占用看板实时通道的值。 */
const WINDOW_OPTIONS = [
  { label: $t('page.iot.board.window1h'), value: 60 },
  { label: $t('page.iot.board.window6h'), value: 360 },
  { label: $t('page.iot.board.window24h'), value: 1440 },
  { label: $t('page.iot.board.window7d'), value: 10_080 },
];

/** ApiSelect 的 api：按参数里的 deviceId 拉候选；失败/为空用禁用项把原因显示出来。 */
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
    const errorMessage = extractErrorMessage(
      pointsResult.reason,
      $t('page.iot.board.propertyLoadFailed'),
    );
    return [
      {
        disabled: true,
        label: `${$t('page.iot.board.propertyLoadFailed')}：${errorMessage}`,
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

/** 依类型显隐的依赖配置（triggerFields = type，字段互斥显示）。 */
function visibleFor(field: Parameters<typeof isBoardWidgetFieldVisible>[0]) {
  return {
    resolve: ({ values }: { values: Record<string, any> }) => ({
      show: isBoardWidgetFieldVisible(field, values.type),
    }),
    triggerFields: ['type'],
  };
}

function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Divider',
      fieldName: 'groupBasic',
      formItemClass: 'col-span-1 md:col-span-1 pb-0',
      hideLabel: true,
      renderComponentContent() {
        return { default: () => $t('page.iot.board.groupBasic') };
      },
    },
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
      component: 'Divider',
      dependencies: {
        resolve: ({ values }) => ({
          show: isMultiPointWidgetType(
            isBoardWidgetType(values.type) ? values.type : 'value',
          ),
        }),
        triggerFields: ['type'],
      },
      fieldName: 'groupPoints',
      formItemClass: 'col-span-1 md:col-span-1 pb-0',
      hideLabel: true,
      renderComponentContent() {
        return { default: () => $t('page.iot.board.groupPoints') };
      },
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
            placeholder: values.deviceId
              ? $t('page.iot.board.propertyPlaceholder')
              : $t('page.iot.board.noDevice'),
          },
          disabled: !values.deviceId,
          show: isBoardWidgetFieldVisible('propertyId', values.type),
        }),
        triggerFields: ['type', 'deviceId'],
      },
      fieldName: 'propertyId',
      label: $t('page.iot.board.property'),
      rules: 'selectRequired',
    },
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: loadPropertyOptions,
        class: 'w-full',
        labelField: 'label',
        mode: 'multiple',
        placeholder: $t('page.iot.board.propertiesPlaceholder'),
        showSearch: true,
        valueField: 'value',
      },
      dependencies: {
        resolve: ({ values }) => ({
          componentProps: {
            params: { deviceId: values.deviceId ?? '' },
            placeholder: values.deviceId
              ? $t('page.iot.board.propertiesPlaceholder')
              : $t('page.iot.board.noDevice'),
          },
          disabled: !values.deviceId,
          show: isBoardWidgetFieldVisible('propertyIds', values.type),
        }),
        triggerFields: ['type', 'deviceId'],
      },
      fieldName: 'propertyIds',
      label: $t('page.iot.board.properties'),
      rules: 'selectRequired',
    },
    {
      component: 'Divider',
      dependencies: {
        resolve: ({ values }) => ({
          show:
            isBoardWidgetFieldVisible('unit', values.type) ||
            isBoardWidgetFieldVisible('decimals', values.type) ||
            isBoardWidgetFieldVisible('gaugeMin', values.type) ||
            isBoardWidgetFieldVisible('gaugeMax', values.type) ||
            isBoardWidgetFieldVisible('windowMinutes', values.type),
        }),
        triggerFields: ['type'],
      },
      fieldName: 'groupDisplay',
      formItemClass: 'col-span-1 md:col-span-1 pb-0',
      hideLabel: true,
      renderComponentContent() {
        return { default: () => $t('page.iot.board.groupDisplay') };
      },
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: 16,
        placeholder: $t('page.iot.board.unitPlaceholder'),
      },
      dependencies: visibleFor('unit'),
      fieldName: 'unit',
      label: $t('page.iot.board.unit'),
    },
    {
      component: 'InputNumber',
      componentProps: {
        max: IOT_BOARD_MAX_DECIMALS,
        min: 0,
        placeholder: $t('page.iot.board.decimalsPlaceholder'),
        precision: 0,
      },
      dependencies: visibleFor('decimals'),
      fieldName: 'decimals',
      label: $t('page.iot.board.decimals'),
    },
    {
      component: 'InputNumber',
      componentProps: {
        class: 'w-full',
        placeholder: $t('page.iot.board.gaugeMinPlaceholder'),
      },
      dependencies: visibleFor('gaugeMin'),
      fieldName: 'min',
      label: $t('page.iot.board.gaugeMin'),
    },
    {
      component: 'InputNumber',
      componentProps: {
        class: 'w-full',
        placeholder: $t('page.iot.board.gaugeMaxPlaceholder'),
      },
      dependencies: visibleFor('gaugeMax'),
      fieldName: 'max',
      label: $t('page.iot.board.gaugeMax'),
    },
    {
      component: 'Select',
      componentProps: {
        options: WINDOW_OPTIONS,
      },
      dependencies: visibleFor('windowMinutes'),
      fieldName: 'windowMinutes',
      label: $t('page.iot.board.windowMinutes'),
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
    const type = isBoardWidgetType(values.type) ? values.type : 'value';
    const deviceId = String(values.deviceId ?? '').trim();
    const title = String(values.title ?? '').trim();
    const unit = String(values.unit ?? '').trim();
    const widget: BoardWidget = {
      deviceId,
      id: modalApi.getData()?.widget?.id ?? '',
      propertyId: '',
      title,
      type,
    };
    if (isMultiPointWidgetType(type)) {
      const propertyIds = sanitizeBoardPropertyIds(values.propertyIds);
      if (propertyIds.length === 0) {
        // 不静默放过：多点位类型至少选 1 个点位，否则后端必填的 propertyId 会是空串
        formApi.setFieldError(
          'propertyIds',
          $t('page.iot.board.propertiesRequired'),
        );
        return;
      }
      // 多点位类型：propertyIds 是主字段；propertyId 取第一个，保持后端必填字段非空
      widget.propertyIds = propertyIds;
      widget.propertyId = propertyIds[0] as string;
    } else {
      widget.propertyId = String(values.propertyId ?? '').trim();
    }
    if (unit !== '') {
      widget.unit = unit;
    }
    if (values.decimals !== undefined && values.decimals !== null) {
      widget.decimals = Number(values.decimals);
    }
    if (visibleForType('gaugeMin', type) && isFiniteNumber(values.min)) {
      widget.min = Number(values.min);
    }
    if (visibleForType('gaugeMax', type) && isFiniteNumber(values.max)) {
      widget.max = Number(values.max);
    }
    if (
      visibleForType('windowMinutes', type) &&
      isFiniteNumber(values.windowMinutes)
    ) {
      widget.windowMinutes = Number(values.windowMinutes);
    }
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
    const existing = data?.widget;
    let propertyIds: string[] | undefined;
    if (existing?.propertyIds && existing.propertyIds.length > 0) {
      propertyIds = existing.propertyIds;
    } else if (existing?.propertyId) {
      propertyIds = [existing.propertyId];
    }
    formApi.setValues({
      decimals: data?.widget?.decimals,
      deviceId: data?.widget?.deviceId ?? undefined,
      max: data?.widget?.max,
      min: data?.widget?.min,
      propertyId: data?.widget?.propertyId ?? undefined,
      propertyIds,
      title: data?.widget?.title ?? '',
      type: data?.widget?.type ?? 'value',
      unit: data?.widget?.unit,
      windowMinutes: data?.widget?.windowMinutes ?? 1440,
    });
  },
});

function isFiniteNumber(value: unknown): boolean {
  return (
    value !== null && value !== undefined && Number.isFinite(Number(value))
  );
}

function visibleForType(
  field: Parameters<typeof isBoardWidgetFieldVisible>[0],
  type: BoardWidgetType,
): boolean {
  return isBoardWidgetFieldVisible(field, type);
}

defineExpose({ modalApi });
</script>

<template>
  <Modal>
    <Form />
  </Modal>
</template>

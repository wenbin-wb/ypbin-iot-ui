<script lang="ts" setup>
import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { IotThingModelApi } from '#/api/iot';

import { ref } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import {
  createCommand,
  createEvent,
  createProperty,
  createService,
  IOT_ACCESS_MODES,
  IOT_DATA_TYPES,
  IOT_SERVICE_OPTIONS,
  updateCommand,
  updateEvent,
  updateProperty,
  updateService,
} from '#/api/iot';
import { $t } from '#/locales';

/**
 * 物模型元素编辑器（F2）：服务 / 属性 / 命令 / 事件四类的增删改**共用一个弹窗**。
 *
 * 为什么一个弹窗装四类：四者的字段集不同但流程完全一致（校验 → create/update → reload），
 * 拆成四个文件只会把同一段流程抄四遍。四张表单**同时挂载**（用 `v-show` 而非 `v-if`）：
 * vben 的 `formApi.setValues()` 会等待表单挂载（`getForm()` 里 `waitForCondition`），
 * 隐藏但已挂载的表单不会把提交卡住，`v-if` 则会让未激活的那几张永远等不到挂载。
 *
 * 层级提醒：属性/命令/事件都挂在**服务**下（`serviceId` 必填），服务才挂在产品下。
 */
interface ThingModelFormData {
  kind: 'command' | 'event' | 'property' | 'service';
  productId: string;
  row?: Record<string, any> | null;
  /** 属性/命令/事件必填：它们所属的服务主键。 */
  serviceId?: string;
}

const emit = defineEmits(['reload']);

const current = ref<null | ThingModelFormData>(null);

/** 服务表单。 */
function serviceSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'serviceId',
      help: $t('page.iot.product.serviceIdHelp'),
      label: $t('page.iot.product.serviceId'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'serviceName',
      label: $t('page.iot.product.serviceName'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: IOT_SERVICE_OPTIONS.map((value) => ({ label: value, value })),
      },
      fieldName: 'serviceOption',
      label: $t('page.iot.product.serviceOption'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'sort',
      label: $t('page.iot.group.sort'),
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 255, rows: 2 },
      fieldName: 'description',
      label: $t('page.iot.product.description'),
    },
  ];
}

/** 属性表单。 */
function propertySchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'identifier',
      help: $t('page.iot.product.identifierCamel'),
      label: $t('page.iot.point.identifier'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'propertyName',
      label: $t('page.iot.product.propertyName'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: IOT_DATA_TYPES.map((value) => ({ label: value, value })),
      },
      fieldName: 'dataType',
      label: $t('page.iot.point.dataType'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: IOT_ACCESS_MODES.map((value) => ({ label: value, value })),
      },
      fieldName: 'accessMode',
      label: $t('page.iot.point.accessMode'),
      rules: 'required',
    },
    {
      component: 'Switch',
      fieldName: 'required',
      label: $t('page.iot.product.required'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'minValue',
      label: $t('page.iot.product.minValue'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'maxValue',
      label: $t('page.iot.product.maxValue'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'step',
      label: $t('page.iot.product.step'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'maxLength',
      label: $t('page.iot.product.maxLength'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 32 },
      fieldName: 'unit',
      label: $t('page.iot.point.unit'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 2000 },
      fieldName: 'enumList',
      help: $t('page.iot.product.enumListHelp'),
      label: $t('page.iot.product.enumList'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'defaultValue',
      label: $t('page.iot.product.defaultValue'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'sort',
      label: $t('page.iot.group.sort'),
    },
  ];
}

/** 命令表单。 */
function commandSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'identifier',
      help: $t('page.iot.product.identifierUpper'),
      label: $t('page.iot.point.identifier'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'commandName',
      label: $t('page.iot.product.commandName'),
      rules: 'required',
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 4000, rows: 3 },
      fieldName: 'inputParams',
      help: $t('page.iot.product.jsonHelp'),
      label: $t('page.iot.product.inputParams'),
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 4000, rows: 3 },
      fieldName: 'outputParams',
      help: $t('page.iot.product.jsonHelp'),
      label: $t('page.iot.product.outputParams'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'timeoutMs',
      label: $t('page.iot.product.timeoutMs'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'sort',
      label: $t('page.iot.group.sort'),
    },
  ];
}

/** 事件表单。 */
function eventSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'identifier',
      help: $t('page.iot.product.identifierCamel'),
      label: $t('page.iot.point.identifier'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'eventName',
      label: $t('page.iot.product.eventName'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: IOT_DATA_TYPES.map((value) => ({ label: value, value })),
      },
      fieldName: 'dataType',
      label: $t('page.iot.point.dataType'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'maxLength',
      label: $t('page.iot.product.maxLength'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 32 },
      fieldName: 'unit',
      label: $t('page.iot.point.unit'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 2000 },
      fieldName: 'enumList',
      help: $t('page.iot.product.enumListHelp'),
      label: $t('page.iot.product.enumList'),
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full' },
      fieldName: 'sort',
      label: $t('page.iot.group.sort'),
    },
  ];
}

const [ServiceForm, serviceFormApi] = useVbenForm({
  schema: serviceSchema(),
  showDefaultActions: false,
});

const [PropertyForm, propertyFormApi] = useVbenForm({
  schema: propertySchema(),
  showDefaultActions: false,
});

const [CommandForm, commandFormApi] = useVbenForm({
  schema: commandSchema(),
  showDefaultActions: false,
});

const [EventForm, eventFormApi] = useVbenForm({
  schema: eventSchema(),
  showDefaultActions: false,
});

function kindLabel(kind: ThingModelFormData['kind']) {
  if (kind === 'service') {
    return $t('page.iot.product.service');
  }
  if (kind === 'property') {
    return $t('page.iot.product.property');
  }
  if (kind === 'command') {
    return $t('page.iot.product.command');
  }
  return $t('page.iot.product.event');
}

async function submitService(data: ThingModelFormData, isUpdate: boolean) {
  const { valid } = await serviceFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await serviceFormApi.getValues<IotThingModelApi.ServiceSaveReq>();
  if (isUpdate) {
    await updateService(data.productId, String(data.row?.id ?? ''), values);
  } else {
    await createService(data.productId, values);
  }
}

async function submitProperty(data: ThingModelFormData, isUpdate: boolean) {
  const { valid } = await propertyFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await propertyFormApi.getValues<IotThingModelApi.PropertySaveReq>();
  const serviceId = data.serviceId ?? '';
  if (isUpdate) {
    await updateProperty(data.productId, serviceId, String(data.row?.id ?? ''), values);
  } else {
    await createProperty(data.productId, serviceId, values);
  }
}

async function submitCommand(data: ThingModelFormData, isUpdate: boolean) {
  const { valid } = await commandFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await commandFormApi.getValues<IotThingModelApi.CommandSaveReq>();
  const serviceId = data.serviceId ?? '';
  if (isUpdate) {
    await updateCommand(data.productId, serviceId, String(data.row?.id ?? ''), values);
  } else {
    await createCommand(data.productId, serviceId, values);
  }
}

async function submitEvent(data: ThingModelFormData, isUpdate: boolean) {
  const { valid } = await eventFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await eventFormApi.getValues<IotThingModelApi.EventSaveReq>();
  const serviceId = data.serviceId ?? '';
  if (isUpdate) {
    await updateEvent(data.productId, serviceId, String(data.row?.id ?? ''), values);
  } else {
    await createEvent(data.productId, serviceId, values);
  }
}

const [Modal, modalApi] = useVbenModal<ThingModelFormData>({
  onCancel() {
    modalApi.close();
  },
  async onConfirm() {
    const data = current.value;
    if (!data) {
      return;
    }
    const isUpdate = !!data.row?.id;
    try {
      modalApi.setState({ confirmLoading: true });
      if (data.kind === 'service') {
        await submitService(data, isUpdate);
      } else if (data.kind === 'property') {
        await submitProperty(data, isUpdate);
      } else if (data.kind === 'command') {
        await submitCommand(data, isUpdate);
      } else {
        await submitEvent(data, isUpdate);
      }
      message.success($t('common.success'));
      modalApi.close();
      emit('reload');
    } catch {
      // 接口失败提示由全局请求拦截器统一给出（这里只兜底避免未处理拒绝），
      // 校验失败已在各 submit 内 `return`，不会走到本分支
    } finally {
      modalApi.setState({ confirmLoading: false });
    }
  },
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = modalApi.getData();
    current.value = data ?? null;
    if (!data) {
      return;
    }
    const isUpdate = !!data.row?.id;
    serviceFormApi.reset();
    propertyFormApi.reset();
    commandFormApi.reset();
    eventFormApi.reset();
    modalApi.setState({
      title: isUpdate
        ? $t('ui.actionTitle.edit', [kindLabel(data.kind)])
        : $t('ui.actionTitle.create', [kindLabel(data.kind)]),
    });
    const row = data.row ?? {};
    if (data.kind === 'service') {
      await serviceFormApi.setValues(row);
    } else if (data.kind === 'property') {
      await propertyFormApi.setValues(row);
    } else if (data.kind === 'command') {
      await commandFormApi.setValues(row);
    } else {
      await eventFormApi.setValues(row);
    }
  },
});
</script>
<template>
  <Modal class="w-[640px]">
    <ServiceForm v-show="current?.kind === 'service'" />
    <PropertyForm v-show="current?.kind === 'property'" />
    <CommandForm v-show="current?.kind === 'command'" />
    <EventForm v-show="current?.kind === 'event'" />
  </Modal>
</template>

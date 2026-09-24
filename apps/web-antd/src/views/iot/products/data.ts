import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotProductApi } from '#/api/iot';

import { $t } from '#/locales';

export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'productCode', title: $t('iot.product.code'), minWidth: 150 },
    { field: 'productName', title: $t('iot.product.name'), minWidth: 160 },
    { field: 'protocol', title: $t('iot.device.protocol'), width: 110 },
    { field: 'dataFormat', title: $t('iot.product.dataFormat'), width: 110 },
    { field: 'deviceType', title: $t('iot.product.deviceType'), width: 120 },
    {
      field: 'modelStatus',
      title: $t('iot.product.modelStatus'),
      width: 110,
      cellRender: { name: 'CellTag' },
    },
    { field: 'currentVersion', title: $t('iot.product.currentVersion'), width: 110 },
    { field: 'createTime', title: $t('iot.device.createTime'), width: 170 },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      width: 240,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'productCode',
      label: $t('iot.product.code'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'productName',
      label: $t('iot.product.name'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: [
          { label: 'Modbus TCP', value: 'modbus' },
          { label: 'TCP 透传', value: 'tcp' },
          { label: 'MQTT', value: 'mqtt' },
          { label: 'OPC UA', value: 'opcua' },
        ],
      },
      fieldName: 'protocol',
      label: $t('iot.device.protocol'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: [
          { label: 'JSON', value: 'JSON' },
          { label: 'BINARY', value: 'BINARY' },
        ],
      },
      defaultValue: 'JSON',
      fieldName: 'dataFormat',
      label: $t('iot.product.dataFormat'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'deviceType',
      label: $t('iot.product.deviceType'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 120 },
      fieldName: 'manufacturerName',
      label: $t('iot.product.manufacturer'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('iot.device.remark'),
    },
  ];
}

export type ProductRow = IotProductApi.ProductResp;

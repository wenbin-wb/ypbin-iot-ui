import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { $t } from '#/locales';

/** 设备台账列表列（可用率入口放在操作列：逐台设备的断档/可用率是 M-2 的核心观感）。 */
export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'deviceCode', title: $t('iot.device.code'), minWidth: 140 },
    { field: 'deviceName', title: $t('iot.device.name'), minWidth: 160 },
    { field: 'protocol', title: $t('iot.device.protocol'), width: 110 },
    { field: 'endpoint', title: $t('iot.device.endpoint'), minWidth: 200 },
    {
      field: 'onlineStatus',
      title: $t('iot.device.onlineStatus'),
      width: 110,
      cellRender: { name: 'CellTag' },
    },
    { field: 'lastSeenAt', title: $t('iot.device.lastSeenAt'), width: 170 },
    { field: 'createTime', title: $t('iot.device.createTime'), width: 170 },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      width: 220,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

/** 新增/编辑设备表单。 */
export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'deviceCode',
      label: $t('iot.device.code'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'deviceName',
      label: $t('iot.device.name'),
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
        placeholder: $t('iot.device.protocolPlaceholder'),
      },
      fieldName: 'protocol',
      label: $t('iot.device.protocol'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: {
        placeholder: $t('iot.device.endpointPlaceholder'),
      },
      fieldName: 'endpoint',
      label: $t('iot.device.endpoint'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('iot.device.remark'),
    },
  ];
}

export type DeviceRow = IotDeviceApi.DeviceResp;

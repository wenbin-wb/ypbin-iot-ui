import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { $t } from '#/locales';

/** 设备台账列表列（可用率入口放在操作列：逐台设备的断档/可用率是 M-2 的核心观感）。 */
export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'deviceCode', title: $t('page.iot.device.code'), minWidth: 140 },
    { field: 'deviceName', title: $t('page.iot.device.name'), minWidth: 160 },
    { field: 'protocol', title: $t('page.iot.device.protocol'), width: 110 },
    { field: 'endpoint', title: $t('page.iot.device.endpoint'), minWidth: 200 },
    {
      field: 'onlineStatus',
      title: $t('page.iot.device.onlineStatus'),
      width: 110,
      cellRender: { name: 'CellTag' },
    },
    { field: 'lastSeenAt', title: $t('page.iot.device.lastSeenAt'), width: 170 },
    { field: 'createTime', title: $t('page.iot.device.createTime'), width: 170 },
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
      label: $t('page.iot.device.code'),
      rules: 'required',
    },
    {
      component: 'Input',
      // 与后端 @Size(max = 100) 对齐：前端放宽会让用户在提交时才吃后端报错
      componentProps: { maxlength: 100 },
      fieldName: 'deviceName',
      label: $t('page.iot.device.name'),
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
        placeholder: $t('page.iot.device.protocolPlaceholder'),
      },
      fieldName: 'protocol',
      label: $t('page.iot.device.protocol'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: {
        placeholder: $t('page.iot.device.endpointPlaceholder'),
      },
      fieldName: 'endpoint',
      help: $t('page.iot.device.endpointHelp'),
      label: $t('page.iot.device.endpoint'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('page.iot.device.remark'),
    },
  ];
}

export type DeviceRow = IotDeviceApi.DeviceResp;

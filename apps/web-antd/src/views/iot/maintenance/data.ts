import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';

import { getDeviceOptions } from '#/api/iot';
import { $t } from '#/locales';

/** 维护窗口列表列。 */
export function useColumns(): VxeTableGridColumns {
  return [
    {
      field: 'deviceId',
      title: $t('iot.maintenance.device'),
      minWidth: 160,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue || $t('iot.maintenance.tenantWide'),
    },
    { field: 'startTs', title: $t('iot.maintenance.start'), width: 170 },
    {
      field: 'endTs',
      title: $t('iot.maintenance.end'),
      width: 170,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue || $t('iot.maintenance.ongoing'),
    },
    {
      field: 'source',
      title: $t('iot.maintenance.source'),
      width: 120,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue === 'LEASE_HANDOVER'
          ? $t('iot.maintenance.sourceHandover')
          : $t('iot.maintenance.sourceManual'),
    },
    { field: 'reason', title: $t('iot.maintenance.reason'), minWidth: 200 },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      width: 140,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

/** 声明维护窗口表单（设备留空=该租户全部设备）。 */
export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getDeviceOptions,
        class: 'w-full',
        labelField: 'deviceName',
        placeholder: $t('iot.maintenance.devicePlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      label: $t('iot.maintenance.device'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'startTs',
      label: $t('iot.maintenance.start'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'endTs',
      label: $t('iot.maintenance.end'),
      help: $t('iot.maintenance.endHelp'),
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 255, rows: 3 },
      fieldName: 'reason',
      label: $t('iot.maintenance.reason'),
      rules: 'required',
    },
  ];
}

import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';

import { getDeviceOptions } from '#/api/iot';
import { $t } from '#/locales';

/** 维护窗口列表列。 */
export function useColumns(): VxeTableGridColumns {
  return [
    {
      field: 'deviceId',
      title: $t('page.iot.maintenance.device'),
      minWidth: 160,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue || $t('page.iot.maintenance.tenantWide'),
    },
    { field: 'startTs', title: $t('page.iot.maintenance.start'), width: 170 },
    {
      field: 'endTs',
      title: $t('page.iot.maintenance.end'),
      width: 170,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue || $t('page.iot.maintenance.ongoing'),
    },
    {
      field: 'source',
      title: $t('page.iot.maintenance.source'),
      width: 120,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue === 'LEASE_HANDOVER'
          ? $t('page.iot.maintenance.sourceHandover')
          : $t('page.iot.maintenance.sourceManual'),
    },
    { field: 'reason', title: $t('page.iot.maintenance.reason'), minWidth: 200 },
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
        placeholder: $t('page.iot.maintenance.devicePlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      label: $t('page.iot.maintenance.device'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'startTs',
      label: $t('page.iot.maintenance.start'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'endTs',
      label: $t('page.iot.maintenance.end'),
      help: $t('page.iot.maintenance.endHelp'),
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 255, rows: 3 },
      fieldName: 'reason',
      label: $t('page.iot.maintenance.reason'),
      rules: 'required',
    },
  ];
}

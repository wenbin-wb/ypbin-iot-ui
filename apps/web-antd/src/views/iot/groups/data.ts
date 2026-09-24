import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';

import { $t } from '#/locales';

export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'groupName', title: $t('iot.group.name'), minWidth: 200 },
    { field: 'sort', title: $t('iot.group.sort'), width: 100 },
    { field: 'remark', title: $t('iot.device.remark'), minWidth: 200 },
    { field: 'createTime', title: $t('iot.device.createTime'), width: 170 },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      width: 160,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'groupName',
      label: $t('iot.group.name'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full', min: 0 },
      defaultValue: 0,
      fieldName: 'sort',
      label: $t('iot.group.sort'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('iot.device.remark'),
    },
  ];
}

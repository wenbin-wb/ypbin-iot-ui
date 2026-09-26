import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';

import { $t } from '#/locales';

export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'groupName', title: $t('page.iot.group.name'), minWidth: 200 },
    { field: 'sort', title: $t('page.iot.group.sort'), width: 100 },
    { field: 'remark', title: $t('page.iot.device.remark'), minWidth: 200 },
    { field: 'createTime', title: $t('page.iot.device.createTime'), width: 170 },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      // 三个动作（成员管理/编辑/删除）比原来的两个按钮更宽，160 会把「成员管理」挤掉
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
      componentProps: { maxlength: 128 },
      fieldName: 'groupName',
      label: $t('page.iot.group.name'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { class: 'w-full', min: 0 },
      defaultValue: 0,
      fieldName: 'sort',
      label: $t('page.iot.group.sort'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('page.iot.device.remark'),
    },
  ];
}

import type { Ref } from 'vue';

import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotGroupApi } from '#/api/iot';

import { getGroupTreeOptions, isRootGroup } from '#/api/iot/group';
import { $t } from '#/locales';

import { displayOrFallback, formatDateTime } from '../shared/display';

/**
 * 列表行 = 后端分组 DTO + 展示层批量解析的 `parentIdName`。
 *
 * 后端 `getGroupList` 只给 `parentId`，名称由 `groups/index.vue` 用**同一次**列表结果做
 * id→groupName 映射补齐（一次请求，不逐行查）；根分组/父分组已不存在时保持空。
 */
export type GroupRow = IotGroupApi.GroupResp & {
  parentIdName?: string;
};

export function useColumns(): VxeTableGridColumns {
  return [
    {
      field: 'groupName',
      title: $t('page.iot.group.name'),
      minWidth: 200,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        displayOrFallback(cellValue),
    },
    {
      field: 'parentIdName',
      title: $t('page.iot.group.parentName'),
      minWidth: 160,
      // 根分组显示「根分组」；parentId 有值但名称解析不到（父分组已删/越权）显示 `-`
      formatter: ({ row }: { row: GroupRow }) =>
        isRootGroup(row.parentId)
          ? $t('page.iot.group.parentRoot')
          : displayOrFallback(row.parentIdName),
    },
    {
      field: 'sort',
      title: $t('page.iot.group.sort'),
      width: 100,
      formatter: ({ cellValue }: { cellValue?: number | string }) =>
        displayOrFallback(cellValue),
    },
    {
      field: 'remark',
      title: $t('page.iot.device.remark'),
      minWidth: 200,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        displayOrFallback(cellValue),
    },
    {
      field: 'createTime',
      title: $t('page.iot.device.createTime'),
      width: 170,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        formatDateTime(cellValue),
    },
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

/**
 * 分组表单 schema。
 *
 * `rowId` 是编辑行的 id（新增时为空串）：父分组 ApiTreeSelect 的 api 在每次下拉打开时
 * 用最新 `rowId` 调 `getGroupTreeOptions(excludeId)`，前端先剔除自己及后代；
 * 后端仍会做最终校验，前端过滤只是避免提交时才报错的无效往返。
 */
export function useFormSchema(rowId?: Ref<string>): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'groupName',
      label: $t('page.iot.group.name'),
      rules: 'required',
    },
    {
      component: 'ApiTreeSelect',
      componentProps: {
        allowClear: true,
        // 每次下拉展开都按当前 rowId 重新取树；可见事件用 TreeSelect 真实事件名，
        // 覆盖 adapter ApiTreeSelect 默认的 onVisibleChange（vc-tree-select 不响应后者）。
        alwaysLoad: true,
        api: () => getGroupTreeOptions(rowId?.value),
        class: 'w-full',
        placeholder: $t('page.iot.group.parentPlaceholder'),
        showSearch: true,
        treeNodeFilterProp: 'label',
        visibleEvent: 'onDropdownVisibleChange',
      },
      fieldName: 'parentId',
      help: $t('page.iot.group.parentHelp'),
      label: $t('page.iot.group.parentName'),
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

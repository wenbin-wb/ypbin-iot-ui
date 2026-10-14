import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotProductApi } from '#/api/iot';

import { $t } from '#/locales';

import {
  dataFormatOptions,
  displayOrFallback,
  formatDateTime,
  modelStatusOptions,
  protocolOptions,
} from '../shared/display';

/**
 * CellTag 按**原始值**严格匹配；后端历史数据大小写不统一（协议/数据格式/物模型状态），
 * 为每个选项补大小写变体，避免大小写不同就退回显示原始码。
 */
function withCaseVariants(options: Array<{ label: string; value: string }>) {
  return options.flatMap((option) => {
    const variants = new Set([
      option.value,
      option.value.toLowerCase(),
      option.value.toUpperCase(),
    ]);
    return [...variants].map((value) => ({ label: option.label, value }));
  });
}

export function useColumns(): VxeTableGridColumns {
  return [
    { field: 'productCode', title: $t('page.iot.product.code'), minWidth: 150 },
    { field: 'productName', title: $t('page.iot.product.name'), minWidth: 160 },
    {
      field: 'protocol',
      title: $t('page.iot.device.protocol'),
      width: 110,
      cellRender: {
        name: 'CellTag',
        options: withCaseVariants(protocolOptions()),
      },
    },
    {
      field: 'dataFormat',
      title: $t('page.iot.product.dataFormat'),
      width: 110,
      cellRender: {
        name: 'CellTag',
        options: withCaseVariants(dataFormatOptions()),
      },
    },
    {
      field: 'deviceType',
      title: $t('page.iot.product.deviceType'),
      width: 120,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        displayOrFallback(cellValue),
    },
    {
      field: 'modelStatus',
      title: $t('page.iot.product.modelStatus'),
      width: 110,
      cellRender: {
        name: 'CellTag',
        options: withCaseVariants(modelStatusOptions()),
      },
    },
    {
      field: 'currentVersion',
      title: $t('page.iot.product.currentVersion'),
      width: 110,
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
      // 高频「详情/编辑」保持按钮，低频「发布/删除」收进更多菜单，宽度 220 不再截断
      width: 220,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

export function useGridFormSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: {
        allowClear: true,
        placeholder: $t('page.iot.product.searchKeywordPlaceholder'),
      },
      fieldName: 'keyword',
      label: $t('page.iot.product.searchKeyword'),
    },
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        options: protocolOptions(),
        placeholder: $t('page.iot.product.protocolPlaceholder'),
      },
      fieldName: 'protocol',
      label: $t('page.iot.device.protocol'),
    },
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        options: modelStatusOptions(),
        placeholder: $t('page.iot.product.modelStatusFilterPlaceholder'),
      },
      fieldName: 'modelStatus',
      label: $t('page.iot.product.modelStatus'),
    },
  ];
}

export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: {
        maxlength: 64,
        placeholder: $t('page.iot.product.codePlaceholder'),
      },
      fieldName: 'productCode',
      help: $t('page.iot.product.codeHelp'),
      label: $t('page.iot.product.code'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: { maxlength: 128 },
      fieldName: 'productName',
      label: $t('page.iot.product.name'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        options: protocolOptions(),
        placeholder: $t('page.iot.product.protocolPlaceholder'),
      },
      defaultValue: 'modbus',
      fieldName: 'protocol',
      label: $t('page.iot.device.protocol'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: { options: dataFormatOptions() },
      defaultValue: 'JSON',
      fieldName: 'dataFormat',
      label: $t('page.iot.product.dataFormat'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 64 },
      fieldName: 'deviceType',
      label: $t('page.iot.product.deviceType'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 120 },
      fieldName: 'manufacturerName',
      label: $t('page.iot.product.manufacturer'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('page.iot.device.remark'),
    },
  ];
}

export type ProductRow = IotProductApi.ProductResp;

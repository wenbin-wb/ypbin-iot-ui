import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { getPublishedProductOptions } from '#/api/iot';
// 值导入走全路径（skill 约定）；`#/api/iot` 聚合器只用于类型导入
import { getProductOptions } from '#/api/iot/product';
import { $t } from '#/locales';

import {
  displayOrFallback,
  formatDateTime,
  onlineStatusColor,
  onlineStatusOptions,
  protocolLabel,
  protocolOptions,
} from '../shared/display';

/** 设备台账列表列（可用率/历史曲线入口放在操作列：逐台设备的数据面查询是「可用率与断档」能力的核心观感）。 */
export function useColumns(): VxeTableGridColumns {
  return [
    // 勾选列必须**显式声明**：vxe 不会因为 `checkboxConfig` 自动生成勾选列
    // （告警页 2026-10-03 用真实挂载 A/B 探针证实：只有 checkboxConfig 时勾选单元格数 = 0）。
    // 批量启用/停用/删除都依赖它。
    { type: 'checkbox', width: 46 },
    { field: 'deviceCode', title: $t('page.iot.device.code'), minWidth: 140 },
    { field: 'deviceName', title: $t('page.iot.device.name'), minWidth: 160 },
    {
      field: 'productIdName',
      title: $t('page.iot.device.product'),
      minWidth: 160,
      // 后端已用 @RefText("product") 翻译产品名；并行开发期可能缺失 ⇒ 依次回落
      // productIdName → productId → `-`，不把「没注解名」误读成「未绑定产品」。
      formatter: ({ row }: { row: IotDeviceApi.DeviceResp }) =>
        displayOrFallback(row.productIdName ?? row.productId),
    },
    {
      field: 'protocol',
      title: $t('page.iot.device.protocol'),
      width: 110,
      // 接口传的是码（modbus/tcp/mqtt/opcua），列里必须显示统一中文名；
      // 未知码由 display.ts 原样露出「未知（原码）」，不猜成已知协议。
      formatter: ({ cellValue }: { cellValue?: string }) =>
        protocolLabel(cellValue),
    },
    { field: 'endpoint', title: $t('page.iot.device.endpoint'), minWidth: 200 },
    {
      // 所在空间：数据由后端在列表查询时**一次批量反查**填充（不是设备表字段）。
      // 展示「主空间路径 + N」——设备可同时属于多个空间点。
      field: 'spaceText',
      title: $t('page.iot.device.space'),
      minWidth: 180,
      slots: { default: 'spaceText' },
    },
    {
      field: 'onlineStatus',
      title: $t('page.iot.device.onlineStatus'),
      width: 110,
      // 在线状态用 CellTag 着色展示：禁止把 online/offline 裸码直接渲染到列里；
      // label/color 统一取自 shared/display，避免本页再抄一份映射（口径漂移）。
      cellRender: {
        name: 'CellTag',
        options: onlineStatusOptions().map((item) => ({
          color: onlineStatusColor(item.value),
          label: item.label,
          value: item.value,
        })),
      },
    },
    {
      // 启停开关：此前设备没有停用写入口，用户要停采只能**删设备**或**删映射**，
      // 两者都会丢台账信息（且删设备是逻辑删除，编码按唯一键不可复用）。
      // 这是「运维意图」，与在线状态（观测值）分列展示，避免被读成同一件事。
      field: 'status',
      title: $t('page.iot.device.status'),
      width: 110,
      slots: { default: 'status' },
    },
    {
      field: 'lastSeenAt',
      title: $t('page.iot.device.lastSeenAt'),
      width: 170,
      // 后端时间形态不统一（epoch / ISO / `yyyy-MM-dd HH:mm:ss`），统一走展示层格式化；
      // 空值/非法值显示 `-`，不把 `Invalid Date` 或原始串直接贴给用户。
      formatter: ({ cellValue }: { cellValue?: string }) =>
        formatDateTime(cellValue),
    },
    {
      // 活动告警标记（设备台账列表加一列/一个标记）：
      // 计数由**一次批量查询**给出（`/iot/alerts/active-counts`），不按行发请求
      field: 'alertActive',
      title: $t('page.iot.alert.activeCount'),
      width: 110,
      slots: { default: 'alertActive' },
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
      // 详情/编辑留在行内；告警/可用率/历史曲线/删除收进「更多」下拉。
      // 6 个 icon+文字按钮横排即使给到 460 宽也会被省略号截断，收窄到 220 后一屏可读。
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
      component: 'ApiSelect',
      // 此前 `productId` 只出现在 `api/iot/device.ts` 的类型声明里（0 处视图使用），
      // 于是「产品 → 设备」这条线在界面上完全断掉（设备台账看不出归属哪个产品）。
      // 只列**已发布**产品：设备要绑定物模型版本，草稿态结构随时会变，绑上去无从校验。
      componentProps: {
        allowClear: true,
        api: getPublishedProductOptions,
        class: 'w-full',
        labelField: 'productName',
        placeholder: $t('page.iot.device.productPlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'productId',
      help: $t('page.iot.device.productHelp'),
      label: $t('page.iot.device.product'),
    },
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
        // 与搜索表单共用 display.ts 的同一份协议选项，避免表单/筛选两处口径不一致
        options: protocolOptions(),
        placeholder: $t('page.iot.device.protocolPlaceholder'),
      },
      defaultValue: 'modbus',
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
      // 所在空间：设备可对应多个空间点（如「机房」与「机房所在 3F」），故多选。
      // 绑定走独立接口（/iot/device/{id}/spaces/sync），不塞进 DeviceSaveReq——
      // 否则「改个备注」也会要求空间绑定权限。
      // 用**全量树**而不是懒加载树：`ApiComponent` 的 `api` 只接收 schema 里静态的
      // `props.params`（见 packages/effects/common-ui/.../api-component.vue 的 mergedParams），
      // **没有把 parentId 回传给 api 的路径** ⇒ 懒加载在表单里恒只拿到根层，
      // 用户永远选不到楼栋/房间。与 `_shared/space-select.vue` 同一口径（那边也是全量）。
      component: 'ApiTreeSelect',
      componentProps: {
        allowClear: true,
        api: async () => {
          const { getSpaceTree } = await import('#/api/system/space');
          return (await getSpaceTree()) ?? [];
        },
        childrenField: 'children',
        class: 'w-full',
        labelField: 'name',
        multiple: true,
        placeholder: $t('page.iot.device.spaceFilterPlaceholder'),
        showSearch: true,
        treeNodeFilterProp: 'name',
        valueField: 'id',
      },
      fieldName: 'spaceIds',
      label: $t('page.iot.device.space'),
    },
    {
      component: 'Input',
      componentProps: { maxlength: 255 },
      fieldName: 'remark',
      label: $t('page.iot.device.remark'),
    },
  ];
}

/**
 * 设备台账搜索表单。
 *
 * 字段名与后端 `IotDeviceQuery` 完全一致（`keyword` / `productId` / `protocol`），
 * 查询时原样透传，不在页面里做改名映射（铁律 7）。
 * 协议选项复用 shared/display；产品下拉复用 `getProductOptions`（labelField/valueField
 * 与后端 `id`/`productName` 同名），避免页面里硬编码中文。
 *
 * @param initialProductId 从 `?productId=` 带来的预填值（产品详情进入时只筛该产品）。
 */
export function useGridFormSchema(initialProductId?: string): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: {
        allowClear: true,
        placeholder: $t('page.iot.device.searchKeywordPlaceholder'),
      },
      fieldName: 'keyword',
      label: $t('page.iot.device.searchKeyword'),
    },
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getProductOptions,
        class: 'w-full',
        labelField: 'productName',
        placeholder: $t('page.iot.device.productFilterPlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      defaultValue: initialProductId,
      fieldName: 'productId',
      label: $t('page.iot.device.product'),
    },
    {
      // 空间筛选（含全部后代）：设备挂在末级房间，选「A栋」要能看到其下所有设备。
      // 同样用全量树（`ApiComponent` 不支持向 api 回传 parentId，懒加载只会拿到根层）。
      component: 'ApiTreeSelect',
      componentProps: {
        allowClear: true,
        api: async () => {
          const { getSpaceTree } = await import('#/api/system/space');
          return (await getSpaceTree()) ?? [];
        },
        childrenField: 'children',
        class: 'w-full',
        labelField: 'name',
        placeholder: $t('page.iot.device.spaceFilterPlaceholder'),
        showSearch: true,
        treeNodeFilterProp: 'name',
        valueField: 'id',
      },
      fieldName: 'spaceId',
      label: $t('page.iot.device.space'),
    },
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        options: protocolOptions(),
        placeholder: $t('page.iot.device.protocolFilterPlaceholder'),
      },
      fieldName: 'protocol',
      label: $t('page.iot.device.protocol'),
    },
  ];
}

export type DeviceRow = IotDeviceApi.DeviceResp;

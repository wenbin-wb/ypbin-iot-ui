import type { VbenFormSchema as FormSchema } from '#/adapter/form';

import { IotTwinApi } from '#/api/iot';
import { $t } from '#/locales';
import { isDisplayTypeSupported } from '#/three/twin/display';

/**
 * 数字孪生页的表单 schema 与选项常量（页面只做编排）。
 *
 * ## 长度/数值上限一律引用 `TWIN_LIMITS`，不写字面量
 *
 * `api/iot/twin.ts` 的 `TWIN_LIMITS` 是后端 `TwinLimits` 的前端镜像。若这里的
 * `maxlength` 写字面量（如 `255`），改了一个另一个不会跟 ⇒ 就是 `TwinLimits`
 * 注释里说的「散落必然漂移」在前端侧重演（工单 #128）。
 */

/**
 * 锚点缩放的最小值。
 *
 * `TWIN_LIMITS` 里没有这一项：它不是**后端**限制，而是前端表单的可用性约束
 * （缩放到 0 会让模型消失，用户会以为加载失败）。故在前端定义为具名常量，
 * 而不是在 schema 里写 `0.000001` 这种魔法值。
 */
const MIN_ANCHOR_SCALE = 0.000001;

/** 场景类型选项。 */
export function sceneTypeOptions(): Array<{ label: string; value: string }> {
  return [
    { label: $t('page.iot.twin.sceneType.park'), value: 'park' },
    { label: $t('page.iot.twin.sceneType.building'), value: 'building' },
    { label: $t('page.iot.twin.sceneType.floor'), value: 'floor' },
    { label: $t('page.iot.twin.sceneType.room'), value: 'room' },
  ];
}

/**
 * 展示形态选项。
 *
 * 选项**不隐藏**未实现的形态（`gauge` / `sparkline`）：已存库的历史配置需要能被回显，
 * 隐藏会让用户编辑时发现「我配的形态不见了」。改为在标签上标注「暂不支持」，
 * 由 `isDisplayTypeSupported` 判定（工单 #126：宁可诚实标注，不做「能选但不生效」）。
 */
export function displayTypeOptions(): Array<{
  label: string;
  value: string;
}> {
  const entries: Array<{ code: string; key: string }> = [
    { code: 'value', key: 'value' },
    { code: 'gauge', key: 'gauge' },
    { code: 'switch', key: 'switch' },
    { code: 'color', key: 'color' },
    { code: 'sparkline', key: 'sparkline' },
  ];
  return entries.map(({ code, key }) => {
    const base = $t(`page.iot.twin.displayType.${key}`);
    return {
      label: isDisplayTypeSupported(code)
        ? base
        : `${base}（${$t('page.iot.twin.displayTypeUnsupported')}）`,
      value: code,
    };
  });
}

/** 展示角色选项。 */
export function displayRoleOptions(): Array<{ label: string; value: string }> {
  return [
    { label: $t('page.iot.twin.displayRole.primary'), value: 'primary' },
    { label: $t('page.iot.twin.displayRole.secondary'), value: 'secondary' },
  ];
}

/** 点位表单的标量字段 schema（设备/坐标/法线/节点名/图标/标签/备注）。 */
export function usePointFormSchema(): FormSchema[] {
  return [
    {
      // 设备选择器是独立组件（要远程搜索 + 回显反查），不适合塞进 schema 的通用控件；
      // 它渲染在表单**上方**，这里只保留一个隐藏字段承载「必填」校验。
      component: 'Input',
      componentProps: { class: 'hidden' },
      fieldName: 'deviceId',
      formItemClass: 'hidden',
      label: $t('page.iot.twin.device'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'localX',
      label: 'X',
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'localY',
      label: 'Y',
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'localZ',
      label: 'Z',
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'normalX',
      label: 'Nx',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'normalY',
      label: 'Ny',
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.01 },
      fieldName: 'normalZ',
      label: 'Nz',
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxNodeNameLength,
      },
      fieldName: 'nodeName',
      label: $t('page.iot.twin.nodeName'),
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxIconLength,
      },
      fieldName: 'icon',
      label: $t('page.iot.twin.icon'),
    },
    {
      component: 'Switch',
      defaultValue: true,
      fieldName: 'labelVisible',
      label: $t('page.iot.twin.labelVisible'),
    },
    {
      component: 'Textarea',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxPointRemarkLength,
        rows: 2,
      },
      fieldName: 'remark',
      label: $t('page.iot.twin.remark'),
    },
  ];
}

/**
 * 场景表单 schema。
 *
 * @param parentOptions 父场景候选（由调用方按「排除自身与后代」算出）
 * @returns 表单 schema
 */
export function useSceneFormSchema(
  parentOptions: Array<{ label: string; value: string }>,
): FormSchema[] {
  return [
    {
      component: 'Input',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxSceneCodeLength,
        placeholder: $t('page.iot.twin.sceneCodePlaceholder'),
      },
      fieldName: 'sceneCode',
      label: $t('page.iot.twin.sceneCode'),
      rules: 'required',
    },
    {
      component: 'Input',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxSceneNameLength,
      },
      fieldName: 'sceneName',
      label: $t('page.iot.twin.sceneName'),
      rules: 'required',
    },
    {
      component: 'Select',
      componentProps: {
        allowClear: true,
        optionFilterProp: 'label',
        options: parentOptions,
        placeholder: $t('page.iot.twin.parentPlaceholder'),
        showSearch: true,
      },
      fieldName: 'parentId',
      label: $t('page.iot.twin.parentScene'),
    },
    {
      component: 'Select',
      componentProps: {
        options: sceneTypeOptions(),
      },
      defaultValue: 'building',
      fieldName: 'sceneType',
      label: $t('page.iot.twin.sceneTypeLabel'),
      rules: 'required',
    },
    {
      component: 'InputNumber',
      componentProps: { min: 0, step: 0.1 },
      fieldName: 'anchorX',
      label: $t('page.iot.twin.anchorX'),
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.1 },
      fieldName: 'anchorY',
      label: $t('page.iot.twin.anchorY'),
    },
    {
      component: 'InputNumber',
      componentProps: { step: 0.1 },
      fieldName: 'anchorZ',
      label: $t('page.iot.twin.anchorZ'),
    },
    {
      component: 'InputNumber',
      componentProps: { step: 1 },
      fieldName: 'anchorRy',
      help: $t('page.iot.twin.anchorRotationHelp'),
      label: $t('page.iot.twin.anchorRy'),
    },
    {
      component: 'InputNumber',
      componentProps: { min: MIN_ANCHOR_SCALE, step: 0.1 },
      defaultValue: 1,
      fieldName: 'anchorScale',
      help: $t('page.iot.twin.anchorScaleHelp'),
      label: $t('page.iot.twin.anchorScale'),
    },
    {
      component: 'InputNumber',
      componentProps: { min: 0 },
      defaultValue: 0,
      fieldName: 'sort',
      label: $t('page.iot.twin.sort'),
    },
    {
      component: 'Textarea',
      componentProps: {
        maxlength: IotTwinApi.TWIN_LIMITS.maxSceneRemarkLength,
        rows: 3,
      },
      fieldName: 'remark',
      label: $t('page.iot.device.remark'),
    },
  ];
}

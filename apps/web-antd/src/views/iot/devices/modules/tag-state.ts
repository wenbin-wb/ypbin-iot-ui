import type { ListState } from '../../shared/list-state';

import type { IotDeviceTagApi } from '#/api/iot';

import { $t } from '#/locales';

import { resolveListState } from '../../shared/list-state';

/**
 * 设备标签页的**纯逻辑**（表单校验 + 状态判定），零 vue/antdv 依赖，可直接单测。
 *
 * 为什么抽出：标签表单只有两个字段，但边界（空值、长度、重复键）和状态判定
 * （加载失败 vs 真的没标签）是"做错了看不出"的部分 —— 抽成纯函数后可在 jsdom 外穷举。
 */

/** 标签键最大长度（后端 @Size(64)）。 */
export const TAG_KEY_MAX = 64;

/** 标签值最大长度（后端 @Size(255)）。 */
export const TAG_VALUE_MAX = 255;

/** 校验失败结论：只带 i18n key 与参数，文案由 {@link resolveTagFormCheckMessage} 在渲染时解析。 */
export interface TagFormCheckFailed {
  ok: false;
  /** i18n 键（`page.iot.tag.validation.*`）。 */
  messageKey: string;
  /** 插值参数（按 key 定义顺序传入）。 */
  params?: Array<number | string>;
}

/** 表单校验结论。 */
export type TagFormCheck = TagFormCheckFailed | { ok: true };

/**
 * 把校验结论解析成面向用户的文案（成功返回空串）。
 *
 * 页面必须经此渲染错误，不得直接展示 `messageKey`（那会把 i18n 键暴露给用户）。
 *
 * @param check 校验结论
 * @returns 本地化错误文案；通过时为空串
 */
export function resolveTagFormCheckMessage(check: TagFormCheck): string {
  return check.ok ? '' : $t(check.messageKey, check.params ?? []);
}

/**
 * 表单是否可通过（非空 + 长度边界，与后端 @NotBlank/@Size 同口径）。
 *
 * @param tagKey   标签键
 * @param tagValue 标签值
 * @returns 校验结论
 */
export function checkTagForm(tagKey: string, tagValue: string): TagFormCheck {
  const key = (tagKey ?? '').trim();
  const value = (tagValue ?? '').trim();
  if (key === '') {
    return {
      messageKey: 'page.iot.tag.validation.keyRequired',
      ok: false,
    };
  }
  if (value === '') {
    return {
      messageKey: 'page.iot.tag.validation.valueRequired',
      ok: false,
    };
  }
  if (key.length > TAG_KEY_MAX) {
    return {
      messageKey: 'page.iot.tag.validation.keyTooLong',
      ok: false,
      params: [TAG_KEY_MAX],
    };
  }
  if (value.length > TAG_VALUE_MAX) {
    return {
      messageKey: 'page.iot.tag.validation.valueTooLong',
      ok: false,
      params: [TAG_VALUE_MAX],
    };
  }
  return { ok: true };
}

/**
 * 归一化表单值（trim；保存前用）。
 *
 * @param tagKey   标签键
 * @param tagValue 标签值
 * @returns 归一化后的值
 */
export function normalizeTagForm(
  tagKey: string,
  tagValue: string,
): IotDeviceTagApi.TagSaveReq {
  return { tagKey: (tagKey ?? '').trim(), tagValue: (tagValue ?? '').trim() };
}

/**
 * 标签列表的展示态（加载中/失败/空/就绪，失败优先于空）。
 *
 * 判据已收口到 `../../shared/list-state`（`resolveListState`）：本函数只保留原导出名与
 * 位置参数签名，行为零漂移；「失败优先于空」的顺序由 `shared/list-state.test.ts` 守门。
 */
export type TagListState = ListState;

export function resolveTagListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): TagListState {
  return resolveListState({ errorMessage, itemCount, loading });
}

/**
 * 合并键值对为唯一键（用于 React/表格 key；后端允许同 key 多 value 吗？——不含，仅作展示 key）。
 *
 * @param index 序号
 * @param tag   标签
 * @returns 稳定展示 key
 */
export function tagDisplayKey(
  index: number,
  tag?: { id?: number | string },
): string {
  const id = String(tag?.id ?? '');
  return id || `row-${index}`;
}

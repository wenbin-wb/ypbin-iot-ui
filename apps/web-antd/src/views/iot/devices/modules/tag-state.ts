import type { IotDeviceTagApi } from '#/api/iot';

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

/** 表单校验结论。 */
export interface TagFormCheck {
  ok: boolean;
  /** 面向用户的原因（ok=false 时非空）。 */
  message: string;
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
    return { ok: false, message: '标签键不能为空' };
  }
  if (value === '') {
    return { ok: false, message: '标签值不能为空' };
  }
  if (key.length > TAG_KEY_MAX) {
    return { ok: false, message: `标签键超过 ${TAG_KEY_MAX} 字符限制` };
  }
  if (value.length > TAG_VALUE_MAX) {
    return { ok: false, message: `标签值超过 ${TAG_VALUE_MAX} 字符限制` };
  }
  return { ok: true, message: '' };
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
 * @param loading      是否加载中
 * @param errorMessage 加载失败原因（非空即失败）
 * @param itemCount    条目数
 * @returns 状态
 */
export type TagListState = 'empty' | 'error' | 'loading' | 'ready';

export function resolveTagListState(
  loading: boolean,
  errorMessage: string,
  itemCount: number,
): TagListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  return itemCount > 0 ? 'ready' : 'empty';
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

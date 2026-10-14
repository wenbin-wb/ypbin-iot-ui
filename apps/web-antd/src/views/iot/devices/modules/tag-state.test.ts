import { createApp } from 'vue';

import { i18n } from '@vben/locales';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  checkTagForm,
  normalizeTagForm,
  resolveTagFormCheckMessage,
  resolveTagListState,
  TAG_KEY_MAX,
  TAG_VALUE_MAX,
  tagDisplayKey,
} from './tag-state';

/** 真实 i18n：只初始化一次（`$t` 就是 `i18n.global.t`）。 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  // en-US 语言包与生产同源合并；缺键/编译不过会让下面的英文断言直接红
  const mod = (await import('#/locales/langs/en-US/page.json')) as {
    default?: Record<string, unknown>;
  };
  const pageDict = (mod.default ?? mod) as { iot: Record<string, unknown> };
  i18n.global.mergeLocaleMessage('en-US', { page: pageDict });
});

/**
 * 设备标签纯逻辑用例。
 *
 * 重点锁死：边界与后端 @NotBlank/@Size 同口径（前端过松会让"保存被后端拒"的错
 * 延迟到提交后才发现；过紧则能填的填不了）；失败态优先于空态（不把加载失败画成"没标签"）。
 */

describe('checkTagForm（与后端 @NotBlank/@Size 同口径）', () => {
  it('合法输入通过', () => {
    expect(checkTagForm('site', '华东')).toMatchObject({ ok: true });
  });

  it('空值拒绝（前后空白按空处理）', () => {
    expect(checkTagForm('', 'x')).toMatchObject({ ok: false });
    expect(checkTagForm('  ', 'x')).toMatchObject({ ok: false });
    expect(checkTagForm('k', '')).toMatchObject({ ok: false });
    expect(checkTagForm('k', '  ')).toMatchObject({ ok: false });
  });

  it('长度边界与后端一致（<=64 / <=255）', () => {
    expect(checkTagForm('k'.repeat(TAG_KEY_MAX), 'v')).toMatchObject({
      ok: true,
    });
    expect(checkTagForm('k'.repeat(TAG_KEY_MAX + 1), 'v')).toMatchObject({
      ok: false,
    });
    expect(checkTagForm('k', 'v'.repeat(TAG_VALUE_MAX))).toMatchObject({
      ok: true,
    });
    expect(checkTagForm('k', 'v'.repeat(TAG_VALUE_MAX + 1))).toMatchObject({
      ok: false,
    });
  });

  it('失败结论带结构化 key/参数（页面不得自己拼文案）', () => {
    expect(checkTagForm('', 'v')).toMatchObject({
      messageKey: 'page.iot.tag.validation.keyRequired',
      ok: false,
    });
    expect(checkTagForm('k', '')).toMatchObject({
      messageKey: 'page.iot.tag.validation.valueRequired',
      ok: false,
    });
    expect(checkTagForm('k'.repeat(100), 'v')).toMatchObject({
      messageKey: 'page.iot.tag.validation.keyTooLong',
      ok: false,
      params: [TAG_KEY_MAX],
    });
    expect(checkTagForm('k', 'v'.repeat(300))).toMatchObject({
      messageKey: 'page.iot.tag.validation.valueTooLong',
      ok: false,
      params: [TAG_VALUE_MAX],
    });
  });
});

describe('resolveTagFormCheckMessage（真实 vue-i18n，不 mock #/locales）', () => {
  it('zh-CN：失败文案可读、带字段名与上限，通过时为空串', () => {
    expect(resolveTagFormCheckMessage(checkTagForm('', 'v'))).toBe(
      '标签键不能为空',
    );
    expect(resolveTagFormCheckMessage(checkTagForm('k', ''))).toBe(
      '标签值不能为空',
    );
    expect(resolveTagFormCheckMessage(checkTagForm('k'.repeat(100), 'v'))).toBe(
      '标签键超过 64 字符限制',
    );
    expect(resolveTagFormCheckMessage(checkTagForm('k', 'v'.repeat(300)))).toBe(
      '标签值超过 255 字符限制',
    );
    expect(resolveTagFormCheckMessage(checkTagForm('k', 'v'))).toBe('');
  });

  it('en-US：同 key 同参数给出英文文案（不回落中文）', () => {
    const previous = i18n.global.locale.value;
    try {
      i18n.global.locale.value = 'en-US' as never;
      expect(resolveTagFormCheckMessage(checkTagForm('', 'v'))).toBe(
        'Tag key is required',
      );
      expect(resolveTagFormCheckMessage(checkTagForm('k', ''))).toBe(
        'Tag value is required',
      );
      expect(
        resolveTagFormCheckMessage(checkTagForm('k'.repeat(100), 'v')),
      ).toBe('Tag key exceeds the 64-character limit');
      expect(
        resolveTagFormCheckMessage(checkTagForm('k', 'v'.repeat(300))),
      ).toBe('Tag value exceeds the 255-character limit');
    } finally {
      i18n.global.locale.value = previous as never;
    }
  });
});

describe('normalizeTagForm', () => {
  it('trim 后再给后端（避免"看似合法实则带空白"）', () => {
    expect(normalizeTagForm('  site ', '  华东 ')).toStrictEqual({
      tagKey: 'site',
      tagValue: '华东',
    });
  });
});

describe('resolveTagListState（失败优先于空）', () => {
  it('加载中优先', () => {
    expect(resolveTagListState(true, '', 0)).toBe('loading');
  });

  it('🔴 失败必须显示 error，不能画成空态', () => {
    expect(resolveTagListState(false, '网络错误', 0)).toBe('error');
  });

  it('确实没有标签才空态', () => {
    expect(resolveTagListState(false, '', 0)).toBe('empty');
  });

  it('有数据为 ready', () => {
    expect(resolveTagListState(false, '', 2)).toBe('ready');
  });
});

describe('tagDisplayKey', () => {
  it('优先用 id；无 id 用序号（不改写显示）', () => {
    expect(tagDisplayKey(0, { id: '9' })).toBe('9');
    expect(tagDisplayKey(0, { id: 9 })).toBe('9');
    expect(tagDisplayKey(2, {})).toBe('row-2');
  });
});

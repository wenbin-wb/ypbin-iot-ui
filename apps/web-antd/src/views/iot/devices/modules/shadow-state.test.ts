import { createApp } from 'vue';

import { i18n } from '@vben/locales';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  desiredToEditableText,
  parseDesiredJson,
  recordToRows,
  resolveDesiredParseMessage,
} from './shadow-state';

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
 * 设备影子期望值纯逻辑用例。
 *
 * 重点：JSON 文本 ↔ 对象 边界（非法 JSON / 非对象 / 空 / 深层值）；
 * 展示行避免 [object Object]。
 */

describe('parseDesiredJson', () => {
  it('合法对象通过', () => {
    expect(parseDesiredJson('{"target": 25.5, "enabled": true}')).toStrictEqual(
      { ok: true, value: { enabled: true, target: 25.5 } },
    );
  });

  it('🔴 空文本 = 清空（给 {}，不是报错）', () => {
    expect(parseDesiredJson('')).toStrictEqual({ ok: true, value: {} });
  });

  it('非法 JSON 拒绝（结构化 key，不把中文抄进纯逻辑）', () => {
    expect(parseDesiredJson('{ target: 25 }')).toMatchObject({
      messageKey: 'page.iot.shadow.validation.jsonInvalid',
      ok: false,
    });
  });

  it('🔴 数组 / 标量 / null 拒绝（后端要求 Map）', () => {
    for (const text of ['[1,2]', '25', '"x"', 'null']) {
      expect(parseDesiredJson(text)).toMatchObject({
        messageKey: 'page.iot.shadow.validation.objectRequired',
        ok: false,
      });
    }
  });

  it('深层嵌套对象可解析', () => {
    expect(parseDesiredJson('{"a":{"b":[1,2],"c":"x"}}')).toStrictEqual({
      ok: true,
      value: { a: { b: [1, 2], c: 'x' } },
    });
  });
});

describe('resolveDesiredParseMessage（真实 vue-i18n，不 mock #/locales）', () => {
  it('zh-CN：非法 JSON / 非对象文案可读，通过时为空串', () => {
    expect(resolveDesiredParseMessage(parseDesiredJson('{ x: 1 }'))).toBe(
      '不是合法的 JSON',
    );
    expect(resolveDesiredParseMessage(parseDesiredJson('[1,2]'))).toBe(
      '期望值必须是 JSON 对象（键值对），不能是数组/数字/null',
    );
    expect(resolveDesiredParseMessage(parseDesiredJson('{"x":1}'))).toBe('');
  });

  it('en-US：同 key 给出英文文案（不回落中文）', () => {
    const previous = i18n.global.locale.value;
    try {
      i18n.global.locale.value = 'en-US' as never;
      expect(resolveDesiredParseMessage(parseDesiredJson('{ x: 1 }'))).toBe(
        'Not valid JSON',
      );
      expect(resolveDesiredParseMessage(parseDesiredJson('[1,2]'))).toBe(
        'Desired value must be a JSON object (key-value pairs), not an array, number, or null',
      );
    } finally {
      i18n.global.locale.value = previous as never;
    }
  });
});

describe('desiredToEditableText', () => {
  it('空/缺省给 {}', () => {
    expect(desiredToEditableText()).toBe('{}');
    expect(desiredToEditableText({})).toBe('{}');
    expect(desiredToEditableText(null)).toBe('{}');
  });

  it('格式化缩进便于编辑', () => {
    expect(desiredToEditableText({ target: 25 })).toBe('{\n  "target": 25\n}');
  });
});

describe('recordToRows', () => {
  it('标量字面化、键名升序', () => {
    expect(recordToRows({ b: 2, a: 'x' })).toEqual([
      { key: 'a', value: 'x' },
      { key: 'b', value: '2' },
    ]);
  });

  it('🔴 对象/数组成员 JSON 化而不是 [object Object]', () => {
    expect(recordToRows({ nested: { a: 1 }, arr: [1, 2] })).toEqual([
      { key: 'arr', value: '[1,2]' },
      { key: 'nested', value: '{"a":1}' },
    ]);
  });

  it('null/undefined 值显示占位', () => {
    expect(recordToRows({ n: null })).toEqual([{ key: 'n', value: 'null' }]);
  });

  it('空/缺省给空数组', () => {
    expect(recordToRows()).toEqual([]);
    expect(recordToRows({})).toEqual([]);
  });
});

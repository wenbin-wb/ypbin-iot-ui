import { createApp } from 'vue';

import { i18n } from '@vben/locales';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildDesiredFromReported,
  desiredToEditableText,
  parseDesiredJson,
  recordToRows,
  resolveDesiredParseMessage,
  shadowDiffRows,
  shadowValueEquals,
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

describe('shadowDiffRows（四态 + 排序，纯函数）', () => {
  it('四态齐全：一致 / 值不一致 / 仅期望 / 仅上报', () => {
    expect(
      shadowDiffRows(
        { b: '2', onlyReported: 'yes', same: 'x' },
        { a: 1, b: 3, same: 'x' },
      ),
    ).toEqual([
      {
        desiredText: '1',
        key: 'a',
        reportedText: '',
        status: 'missing-report',
      },
      {
        desiredText: '3',
        key: 'b',
        reportedText: '2',
        status: 'value-differs',
      },
      {
        desiredText: '',
        key: 'onlyReported',
        reportedText: 'yes',
        status: 'extra-report',
      },
      {
        desiredText: 'x',
        key: 'same',
        reportedText: 'x',
        status: 'match',
      },
    ]);
  });

  it('🔴 判等与后端同口径：25.0 字符串 == 25 数值、true 字符串 == true 布尔、大小写不敏感', () => {
    expect(
      shadowDiffRows(
        { bool: 'TRUE', num: '25.0' },
        { bool: true, num: 25 },
      ).map((row) => row.status),
    ).toEqual(['match', 'match']);
  });

  it('🔴 不 trim：带空格的字符串与无空格不等价（与后端一致）', () => {
    expect(shadowValueEquals(' 25 ', 25)).toBe(false);
    expect(shadowValueEquals(' 25 ', '25 ')).toBe(false);
    expect(shadowValueEquals('25', '25.0')).toBe(true);
    expect(shadowValueEquals('OFF', 'off')).toBe(false);
  });

  it('🔴 定点十进制：0.1+0.2 类浮点误差不得把不等值判成相等', () => {
    expect(shadowValueEquals('0.3', 0.1 + 0.2)).toBe(false);
    expect(shadowValueEquals('0.30', '0.3')).toBe(true);
    expect(shadowValueEquals('1e3', '1000')).toBe(true);
    expect(shadowValueEquals('1e-3', '0.001')).toBe(true);
    expect(shadowValueEquals('-0', '0')).toBe(true);
  });

  it('🔴 指数/位数有界：极端上报值不得触发补零崩溃（RangeError/OOM），退回原串比较', () => {
    // reported 来自设备 MQTT 原始读数，完全不可信：`1e-999999999` 若照常补零，
    // `'0'.repeat(999999999)` 会抛 RangeError: Invalid string length，整个概览页签崩掉。
    expect(() => shadowValueEquals('1e-999999999', 1)).not.toThrow();
    expect(shadowValueEquals('1e-999999999', 1)).toBe(false);
    expect(() => shadowValueEquals('1e999999999', 1)).not.toThrow();
    expect(shadowValueEquals('1e999999999', 1)).toBe(false);
    // 指数刚好在边界内仍要能正常归一化（不能因为加守卫把正常值判成不可解析）
    expect(shadowValueEquals('1e-9', 0.000000001)).toBe(true);
    expect(shadowValueEquals('1e300', `1${'0'.repeat(300)}`)).toBe(true);
    // 超长数字串（补零/切分都会分配巨串）同样退回原串比较，不抛异常
    const longDigits = `0.${'1'.repeat(2000)}`;
    expect(() => shadowValueEquals(longDigits, 0)).not.toThrow();
    expect(shadowValueEquals(longDigits, 0)).toBe(false);
    // 同一个超长串与自身比较仍等价（原串口径）
    expect(shadowValueEquals(longDigits, longDigits)).toBe(true);
  });

  it('🔴 对象/数组区分类型并递归比较（空对象 ≠ 空数组，与后端 Map/List 一致）', () => {
    expect(shadowValueEquals({}, [])).toBe(false);
    expect(shadowValueEquals({ a: 1 }, { a: '1' })).toBe(true);
    expect(shadowValueEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(shadowValueEquals({ a: 1 }, { b: 1 })).toBe(false);
    expect(shadowValueEquals([1, '2'], [1, 2])).toBe(true);
    expect(shadowValueEquals([1, 2], [2, 1])).toBe(false);
  });

  it('null 与 undefined 同哨兵；「键不存在」与「值为 null」是两种状态', () => {
    expect(shadowValueEquals(null, null)).toBe(true);
    expect(shadowValueEquals(null, undefined)).toBe(true);
    expect(shadowDiffRows({ k: null }, { k: null })[0]?.status).toBe('match');
    // desired 有键（值 null）而 reported 无该键 ⇒ 是「仅期望」，不是「一致」
    expect(shadowDiffRows({}, { k: null })[0]).toMatchObject({
      desiredText: 'null',
      reportedText: '',
      status: 'missing-report',
    });
  });

  it('空对象/缺省：两侧都空给空数组，单侧为空仍逐键列出', () => {
    expect(shadowDiffRows()).toEqual([]);
    expect(shadowDiffRows({}, {})).toEqual([]);
    expect(shadowDiffRows({}, null)).toEqual([]);
    expect(shadowDiffRows({ onlyReported: 1 })).toEqual([
      {
        desiredText: '',
        key: 'onlyReported',
        reportedText: '1',
        status: 'extra-report',
      },
    ]);
    expect(shadowDiffRows(null, { onlyDesired: 1 })).toEqual([
      {
        desiredText: '1',
        key: 'onlyDesired',
        reportedText: '',
        status: 'missing-report',
      },
    ]);
  });

  it('排序稳定：键名升序且两侧键合并去重（含大小写/数字前缀）', () => {
    const rows = shadowDiffRows(
      { B: 1, a: 1, '10': 1 },
      { A: 1, b: 1, '2': 1 },
    );
    expect(rows.map((row) => row.key)).toEqual(['10', '2', 'A', 'B', 'a', 'b']);
  });

  it('对象值展示为 JSON（不出现 [object Object]）', () => {
    const rows = shadowDiffRows({ nested: { a: 1 } }, { nested: { a: 2 } });
    expect(rows[0]).toMatchObject({
      desiredText: '{"a":2}',
      reportedText: '{"a":1}',
      status: 'value-differs',
    });
  });
});

describe('buildDesiredFromReported（一键应用 = 以上报为准）', () => {
  it('🔴 desired ← reported：剔除 reported 中没有的多余键', () => {
    expect(
      buildDesiredFromReported({ temp: '25.0' }, { temp: 26, stale: 'x' }),
    ).toEqual({ temp: '25.0' });
  });

  it('reported 为空 ⇒ 结果为空对象（清空全部期望键，属有损操作，故组件必须二次确认）', () => {
    expect(buildDesiredFromReported({}, { temp: 26 })).toEqual({});
    expect(buildDesiredFromReported()).toEqual({});
    expect(buildDesiredFromReported(null, null)).toEqual({});
  });

  it('🔴 无变化时原样返回入参引用（组件据此跳过无意义的 PUT）', () => {
    const desired = { num: 25, flag: true };
    const same = buildDesiredFromReported(
      { flag: 'TRUE', num: '25.0' },
      desired,
    );
    expect(same).toBe(desired);
  });

  it('有变化时返回新对象（不与入参共享引用，避免误改页面状态）', () => {
    const desired = { num: 24 };
    const next = buildDesiredFromReported({ num: '25.0' }, desired);
    expect(next).not.toBe(desired);
    expect(next).toEqual({ num: '25.0' });
  });

  it('返回的是浅拷贝：改结果不影响 reported 入参', () => {
    const reported = { temp: 25 };
    const next = buildDesiredFromReported(reported, { temp: 20 });
    next.temp = 99;
    expect(reported.temp).toBe(25);
  });
});

import { describe, expect, it } from 'vitest';

import {
  desiredToEditableText,
  parseDesiredJson,
  recordToRows,
} from './shadow-state';

/**
 * 设备影子期望值纯逻辑用例（看板 #13）。
 *
 * 重点：JSON 文本 ↔ 对象 边界（非法 JSON / 非对象 / 空 / 深层值）；
 * 展示行避免 [object Object]。
 */

describe('parseDesiredJson', () => {
  it('合法对象通过', () => {
    const r = parseDesiredJson('{"target": 25.5, "enabled": true}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ target: 25.5, enabled: true });
  });

  it('🔴 空文本 = 清空（给 {}，不是报错）', () => {
    const r = parseDesiredJson('');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  it('非法 JSON 拒绝', () => {
    const r = parseDesiredJson('{ target: 25 }');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('JSON');
  });

  it('🔴 数组 / 标量 / null 拒绝（后端要求 Map）', () => {
    for (const text of ['[1,2]', '25', '"x"', 'null']) {
      expect(parseDesiredJson(text).ok).toBe(false);
    }
  });

  it('深层嵌套对象可解析', () => {
    const r = parseDesiredJson('{"a":{"b":[1,2],"c":"x"}}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: { b: [1, 2], c: 'x' } });
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

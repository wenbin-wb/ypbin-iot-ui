import { describe, expect, it } from 'vitest';

import { toBackendNumber } from './backend-number';

/**
 * `toBackendNumber` 的边界用例。
 *
 * 这个函数是「后端 Long 序列化成字符串」这条口径的**唯一**落点：分页 `total/page/pageSize`、
 * 计数、时间戳毫秒等都要过它。它一旦写错，症状是**静默**的（NaN 渲染成空、`"0"` 被当真值、
 * 字符串拼接出 `"171"`），所以边界必须逐条钉死。
 */
describe('toBackendNumber（后端 Long→字符串口径的唯一转换点）', () => {
  it('数字原样返回（含 0 与负数）', () => {
    expect(toBackendNumber(0)).toBe(0);
    expect(toBackendNumber(17)).toBe(17);
    expect(toBackendNumber(-3)).toBe(-3);
  });

  it('数字字符串按**数值**解析，而不是原样留着', () => {
    // 后端真实返回：{"total":"17","page":"1","pageSize":"10"}
    expect(toBackendNumber('17')).toBe(17);
    expect(toBackendNumber('0')).toBe(0);
    expect(toBackendNumber('-3')).toBe(-3);
    expect(toBackendNumber(' 42 ')).toBe(42);
  });

  it('空值一律回落 0（不把 NaN 泄漏到界面）', () => {
    expect(toBackendNumber(undefined)).toBe(0);
    expect(toBackendNumber(null)).toBe(0);
    expect(toBackendNumber('')).toBe(0);
  });

  it('解析不出的脏值回落 0，不产生 NaN/Infinity', () => {
    expect(toBackendNumber('abc')).toBe(0);
    expect(toBackendNumber('12px')).toBe(0);
    expect(toBackendNumber(Number.NaN)).toBe(0);
    expect(toBackendNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toBackendNumber(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(toBackendNumber({})).toBe(0);
    expect(toBackendNumber([])).toBe(0);
  });

  it('🔴 回归「`"0"` 是真值」这个坑：`?? 0` 挡不住字符串计数', () => {
    // 这就是本函数存在的**具体**理由：后端把 0 回成 "0"，
    // `const n = res.total ?? 0` 得到的是字符串 "0"（不是数字 0）。
    const raw: number | string = '0';
    const naive = raw ?? 0;
    expect(typeof naive).toBe('string');
    // 真值判断会走错分支（这就是 guide.vue 里 `counts` 参与 `> 0` 判断的风险面）
    expect(Boolean(naive)).toBe(true);
    // 而转数后是真 0
    expect(toBackendNumber(raw)).toBe(0);
    expect(Boolean(toBackendNumber(raw))).toBe(false);
  });

  it('🔴 回归「字符串相加」这个坑：`total + 1` 会拼接', () => {
    const raw: number | string = '17';
    // 说明为什么必须转换而不是「反正 JS 会隐式转换」
    expect(raw + 1).toBe('171');
    expect(toBackendNumber(raw) + 1).toBe(18);
  });
});

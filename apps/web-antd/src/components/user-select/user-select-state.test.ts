import { describe, expect, it } from 'vitest';

import {
  filterUserOptions,
  mergeUserOptions,
  normalizeUserIds,
  placeholderOptions,
  planBackfillIds,
  resolveUserLabel,
  toUserOption,
} from './user-select-state';

/**
 * 用户选择器纯逻辑用例。
 *
 * 重点锁死**回显**这条最容易做坏的路径：
 * - 编辑时只有 id，候选里可能没有那几个人（分页/搜索词不匹配）⇒ 必须能算出"要补拉谁"；
 * - 补拉失败时**不能把该值渲染成裸 ID 或丢失**，而要给带标注的占位；
 * - 展示文案必须能区分同名用户（姓名 + 登录名）。
 */

const alice = {
  id: 2,
  realName: '张三',
  username: 'zhangsan',
  email: 'a@b.com',
};
const bob = { id: 7, realName: '李四', username: 'lisi' };

describe('normalizeUserIds（兼容数组与后端逗号串）', () => {
  it('数组形态：去重、去空白', () => {
    expect(normalizeUserIds([' 1 ', '1', '2', ''])).toStrictEqual(['1', '2']);
  });

  it('🔴 字符串形态（后端存储就是逗号串）', () => {
    expect(normalizeUserIds('1,2, 2 ,3')).toStrictEqual(['1', '2', '3']);
  });

  it('空值一律空数组（绝不 null）', () => {
    for (const value of [null, undefined, '', [], ' , ']) {
      expect(normalizeUserIds(value as never)).toStrictEqual([]);
    }
  });

  it('数字与数字数组也接受（后端 Long 是字符串，但调用方可能给 number）', () => {
    expect(normalizeUserIds(2)).toStrictEqual(['2']);
    expect(normalizeUserIds([2, 7, 2])).toStrictEqual(['2', '7']);
  });
});

describe('resolveUserLabel（同名用户必须能分辨）', () => {
  it('有姓名有登录名 ⇒ 姓名（登录名）', () => {
    expect(resolveUserLabel(alice)).toBe('张三（zhangsan）');
  });

  it('只有姓名 / 只有登录名各自回落', () => {
    expect(resolveUserLabel({ id: 1, realName: '王五' })).toBe('王五');
    expect(resolveUserLabel({ id: 1, username: 'wangwu' })).toBe('wangwu');
  });

  it('🔴 姓名与登录名都为空 ⇒ 回落 #id，绝不返回空串', () => {
    expect(resolveUserLabel({ id: 9, realName: '  ', username: null })).toBe(
      '#9',
    );
    // 空白标签比"裸 ID"更糟：用户会以为组件坏了
    expect(resolveUserLabel({ id: 9 })).toBe('#9');
  });

  it('连 id 都没有 ⇒ 显式"未知用户"而不是空', () => {
    expect(resolveUserLabel({ id: '' })).toBe('未知用户');
  });
});

describe('toUserOption', () => {
  it('value 统一为字符串（后端 Long→字符串，混用 number 会让 v-model 比对失败）', () => {
    const option = toUserOption(alice);
    expect(option.value).toBe('2');
    expect(typeof option.value).toBe('string');
    expect(option.label).toBe('张三（zhangsan）');
    expect(option.email).toBe('a@b.com');
  });
});

describe('mergeUserOptions', () => {
  it('按 value 去重并保留首次出现顺序', () => {
    const merged = mergeUserOptions(
      [{ label: 'A', value: '1' }],
      [
        { label: 'A2', value: '1' },
        { label: 'B', value: '2' },
      ],
    );

    expect(merged.map((item) => item.value)).toStrictEqual(['1', '2']);
    expect(merged[0]?.label).toBe('A');
  });

  it('忽略空 value 与空批次', () => {
    expect(mergeUserOptions([], [{ label: 'x', value: ' ' }])).toStrictEqual(
      [],
    );
  });
});

describe('planBackfillIds（回显的关键）', () => {
  it('🔴 已选中但候选里没有的 ⇒ 需要补拉（否则标签显示裸 ID）', () => {
    const loaded = [toUserOption(alice)];
    // 选了 2（已在候选）与 7（不在候选，通常是历史数据/分页外）
    expect(planBackfillIds(['2', '7'], loaded)).toStrictEqual(['7']);
  });

  it('全都在候选里 ⇒ 不补拉（避免无谓请求）', () => {
    const loaded = [toUserOption(alice), toUserOption(bob)];
    expect(planBackfillIds(['2', '7'], loaded)).toStrictEqual([]);
  });

  it('未选中任何 ⇒ 不补拉', () => {
    expect(planBackfillIds([], [toUserOption(alice)])).toStrictEqual([]);
  });

  it('接受字符串形态的已选值（后端回填）', () => {
    expect(planBackfillIds(normalizeUserIds('2,7'), [])).toStrictEqual([
      '2',
      '7',
    ]);
  });
});

describe('placeholderOptions（补拉失败不能丢值）', () => {
  it('为失败 ID 生成带标注的占位，保留该值', () => {
    const options = placeholderOptions(['7']);

    expect(options).toHaveLength(1);
    expect(options[0]?.value).toBe('7');
    // 必须标注"未知"：让信息如实呈现，而不是伪装成正常用户
    expect(options[0]?.label).toContain('未知');
  });

  it('空输入 ⇒ 空数组', () => {
    expect(placeholderOptions([])).toStrictEqual([]);
  });
});

describe('filterUserOptions（本地即时过滤兜底）', () => {
  const options = [toUserOption(alice), toUserOption(bob)];

  it('关键词为空 ⇒ 原样返回', () => {
    expect(filterUserOptions(options, '')).toHaveLength(2);
  });

  it('匹配姓名（中文）', () => {
    expect(
      filterUserOptions(options, '张').map((item) => item.value),
    ).toStrictEqual(['2']);
  });

  it('匹配登录名（大小写不敏感）', () => {
    expect(
      filterUserOptions(options, 'LISI').map((item) => item.value),
    ).toStrictEqual(['7']);
  });

  it('无命中 ⇒ 空数组（不是 null）', () => {
    expect(filterUserOptions(options, 'zzz')).toStrictEqual([]);
  });
});

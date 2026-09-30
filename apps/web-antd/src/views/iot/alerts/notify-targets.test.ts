import { describe, expect, it } from 'vitest';

import {
  findInvalidEmails,
  isEmailToken,
  isUserIdToken,
  joinNotifyTargets,
  splitNotifyTargets,
} from './notify-targets';

/**
 * `notifyTargets` 拆合逻辑用例（看板 #10/#13 收件人改造）。
 *
 * 判据必须与**后端** `AlertNotifyPlanner#resolveTargets` 同口径：
 * 含 `@` ⇒ 邮件；纯数字且非 0 ⇒ 站内信用户 ID。
 *
 * 🔴 本用例最重要的一条是**生产数据的向后兼容**：线上演示规则的
 * `notify_targets` 实际是 `2,991736107@qq.com`（一个用户 ID + 一个邮箱混填）。
 * 改造后打开这条规则再保存，**必须原样还原**，否则就是"改个界面把线上规则改坏了"。
 */

describe('isUserIdToken（与后端 isPositiveNumber 同语义）', () => {
  it('纯数字且非 0 ⇒ 是用户 ID', () => {
    expect(isUserIdToken('2')).toBe(true);
    expect(isUserIdToken('991736107')).toBe(true);
    expect(isUserIdToken('0')).toBe(false);
  });

  it('空串 / 含非数字字符 ⇒ 不是', () => {
    expect(isUserIdToken('')).toBe(false);
    expect(isUserIdToken('12a')).toBe(false);
    expect(isUserIdToken('991736107@qq.com')).toBe(false);
  });

  it('🔴 不把 Number() 认的写法当用户 ID（后端只认纯数字字符）', () => {
    // Number('1e3') = 1000、Number(' 1') = 1、Number('0x1') = 1 —— 若前端用 Number()
    // 判据就会与后端分歧：前端按用户ID保存，后端却当无效 token 静默忽略。
    expect(isUserIdToken('1e3')).toBe(false);
    expect(isUserIdToken(' 1')).toBe(false);
    expect(isUserIdToken('0x1')).toBe(false);
    expect(isUserIdToken('1.0')).toBe(false);
    expect(isUserIdToken('+1')).toBe(false);
  });
});

describe('isEmailToken', () => {
  it('含 @ 即算（只分流、不校验格式）', () => {
    expect(isEmailToken('a@b.com')).toBe(true);
    // 后端只按"含不含 @"分流 ⇒ 前端若收得更紧会出现"后端会发、前端不让填"
    expect(isEmailToken('@')).toBe(true);
    expect(isEmailToken('not-an-email@')).toBe(true);
  });

  it('不含 @ ⇒ 不是', () => {
    expect(isEmailToken('123')).toBe(false);
    expect(isEmailToken('abc')).toBe(false);
  });
});

describe('splitNotifyTargets', () => {
  it('🔴 生产实值兼容：2,991736107@qq.com 拆成 1 用户 + 1 邮箱', () => {
    const split = splitNotifyTargets('2,991736107@qq.com');

    expect(split.userIds).toStrictEqual(['2']);
    expect(split.emails).toStrictEqual(['991736107@qq.com']);
    expect(split.unrecognized).toStrictEqual([]);
  });

  it('空 / null / undefined ⇒ 三个空数组（绝不返回 null）', () => {
    for (const raw of ['', null, undefined]) {
      const split = splitNotifyTargets(raw as never);
      expect(split.userIds).toStrictEqual([]);
      expect(split.emails).toStrictEqual([]);
      expect(split.unrecognized).toStrictEqual([]);
    }
  });

  it('去空白、丢空段、去重（保持首次出现顺序）', () => {
    const split = splitNotifyTargets(' 1 , ,2,1, a@b.com ,a@b.com ');

    expect(split.userIds).toStrictEqual(['1', '2']);
    expect(split.emails).toStrictEqual(['a@b.com']);
  });

  it('🔴 无法识别的 token 必须被带出来，不能悄悄丢', () => {
    const split = splitNotifyTargets('1,abc,a@b.com');

    expect(split.unrecognized).toStrictEqual(['abc']);
  });
});

describe('joinNotifyTargets', () => {
  it('顺序固定：用户 ID → 邮箱 → 无法识别项（保证"只是打开又保存"不产生 diff）', () => {
    const joined = joinNotifyTargets({
      userIds: ['2', '1'],
      emails: ['b@b.com', 'a@a.com'],
      unrecognized: ['zzz'],
    });

    expect(joined).toBe('2,1,b@b.com,a@a.com,zzz');
  });

  it('去重与去空白（含用户在输入框里手敲的多余空格/逗号）', () => {
    const joined = joinNotifyTargets({
      userIds: [' 1 ', '1', ''],
      emails: [' a@b.com ', ''],
      unrecognized: [],
    });

    expect(joined).toBe('1,a@b.com');
  });

  it('全空 ⇒ 空串（调用方据此转 undefined，保留"留空=发给创建者"语义）', () => {
    expect(
      joinNotifyTargets({ userIds: [], emails: [], unrecognized: [] }),
    ).toBe('');
  });
});

describe('findInvalidEmails（防止"填了收件人却没人收到"）', () => {
  it('🔴 漏 @ 的条目必须被指出（后端会静默忽略它）', () => {
    expect(findInvalidEmails(['ops', 'a@b.com'])).toStrictEqual(['ops']);
  });

  it('全部合法 ⇒ 空数组', () => {
    expect(findInvalidEmails(['a@b.com', 'c@d.com'])).toStrictEqual([]);
  });

  it('空白条目不算"非法"（是"没填"，不该报错）', () => {
    expect(findInvalidEmails(['', '  ', 'a@b.com'])).toStrictEqual([]);
  });

  it('空输入不炸', () => {
    expect(findInvalidEmails([])).toStrictEqual([]);
  });
});

describe('拆合往返（round-trip）', () => {
  it('🔴 生产实值往返不变', () => {
    const raw = '2,991736107@qq.com';
    expect(joinNotifyTargets(splitNotifyTargets(raw))).toBe(raw);
  });

  it('混乱输入往返后被规范化（但不丢任何有效信息）', () => {
    // 输入：顺序乱、有重复、有多余空格、有无法识别项
    const messy = ' a@b.com ,1,abc,1, 2 ';
    const normalized = joinNotifyTargets(splitNotifyTargets(messy));

    // 归一化后：用户ID(1,2) → 邮箱 → 未识别(abc)
    expect(normalized).toBe('1,2,a@b.com,abc');
    // 且再次拆合是**幂等**的（归一化后不再变化）
    expect(joinNotifyTargets(splitNotifyTargets(normalized))).toBe(normalized);
  });

  it('纯邮箱 / 纯用户 ID 各自往返不变', () => {
    expect(joinNotifyTargets(splitNotifyTargets('a@b.com,c@d.com'))).toBe(
      'a@b.com,c@d.com',
    );
    expect(joinNotifyTargets(splitNotifyTargets('1,2,3'))).toBe('1,2,3');
  });
});

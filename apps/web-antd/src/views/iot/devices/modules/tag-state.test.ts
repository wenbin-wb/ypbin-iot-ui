import { describe, expect, it } from 'vitest';

import {
  checkTagForm,
  normalizeTagForm,
  resolveTagListState,
  TAG_KEY_MAX,
  TAG_VALUE_MAX,
  tagDisplayKey,
} from './tag-state';

/**
 * 设备标签纯逻辑用例（看板 #13）。
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

  it('失败信息能指出是哪个字段', () => {
    expect(checkTagForm('', 'v').message).toContain('标签键');
    expect(checkTagForm('k', '').message).toContain('标签值');
    expect(checkTagForm('k'.repeat(100), 'v').message).toContain('64');
    expect(checkTagForm('k', 'v'.repeat(300)).message).toContain('255');
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

import { describe, expect, it } from 'vitest';

import { splitSpaceText } from './space-display';

describe('splitSpaceText（设备「所在空间」列展示拆分）', () => {
  it('★ 带「+N」时拆出主路径与其它空间数', () => {
    expect(splitSpaceText('总部园区/A栋/1F/101室 +2')).toEqual({
      others: 2,
      primary: '总部园区/A栋/1F/101室',
    });
  });

  it('单个空间（无 +N）时 others 为 0', () => {
    expect(splitSpaceText('总部园区/A栋')).toEqual({
      others: 0,
      primary: '总部园区/A栋',
    });
  });

  it('★ 空间名本身含 " +" 时不被误切（只认结尾的 " +数字"）', () => {
    // 「A+栋」这种名字真实存在（用户自由输入），用 split(' +') 会把名字切坏
    expect(splitSpaceText('园区/A+栋/1F +1')).toEqual({
      others: 1,
      primary: '园区/A+栋/1F',
    });
  });

  it('名字结尾恰好是 " +3" 但属于名字时也会被拆（已知边界，如实声明）', () => {
    // 这是「文本协议」的固有歧义：后端拼字符串时无法区分「名字」与「后缀」。
    // 彻底解决需要后端改结构（返回 {primary, others} 而不是拼好的字符串）。
    // 此处锁定当前行为，避免有人误以为已完全无歧义。
    expect(splitSpaceText('园区/A +3')).toEqual({
      others: 3,
      primary: '园区/A',
    });
  });

  it('空串/null/undefined 返回空主路径且 others=0', () => {
    expect(splitSpaceText('')).toEqual({ others: 0, primary: '' });
    expect(splitSpaceText(null)).toEqual({ others: 0, primary: '' });
    expect(splitSpaceText(undefined)).toEqual({ others: 0, primary: '' });
  });

  it('去掉首尾空白', () => {
    expect(splitSpaceText('  园区/A栋  ')).toEqual({
      others: 0,
      primary: '园区/A栋',
    });
  });
});

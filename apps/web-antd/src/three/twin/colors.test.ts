import { describe, expect, it } from 'vitest';

import { isLightBackground } from './colors';

/**
 * 深浅底色判定（**纯函数**）。
 *
 * 这个判定决定「画布地面/网格用深色还是浅色调色板」：判错一次，亮色主题下就会出现
 * 「深色地面嵌在浅色页面里」或「浅色底上看不见网格线」。因此把边界钉死。
 */
describe('is_light_background', () => {
  it('浅色 hex（#fff / #f8fafc / rgba 白）⇒ true', () => {
    expect(isLightBackground('#ffffff')).toBe(true);
    expect(isLightBackground('#f8fafc')).toBe(true);
    expect(isLightBackground('#fff')).toBe(true);
    expect(isLightBackground('rgba(248, 250, 252, 1)')).toBe(true);
  });

  it('深色 hex/rgb ⇒ false（现有画布背景不能被误判成浅色）', () => {
    expect(isLightBackground('#0b1220')).toBe(false);
    expect(isLightBackground('#111a2b')).toBe(false);
    expect(isLightBackground('rgb(7, 11, 20)')).toBe(false);
  });

  it('空/无法解析 ⇒ false（安全默认：保持现有深色配色）', () => {
    expect(isLightBackground(undefined)).toBe(false);
    expect(isLightBackground(null)).toBe(false);
    expect(isLightBackground('')).toBe(false);
    expect(isLightBackground('not-a-color')).toBe(false);
    expect(isLightBackground('hsl(0 0% 0%)')).toBe(false);
  });

  it('★ 分界附近：中灰按深色处理（不把深灰误判成浅色）', () => {
    // 128 灰 = 感知亮度 0.5，远低于 0.72 阈值 ⇒ 深色
    expect(isLightBackground('#808080')).toBe(false);
    // 208 灰 = 0.81，高于阈值 ⇒ 浅色
    expect(isLightBackground('#d0d0d0')).toBe(true);
  });
});

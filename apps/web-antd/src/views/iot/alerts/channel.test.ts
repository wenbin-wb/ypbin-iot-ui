import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import { channelLabel } from './channel';

/** 投递渠道中文化：真实 i18n（键缺失/编译不过要让用例红）。 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

describe('channelLabel（投递记录渠道列）', () => {
  it('渠道码 INBOX/EMAIL 映射中文，大小写与空白不敏感', () => {
    expect(channelLabel('INBOX')).toBe('站内信');
    expect(channelLabel('email')).toBe('邮件');
    expect(channelLabel(' inbox ')).toBe('站内信');
  });

  it('未知渠道不伪装：显示「未知（原码）」保留排障线索', () => {
    expect(channelLabel('WEBHOOK')).toBe('未知（WEBHOOK）');
  });

  it('空值显示 -', () => {
    expect(channelLabel(undefined)).toBe('-');
    expect(channelLabel(null)).toBe('-');
    expect(channelLabel('')).toBe('-');
  });
});

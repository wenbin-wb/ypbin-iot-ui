import { describe, expect, it } from 'vitest';

import {
  resolveNotifyRisk,
  splitChannels,
  splitTargetKinds,
} from './notify-risk';

/** 通知风险纯逻辑用例（看板 #14 前端提示；与后端 resolveTargets 语义对齐）。 */

describe('splitChannels / splitTargetKinds', () => {
  it('渠道拆分 trim 去空', () => {
    expect(splitChannels('INBOX, EMAIL')).toEqual(['INBOX', 'EMAIL']);
    expect(splitChannels(undefined)).toEqual([]);
    expect(splitChannels('  , ')).toEqual([]);
  });

  it('目标拆分：@→邮箱、纯数字→userId、其余→unrecognized（与后端同口径）', () => {
    expect(splitTargetKinds('2,991736107@qq.com ,bogus , 3')).toEqual({
      emails: ['991736107@qq.com'],
      userIds: ['2', '3'],
      unrecognized: ['bogus'],
    });
    expect(splitTargetKinds(undefined)).toEqual({
      emails: [],
      userIds: [],
      unrecognized: [],
    });
  });
});

describe('resolveNotifyRisk（看板 #14 风险三态）', () => {
  it('🔴 EMAIL 渠道开着但无邮箱收件人 ⇒ emailBroken（投递必败/GIVEN_UP）', () => {
    expect(resolveNotifyRisk('EMAIL', '2')).toBe('emailBroken');
    expect(resolveNotifyRisk('EMAIL,INBOX', '2')).toBe('emailBroken');
    expect(resolveNotifyRisk('EMAIL', undefined)).toBe('emailBroken');
  });

  it('iNBOX-only 且目标为空 ⇒ inboxOnly（后端回落给创建者，有效只是要知道）', () => {
    expect(resolveNotifyRisk('INBOX', undefined)).toBe('inboxOnly');
    expect(resolveNotifyRisk('INBOX', '')).toBe('inboxOnly');
  });

  it('各渠道有对应目标 ⇒ ok', () => {
    expect(resolveNotifyRisk('EMAIL', 'a@b.com')).toBe('ok');
    expect(resolveNotifyRisk('INBOX', '2')).toBe('ok');
    expect(resolveNotifyRisk('EMAIL,INBOX', 'a@b.com,2')).toBe('ok');
    expect(resolveNotifyRisk(undefined, undefined)).toBe('ok');
    expect(resolveNotifyRisk('', '')).toBe('ok');
  });
});

import { describe, expect, it } from 'vitest';

import {
  notifyHintKey,
  notifyRiskLabelKey,
  resolveNotifyRisk,
  splitChannels,
  splitTargetKinds,
} from './notify-risk';

/**
 * 通知对象风险纯逻辑用例（前端可见提示；判据与后端 `AlertNotifyPlanner#resolveTargets` 对齐）。
 *
 * 为什么这些用例重要：提示必须**基于真实字段**且**诚实**——
 * 「EMAIL 无收件邮箱」不等于「投递必败」（平台可能配了兜底邮箱）；
 * 「未配通知对象」时站内信会走兜底链（规则创建者 ∪ 平台兜底用户）。
 * 文案一旦说反，用户会据此做出错误决策（关掉渠道 / 误以为有人会收到）。
 */

describe('splitChannels / splitTargetKinds', () => {
  it('渠道拆分 trim 去空', () => {
    expect(splitChannels('INBOX, EMAIL')).toEqual(['INBOX', 'EMAIL']);
    expect(splitChannels(undefined)).toEqual([]);
    expect(splitChannels('  , ')).toEqual([]);
  });

  it('目标拆分：@→邮箱、纯数字非 0→userId、其余→unrecognized（与后端同口径）', () => {
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

  it('0 不是有效用户 ID（后端 isPositiveNumber 不认）⇒ 归入 unrecognized', () => {
    expect(splitTargetKinds('0').userIds).toEqual([]);
    expect(splitTargetKinds('0').unrecognized).toEqual(['0']);
  });
});

describe('resolveNotifyRisk（通知对象风险五态）', () => {
  it('① 未配置：没选渠道 ⇒ noChannel；选了渠道但通知对象为空 ⇒ noTargets', () => {
    expect(resolveNotifyRisk(undefined, undefined)).toBe('noChannel');
    expect(resolveNotifyRisk('', '')).toBe('noChannel');
    expect(resolveNotifyRisk('INBOX', '')).toBe('noTargets');
    expect(resolveNotifyRisk('EMAIL', undefined)).toBe('noTargets');
    expect(resolveNotifyRisk('INBOX,EMAIL', ' , ')).toBe('noTargets');
  });

  it('② 已配置：各渠道都有显式目标 ⇒ ok（提示不出现）', () => {
    expect(resolveNotifyRisk('EMAIL', 'a@b.com')).toBe('ok');
    expect(resolveNotifyRisk('INBOX', '2')).toBe('ok');
    expect(resolveNotifyRisk('INBOX,EMAIL', 'a@b.com,2')).toBe('ok');
  });

  it('③ 兜底语义：EMAIL 无邮箱 ⇒ emailFallback（不是「投递必败」）；INBOX 无用户 ⇒ inboxFallback', () => {
    expect(resolveNotifyRisk('EMAIL', '2')).toBe('emailFallback');
    expect(resolveNotifyRisk('EMAIL,INBOX', '2')).toBe('emailFallback');
    expect(resolveNotifyRisk('INBOX', 'a@b.com')).toBe('inboxFallback');
    expect(resolveNotifyRisk('INBOX', 'bogus')).toBe('inboxFallback');
    // '0' 不是有效用户 ID ⇒ 站内信仍走兜底（与后端 isPositiveNumber 一致）
    expect(resolveNotifyRisk('INBOX', '0')).toBe('inboxFallback');
  });
});

describe('notifyHintKey / notifyRiskLabelKey（提示出现与否 + 标签键）', () => {
  it('未配置 / 仅兜底 ⇒ 提示出现；配置齐全 ⇒ 提示不出现', () => {
    expect(notifyHintKey(resolveNotifyRisk('INBOX', ''))).toBe(
      'page.iot.alert.notify.hintNoTargets',
    );
    expect(notifyHintKey(resolveNotifyRisk('', ''))).toBe(
      'page.iot.alert.notify.hintNoChannel',
    );
    expect(notifyHintKey(resolveNotifyRisk('EMAIL', '2'))).toBe(
      'page.iot.alert.notify.hintEmailFallback',
    );
    expect(notifyHintKey(resolveNotifyRisk('INBOX', 'a@b.com'))).toBe(
      'page.iot.alert.notify.hintInboxFallback',
    );
    expect(
      notifyHintKey(resolveNotifyRisk('INBOX,EMAIL', '2,a@b.com')),
    ).toBeUndefined();
  });

  it('每个风险态都有非空标签键', () => {
    for (const risk of [
      'noChannel',
      'noTargets',
      'emailFallback',
      'inboxFallback',
      'ok',
    ] as const) {
      expect(notifyRiskLabelKey(risk)).not.toBe('');
    }
  });
});

/**
 * 文案诚实性用例：直接读 zh-CN / en-US 语言包，钉住「兜底」语义。
 *
 * 不测整句相等（文案会润色），只测**必须出现 / 必须不出现**的关键事实：
 * 1. 「未配置通知对象」必须提到站内信兜底链与邮件兜底邮箱；
 * 2. 「EMAIL 无收件邮箱」必须带条件（有平台兜底邮箱才送达），不能是无条件失败。
 */
describe('提示文案的兜底语义（zh-CN / en-US）', () => {
  it('zh-CN：未配置/邮件兜底文案都点明「平台兜底」，且不再宣称无条件投递失败', async () => {
    const mod = (await import('#/locales/langs/zh-CN/page.json')) as {
      default?: Record<string, unknown>;
    };
    const page = (mod.default ?? mod) as any;
    const notify = page.iot.alert.notify;
    expect(notify.hintNoTargets).toContain('兜底');
    expect(notify.hintNoTargets).toContain('创建者');
    expect(notify.hintNoTargets).toContain('兜底邮箱');
    expect(notify.hintEmailFallback).toContain('兜底邮箱');
    // 旧文案的无条件断言（平台配了兜底邮箱时并不成立）必须已消失
    expect(notify.hintEmailFallback).not.toContain('投递失败');
    expect(notify.hintNoTargets).not.toContain('投递必败');
    expect(notify.hintNoChannel).toContain('不会产生任何通知记录');
  });

  it('en-US：fallback 语义同样成立', async () => {
    const mod = (await import('#/locales/langs/en-US/page.json')) as {
      default?: Record<string, unknown>;
    };
    const page = (mod.default ?? mod) as any;
    const notify = page.iot.alert.notify;
    expect(notify.hintNoTargets.toLowerCase()).toContain('fallback');
    expect(notify.hintNoTargets).toContain('rule creator');
    expect(notify.hintNoTargets).toContain('fallback mailboxes');
    expect(notify.hintEmailFallback).toContain('fallback mailboxes');
    expect(notify.hintEmailFallback).not.toContain('will fail');
  });
});

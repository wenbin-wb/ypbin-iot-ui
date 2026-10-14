/**
 * 告警规则「通知对象」风险的**纯逻辑**（前端可见提示）。
 *
 * 判据 = **真实字段**，不是猜测：
 * - `notifyChannels` 是逗号分隔的渠道码（当前只有 `INBOX` / `EMAIL`）；
 * - `notifyTargets` 是逗号分隔的混合 token：含 `@` ⇒ 邮箱收件人；纯数字且非 0 ⇒ 站内信用户 ID；
 *   其余 token 后端**静默忽略**（归入 `unrecognized`）。
 *
 * 投递结果的真实口径（读后端 `AlertNotifyPlanner#resolveTargets` 得到，不是推测）：
 * - 渠道集合为空 ⇒ `plan()` 直接返回空列表，**一条通知记录都不产生**（也不会有人收到）；
 * - 收件人为空、或某渠道没有对应形态的 token 时，后端按渠道走**兜底**：
 *   - `INBOX`：规则创建者 ∪ `ypbin.alert.notify-fallback-inbox-user-ids`；
 *   - `EMAIL`：`ypbin.alert.notify-fallback-emails`；该列表为空 ⇒ 该渠道落 `GIVEN_UP`（**不会送达**）。
 * - 因此「EMAIL 无收件邮箱」**不等于**「投递必败」：平台配了兜底邮箱就会送达。文案必须如实表达这个条件，
 *   不能写成无条件的失败（这正是旧版 `emailBroken` 文案与新增平台兜底后的事实脱节之处）。
 *
 * 前端**拿不到**平台兜底配置（规则接口不返回 `AlertProperties`），所以文案只能写成
 * 「平台配置了兜底邮箱才会送达，否则不会送达」——这是当前信息边界下唯一诚实的说法。
 */
import { isUserIdToken } from './notify-targets';

/** 通知对象风险五态。 */
export type NotifyRisk =
  /** EMAIL 渠道开着但没有任何邮箱收件人：邮件仅靠平台兜底邮箱，兜底为空则不送达。 */
  | 'emailFallback'
  /** INBOX 渠道开着但没有任何用户收件人：站内信兜底给规则创建者 ∪ 平台兜底用户。 */
  | 'inboxFallback'
  /** 一个渠道都没选：不会产生任何通知记录。 */
  | 'noChannel'
  /** 选了渠道，但通知对象完全为空（渠道可能一个或多个）。 */
  | 'noTargets'
  /** 各渠道都有显式目标。 */
  | 'ok';

/** 拆分通知渠道（逗号分隔，trim、去空）。 */
export function splitChannels(channels: null | string | undefined): string[] {
  if (!channels) {
    return [];
  }
  return channels
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 拆分通知目标：含 `@` → 邮箱；纯数字且非 0 → userId；其它 → 无法识别。
 *
 * 用户 ID 判据复用 {@link isUserIdToken}（与后端 `isPositiveNumber` 逐字符同语义）：
 * `'0'` 在后端不是有效收件人，前端若把它当用户 ID，会漏报「站内信其实走了兜底」。
 */
export function splitTargetKinds(targets: null | string | undefined): {
  emails: string[];
  unrecognized: string[];
  userIds: string[];
} {
  const emails: string[] = [];
  const userIds: string[] = [];
  const unrecognized: string[] = [];
  if (!targets) {
    return { emails, userIds, unrecognized };
  }
  for (const raw of targets.split(',')) {
    const token = raw.trim();
    if (token === '') {
      continue;
    }
    if (token.includes('@')) {
      emails.push(token);
    } else if (isUserIdToken(token)) {
      userIds.push(token);
    } else {
      unrecognized.push(token);
    }
  }
  return { emails, userIds, unrecognized };
}

/**
 * 判定通知风险（判据优先级：未选渠道 → 未配对象 → 邮件无邮箱 → 站内信无用户 → 正常）。
 *
 * `targetsEmpty` 只看「三类 token 是否全空」，与渠道无关：只要通知对象整段为空，
 * 无论开的是 INBOX 还是 EMAIL，都属于「未配置通知对象」这一头条提示。
 */
export function resolveNotifyRisk(
  channels: null | string | undefined,
  targets: null | string | undefined,
): NotifyRisk {
  const channelList = splitChannels(channels);
  if (channelList.length === 0) {
    return 'noChannel';
  }
  const hasEmail = channelList.includes('EMAIL');
  const hasInbox = channelList.includes('INBOX');
  const kinds = splitTargetKinds(targets);
  const targetsEmpty =
    kinds.emails.length === 0 &&
    kinds.userIds.length === 0 &&
    kinds.unrecognized.length === 0;
  if (targetsEmpty) {
    return 'noTargets';
  }
  if (hasEmail && kinds.emails.length === 0) {
    return 'emailFallback';
  }
  if (hasInbox && kinds.userIds.length === 0) {
    return 'inboxFallback';
  }
  return 'ok';
}

/** 风险态 → 列表页风险标签的 i18n 键。 */
export function notifyRiskLabelKey(risk: NotifyRisk): string {
  switch (risk) {
    case 'emailFallback': {
      return 'page.iot.alert.notify.riskEmailFallback';
    }
    case 'inboxFallback': {
      return 'page.iot.alert.notify.riskInboxFallback';
    }
    case 'noChannel': {
      return 'page.iot.alert.notify.riskNoChannel';
    }
    case 'noTargets': {
      return 'page.iot.alert.notify.riskNoTargets';
    }
    default: {
      return 'page.iot.alert.notify.riskOk';
    }
  }
}

/**
 * 风险态 → 页面内联提示的 i18n 键；`ok` 返回 `undefined`（⇒ 提示**不出现**）。
 *
 * 「提示出现/不出现」由本函数唯一定义，模板只判断有无键；文案内容交给 zh/en 语言包。
 */
export function notifyHintKey(risk: NotifyRisk): string | undefined {
  switch (risk) {
    case 'emailFallback': {
      return 'page.iot.alert.notify.hintEmailFallback';
    }
    case 'inboxFallback': {
      return 'page.iot.alert.notify.hintInboxFallback';
    }
    case 'noChannel': {
      return 'page.iot.alert.notify.hintNoChannel';
    }
    case 'noTargets': {
      return 'page.iot.alert.notify.hintNoTargets';
    }
    default: {
      return undefined;
    }
  }
}

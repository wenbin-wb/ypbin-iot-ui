/**
 * 告警规则「通知对象」风险的**纯逻辑**（看板 #14「前端可见提示」）。
 *
 * 与后端 AlertNotifyPlanner.resolveTargets 语义对齐：notifyTargets 是逗号分隔 token，
 * 含 @ 视为 EMAIL、纯数字视为 INBOX userId、其余被后端忽略；
 * notifyTargets 空/NULL 时后端对 INBOX 回落「发给规则创建者」（有效，不算风险），
 * 而 EMAIL 渠道在解析不出任何邮箱时投递失败（无兜底则 GIVEN_UP，见后端 WARN NO_RECIPIENT）。
 */

export type NotifyRisk = 'emailBroken' | 'inboxOnly' | 'ok';

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

/** 拆分通知目标：含 @ → 邮箱；纯数字 → userId；其它 → 无法识别。 */
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
    } else if (/^\d+$/.test(token)) {
      userIds.push(token);
    } else {
      unrecognized.push(token);
    }
  }
  return { emails, userIds, unrecognized };
}

/**
 * 判定通知风险：
 *   emailBroken —— EMAIL 渠道开着但没有任何邮箱收件人（该渠道投递必败，无兜底则后端 GIVEN_UP）；
 *   inboxOnly —— 只开 INBOX 且目标为空（后端回落给规则创建者，有效，仅提示）；
 *   ok —— 各渠道都有对应目标（或未开启）。
 */
export function resolveNotifyRisk(
  channels: null | string | undefined,
  targets: null | string | undefined,
): NotifyRisk {
  const channelList = splitChannels(channels);
  const hasEmail = channelList.includes('EMAIL');
  const hasInbox = channelList.includes('INBOX');
  const kinds = splitTargetKinds(targets);

  if (hasEmail && kinds.emails.length === 0) {
    return 'emailBroken';
  }
  if (
    kinds.emails.length === 0 &&
    kinds.userIds.length === 0 &&
    kinds.unrecognized.length === 0 &&
    !hasEmail &&
    hasInbox
  ) {
    return 'inboxOnly';
  }
  return 'ok';
}

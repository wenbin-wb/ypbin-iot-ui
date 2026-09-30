/**
 * `notifyTargets` 的**形态分流**纯逻辑（与后端 `AlertNotifyPlanner#resolveTargets` 同一口径）。
 *
 * 后端契约（**不得更改**）：`iot_alert_rule.notify_targets` 是一个逗号分隔的字符串，
 * 里面**混合**放两种 token，服务端按**形态**分流：
 * - 含 `@` 的 token ⇒ 邮件渠道收件人；
 * - 纯数字（且非 0）的 token ⇒ 站内信渠道收件人（用户 ID）。
 *
 * 为什么要有这个模块：表单要把那一串**拆成**"选出来的系统用户" + "额外邮箱"，
 * 保存时再**合回**原字符串。拆合逻辑若不抽成纯函数，就只能靠组件里两处 `.split(',')`
 * 各自实现——那是"改一处忘一处"的经典来源（且拆分错了会**静默改坏**用户在用的规则）。
 */

/** 无法归类的 token（既非邮箱也非用户 ID）。 */
export interface NotifyTargetSplit {
  /** 纯数字 token：站内信收件人的用户 ID。 */
  userIds: string[];
  /** 含 `@` 的 token：邮件收件人。 */
  emails: string[];
  /**
   * **既不是邮箱也不是用户 ID** 的 token。
   *
   * 🔴 必须**单独带出来**而不是丢弃：后端对这类 token 是**静默忽略**的
   * （形态不匹配当前渠道就跳过）。若表单保存时把它们悄悄删掉，用户会发现
   * "我只改了收件人，怎么原来填的东西没了" —— 静默数据丢失比多一个警告更糟。
   * ⇒ 本模块**原样保留**它们，并由调用方在界面上**显式提示**。
   */
  unrecognized: string[];
}

/**
 * 判断 token 是否为用户 ID（纯数字且非 0）。
 *
 * 与后端 `isPositiveNumber` **逐字符**同语义（不用 `Number()`：`'1e3'`/`' 1'`/`'0x1'`
 * 在 `Number()` 下会被当成数字，而后端只认纯数字字符 ⇒ 两边判据必须一致）。
 *
 * @param token 待判 token（已 trim）
 * @returns 是用户 ID 返回 true
 */
export function isUserIdToken(token: string): boolean {
  if (token === '') {
    return false;
  }
  for (const char of token) {
    if (char < '0' || char > '9') {
      return false;
    }
  }
  return token !== '0';
}

/**
 * 判断 token 是否为邮箱（含 `@` 即算）。
 *
 * 刻意**不做**严格邮箱校验：后端只按"含不含 `@`"分流，前端若收得更紧，
 * 会出现"后端会发、前端不让填"的口径分裂。这里只负责**分流**，不负责**校验**。
 *
 * @param token 待判 token
 * @returns 含 `@` 返回 true
 */
export function isEmailToken(token: string): boolean {
  return token.includes('@');
}

/**
 * 把后端存的 `notifyTargets` 串拆成三段。
 *
 * @param raw 后端原文（可空 / null）
 * @returns 拆分结果（空输入 ⇒ 三个空数组，**绝不返回 null**）
 */
export function splitNotifyTargets(raw?: null | string): NotifyTargetSplit {
  const result: NotifyTargetSplit = {
    userIds: [],
    emails: [],
    unrecognized: [],
  };
  if (!raw) {
    return result;
  }
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const token = piece.trim();
    if (token === '' || seen.has(token)) {
      // 空段（如 "a,,b" 或结尾逗号）与重复项都跳过：它们不携带信息，
      // 保留只会让"用户看到 3 个收件人、实际只有 2 个"这种不一致发生。
      continue;
    }
    seen.add(token);
    if (isEmailToken(token)) {
      result.emails.push(token);
    } else if (isUserIdToken(token)) {
      result.userIds.push(token);
    } else {
      result.unrecognized.push(token);
    }
  }
  return result;
}

/**
 * 把三段合回后端契约的字符串。
 *
 * 顺序固定为 **用户 ID → 邮箱 → 无法识别项**：让同一次编辑的保存结果**稳定**，
 * 避免"只是打开又保存"也产生 diff（那种噪音会让审计看不出真正的改动）。
 *
 * @param split 拆分结果
 * @returns 逗号分隔串；三段皆空时返回空串（调用方需转成 `undefined` 以保留"留空=发给创建者"语义）
 */
export function joinNotifyTargets(split: NotifyTargetSplit): string {
  return [
    ...dedup(split.userIds),
    ...dedup(split.emails),
    ...dedup(split.unrecognized),
  ].join(',');
}

/**
 * 找出"不像邮箱"的条目（不含 `@`）。
 *
 * 为什么要有它：额外邮箱字段若允许随便填，用户敲了 `ops`（漏了 `@`）也能保存，
 * 而后端按形态分流会把 `ops` **静默忽略** —— 结果就是"我明明填了收件人，告警却没人收到"。
 * ⇒ 界面必须**当场**指出来。这里只做判据，文案与展示交给页面。
 *
 * @param emails 待检查的条目
 * @returns 不含 `@` 的条目（保持原顺序）
 */
export function findInvalidEmails(emails: string[]): string[] {
  return (emails ?? [])
    .map((item) => (item ?? '').trim())
    .filter((token) => token !== '' && !token.includes('@'));
}

/**
 * 去重并丢弃空项（保持首次出现的顺序）。
 *
 * @param values 原始值
 * @returns 去重后的新数组
 */
function dedup(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const token = (value ?? '').trim();
    if (token === '' || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

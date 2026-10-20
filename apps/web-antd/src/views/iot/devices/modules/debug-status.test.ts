import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  batchRowClassName,
  describeError,
  displayTime,
  displayValue,
  errorCodeText,
  kindText,
  replyOf,
  showTotal,
  sourceText,
  statusColor,
  statusText,
} from './debug-status';

/**
 * 「在线调试」展示层纯函数用例（拆分批次 5-H，从 `detail-debug.vue` 抽出后补的守门）。
 *
 * 这一层守两条**不可退让**的口径：
 * 1. **未知码不吞**：后端新增状态/错误码时，页面必须显示「未知（原码）」而不是空白或假中文；
 * 2. **原始信封可展开**：业务失败是 `HTTP 200 + R.code != 200`，`code`/`message`/原始 JSON
 *    三者都要留给排障（只留一句文案等于丢证据）。
 *
 * 文案断言用**真实 i18n + 真实语言包**（从 `page.json` 反查），不 stubs `$t`：
 * 桩只能证明「函数被调用」，证明不了「键存在且能编译」。
 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

/** 真实语言包里的 debug 段（用来反查期望文案，避免在用例里硬编码中文）。 */
async function debugMessages(): Promise<Record<string, string>> {
  const mod = (await import('#/locales/langs/zh-CN/page.json')) as {
    default: { iot: { debug: Record<string, string> } };
  };
  return mod.default.iot.debug;
}

/** 后端「业务失败」信封（HTTP 200 + `R.code != 200`，全仓约定）。 */
function bizFailure(code: number, message: string) {
  return Object.assign(new Error(message), {
    response: { data: { code, data: null, message } },
  });
}

describe('describeError：原样保留后端 code/message/信封', () => {
  it('业务失败信封 ⇒ code 保留、message 原样、raw 是信封 JSON', () => {
    const detail = describeError(bizFailure(4001, '点位不存在'), '兜底文案');
    expect(detail.code).toBe('4001');
    expect(detail.message).toBe('点位不存在');
    expect(detail.raw).toContain('"code": 4001');
    expect(detail.raw).toContain('点位不存在');
  });

  it('无业务信封（如 500 纯文本错误）⇒ code 为空串，message 取异常自身文案', () => {
    const detail = describeError(new Error('Request failed 500'), '兜底文案');
    expect(detail.code).toBe('');
    expect(detail.message).toBe('Request failed 500');
    expect(detail.raw).toBe('Request failed 500');
  });

  it('拿不到任何文案 ⇒ 用调用方 fallback（不显示空白）', () => {
    const detail = describeError({ weird: true }, '兜底文案');
    expect(detail.message).toBe('兜底文案');
  });
});

describe('码值 → 文案：未知码不吞', () => {
  it('statusText：已知码走真实语言包；未知码保留原码；空值显示 -', async () => {
    const messages = await debugMessages();
    expect(statusText('failed')).toBe(messages.statusFailed);
    expect(statusText('succeeded')).toBe(messages.statusSucceeded);
    expect(statusText('NEW_STATUS')).toContain('NEW_STATUS');
    expect(statusText(undefined)).toBe('-');
  });

  it('statusColor：失败=error / 成功=success / 超时=warning / 其它=default', () => {
    expect(statusColor('failed')).toBe('error');
    expect(statusColor('succeeded')).toBe('success');
    expect(statusColor('timeout')).toBe('warning');
    expect(statusColor('sent')).toBe('processing');
    expect(statusColor('whatever')).toBe('default');
  });

  it('kindText：三个动作码有文案；未知码按原码展示', async () => {
    const messages = await debugMessages();
    expect(kindText('property_set')).toBe(messages.kindPropertySet);
    expect(kindText('property_get')).toBe(messages.kindPropertyGet);
    expect(kindText('service_call')).toBe(messages.kindServiceCall);
    expect(kindText('custom_kind')).toBe('custom_kind');
    expect(kindText(undefined)).toBe('-');
  });

  it('errorCodeText：已知失败码给人话；未知码保留原码；空值空串', async () => {
    const messages = await debugMessages();
    expect(errorCodeText('NO_SUBSCRIBER')).toBe(messages.errorNoSubscriber);
    expect(errorCodeText('DEVICE_OFFLINE')).toBe(messages.errorDeviceOffline);
    expect(errorCodeText('TIMEOUT')).toBe(messages.errorTimeout);
    expect(errorCodeText('SOMETHING_NEW')).toContain('SOMETHING_NEW');
    expect(errorCodeText(undefined)).toBe('');
  });

  it('sourceText：来源码映射；未知/空值不伪造已知值', async () => {
    const messages = await debugMessages();
    expect(sourceText('console')).toBe(messages.sourceConsole);
    expect(sourceText('api')).toBe(messages.sourceApi);
    expect(sourceText(undefined)).toBe('-');
    expect(sourceText('weird')).toContain('weird');
  });

  it('showTotal：把条数带进文案（分页总数不是空白）', async () => {
    expect(showTotal(3)).toContain('3');
  });
});

describe('回执解析与展示', () => {
  it('replyOf：合法对象 → 结构；非法 JSON / 数组 / 空 → undefined（页面回退原文）', () => {
    expect(replyOf({ replyPayload: '{"code":0}' })).toEqual({ code: 0 });
    expect(replyOf({ replyPayload: 'not-json' })).toBeUndefined();
    expect(replyOf({ replyPayload: '[1,2]' })).toBeUndefined();
    expect(replyOf({ replyPayload: '' })).toBeUndefined();
    expect(replyOf({})).toBeUndefined();
  });

  it('displayValue：空值 -、对象 JSON 化、标量原样', () => {
    expect(displayValue(undefined)).toBe('-');
    expect(displayValue('')).toBe('-');
    expect(displayValue(0)).toBe('0');
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
  });

  it('displayTime：可解析时间走统一格式；解析不了的原样露出（不显示空白）', () => {
    expect(displayTime('2026-09-27 20:25:44')).toContain('2026');
    expect(displayTime(1_790_511_944_141)).toContain('2026');
    expect(displayTime('not-a-time')).toBe('not-a-time');
  });
});

describe('batchRowClassName：本批高亮', () => {
  const row = { requestId: 'cmd-1' } as never;

  it('命中本批 ⇒ 语义 token 类（暗色可读，不是硬编码调色板）', () => {
    expect(batchRowClassName(new Set(['cmd-1']), row)).toBe('bg-primary/10');
  });

  it('不在本批 ⇒ 空串', () => {
    expect(batchRowClassName(new Set(['other']), row)).toBe('');
  });
});

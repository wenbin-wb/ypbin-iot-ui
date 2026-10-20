import type { DisplayValue } from '../../shared/display';

import type { IotCommandApi } from '#/api/iot';

import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { formatDateTime } from '../../shared/display';

/**
 * 「在线调试」的**展示/错误口径**纯函数（从 `detail-debug.vue` 拆出，2026-10-20 架构审查 §2.2）。
 *
 * 抽出的理由：这一层是「码值 → 人话」和「后端信封 → 可展开的原始错误」两个纯映射，
 * 与下发/轮询的并发语义无关；放在页面里时既无法单测，又和状态机代码混读。
 *
 * 三条口径（原样保留，不得在搬迁中丢失）：
 * 1. **未知码不吞**：`error_code`/`status`/`kind`/`source` 的未知值按「未知（原码）」展示，
 *    不猜一个像中文的值（与 `shared/display.ts` 同一口径）；
 * 2. **原始信封可展开**：业务失败是 `HTTP 200 + R.code != 200`，除了 `message` 还要保留
 *    `code` 与原始 JSON —— 排障时这两样比一句文案有用；
 * 3. **解析不了的报文原样露出**：`replyPayload` 非 JSON 时返回 `undefined`，由页面回退展示原文。
 */

/** 后端失败详情（`message` 原样 + 原始 `code`/信封可展开）。 */
export interface ErrorDetail {
  /** 后端 `R.code`（拿不到时为空串）。 */
  code: string;
  /** 后端 `R.message`（拿不到时用 fallback）。 */
  message: string;
  /** 原始信封文本，供展开查看。 */
  raw: string;
}

/** 状态下拉的顺序（与后端状态机同序；空 = 全部）。 */
export const STATUS_OPTIONS: IotCommandApi.CommandStatusCode[] = [
  'pending',
  'sent',
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
];

/**
 * 取后端响应的「原样」错误：`extractErrorMessage` 只回文案，这里额外保留 `R.code` 与原始信封。
 *
 * 业务失败的形态是 **HTTP 200 + `R.code != 200`**（全仓约定），信封在 `error.response.data` 上。
 */
export function describeError(error: unknown, fallback: string): ErrorDetail {
  const envelope = readEnvelope(error);
  const rawCode = envelope?.code;
  const code = rawCode === null || rawCode === undefined ? '' : String(rawCode);
  const rawMessage = envelope?.message;
  const message =
    typeof rawMessage === 'string' && rawMessage !== ''
      ? rawMessage
      : extractErrorMessage(error, fallback);
  let raw: string;
  if (envelope) {
    try {
      raw = JSON.stringify(envelope, null, 2);
    } catch {
      raw = message;
    }
  } else {
    raw = error instanceof Error ? error.message : String(error);
  }
  return { code, message, raw };
}

function readEnvelope(
  error: unknown,
): undefined | { code?: unknown; message?: unknown } {
  const record = error as
    | undefined
    | { data?: unknown; response?: { data?: unknown } };
  const payload = record?.response?.data ?? record?.data;
  if (payload && typeof payload === 'object') {
    return payload as { code?: unknown; message?: unknown };
  }
  return undefined;
}

/** 状态码 → 文案（未知码**不吞**，按原始码展示）。 */
export function statusText(statusCode?: string): string {
  switch (statusCode) {
    case 'cancelled': {
      return $t('page.iot.debug.statusCancelled');
    }
    case 'failed': {
      return $t('page.iot.debug.statusFailed');
    }
    case 'pending': {
      return $t('page.iot.debug.statusPending');
    }
    case 'sent': {
      return $t('page.iot.debug.statusSent');
    }
    case 'succeeded': {
      return $t('page.iot.debug.statusSucceeded');
    }
    case 'timeout': {
      return $t('page.iot.debug.statusTimeout');
    }
    default: {
      return statusCode
        ? `${$t('page.iot.debug.unknownStatus')}（${statusCode}）`
        : '-';
    }
  }
}

/**
 * 来源码（后端 `CommandSource`）→ 文案。
 *
 * 未知码不伪装成已知值，按「未知（原码）」展示（与 shared/display.ts 同一口径）。
 */
export function sourceText(source?: string): string {
  switch (source) {
    case 'api': {
      return $t('page.iot.debug.sourceApi');
    }
    case 'console': {
      return $t('page.iot.debug.sourceConsole');
    }
    case 'rule': {
      return $t('page.iot.debug.sourceRule');
    }
    default: {
      return source ? $t('page.iot.display.unknownWithValue', [source]) : '-';
    }
  }
}

/** 状态码 → antdv Tag 颜色。 */
export function statusColor(statusCode?: string): string {
  switch (statusCode) {
    case 'failed': {
      return 'error';
    }
    case 'pending': {
      return 'default';
    }
    case 'sent': {
      return 'processing';
    }
    case 'succeeded': {
      return 'success';
    }
    case 'timeout': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
}

/** 动作码 → 文案（未知码按原始码展示）。 */
export function kindText(kindCode?: string): string {
  switch (kindCode) {
    case 'property_get': {
      return $t('page.iot.debug.kindPropertyGet');
    }
    case 'property_set': {
      return $t('page.iot.debug.kindPropertySet');
    }
    case 'service_call': {
      return $t('page.iot.debug.kindServiceCall');
    }
    default: {
      return kindCode ?? '-';
    }
  }
}

/** 失败原因码 → 人话（**未知码不吞**，按原始码展示）。 */
export function errorCodeText(errorCode?: string): string {
  switch (errorCode) {
    case 'DEVICE_OFFLINE': {
      return $t('page.iot.debug.errorDeviceOffline');
    }
    case 'DEVICE_REJECTED': {
      return $t('page.iot.debug.errorDeviceRejected');
    }
    case 'EMQX_ERROR': {
      return $t('page.iot.debug.errorEmqx');
    }
    case 'NO_SUBSCRIBER': {
      return $t('page.iot.debug.errorNoSubscriber');
    }
    case 'TIMEOUT': {
      return $t('page.iot.debug.errorTimeout');
    }
    default: {
      return errorCode
        ? `${$t('page.iot.debug.unknownErrorCode')}（${errorCode}）`
        : '';
    }
  }
}

/** 分页总数文案。 */
export function showTotal(total: number): string {
  return $t('page.iot.debug.total', [String(total)]);
}

/** 把 `replyPayload` 解析成结构化字段；非 JSON/非对象返回 `undefined`（页面回退展示原文）。 */
export function replyOf(record: {
  replyPayload?: string;
}): IotCommandApi.ReplyPayload | undefined {
  const text = record.replyPayload;
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as IotCommandApi.ReplyPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 值 → 展示文本（对象/数组用 JSON，避免 `[object Object]`）。 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 时间字段 → 展示文本：统一走 shared/display；解析不了的原始值原样露出，不显示成空白。 */
export function displayTime(value?: DisplayValue): string {
  return formatDateTime(value, displayValue(value));
}

/**
 * 本批高亮：最近一次下发产生的记录在列表里标出来，避免 N 条看着像孤立记录。
 *
 * 用语义 token（`bg-primary/10`）而不是硬编码调色板：硬编码在暗色主题下是近白底 + 浅色文字
 * （对比度 1.09:1，内容不可读）。
 */
export function batchRowClassName(
  batchRequestIds: ReadonlySet<string>,
  record: IotCommandApi.CommandInstanceResp,
): string {
  return batchRequestIds.has(record.requestId) ? 'bg-primary/10' : '';
}

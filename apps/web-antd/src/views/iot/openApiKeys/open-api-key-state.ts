import type { ListState } from '../shared/list-state';

import { resolveListState } from '../shared/list-state';

/**
 * 开放 API Key 管理页的**纯逻辑**（表单校验/归一化/列表态/状态展示），零 vue 依赖可单测。
 *
 * 后端口径（OpenApiKeyService/OpenApiPrincipal）：
 *   ① appName 必填（blank 即 400）；
 *   ② scopes 至少一个，且每个值必须在开放白名单内（含 iot:debug:send 高危项）；
 *   ③ status 为 EntityStatus 码：1=启用、0=停用（吊销后）；
 *   ④ secret 明文只在创建响应返回一次 —— 本文件不触碰 secret，只做表单与展示逻辑。
 */

/** 后端开放作用域白名单（与 OpenApiPrincipal.ALLOWED_SCOPES 精确对齐）。 */
export const OPEN_API_ALLOWED_SCOPES: readonly string[] = [
  'iot:device:list',
  'iot:device:latest',
  'iot:series:get',
  'iot:alert:list',
  'iot:product:list',
  'iot:availability:get',
  'iot:debug:send',
];

/** 高危作用域：命令下发（默认不授予，需显式勾选）。 */
export const OPEN_API_DANGEROUS_SCOPE = 'iot:debug:send';

/** Key 列表展示态（判据收口到 shared/list-state）。 */
export type OpenApiKeyListState = ListState;

/** 表单校验结果。 */
export type CheckResult = { message?: string; ok: boolean };

/**
 * 创建表单校验（与后端 CreateReq 同口径，先在前端拦住，避免"保存才报错"）。
 */
export function checkOpenApiKeyForm(
  appName: string,
  scopes: string[],
  rateLimitQps?: number,
  dailyQuota?: number,
): CheckResult {
  if (!appName || !appName.trim()) {
    return { message: 'appName-required', ok: false };
  }
  const picked = (scopes ?? []).map((s) => s.trim()).filter(Boolean);
  if (picked.length === 0) {
    return { message: 'scopes-required', ok: false };
  }
  const illegal = picked.find((s) => !OPEN_API_ALLOWED_SCOPES.includes(s));
  if (illegal) {
    return { message: `scope-not-allowed:${illegal}`, ok: false };
  }
  if (rateLimitQps !== undefined && !(rateLimitQps > 0)) {
    return { message: 'qps-invalid', ok: false };
  }
  if (dailyQuota !== undefined && !(dailyQuota >= 0)) {
    return { message: 'quota-invalid', ok: false };
  }
  return { ok: true };
}

/** 表单归一化：trim 应用名、scopes 去重去空（顺序保持首次出现）。 */
export function normalizeOpenApiKeyForm(
  appName: string,
  scopes: string[],
): { appName: string; scopes: string } {
  const seen = new Set<string>();
  for (const raw of scopes ?? []) {
    const token = (raw ?? '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
    }
  }
  return { appName: appName.trim(), scopes: [...seen].join(',') };
}

/**
 * IP 白名单（`ipWhitelist`）的客户端校验与归一化。
 *
 * 为什么前端要做一遍：后端 **创建 Key 时就拒绝非法条目**（不会存进去事后静默忽略），
 * 前端先拦可以把「保存才报错」提前成表单内错误；口径必须与后端 starter
 * `IpWhitelist.isValidEntry` 一致（支持单个 IPv4/IPv6 与 CIDR，不接受域名/端口外的花活）。
 *
 * 输入容错：任务/用户都习惯用逗号**或换行**分隔，这里统一按逗号/换行切分，
 * 提交给后端的始终是**逗号分隔、去重、trim 后**的串；空串 ⇒ `normalized` 缺席（= 不限来源）。
 */

/** 单个 IPv4 地址的位数（CIDR 掩码上限）。 */
const IPV4_BITS = 32;

/** 单个 IPv6 地址的位数（CIDR 掩码上限）。 */
const IPV6_BITS = 128;

/** IPv4 点分十进制的段数。 */
const IPV4_OCTET_COUNT = 4;

/** 单个 IPv4 段的最大值。 */
const IPV4_OCTET_MAX = 255;

/** IPv6 完整写法的分组数。 */
const IPV6_GROUP_COUNT = 8;

/** 单个 IPv6 分组：1~4 位十六进制。 */
const IPV6_GROUP_PATTERN = /^[\dA-Fa-f]{1,4}$/;

/** 纯数字（CIDR 掩码位）。 */
const CIDR_MASK_PATTERN = /^\d{1,3}$/;

/** 去掉 IPv6 的方括号（后端 `normalizeBrackets` 同口径）。 */
function stripBrackets(value: string): string {
  return value.length >= 2 && value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1).trim()
    : value;
}

/** IPv4 字面量（四段十进制，各段 ≤255）。 */
function isIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== IPV4_OCTET_COUNT) {
    return false;
  }
  return parts.every(
    (part) => /^\d{1,3}$/.test(part) && Number(part) <= IPV4_OCTET_MAX,
  );
}

/** 是否单个十六进制分组（IPv6 的一段）。 */
function isIpv6Group(value: string): boolean {
  return IPV6_GROUP_PATTERN.test(value);
}

/** 按冒号切分分组；空串返回空数组（`::` 压缩位由调用方按「<8 组」判定）。 */
function splitIpv6Groups(value: string): string[] {
  return value === '' ? [] : value.split(':');
}

/** IPv6 字面量（支持 `::` 压缩与末尾内嵌 IPv4，如 `::ffff:192.168.1.10`）。 */
function isIpv6Literal(value: string): boolean {
  if (value === '' || value.includes('%')) {
    // 作用域标识（fe80::1%eth0）后端 isLiteralAddress 也不接受
    return false;
  }
  let text = value;
  if (text.includes('.')) {
    // 末尾内嵌 IPv4 在 IPv6 语法里占 2 个分组：先替换成 `0:0` 再按纯 IPv6 校验，
    // 避免自己实现「v4 尾巴 + :: 压缩」两套规则组合带来的漏判。
    const match = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
    if (!match?.[1] || !match[2] || !isIpv4Literal(match[2])) {
      return false;
    }
    text = `${match[1]}0:0`;
  }
  const doubleColonCount = text.split('::').length - 1;
  if (doubleColonCount > 1) {
    return false;
  }
  if (doubleColonCount === 1) {
    const [head = '', tail = ''] = text.split('::');
    const groups = [...splitIpv6Groups(head), ...splitIpv6Groups(tail)];
    // `::` 必须至少压缩一组（否则写法本身非法）
    return (
      groups.length < IPV6_GROUP_COUNT &&
      groups.every((group) => isIpv6Group(group))
    );
  }
  const groups = splitIpv6Groups(text);
  return (
    groups.length === IPV6_GROUP_COUNT &&
    groups.every((group) => isIpv6Group(group))
  );
}

/**
 * 去掉 IPv4 的端口后缀（`1.2.3.4:5678`）。
 *
 * 与后端 `parseAddress` 同口径：仅「恰有一个冒号且含点」才剥离，
 * 否则会把 IPv6 地址误截断。
 */
function stripIpv4Port(value: string): string {
  const firstColon = value.indexOf(':');
  if (
    firstColon !== -1 &&
    value.includes('.') &&
    !value.includes(':', firstColon + 1)
  ) {
    return value.slice(0, firstColon);
  }
  return value;
}

/** 单个白名单条目是否合法（与后端 `IpWhitelist.isValidEntry` 对齐）。 */
export function isValidIpWhitelistEntry(entry: string): boolean {
  const trimmed = (entry ?? '').trim();
  if (!trimmed) {
    return false;
  }
  const unbracketed = stripBrackets(trimmed);
  const slash = unbracketed.indexOf('/');
  const addressText = slash === -1 ? unbracketed : unbracketed.slice(0, slash);
  const maskText = slash === -1 ? '' : unbracketed.slice(slash + 1);
  const address = stripIpv4Port(addressText);
  let addressBits: number | undefined;
  if (isIpv4Literal(address)) {
    addressBits = IPV4_BITS;
  } else if (isIpv6Literal(address)) {
    addressBits = IPV6_BITS;
  }
  if (addressBits === undefined) {
    return false;
  }
  if (maskText === '') {
    return true;
  }
  if (!CIDR_MASK_PATTERN.test(maskText)) {
    return false;
  }
  return Number(maskText) <= addressBits;
}

/** IP 白名单解析结果：`invalidEntry` 非空表示拦到了非法条目。 */
export interface IpWhitelistParseResult {
  /** 第一个非法条目（原样回显给用户定位问题）。 */
  invalidEntry?: string;
  /** 归一化后的逗号分隔串；空/未配置时为 undefined（= 不限来源）。 */
  normalized?: string;
}

/**
 * 解析并归一化 IP 白名单输入（逗号/换行分隔）。
 *
 * 返回**第一个**非法条目即停（与后端建 Key 时逐条校验、首个非法即拒绝的行为一致），
 * 让用户一次只改一处、而不是面对一整屏错误。
 */
export function parseIpWhitelist(
  input?: null | string,
): IpWhitelistParseResult {
  const text = (input ?? '').replaceAll(/\r\n?|\n/g, ',');
  const deduped: string[] = [];
  for (const raw of text.split(',')) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    if (!isValidIpWhitelistEntry(token)) {
      return { invalidEntry: token };
    }
    if (!deduped.includes(token)) {
      deduped.push(token);
    }
  }
  return deduped.length > 0 ? { normalized: deduped.join(',') } : {};
}

/** 列表「来源限制」列的展示态：已配置 / 不限 / 未知（后端未返回该字段）。 */
export type OpenApiKeyIpWhitelistKind = 'configured' | 'unknown' | 'unlimited';

/**
 * 来源限制列展示态。
 *
 * 注意：后端 `ListItemResp` **当前不返回** `ipWhitelist`，因此字段缺席时是「未知」，
 * 绝不能画成「不限来源」——那会把「后端没给数据」说成一项安全结论（假播报）。
 */
export function openApiKeyIpWhitelistKind(
  value?: null | string,
): OpenApiKeyIpWhitelistKind {
  if (value === undefined || value === null) {
    return 'unknown';
  }
  return value.trim() === '' ? 'unlimited' : 'configured';
}

/** 列表态判定（错误优先于空态，避免把加载失败画成"没有 Key"；判据收口到 shared/list-state）。 */
export function resolveOpenApiKeyListState(
  loading: boolean,
  errorMessage: string,
  count: number,
): OpenApiKeyListState {
  return resolveListState({ errorMessage, itemCount: count, loading });
}

/** 启用态判定（后端 EntityStatus：1=启用，其余一律按停用展示，fail-closed）。 */
export function isOpenApiKeyEnabled(status?: null | number): boolean {
  return status === 1;
}

/** 状态 ⇒ 标签颜色（启用绿、停用灰）。 */
export function openApiKeyStatusColor(status?: null | number): string {
  return isOpenApiKeyEnabled(status) ? 'success' : 'default';
}

/** 状态 ⇒ i18n 展示键。 */
export function openApiKeyStatusLabelKey(status?: null | number): string {
  return isOpenApiKeyEnabled(status)
    ? 'page.iot.openApiKey.enabled'
    : 'page.iot.openApiKey.disabled';
}

/** 用量进度（0–100 clamp；配额不限/未知时回 0，调用方按不限/未知展示，不画进度）。 */
export function openApiKeyUsagePercent(
  usedToday?: null | number | string,
  dailyQuota?: null | number,
): number {
  const used = toFiniteNumber(usedToday);
  if (
    used === undefined ||
    dailyQuota === undefined ||
    dailyQuota === null ||
    dailyQuota <= 0
  ) {
    return 0;
  }
  if (used <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((used / dailyQuota) * 100));
}

/** 用量展示形态（limited 才画进度条）。 */
export type OpenApiKeyUsageKind = 'limited' | 'unknown' | 'unlimited';

/** 用量展示形态判定（与 percent 配套：limited 才画进度条）。 */
export function openApiKeyUsageKind(
  usedToday?: null | number | string,
  dailyQuota?: null | number,
): OpenApiKeyUsageKind {
  if (dailyQuota === undefined || dailyQuota === null || dailyQuota <= 0) {
    return 'unlimited';
  }
  if (toFiniteNumber(usedToday) === undefined) {
    return 'unknown';
  }
  return 'limited';
}

/** 用量文本（`12`；调用方按 kind 决定是否展示，缺席显示 '-'）。 */
export function openApiKeyUsageLabel(
  usedToday?: null | number | string,
): string {
  const used = toFiniteNumber(usedToday);
  return used === undefined ? '-' : String(used);
}

/**
 * 后端 Long 序列化成字符串（本仓 Jackson 全局把 Long 转 String，防 JS 精度丢失；
 * `tenantId` 同理）——此处统一归一化，非数字字符串按缺席处理。
 */
function toFiniteNumber(value?: null | number | string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

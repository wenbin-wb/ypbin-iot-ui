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

/** Key 列表展示态。 */
export type OpenApiKeyListState = 'empty' | 'error' | 'loading' | 'ready';

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

/** 列表态判定（错误优先于空态，避免把加载失败画成"没有 Key"）。 */
export function resolveOpenApiKeyListState(
  loading: boolean,
  errorMessage: string,
  count: number,
): OpenApiKeyListState {
  if (loading) {
    return 'loading';
  }
  if (errorMessage) {
    return 'error';
  }
  return count > 0 ? 'ready' : 'empty';
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

/** 时间展示（缺席显示 '-'）。 */
export function openApiKeyTimeLabel(value?: null | string): string {
  return value ? String(value) : '-';
}

/** 作用域展示（空数组显示 '-'，否则逗号连接）。 */
export function openApiKeyScopesLabel(scopes?: null | string[]): string {
  return scopes && scopes.length > 0 ? scopes.join(', ') : '-';
}
